import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  acquireSkill,
  acquireSkillsShSkill,
} from '../src/index.js';
import type { AcquireSkillInput } from '../src/index.js';

const BASE = 'http://127.0.0.1:32123';
const DETAIL_PATH = '/catalog/api/v1/skills/example.test/demo';
const INDEX_PATH = '/published/.well-known/agent-skills/index.json';
const SKILL = Buffer.from('---\nname: demo\ndescription: Archive fixture\n---\n# demo\n', 'utf8');

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function writeU16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
}

function writeU32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function crc32(value: Uint8Array): number {
  let result = 0xffffffff;
  for (const byte of value) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
    }
  }
  return (result ^ 0xffffffff) >>> 0;
}

interface ZipOptions {
  centralCrc?: number;
  localCrc?: number;
  centralName?: string;
  localName?: string;
  method?: 0 | 8;
  compressed?: Uint8Array;
  uncompressedSize?: number;
  creatorVersion?: number;
  externalAttributes?: number;
}

function singleEntryZip(options: ZipOptions = {}): Uint8Array {
  const method = options.method ?? 0;
  const centralName = Buffer.from(options.centralName ?? 'SKILL.md', 'utf8');
  const localName = Buffer.from(options.localName ?? options.centralName ?? 'SKILL.md', 'utf8');
  const content = Buffer.from(options.compressed ?? SKILL);
  const compressedSize = content.length;
  const uncompressedSize = options.uncompressedSize ?? SKILL.length;
  const actualCrc = crc32(SKILL);
  const centralCrc = options.centralCrc ?? actualCrc;
  const localCrc = options.localCrc ?? centralCrc;

  const local = Buffer.alloc(30 + localName.length + compressedSize);
  writeU32(local, 0, 0x04034b50);
  writeU16(local, 4, 20);
  writeU32(local, 6, 0);
  writeU16(local, 8, method);
  writeU16(local, 10, 0);
  writeU16(local, 12, 0);
  writeU32(local, 14, localCrc);
  writeU32(local, 18, compressedSize);
  writeU32(local, 22, uncompressedSize);
  writeU16(local, 26, localName.length);
  writeU16(local, 28, 0);
  localName.copy(local, 30);
  content.copy(local, 30 + localName.length);

  const central = Buffer.alloc(46 + centralName.length);
  writeU32(central, 0, 0x02014b50);
  writeU16(central, 4, options.creatorVersion ?? 20);
  writeU16(central, 6, 20);
  writeU32(central, 8, 0);
  writeU16(central, 10, method);
  writeU16(central, 12, 0);
  writeU16(central, 14, 0);
  writeU32(central, 16, centralCrc);
  writeU32(central, 20, compressedSize);
  writeU32(central, 24, uncompressedSize);
  writeU16(central, 28, centralName.length);
  writeU16(central, 30, 0);
  writeU16(central, 32, 0);
  writeU16(central, 34, 0);
  writeU16(central, 36, 0);
  writeU32(central, 38, options.externalAttributes ?? 0);
  writeU32(central, 42, 0);
  centralName.copy(central, 46);

  const end = Buffer.alloc(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 4, 0);
  writeU16(end, 6, 0);
  writeU16(end, 8, 1);
  writeU16(end, 10, 1);
  writeU32(end, 12, central.length);
  writeU32(end, 16, local.length);
  writeU16(end, 20, 0);
  return Uint8Array.from(Buffer.concat([local, central, end]));
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  Buffer.from(`${text}\0`, 'ascii').copy(header, offset);
}

function tarHeaderChecksum(header: Buffer): number {
  let result = 0;
  for (let index = 0; index < header.length; index += 1) {
    result += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return result;
}

function singleFileTar(options: { endMarker?: boolean; corruptChecksum?: boolean } = {}): Uint8Array {
  const header = Buffer.alloc(512);
  Buffer.from('SKILL.md', 'utf8').copy(header, 0);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, SKILL.length);
  writeTarOctal(header, 136, 12, 0);
  header[156] = 0;
  Buffer.from('ustar\0', 'ascii').copy(header, 257);
  Buffer.from('00', 'ascii').copy(header, 263);
  header.fill(0x20, 148, 156);
  const checksum = tarHeaderChecksum(header);
  Buffer.from(`${checksum.toString(8).padStart(6, '0')} \0`, 'ascii').copy(header, 148);
  if (options.corruptChecksum) header[100] ^= 1;

  const data = Buffer.alloc(Math.ceil(SKILL.length / 512) * 512);
  SKILL.copy(data);
  const end = options.endMarker === false ? Buffer.alloc(0) : Buffer.alloc(1_024);
  return Uint8Array.from(Buffer.concat([header, data, end]));
}

function archiveInput(
  archive: Uint8Array,
  archivePath: string,
  contentType: string,
  limits?: AcquireSkillInput['limits'],
): AcquireSkillInput {
  const expectedDigest = digest(archive);
  const artifactPath = new URL(archivePath, `${BASE}${INDEX_PATH}`).pathname;
  const fetchImpl: NonNullable<AcquireSkillInput['fetchImpl']> = async (input) => {
    const path = new URL(input.toString()).pathname;
    if (path === DETAIL_PATH) {
      return new Response(JSON.stringify({
        id: 'example.test/demo',
        source: 'example.test',
        slug: 'demo',
        name: 'demo',
        sourceType: 'well-known',
        installUrl: `${BASE}/published/.well-known/agent-skills/demo`,
        hash: null,
        files: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === INDEX_PATH) {
      return new Response(JSON.stringify({
        $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
        skills: [{
          name: 'demo',
          type: 'archive',
          description: 'Archive fixture',
          url: archivePath,
          digest: expectedDigest,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === artifactPath) {
      return new Response(Buffer.from(archive) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': contentType },
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };

  return {
    upstream: {
      id: 'skills-sh-archive-fixture',
      organizationId: 'org-1',
      name: 'skills.sh archive fixture',
      kind: 'skills-sh',
      enabled: true,
      repositories: ['example.test'],
      baseUrl: `${BASE}/catalog`,
      namespace: '@team',
    },
    importRequest: {
      upstreamId: 'skills-sh-archive-fixture',
      path: 'example.test/demo',
      name: '@team/demo',
      version: '1.0.0',
    },
    fetchImpl,
    allowLoopbackForTests: true,
    ...(limits === undefined ? {} : { limits }),
  };
}

async function expectArchiveError(input: AcquireSkillInput, code: string): Promise<void> {
  await expect(acquireSkillsShSkill(input)).rejects.toMatchObject({ code });
}

describe('skills.sh well-known archive regressions', () => {
  it('caps gzip output before tar parsing', async () => {
    const compressedBomb = gzipSync(Buffer.alloc(128 * 1024));
    const input = archiveInput(
      compressedBomb,
      '/published/demo.tar.gz',
      'application/gzip',
      { maxFiles: 1, maxExpandedBytes: 64 * 1024 },
    );
    await expectArchiveError(input, 'invalid_archive');
  });

  it('caps ZIP deflate output before retaining an oversized member', async () => {
    const compressed = deflateRawSync(Buffer.alloc(64 * 1024, 0x41));
    const archive = singleEntryZip({
      method: 8,
      compressed,
      uncompressedSize: 1,
      centralCrc: 0,
      localCrc: 0,
    });
    await expectArchiveError(archiveInput(archive, '/published/demo.zip', 'application/zip'), 'invalid_archive');
  });

  it('rejects ZIP Unix symlink metadata', async () => {
    const archive = singleEntryZip({
      creatorVersion: 0x0314,
      externalAttributes: 0xa1ff0000,
    });
    await expectArchiveError(archiveInput(archive, '/published/demo.zip', 'application/zip'), 'unsupported_archive');
  });

  it('rejects ZIP entries whose CRC does not match their content', async () => {
    const archive = singleEntryZip({ centralCrc: 0, localCrc: 0 });
    await expectArchiveError(archiveInput(archive, '/published/demo.zip', 'application/zip'), 'digest_mismatch');
  });

  it('rejects ZIP local and central filename mismatches through generic dispatch', async () => {
    const archive = singleEntryZip({ localName: 'other.md' });
    const input = archiveInput(archive, '/published/demo.zip', 'application/zip');
    await expect(acquireSkill(input)).rejects.toMatchObject({ code: 'invalid_archive' });
  });

  it('rejects a tar stream truncated after its final file', async () => {
    const archive = gzipSync(singleFileTar({ endMarker: false }));
    await expectArchiveError(archiveInput(archive, '/published/demo.tar.gz', 'application/gzip'), 'invalid_archive');
  });

  it('rejects tar headers with an invalid checksum', async () => {
    const archive = gzipSync(singleFileTar({ corruptChecksum: true }));
    await expectArchiveError(archiveInput(archive, '/published/demo.tar.gz', 'application/gzip'), 'digest_mismatch');
  });
});
