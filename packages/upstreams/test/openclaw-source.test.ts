import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  acquireOpenClawSource,
  createDefaultOpenClawSourceConfiguration,
  createOpenClawHttpFetcher,
  serializeSkillBundle,
  type OpenClawFetchedSource,
} from '../src/index.js';
import type { OpenClawNormalizedSource } from '../../openclaw/src/types.js';
import type { UpstreamRequestKind } from '../../contracts/src/index.js';

const COMMIT = '0123456789012345678901234567890123456789';
const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const SKILL = Buffer.from('---\nname: demo\ndescription: OpenClaw source fixture\n---\n# Demo\n', 'utf8');
const CONTENT_HASH = '80d711119c66b1eb2d01929130726f0b0e96cfb6f222098c399074cbd027d9ec';

interface TarEntry {
  path: string;
  bytes?: Uint8Array;
  directory?: boolean;
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii').copy(header, offset);
}

function tar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    Buffer.from(entry.path, 'utf8').copy(header, 0, 0, 100);
    writeTarOctal(header, 100, 8, entry.directory ? 0o755 : 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    const bytes = Buffer.from(entry.bytes ?? new Uint8Array());
    writeTarOctal(header, 124, 12, entry.directory ? 0 : bytes.length);
    writeTarOctal(header, 136, 12, 0);
    header[156] = entry.directory ? 0x35 : 0;
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const value of header) checksum += value;
    Buffer.from(`${checksum.toString(8).padStart(6, '0')} \0`, 'ascii').copy(header, 148);
    chunks.push(header);
    if (!entry.directory) {
      const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
      bytes.copy(padded);
      chunks.push(padded);
    }
  }
  chunks.push(Buffer.alloc(1_024));
  return Uint8Array.from(Buffer.concat(chunks));
}

function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(`${key}=${value}\n`, 'utf8');
  let length = body.length + 2;
  while (length !== body.length + String(length).length + 1) {
    length = body.length + String(length).length + 1;
  }
  return Buffer.concat([Buffer.from(`${length} `, 'ascii'), body]);
}

function paxRecordBytes(key: string, value: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(`${key}=`, 'ascii'), Buffer.from(value), Buffer.from('\n', 'ascii')]);
  let length = body.length + 2;
  while (length !== body.length + String(length).length + 1) {
    length = body.length + String(length).length + 1;
  }
  return Buffer.concat([Buffer.from(`${length} `, 'ascii'), body]);
}

function tarWithPaxGlobalHeader(
  entries: readonly TarEntry[],
  payload = paxRecord('comment', COMMIT),
): Uint8Array {
  const header = Buffer.alloc(512);
  Buffer.from('pax_global_header', 'ascii').copy(header, 0);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, payload.length);
  writeTarOctal(header, 136, 12, 0);
  header[156] = 0x67;
  Buffer.from('ustar\0', 'ascii').copy(header, 257);
  Buffer.from('00', 'ascii').copy(header, 263);
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const value of header) checksum += value;
  Buffer.from(`${checksum.toString(8).padStart(6, '0')} \0`, 'ascii').copy(header, 148);
  const padded = Buffer.alloc(Math.ceil(payload.length / 512) * 512);
  payload.copy(padded);
  return Uint8Array.from(Buffer.concat([header, padded, Buffer.from(tar(entries))]));
}

function githubArchive(commit = COMMIT): Uint8Array {
  const root = `skills-${commit}`;
  return Uint8Array.from(gzipSync(Buffer.from(tar([
    { path: `${root}/`, directory: true },
    { path: `${root}/README.md`, bytes: Buffer.from('repository readme\n') },
    { path: `${root}/skills/`, directory: true },
    { path: `${root}/skills/demo/`, directory: true },
    { path: `${root}/skills/demo/SKILL.md`, bytes: SKILL },
    { path: `${root}/skills/demo/assets/`, directory: true },
    { path: `${root}/skills/demo/assets/logo.txt`, bytes: Buffer.from('logo\n') },
    { path: `${root}/skills/demo/empty/`, directory: true },
    { path: `${root}/skills/demo/.clawhub/`, directory: true },
    { path: `${root}/skills/demo/.clawhub/state.json`, bytes: Buffer.from('metadata\n') },
  ]))));
}

function githubArchiveWithPaxGlobalHeader(
  commit = COMMIT,
  payload = paxRecord('comment', commit),
): Uint8Array {
  const root = `skills-${commit}`;
  return Uint8Array.from(gzipSync(Buffer.from(tarWithPaxGlobalHeader([
    { path: `${root}/`, directory: true },
    { path: `${root}/README.md`, bytes: Buffer.from('repository readme\n') },
    { path: `${root}/skills/`, directory: true },
    { path: `${root}/skills/demo/`, directory: true },
    { path: `${root}/skills/demo/SKILL.md`, bytes: SKILL },
    { path: `${root}/skills/demo/assets/`, directory: true },
    { path: `${root}/skills/demo/assets/logo.txt`, bytes: Buffer.from('logo\n') },
    { path: `${root}/skills/demo/empty/`, directory: true },
    { path: `${root}/skills/demo/.clawhub/`, directory: true },
    { path: `${root}/skills/demo/.clawhub/state.json`, bytes: Buffer.from('metadata\n') },
  ], payload))));
}

function fetched(bytes: Uint8Array, overrides: Partial<OpenClawFetchedSource> = {}): OpenClawFetchedSource {
  return {
    bytes,
    requestedUrl: `https://codeload.github.com/acme/skills/tar.gz/${COMMIT}`,
    finalUrl: `https://codeload.github.com/acme/skills/tar.gz/${COMMIT}`,
    status: 200,
    redirected: false,
    contentType: 'application/gzip',
    sourceProviderOrigin: 'https://github.com',
    ...overrides,
  };
}

async function resolve(
  source: OpenClawNormalizedSource,
  value: OpenClawFetchedSource,
  options: Partial<Parameters<typeof acquireOpenClawSource>[0]> = {},
) {
  return acquireOpenClawSource({
    source,
    fetcher: { fetch: async () => value },
    allowedArtifactOrigins: ['https://codeload.github.com'],
    sourceProviderOrigin: 'https://github.com',
    ...options,
  });
}

describe('OpenClaw source verification', () => {
  it('derives the documented ClawHub and immutable GitHub locations without per-skill mapping', async () => {
    const configuration = createDefaultOpenClawSourceConfiguration();
    const clawHub = await configuration.locator.locate({
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/demo',
      version: '1.0.0',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    });
    expect(clawHub.url).toBe('https://clawhub.ai/api/v1/download?slug=demo&ownerHandle=acme&version=1.0.0');
    expect(clawHub.allowedArtifactOrigins).toEqual(['https://clawhub.ai']);
    expect(clawHub.sourceProviderOrigin).toBe('https://clawhub.ai');

    const github = await configuration.locator.locate({
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'openclaw/skills',
      path: 'skills/demo',
      commit: COMMIT,
      contentHash: 'a'.repeat(64),
    });
    expect(github.url).toBe(`https://codeload.github.com/openclaw/skills/tar.gz/${COMMIT}`);
    expect(github.allowedArtifactOrigins).toEqual(['https://codeload.github.com']);
    expect(github.sourceProviderOrigin).toBe('https://github.com');

    const secondClawHub = await configuration.locator.locate({
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: 'other-skill',
      version: '2.0.0',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(secondClawHub.url).toContain('slug=other-skill');
    expect(secondClawHub.url).not.toBe(clawHub.url);
  });

  it('keeps an operator-selected ClawHub origin separate from the fixed public GitHub profile', async () => {
    const configuration = createDefaultOpenClawSourceConfiguration({
      clawHubOrigin: 'https://clawhub.example.test',
    });
    const clawHub = await configuration.locator.locate({
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: 'demo',
      version: '1.0.0',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    });
    expect(clawHub.url).toBe('https://clawhub.example.test/api/v1/download?slug=demo&version=1.0.0');
    expect(configuration.profiles['public-clawhub'].sourceProviderOrigin).toBe('https://clawhub.example.test');
    expect(configuration.profiles['public-github'].sourceProviderOrigin).toBe('https://github.com');
    expect(configuration.profiles['public-github'].allowedArtifactOrigins).toEqual(['https://codeload.github.com']);
  });

  it('rejects invalid default source identities before any source request', async () => {
    const locator = createDefaultOpenClawSourceConfiguration().locator;
    await expect(Promise.resolve().then(() => locator.locate({
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'evil/../repo',
      path: '',
      commit: COMMIT,
      contentHash: 'a'.repeat(64),
    }))).rejects.toMatchObject({ code: 'invalid_source' });
    await expect(Promise.resolve().then(() => locator.locate({
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'openclaw/skills',
      path: 'skills/../demo',
      commit: COMMIT,
      contentHash: 'a'.repeat(64),
    }))).rejects.toMatchObject({ code: 'invalid_source' });
    await expect(Promise.resolve().then(() => locator.locate({
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'openclaw/skills',
      path: '',
      commit: COMMIT.toUpperCase(),
      contentHash: 'a'.repeat(64),
    }))).rejects.toMatchObject({ code: 'invalid_source' });
    expect(() => createDefaultOpenClawSourceConfiguration({ clawHubOrigin: 'http://clawhub.example.test' })).toThrow();
    expect(() => createDefaultOpenClawSourceConfiguration({ clawHubOrigin: 'https://clawhub.example.test/api' })).toThrow();
  });

  it('resolves a pinned GitHub archive and computes the canonical folder hash', async () => {
    const source: OpenClawNormalizedSource = {
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'acme/skills',
      path: 'skills/demo',
      commit: COMMIT,
      contentHash: CONTENT_HASH,
    };
    const result = await resolve(source, fetched(githubArchive()));
    expect(result.bundle.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/logo.txt']);
    expect(result.externalDigest).toBe(`sha256:${CONTENT_HASH}`);
    expect(result.provenance).toMatchObject({
      kind: 'github',
      repository: 'acme/skills',
      path: 'skills/demo',
      revision: COMMIT,
      resolvedCommit: COMMIT,
      sourceProviderOrigin: 'https://github.com',
      sourceResolutionKind: 'github',
    });
  });

  it('accepts a POSIX PAX global metadata header in a pinned GitHub archive', async () => {
    const source: OpenClawNormalizedSource = {
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'acme/skills',
      path: 'skills/demo',
      commit: COMMIT,
      contentHash: CONTENT_HASH,
    };
    const result = await resolve(source, fetched(githubArchiveWithPaxGlobalHeader()));
    expect(result.bundle.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/logo.txt']);
    expect(result.externalDigest).toBe(`sha256:${CONTENT_HASH}`);
  });

  it('accepts only inert PAX global metadata and rejects malformed or path-affecting records', async () => {
    const source: OpenClawNormalizedSource = {
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'acme/skills',
      path: 'skills/demo',
      commit: COMMIT,
      contentHash: CONTENT_HASH,
    };
    const inert = Buffer.concat([
      paxRecord('comment', COMMIT),
      paxRecord('mtime', '1700000000.25'),
      paxRecord('atime', '1700000000'),
      paxRecord('ctime', '1700000000'),
      paxRecord('uid', '1000'),
      paxRecord('gid', '1000'),
    ]);
    const accepted = await resolve(source, fetched(githubArchiveWithPaxGlobalHeader(COMMIT, inert)));
    expect(accepted.externalDigest).toBe(`sha256:${CONTENT_HASH}`);

    await expect(resolve(source, fetched(githubArchiveWithPaxGlobalHeader(COMMIT, paxRecord('path', '../../escape'))))).rejects.toMatchObject({ code: 'unsupported_archive' });
    await expect(resolve(source, fetched(githubArchiveWithPaxGlobalHeader(COMMIT, paxRecord('linkpath', 'SKILL.md'))))).rejects.toMatchObject({ code: 'unsupported_archive' });
    await expect(resolve(source, fetched(githubArchiveWithPaxGlobalHeader(COMMIT, paxRecord('size', '1'))))).rejects.toMatchObject({ code: 'unsupported_archive' });
    await expect(resolve(source, fetched(githubArchiveWithPaxGlobalHeader(COMMIT, Buffer.from(`999 comment=${COMMIT}\n`, 'ascii'))))).rejects.toMatchObject({ code: 'invalid_archive' });
    const missingNewline = paxRecord('comment', COMMIT).subarray(0, -1);
    await expect(resolve(source, fetched(githubArchiveWithPaxGlobalHeader(COMMIT, missingNewline)))).rejects.toMatchObject({ code: 'invalid_archive' });
    await expect(resolve(source, fetched(githubArchiveWithPaxGlobalHeader(COMMIT, paxRecordBytes('comment', Uint8Array.from([0xc3, 0x28])))))).rejects.toMatchObject({ code: 'invalid_archive' });
    await expect(resolve(source, fetched(githubArchiveWithPaxGlobalHeader(COMMIT, paxRecord('comment', 'not-a-commit'))))).rejects.toMatchObject({ code: 'unsupported_archive' });
  });

  it('resolves a verified hosted artifact while retaining its external digest separately', async () => {
    const bytes = serializeSkillBundle({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: SKILL.toString('base64') }],
    });
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const source: OpenClawNormalizedSource = {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/demo',
      version: '1.0.0',
      artifactDigest: digest,
    };
    const result = await resolve(source, fetched(bytes, {
      requestedUrl: 'https://artifacts.example.test/skills/demo.pskills.json',
      finalUrl: 'https://artifacts.example.test/skills/demo.pskills.json',
      contentType: 'application/json',
      sourceProviderOrigin: 'https://artifacts.example.test',
    }), {
      allowedArtifactOrigins: ['https://artifacts.example.test'],
      sourceProviderOrigin: 'https://artifacts.example.test',
    });
    expect(result.bundle.files).toHaveLength(1);
    expect(result.externalDigest).toBe(digest);
    expect(result.provenance.sourceDigest).toBeDefined();
    expect(result.provenance.externalDigest).toBe(result.externalDigest);
    expect(result.provenance.sourceResolutionKind).toBe('snapshot');
  });

  it('accepts bounded nested metadata.openclaw while preserving the original SKILL.md bytes', async () => {
    const openClawSkill = Buffer.from([
      '---',
      'name: demo',
      'description: OpenClaw metadata fixture',
      'metadata:',
      '  openclaw:',
      '    primaryEnv: DEMO_TOKEN',
      '---',
      '# Demo',
      '',
    ].join('\n'), 'utf8');
    const bytes = serializeSkillBundle({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: openClawSkill.toString('base64') }],
    });
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const source: OpenClawNormalizedSource = {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/metadata-demo',
      version: '1.0.0',
      artifactDigest: digest,
    };
    const result = await resolve(source, fetched(bytes, {
      requestedUrl: 'https://artifacts.example.test/metadata.json',
      finalUrl: 'https://artifacts.example.test/metadata.json',
      contentType: 'application/json',
      sourceProviderOrigin: 'https://artifacts.example.test',
    }), {
      allowedArtifactOrigins: ['https://artifacts.example.test'],
      sourceProviderOrigin: 'https://artifacts.example.test',
    });
    expect(Buffer.from(result.bundle.files[0]!.content, 'base64')).toEqual(openClawSkill);
  });

  it('rejects activation keys nested inside OpenClaw metadata', async () => {
    const openClawSkill = Buffer.from([
      '---',
      'name: demo',
      'description: OpenClaw metadata fixture',
      'metadata:',
      '  openclaw:',
      '    hooks: true',
      '---',
      '# Demo',
    ].join('\n'), 'utf8');
    const bytes = serializeSkillBundle({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: openClawSkill.toString('base64') }],
    });
    const source: OpenClawNormalizedSource = {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/unsafe-metadata',
      version: '1.0.0',
      artifactDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
    await expect(resolve(source, fetched(bytes))).rejects.toMatchObject({ code: 'unsafe_frontmatter' });
  });

  it('rejects a changed commit, a content hash mismatch, unsafe paths, redirects, and oversized input', async () => {
    const source: OpenClawNormalizedSource = {
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'acme/skills',
      path: 'skills/demo',
      commit: COMMIT,
      contentHash: CONTENT_HASH,
    };
    await expect(resolve(source, fetched(githubArchive(OTHER_COMMIT)))).rejects.toMatchObject({ code: 'digest_mismatch' });
    await expect(resolve(source, fetched(githubArchive()), { source: { ...source, contentHash: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'digest_mismatch' });
    const unsafe = gzipSync(Buffer.from(tar([{ path: `skills-${COMMIT}/skills/demo/../SKILL.md`, bytes: SKILL }])));
    await expect(resolve(source, fetched(unsafe))).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(resolve(source, fetched(githubArchive(), { finalUrl: 'https://evil.example.test/skills.tar.gz' }))).rejects.toMatchObject({ code: 'redirect_denied' });
    await expect(resolve(source, fetched(githubArchive()), { limits: { maxResponseBytes: 16 } })).rejects.toMatchObject({ code: 'response_size_limit' });
  });

  it('does not fetch or accept an origin outside the explicit transport allowlist', async () => {
    const source: OpenClawNormalizedSource = {
      kind: 'public-github',
      sourceRef: 'public-github',
      repo: 'acme/skills',
      path: 'skills/demo',
      commit: COMMIT,
      contentHash: CONTENT_HASH,
    };
    let called = false;
    await expect(acquireOpenClawSource({
      source,
      fetcher: { fetch: async () => { called = true; return fetched(githubArchive(), { requestedUrl: 'https://evil.example.test/a', finalUrl: 'https://evil.example.test/a' }); } },
      allowedArtifactOrigins: ['https://codeload.github.com'],
      sourceProviderOrigin: 'https://github.com',
    })).rejects.toMatchObject({ code: 'source_origin_denied' });
    expect(called).toBe(true);
  });

  it('uses the bounded DNS-checked HTTP client with no credentials and rejects redirects before body handling', async () => {
    const skillBytes = serializeSkillBundle({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: SKILL.toString('base64') }],
    });
    const digest = `sha256:${createHash('sha256').update(skillBytes).digest('hex')}`;
    const source: OpenClawNormalizedSource = {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/demo',
      version: '1.0.0',
      artifactDigest: digest,
    };
    let calls = 0;
    const observed: UpstreamRequestKind[] = [];
    const fetcher = createOpenClawHttpFetcher({
      allowLoopbackForTests: true,
      fetchImpl: async (_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        return new Response(calls === 1 ? Buffer.from(skillBytes) : null, {
          status: calls === 1 ? 200 : 302,
          headers: calls === 1 ? { 'content-type': 'application/json' } : { location: 'https://evil.example.test/other' },
        });
      },
      locator: {
        locate: () => ({
          url: 'https://127.0.0.1:34443/artifacts/demo.json',
          allowedArtifactOrigins: ['https://127.0.0.1:34443'],
          sourceProviderOrigin: 'https://artifacts.example.test',
        }),
      },
    });
    const first = await acquireOpenClawSource({
      source,
      fetcher,
      allowedArtifactOrigins: ['https://127.0.0.1:34443'],
      sourceProviderOrigin: 'https://artifacts.example.test',
      upstreamObserver: { record: (kind) => observed.push(kind) },
    });
    expect(first.bundle.files).toHaveLength(1);
    expect(observed).toEqual(['source']);
    await expect(acquireOpenClawSource({
      source,
      fetcher,
      allowedArtifactOrigins: ['https://127.0.0.1:34443'],
      sourceProviderOrigin: 'https://artifacts.example.test',
      upstreamObserver: { record: (kind) => observed.push(kind) },
    })).rejects.toMatchObject({ code: 'redirect_denied' });
    expect(calls).toBe(2);
    expect(observed).toEqual(['source', 'source']);
  });
});
