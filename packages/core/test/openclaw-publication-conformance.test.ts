import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  createEmptyRegistryState,
  createRegistryHandler,
  type RegistryOpenClawCandidate,
  type RegistryHandler,
} from '../src/index.js';
import {
  MemoryOpenClawPublicationStore,
  OpenClawPublicationManager,
  previewOpenClawFeed,
} from '../../openclaw-adapter/src/index.ts';
import {
  OpenClawFeedCache,
  parseOpenClawFeed,
  serializeOpenClawFeed,
  sha256,
  type OpenClawFeedEntry,
} from '../../openclaw/src/index.ts';
import {
  acquireOpenClawSource,
  serializeSkillBundle,
  type OpenClawFetchedSource,
} from '../../upstreams/src/index.ts';
import { digestBytes } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Digest,
  Policy,
  Principal,
  RegistryState,
  StateRepository,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const TENANT = 'org-openclaw-conformance';
const SOURCE_ORIGIN = 'https://github.com';
const FEED_URL = 'https://clawhub.example/v1/feeds/skills';
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const COMMIT = '0123456789012345678901234567890123456789';
const CONTENT_HASH = '80d711119c66b1eb2d01929130726f0b0e96cfb6f222098c399074cbd027d9ec';

const POLICY: Policy = {
  revision: 'openclaw-policy-1',
  scanners: [{
    id: 'skillsguard',
    mode: 'required',
    blockSeverities: ['high', 'critical'],
    timeoutSeconds: 5,
  }],
  allowUnscanned: false,
  evidenceMaxAgeSeconds: 3_600,
  hooks: [],
};

class MemoryRepository implements StateRepository {
  state: RegistryState = createEmptyRegistryState(POLICY);

  async read(_organizationId: string): Promise<RegistryState> {
    return structuredClone(this.state);
  }

  async transaction<T>(_organizationId: string, update: (state: RegistryState) => T): Promise<T> {
    const next = structuredClone(this.state);
    const result = update(next);
    this.state = next;
    return result;
  }
}

class MemoryBlobs implements BlobStore {
  private readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const digest = await digestBytes(bytes);
    const key = `blob-${digest.slice('sha256:'.length)}`;
    this.values.set(key, bytes.slice());
    return { key, digest, size: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    return this.values.get(key)?.slice() ?? new Uint8Array();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

interface TarEntry {
  path: string;
  bytes?: Uint8Array;
  directory?: boolean;
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii').copy(header, offset);
}

/** The pinned public GitHub archive fixture used by the OpenClaw verifier tests. */
function publicArchive(): Uint8Array {
  const skill = Buffer.from('---\nname: demo\ndescription: OpenClaw source fixture\n---\n# Demo\n', 'utf8');
  const root = `skills-${COMMIT}`;
  const entries: TarEntry[] = [
    { path: `${root}/`, directory: true },
    { path: `${root}/README.md`, bytes: Buffer.from('repository readme\n') },
    { path: `${root}/skills/`, directory: true },
    { path: `${root}/skills/demo/`, directory: true },
    { path: `${root}/skills/demo/SKILL.md`, bytes: skill },
    { path: `${root}/skills/demo/assets/`, directory: true },
    { path: `${root}/skills/demo/assets/logo.txt`, bytes: Buffer.from('logo\n') },
    { path: `${root}/skills/demo/empty/`, directory: true },
    { path: `${root}/skills/demo/.clawhub/`, directory: true },
    { path: `${root}/skills/demo/.clawhub/state.json`, bytes: Buffer.from('metadata\n') },
  ];
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
  return Uint8Array.from(gzipSync(Buffer.concat(chunks)));
}

function principal(): Principal {
  return {
    organizationId: TENANT,
    subject: 'conformance-admin',
    roles: ['owner', 'admin', 'reader'],
    namespaces: ['@team'],
    scopes: ['registry:*'],
  };
}

function request(handler: RegistryHandler, path: string, init: RequestInit = {}): Promise<Response> {
  return handler(new Request(`${ORIGIN}${path}`, init));
}

describe('composed OpenClaw publication conformance', () => {
  it('accepts a verified public archive, publishes parser-compatible bytes, and withdraws on metadata or policy changes', async () => {
    const archive = publicArchive();
    const source = {
      kind: 'public-github' as const,
      sourceRef: 'public-github' as const,
      repo: 'acme/skills',
      path: 'skills/demo',
      commit: COMMIT,
      contentHash: CONTENT_HASH,
    };
    const feedGithub = {
      repo: source.repo,
      path: source.path,
      commit: source.commit,
      contentHash: source.contentHash,
    };
    const fetched: OpenClawFetchedSource = {
      bytes: archive,
      requestedUrl: `https://codeload.github.com/acme/skills/tar.gz/${COMMIT}`,
      finalUrl: `https://codeload.github.com/acme/skills/tar.gz/${COMMIT}`,
      status: 200,
      redirected: false,
      contentType: 'application/gzip',
      sourceProviderOrigin: SOURCE_ORIGIN,
    };
    const acquisition = await acquireOpenClawSource({
      source,
      fetcher: { fetch: async () => fetched },
      allowedArtifactOrigins: ['https://codeload.github.com'],
      sourceProviderOrigin: SOURCE_ORIGIN,
    });
    expect(acquisition.bundle.files.map((file) => file.path)).toEqual(['SKILL.md', 'assets/logo.txt']);
    expect(acquisition.externalDigest).toBe(`sha256:${CONTENT_HASH}`);

    const repository = new MemoryRepository();
    const canonicalBytes = serializeSkillBundle(acquisition.bundle);
    const canonicalDigest = await digestBytes(canonicalBytes);
    const externalDigest = `sha256:${CONTENT_HASH}` as Digest;
    const entry: OpenClawFeedEntry = {
      type: 'skill',
      id: 'acme/skills/demo',
      title: 'Demo',
      version: COMMIT,
      state: 'available',
      publisher: { id: 'acme', trust: 'official' },
      install: {
        candidates: [{
          sourceRef: 'public-github',
          package: 'acme/skills/demo',
          version: COMMIT,
          integrity: externalDigest,
          github: feedGithub,
        }],
      },
    };
    const skillId = 'skill-openclaw-conformance';
    const skill = {
      id: skillId,
      organizationId: TENANT,
      name: '@team/demo',
      skillName: 'demo',
      version: COMMIT,
      description: 'Verified archive fixture',
      artifact: { key: 'archive-fixture', digest: canonicalDigest, size: canonicalBytes.byteLength },
      state: 'approved' as const,
      policyRevision: POLICY.revision,
      createdAt: '2029-12-31T23:00:00.000Z',
      approvedAt: '2029-12-31T23:00:00.000Z',
      provenance: {
        kind: 'github' as const,
        externalId: entry.id,
        revision: COMMIT,
        externalSnapshotHash: null,
        sourceDigest: canonicalDigest,
        sourceResolutionKind: 'github' as const,
        sourceProviderOrigin: SOURCE_ORIGIN,
        externalDigest,
        repository: source.repo,
        path: source.path,
        resolvedCommit: COMMIT,
      },
      fileCount: acquisition.bundle.files.length,
      scanIds: ['scan-openclaw-conformance'],
    };
    repository.state.skills.push(skill);
    repository.state.scans.push({
      id: 'scan-openclaw-conformance',
      organizationId: TENANT,
      jobId: 'job-openclaw-conformance',
      artifactDigest: canonicalDigest,
      policyRevision: POLICY.revision,
      scannerId: 'skillsguard',
      engineVersion: 'fixture',
      rulesRevision: 'fixture',
      configurationHash: `sha256:${'1'.repeat(64)}`,
      status: 'completed',
      findings: [],
      coverage: {
        filesEnumerated: acquisition.bundle.files.length,
        filesAnalyzed: acquisition.bundle.files.length,
        filesSkipped: 0,
        filesUnsupported: 0,
        limitations: [],
        externalDestinations: [],
      },
      createdAt: '2029-12-31T23:30:00.000Z',
      durationMs: 1,
    });
    const candidate: RegistryOpenClawCandidate = {
      skillId,
      skill: {
        state: 'approved',
        version: skill.version,
        policyRevision: skill.policyRevision,
        artifact: { ...skill.artifact },
      },
      entry,
      sourceArtifact: {
        verified: true,
        digest: externalDigest,
        format: 'github-skill-folder-v1',
        identity: `${source.repo}:${source.path}@${source.commit}`,
      },
    };

    let metadataEntry = entry;
    let feedSequence = 1;
    const metadataBody = (): string => serializeOpenClawFeed({
      schemaVersion: 1,
      id: 'clawhub-official',
      generatedAt: '2029-12-31T23:59:00.000Z',
      sequence: feedSequence,
      expiresAt: '2030-01-02T00:00:00.000Z',
      entries: [metadataEntry],
    });
    const feedFetcher = async (): Promise<Response> => {
      const body = metadataBody();
      const digest = await sha256(new TextEncoder().encode(body));
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', etag: `"${digest}"` },
      });
    };
    const auth: Authenticator = { authenticate: async () => principal() };
    const preview = await previewOpenClawFeed({
      url: FEED_URL,
      expectedFeedId: 'clawhub-official',
      allowedOrigins: ['https://clawhub.example'],
      fetcher: feedFetcher,
    });
    expect(preview).toMatchObject({ kind: 'accepted' });
    const publicationManager = new OpenClawPublicationManager(new MemoryOpenClawPublicationStore());
    const handler = createRegistryHandler({
      repository,
      blobs: new MemoryBlobs(),
      auth,
      config: {
        publicOrigin: ORIGIN,
        maxBodyBytes: 2 * 1024 * 1024,
        organizationId: TENANT,
        leaseSeconds: 60,
      },
      openClaw: {
        feedId: 'private/openclaw',
        feedUrl: `${ORIGIN}/v1/feeds/skills`,
        publicationManager,
        namespace: '@team',
        sourceProviderOrigin: SOURCE_ORIGIN,
        trustedFeed: {
          url: FEED_URL,
          expectedFeedId: 'clawhub-official',
          allowedOrigins: ['https://clawhub.example'],
          fetcher: feedFetcher,
        },
        currentTrustedMetadata: async () => {
          const current = await previewOpenClawFeed({
            url: FEED_URL,
            expectedFeedId: 'clawhub-official',
            allowedOrigins: ['https://clawhub.example'],
            fetcher: feedFetcher,
          });
          return current.kind === 'accepted' || current.kind === 'not-modified'
            ? current.snapshot
            : undefined;
        },
        candidatesForTenant: async () => [candidate],
        now: () => NOW,
      },
    });

    const refresh = async (): Promise<OpenClawFeedEntry[]> => {
      const response = await request(handler, '/v1/feeds/skills/refresh', { method: 'POST' });
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      const body = JSON.parse(responseBody) as { feed: { entryCount: number } };
      const published = await request(handler, '/v1/feeds/skills');
      expect(published.status).toBe(200);
      const bytes = await published.arrayBuffer();
      const parsed = parseOpenClawFeed(new Uint8Array(bytes), {
        expectedFeedId: 'private/openclaw',
        now: NOW,
      });
      expect(body.feed.entryCount).toBe(parsed.entries.length);
      return parsed.entries;
    };

    const first = await refresh();
    expect(first).toMatchObject([{ id: entry.id, publisher: { id: 'acme', trust: 'official' } }]);

    const consumer = new OpenClawFeedCache({ now: () => NOW });
    const consumed = await consumer.refresh({
      url: `${ORIGIN}/v1/feeds/skills`,
      expectedFeedId: 'private/openclaw',
      allowedOrigins: [ORIGIN],
      fetcher: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', 'Bearer conformance');
        return handler(new Request(String(input), { ...init, headers }));
      },
    });
    expect(consumed.kind).toBe('accepted');
    expect(consumed.snapshot?.feed.entries).toHaveLength(1);
    expect(consumed.snapshot?.feed.entries[0]?.install.candidates[0]?.github).toEqual(feedGithub);

    feedSequence += 1;
    metadataEntry = {
      ...entry,
      title: 'Demo current metadata',
      publisher: { id: 'community-maintainers', trust: 'community' },
    };
    expect(await refresh()).toMatchObject([{
      id: entry.id,
      title: 'Demo current metadata',
      publisher: { id: 'community-maintainers', trust: 'community' },
    }]);

    feedSequence += 1;
    metadataEntry = { ...metadataEntry, state: 'blocked' };
    expect(await refresh()).toEqual([]);

    await repository.transaction(TENANT, (state) => {
      state.policy = { ...state.policy, revision: 'openclaw-policy-2' };
    });
    feedSequence += 1;
    metadataEntry = { ...entry };
    expect(await refresh()).toEqual([]);
  });
});
