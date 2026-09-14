import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  acquireClawHubSource,
  type ClawHubSourceAcquisition,
  verifyClawHubArchive,
} from '../src/index.js';

const BASE = 'http://127.0.0.1:54322';
const SKILL = Buffer.from('---\nname: demo\ndescription: ClawHub fixture\n---\n# Demo\n', 'utf8');
const README = Buffer.from('fixture readme\n', 'utf8');

function crc32(value: Uint8Array): number {
  let result = 0xffffffff;
  for (const byte of value) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}

function zip(files: readonly { path: string; bytes: Uint8Array }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const bytes = Buffer.from(file.bytes);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30 + name.length + bytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    bytes.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, central, end]));
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function source(files: ClawHubSourceAcquisition['files']): ClawHubSourceAcquisition {
  return {
    kind: 'clawhub',
    owner: 'acme',
    slug: 'demo',
    version: '1.0.0',
    files,
    sourceProviderOrigin: 'https://clawhub.ai',
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function bytes(value: Uint8Array): Response {
  return new Response(Buffer.from(value) as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/zip' } });
}

describe('native ClawHub source acquisition', () => {
  it('revalidates detail and version manifests before fetching the fixed download route', async () => {
    const archive = zip([
      { path: 'SKILL.md', bytes: SKILL },
      { path: 'README.md', bytes: README },
      { path: '_meta.json', bytes: Buffer.from(JSON.stringify({ ownerId: 'owner-1', publishedAt: 1_700_000_000_000, slug: 'demo', version: '1.0.0' }), 'utf8') },
    ]);
    const files = [
      { path: 'README.md', size: README.length, sha256: sha256(README) },
      { path: 'SKILL.md', size: SKILL.length, sha256: sha256(SKILL) },
    ];
    const calls: Array<{ path: string; authorization: string | null }> = [];
    const fetchImpl = async (raw: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
      const url = new URL(raw.toString());
      calls.push({ path: `${url.pathname}${url.search}`, authorization: init?.headers?.authorization ?? null });
      if (url.pathname === '/api/v1/skills/demo') return json({
        skill: { slug: 'demo' },
        owner: { handle: 'acme' },
        latestVersion: { version: '1.0.0' },
      });
      if (url.pathname === '/api/v1/skills/demo/versions/1.0.0') return json({ version: { version: '1.0.0', files } });
      if (url.pathname === '/api/v1/download') return bytes(archive);
      return new Response('missing fixture', { status: 404 });
    };
    const result = await acquireClawHubSource({
      source: source(files),
      clawHubApiBaseUrl: BASE,
      allowLoopbackForTests: true,
      fetchImpl,
    });
    expect(calls).toEqual([
      { path: '/api/v1/skills/demo', authorization: null },
      { path: '/api/v1/skills/demo/versions/1.0.0', authorization: null },
      { path: '/api/v1/download?slug=demo&ownerHandle=acme&version=1.0.0', authorization: null },
    ]);
    expect(result.bundle.files.map((file) => file.path)).toEqual(['README.md', 'SKILL.md']);
    expect(result.provenance).toMatchObject({
      kind: 'registry',
      repository: 'https://clawhub.ai',
      path: '@acme/demo',
      revision: '1.0.0',
      sourceProviderOrigin: 'https://clawhub.ai',
      sourceResolutionKind: 'snapshot',
      sourceReference: '@clawhub/acme/demo',
    });
    expect(result.provenance.externalDigest).toBe(`sha256:${sha256(archive)}`);
  });

  it('rejects a tampered ClawHub metadata wrapper identity', async () => {
    const archive = zip([
      { path: 'SKILL.md', bytes: SKILL },
      { path: '_meta.json', bytes: Buffer.from(JSON.stringify({ ownerId: 'owner-1', slug: 'demo', version: '9.9.9' }), 'utf8') },
    ]);
    const files = [{ path: 'SKILL.md', size: SKILL.length, sha256: sha256(SKILL) }];
    await expect(acquireClawHubSource({
      source: source(files),
      clawHubApiBaseUrl: BASE,
      allowLoopbackForTests: true,
      fetchImpl: async (raw) => {
        const path = new URL(raw.toString()).pathname;
        if (path === '/api/v1/skills/demo') return json({ skill: { slug: 'demo' }, owner: { handle: 'acme' } });
        if (path === '/api/v1/skills/demo/versions/1.0.0') return json({ version: { version: '1.0.0', files } });
        return bytes(archive);
      },
    })).rejects.toMatchObject({ code: 'digest_mismatch' });
  });

  it('rejects a changed manifest or extra archive member before canonicalization', async () => {
    const skillFile = { path: 'SKILL.md', size: SKILL.length, sha256: sha256(SKILL) };
    const archive = zip([
      { path: 'SKILL.md', bytes: SKILL },
      { path: 'unexpected.txt', bytes: Buffer.from('unexpected\n') },
    ]);
    const calls: string[] = [];
    await expect(acquireClawHubSource({
      source: source([skillFile]),
      clawHubApiBaseUrl: BASE,
      allowLoopbackForTests: true,
      fetchImpl: async (raw) => {
        const url = new URL(raw.toString());
        calls.push(url.pathname);
        if (url.pathname === '/api/v1/skills/demo') return json({ skill: { slug: 'demo' }, owner: { handle: 'acme' } });
        if (url.pathname === '/api/v1/skills/demo/versions/1.0.0') return json({ version: { version: '1.0.0', files: [skillFile] } });
        return bytes(archive);
      },
    })).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(calls).toEqual(['/api/v1/skills/demo', '/api/v1/skills/demo/versions/1.0.0', '/api/v1/download']);
  });

  it('uses raw version file hashes and rejects provider security hashes as a manifest substitute', () => {
    const archive = zip([{ path: 'SKILL.md', bytes: SKILL }]);
    const manifest = [{ path: 'SKILL.md', size: SKILL.length, sha256: sha256(SKILL) }];
    expect(verifyClawHubArchive(archive, manifest, 'application/zip')).toHaveLength(1);
    expect(() => verifyClawHubArchive(archive, [{ path: 'SKILL.md', size: SKILL.length, sha256: '0'.repeat(64) }], 'application/zip')).toThrow(/digest/i);
  });
});
