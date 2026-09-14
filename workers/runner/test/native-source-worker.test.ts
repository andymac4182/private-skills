import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// The worker still performs its production DNS/SSRF check for the fixed
// provider origins. The fixture fetcher below does not make network calls.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

import { acquireImportJob } from '../src/acquisition.js';
import type { WorkerClaimedJob } from '../src/client.js';
import type { ClawHubSourceAcquisition, FetchLike, TesslSourceAcquisition } from '../../../packages/upstreams/src/index.js';
import type { PolyskillSourceAcquisition } from '../../../packages/upstreams/src/polyskill.js';
import { serializePolyskillNativeSemanticFields } from '../../../packages/source-catalog/src/adapters/polyskill-native.js';

const SKILL = Buffer.from('---\nname: native-demo\ndescription: Native worker fixture\n---\n# Demo\n', 'utf8');
const README = Buffer.from('# Native demo\n', 'utf8');

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii').copy(header, offset);
}

function tar(files: readonly { path: string; bytes: Uint8Array }[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    Buffer.from(file.path, 'utf8').copy(header, 0, 0, 100);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 124, 12, file.bytes.length);
    header[156] = 0;
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    Buffer.from(`${checksum.toString(8).padStart(6, '0')} \0`, 'ascii').copy(header, 148);
    chunks.push(header);
    const padded = Buffer.alloc(Math.ceil(file.bytes.length / 512) * 512);
    Buffer.from(file.bytes).copy(padded);
    chunks.push(padded);
  }
  chunks.push(Buffer.alloc(1_024));
  return Uint8Array.from(gzipSync(Buffer.concat(chunks)));
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function archive(value: Uint8Array): Response {
  return new Response(Buffer.from(value) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/gzip' } });
}

function job(
  sourceAcquisition: TesslSourceAcquisition | ClawHubSourceAcquisition | PolyskillSourceAcquisition,
  path: string,
  ref: string,
): WorkerClaimedJob {
  return {
    id: `job-${sourceAcquisition.kind}`,
    kind: 'import',
    organizationId: 'org-1',
    upstream: {
      id: `${sourceAcquisition.kind}-upstream`,
      organizationId: 'org-1',
      name: sourceAcquisition.kind,
      kind: 'registry',
      enabled: true,
      namespace: 'sources',
      baseUrl: sourceAcquisition.kind === 'tessl'
        ? 'https://api.tessl.io'
        : sourceAcquisition.kind === 'clawhub' ? 'https://clawhub.ai' : 'https://polyskill.ai',
    },
    import: {
      upstreamId: `${sourceAcquisition.kind}-upstream`,
      path,
      ref,
      name: '@sources/native-demo',
      version: '0.0.0+source-fixture',
      sourceReference: sourceAcquisition.kind === 'tessl'
        ? '@tessl/acme/assistant/skills/demo@2.0.0'
        : sourceAcquisition.kind === 'clawhub' ? '@clawhub/acme/demo' : '@polyskill/@acme/native-demo@1.2.3',
    },
    sourceAcquisition,
  } as WorkerClaimedJob;
}

describe('worker native source dispatch', () => {
  it('dispatches Tessl directly to its archive endpoint with default native options', async () => {
    const files = [
      { path: 'skills/demo/SKILL.md', bytes: SKILL },
      { path: 'skills/demo/README.md', bytes: README },
    ];
    const bytes = tar(files);
    const source: TesslSourceAcquisition = {
      kind: 'tessl',
      workspace: 'acme',
      tile: 'assistant',
      version: '2.0.0',
      fingerprint: 'a'.repeat(64),
      skillPath: 'skills/demo',
      artifactDigest: `sha256:${sha256(bytes)}`,
      sourceProviderOrigin: 'https://api.tessl.io',
    };
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (raw) => {
      const url = new URL(raw.toString());
      calls.push(url.pathname);
      if (url.pathname.endsWith('/versions/2.0.0')) return json({ data: { attributes: { fingerprint: source.fingerprint } } });
      if (url.pathname.endsWith('/versions/2.0.0/files')) return archive(bytes);
      return new Response('missing', { status: 404 });
    };
    const result = await acquireImportJob(job(source, 'acme/assistant/skills/demo', '2.0.0'), { fetchImpl });
    expect(calls).toEqual([
      '/v1/tiles/acme/assistant/versions/2.0.0',
      '/v1/tiles/acme/assistant/versions/2.0.0/files',
    ]);
    expect(result.bundle.files.map((file) => file.path)).toEqual(['README.md', 'SKILL.md']);
    expect(result.provenance).toMatchObject({ kind: 'registry', sourceReference: '@tessl/acme/assistant/skills/demo@2.0.0' });
  });

  it('dispatches ClawHub directly and verifies its exact version manifest', async () => {
    const files = [
      { path: 'SKILL.md', bytes: SKILL },
      { path: 'README.md', bytes: README },
    ];
    const bytes = tar(files);
    const manifest = files.map((file) => ({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes) }));
    const source: ClawHubSourceAcquisition = {
      kind: 'clawhub',
      owner: 'acme',
      slug: 'demo',
      version: '1.0.0',
      files: manifest,
      sourceProviderOrigin: 'https://clawhub.ai',
    };
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (raw) => {
      const url = new URL(raw.toString());
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/v1/skills/demo') return json({ skill: { slug: 'demo' }, owner: { handle: 'acme' } });
      if (url.pathname === '/api/v1/skills/demo/versions/1.0.0') return json({ version: { version: '1.0.0', files: manifest } });
      if (url.pathname === '/api/v1/download') return archive(bytes);
      return new Response('missing', { status: 404 });
    };
    const result = await acquireImportJob(job(source, '@acme/demo', '1.0.0'), { fetchImpl });
    expect(calls).toEqual([
      '/api/v1/skills/demo',
      '/api/v1/skills/demo/versions/1.0.0',
      '/api/v1/download?slug=demo&ownerHandle=acme&version=1.0.0',
    ]);
    expect(result.bundle.files.map((file) => file.path)).toEqual(['README.md', 'SKILL.md']);
    expect(result.provenance).toMatchObject({ kind: 'registry', sourceReference: '@clawhub/acme/demo', externalDigest: `sha256:${sha256(bytes)}` });
  });

  it('dispatches PolySkill directly with default native options and binds its managed source reference', async () => {
    const payload = {
      name: '@acme/native-demo',
      version: '1.2.3',
      manifest: {
        name: '@acme/native-demo',
        version: '1.2.3',
        description: 'A native demo skill',
        type: 'prompt',
        skill: { instructions: './instructions.md' },
        author: { name: 'acme' },
      },
      instructions: 'Use this guidance as data.\n',
      tools: null,
    };
    const semantic = serializePolyskillNativeSemanticFields(payload);
    const source = {
      kind: 'polyskill',
      name: payload.name,
      version: payload.version,
      contentDigest: `sha256:${sha256(semantic)}`,
      sourceProviderOrigin: 'https://polyskill.ai',
    } as PolyskillSourceAcquisition & { sourceProviderOrigin: string };
    const result = await acquireImportJob(job(source, source.name, source.version), {
      fetchImpl: async (raw) => {
        expect(new URL(raw.toString()).pathname).toBe('/api/skills/%40acme%2Fnative-demo/1.2.3');
        return json(payload);
      },
    });
    expect(result.bundle.files.map((file) => file.path)).toEqual(['SKILL.md', 'instructions.md', 'skill.json']);
    expect(result.provenance).toMatchObject({
      kind: 'registry',
      repository: 'https://polyskill.ai',
      path: source.name,
      revision: source.version,
      sourceReference: '@polyskill/@acme/native-demo@1.2.3',
      externalDigest: source.contentDigest,
    });
  });
});
