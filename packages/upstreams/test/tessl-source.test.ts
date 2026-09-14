import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  acquireTesslSource,
  extractTesslArchive,
  selectTesslSkillDirectory,
  type TesslSourceAcquisition,
} from '../src/index.js';

const FINGERPRINT = 'a'.repeat(64);
const SKILL = Buffer.from('---\nname: tessl-demo\ndescription: Tessl fixture\n---\n# Demo\n', 'utf8');

interface TarEntry {
  path: string;
  bytes?: Uint8Array;
  type?: number;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii').copy(header, offset);
}

function tar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    Buffer.from(entry.path, 'utf8').copy(header, 0, 0, 100);
    const bytes = Buffer.from(entry.bytes ?? new Uint8Array());
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.length);
    writeOctal(header, 136, 12, 0);
    header[156] = entry.type ?? 0;
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const value of header) checksum += value;
    Buffer.from(`${checksum.toString(8).padStart(6, '0')} \0`, 'ascii').copy(header, 148);
    chunks.push(header);
    if (bytes.length > 0) {
      const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
      bytes.copy(padded);
      chunks.push(padded);
    }
  }
  chunks.push(Buffer.alloc(1_024));
  return Uint8Array.from(Buffer.concat(chunks));
}

function archive(entries: readonly TarEntry[]): Uint8Array {
  return Uint8Array.from(gzipSync(Buffer.from(tar(entries))));
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function source(overrides: Partial<TesslSourceAcquisition> = {}): TesslSourceAcquisition {
  return {
    kind: 'tessl',
    workspace: 'acme',
    tile: 'assistant',
    version: '1.0.5',
    fingerprint: FINGERPRINT,
    skillPath: 'skills/demo',
    sourceProviderOrigin: 'https://api.tessl.io',
    ...overrides,
  };
}

function response(value: unknown, contentType = 'application/json'): Response {
  return new Response(contentType === 'application/json' ? JSON.stringify(value) : value as BodyInit, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('native Tessl source acquisition', () => {
  it('revalidates the tile fingerprint, fetches the fixed files route, and selects the exact skill directory', async () => {
    const bytes = archive([
      { path: 'skills/demo/SKILL.md', bytes: SKILL },
      { path: 'skills/demo/assets/logo.txt', bytes: Buffer.from('logo\n') },
      { path: 'skills/other/SKILL.md', bytes: Buffer.from('---\nname: other\ndescription: other\n---\n') },
    ]);
    const seen: Array<{ path: string; accept: string | null; authorization: string | null }> = [];
    const fetched = async (raw: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
      const url = new URL(raw.toString());
      seen.push({ path: url.pathname, accept: init?.headers?.accept ?? null, authorization: init?.headers?.authorization ?? null });
      if (url.pathname.endsWith('/versions/1.0.5')) return response({ data: { attributes: { fingerprint: FINGERPRINT } } });
      if (url.pathname.endsWith('/versions/1.0.5/files')) return response(bytes, 'application/gzip');
      return response({ error: 'missing fixture' }, 'application/json');
    };
    const result = await acquireTesslSource({
      source: source({ artifactDigest: digest(bytes) }),
      fetchImpl: fetched,
      tesslToken: 'tessl-fixture-token',
      tesslApiBaseUrl: 'http://127.0.0.1:54321',
      allowLoopbackForTests: true,
    });
    expect(seen).toEqual([
      { path: '/v1/tiles/acme/assistant/versions/1.0.5', accept: 'application/json', authorization: 'Bearer tessl-fixture-token' },
      { path: '/v1/tiles/acme/assistant/versions/1.0.5/files', accept: 'application/gzip', authorization: 'Bearer tessl-fixture-token' },
    ]);
    expect(result.bundle.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/logo.txt']);
    expect(result.externalDigest).toBe(digest(bytes));
    expect(result.provenance).toMatchObject({
      kind: 'native',
      repository: 'https://api.tessl.io',
      path: 'skills/demo',
      revision: '1.0.5',
      externalSnapshotHash: FINGERPRINT,
      sourceProviderOrigin: 'https://api.tessl.io',
      sourceResolutionKind: 'snapshot',
    });
    expect(result.provenance.sourceReference).toContain('/skills/demo@1.0.5');
  });

  it('requires an exact skill selection when a Tessl tile contains multiple skills', () => {
    const bytes = archive([
      { path: 'skills/one/SKILL.md', bytes: SKILL },
      { path: 'skills/two/SKILL.md', bytes: SKILL },
    ]);
    const files = extractTesslArchive(bytes);
    expect(() => selectTesslSkillDirectory(files, '', undefined)).toThrow(/does not contain SKILL.md|exactly one SKILL.md|ambiguous/i);
    expect(selectTesslSkillDirectory(files, 'skills/two').map((file) => file.path)).toEqual(['SKILL.md']);
  });

  it('preserves nested resources when the explicitly selected skill is the archive root', () => {
    const files = extractTesslArchive(archive([
      { path: 'SKILL.md', bytes: SKILL },
      { path: 'references/examples/example.md', bytes: Buffer.from('example\n') },
    ]));
    expect(selectTesslSkillDirectory(files, '').map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/examples/example.md',
    ]);
  });

  it('fails before archive decoding when the live fingerprint changes', async () => {
    let archiveRequested = false;
    await expect(acquireTesslSource({
      source: source(),
      tesslApiBaseUrl: 'http://127.0.0.1:54321',
      allowLoopbackForTests: true,
      fetchImpl: async (raw) => {
        const path = new URL(raw.toString()).pathname;
        if (path.endsWith('/versions/1.0.5')) return response({ data: { attributes: { fingerprint: 'b'.repeat(64) } } });
        archiveRequested = true;
        return response(new Uint8Array(), 'application/gzip');
      },
    })).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(archiveRequested).toBe(false);
  });

  it('rejects archive links before any bundle is materialized', () => {
    const bytes = archive([{ path: 'skills/demo/SKILL.md', bytes: SKILL, type: 2 }]);
    expect(() => extractTesslArchive(bytes)).toThrow(/link|unsupported/i);
  });
});
