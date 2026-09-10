import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  canReadSkillForPrincipal,
  createEmptyRegistryState,
  createOpenClawImportQueue,
  createRegistryHandler,
  isSkillCurrentlyApproved,
  type RegistryHandler,
} from '../src/index.js';
import {
  MemoryOpenClawPublicationStore,
  OpenClawPublicationManager,
  OpenClawTrustedSnapshotImportService,
  PersistentOpenClawFeedCache,
  StateRepositoryOpenClawConsumerSnapshotStore,
  StateRepositoryOpenClawSourceProofStore,
  createOpenClawCandidateProvider,
  type OpenClawMetadataSnapshot,
} from '../../openclaw-adapter/src/index.ts';
import {
  OpenClawFeedCache,
  parseOpenClawFeed,
  serializeOpenClawFeed,
  sha256,
  type OpenClawFeedEntry,
} from '../../openclaw/src/index.ts';
import type {
  Authenticator,
  BlobStore,
  Policy,
  Principal,
  RegistryState,
  StateRepository,
  StoredBlob,
} from '../../contracts/src/index.js';
import { digestBytes } from '../../storage/src/index.js';
import type { ScannerAdapter, ScanResult as AdapterScanResult } from '../../scanners/src/types.js';
import {
  createDefaultOpenClawSourceConfiguration,
  type OpenClawSourceLocation,
} from '../../upstreams/src/index.js';
import { WorkerRunner } from '../../../workers/runner/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION_ID = 'org-openclaw-worker';
const FEED_ID = 'clawhub-official';
const FEED_URL = 'https://catalog.example/v1/feeds/skills';
const CATALOG_ORIGIN = 'https://catalog.example';
const GITHUB_SOURCE_ORIGIN = 'https://github.com';
const GITHUB_ARTIFACT_ORIGIN = 'https://codeload.github.com';
const USER_TOKEN = 'user-token';
const WORKER_TOKEN = 'worker-token';
const GITHUB_COMMIT = '0123456789012345678901234567890123456789';
const GITHUB_CONTENT_HASH = '80d711119c66b1eb2d01929130726f0b0e96cfb6f222098c399074cbd027d9ec';
const FIXED_POLICY: Policy = {
  revision: 'openclaw-required-scan',
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
  return Uint8Array.from(gzipSync(Buffer.concat(chunks)));
}

function githubArchive(): Uint8Array {
  const root = `skills-${GITHUB_COMMIT}`;
  return tar([
    { path: `${root}/`, directory: true },
    { path: `${root}/README.md`, bytes: Buffer.from('repository readme\n') },
    { path: `${root}/skills/`, directory: true },
    { path: `${root}/skills/demo/`, directory: true },
    {
      path: `${root}/skills/demo/SKILL.md`,
      bytes: Buffer.from('---\nname: demo\ndescription: OpenClaw source fixture\n---\n# Demo\n', 'utf8'),
    },
    { path: `${root}/skills/demo/assets/`, directory: true },
    { path: `${root}/skills/demo/assets/logo.txt`, bytes: Buffer.from('logo\n') },
    { path: `${root}/skills/demo/empty/`, directory: true },
    { path: `${root}/skills/demo/.clawhub/`, directory: true },
    { path: `${root}/skills/demo/.clawhub/state.json`, bytes: Buffer.from('metadata\n') },
  ]);
}

class MemoryRepository implements StateRepository {
  state: RegistryState;

  constructor() {
    this.state = createEmptyRegistryState(FIXED_POLICY);
  }

  async read(): Promise<RegistryState> {
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
    const value = this.values.get(key);
    if (!value) throw new Error('blob missing');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function userPrincipal(scopes: string[] = ['registry:*']): Principal {
  return {
    organizationId: ORGANIZATION_ID,
    subject: 'openclaw-user',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: ['@acme'],
    scopes,
  };
}

function workerPrincipal(): Principal {
  return {
    organizationId: ORGANIZATION_ID,
    subject: 'openclaw-worker',
    roles: ['worker'],
    scopes: ['jobs:claim', 'jobs:complete'],
    identity: 'worker',
  } as Principal & { identity: 'worker' };
}

function makeScanner(): ScannerAdapter {
  return {
    id: 'skillsguard',
    command: 'fixture-scanner',
    metadata: {
      id: 'skillsguard',
      version: 'fixture',
      engineVersion: 'fixture',
      rulesRevision: 'fixture',
    },
    scan: async (input) => {
      const result: AdapterScanResult = {
        schemaVersion: 1,
        organizationId: input.organizationId,
        jobId: input.jobId,
        invocationId: `invocation-${input.jobId}`,
        artifactDigest: input.artifactDigest,
        policyRevision: input.policyRevision,
        adapter: {
          id: 'skillsguard',
          version: 'fixture',
          engineVersion: 'fixture',
          rulesRevision: 'fixture',
          configurationHash: `sha256:${'1'.repeat(64)}`,
        },
        status: 'completed',
        durationMs: 1,
        coverage: {
          filesEnumerated: 1,
          filesAnalyzed: 1,
          filesSkipped: 0,
          filesUnsupported: 0,
          limitations: ['deterministic local test scanner'],
          externalDestinations: [],
        },
        findings: [],
      };
      return { result };
    },
  };
}

function metadataFromRefresh(result: {
  kind: string;
  snapshot?: {
    feed: {
      schemaVersion: 1;
      id: string;
      generatedAt: string;
      sequence: number;
      expiresAt: string;
      description?: string;
      entries: readonly OpenClawFeedEntry[];
    };
    sha256: `sha256:${string}`;
    etag: string;
    lastModified?: string;
    acceptedAt: number;
    sourceUrl: string;
  };
}): { kind: string; snapshot?: OpenClawMetadataSnapshot } {
  if (!result.snapshot) return { kind: result.kind };
  return {
    kind: result.kind,
    snapshot: {
      feed: result.snapshot.feed,
      sha256: result.snapshot.sha256,
      etag: result.snapshot.etag,
      ...(result.snapshot.lastModified === undefined ? {} : { lastModified: result.snapshot.lastModified }),
      acceptedAt: result.snapshot.acceptedAt,
      sourceUrl: result.snapshot.sourceUrl,
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

function requestHandler(
  handler: RegistryHandler,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  return handler(new Request(`${ORIGIN}${input}`, init));
}

describe('OpenClaw trusted-feed worker composition', () => {
  it('refreshes metadata, queues once, scans, records proof, publishes, and serves a warm cached selection', async () => {
    const repository = new MemoryRepository();
    const blobs = new MemoryBlobs();
    let currentPrincipal = userPrincipal();
    const auth: Authenticator = {
      authenticate: async (request) => {
        const authorization = request.headers.get('authorization');
        if (authorization === `Bearer ${USER_TOKEN}`) return currentPrincipal;
        if (authorization === `Bearer ${WORKER_TOKEN}`) return workerPrincipal();
        return null;
      },
    };

    const archiveBytes = githubArchive();
    const sourceDigest = `sha256:${GITHUB_CONTENT_HASH}` as `sha256:${string}`;
    const entry: OpenClawFeedEntry = {
      type: 'skill',
      id: 'acme/skills/demo',
      title: 'Demo',
      // GitHub-backed entries use the immutable commit as their public
      // version. The private release version is derived by the server-owned
      // queue and is never supplied by this test or a caller.
      version: GITHUB_COMMIT,
      state: 'available',
      publisher: { id: 'acme', trust: 'official' },
      install: {
        candidates: [{
          sourceRef: 'public-github',
          package: 'acme/skills/demo',
          version: GITHUB_COMMIT,
          integrity: sourceDigest,
          github: {
            repo: 'acme/skills',
            path: 'skills/demo',
            commit: GITHUB_COMMIT,
            contentHash: GITHUB_CONTENT_HASH,
          },
        }],
      },
    };
    const now = Date.now();
    let feedEntry: OpenClawFeedEntry = entry;
    let feedSequence = 1;
    let feedBody = serializeOpenClawFeed({
      schemaVersion: 1,
      id: FEED_ID,
      generatedAt: new Date(now - 1_000).toISOString(),
      sequence: feedSequence,
      expiresAt: new Date(now + 60 * 60 * 1_000).toISOString(),
      entries: [feedEntry],
    });
    const feedBytes = new TextEncoder().encode(feedBody);
    let feedDigest = await sha256(feedBytes);
    const replaceFeedEntry = async (next: OpenClawFeedEntry): Promise<void> => {
      feedEntry = next;
      feedSequence += 1;
      feedBody = serializeOpenClawFeed({
        schemaVersion: 1,
        id: FEED_ID,
        generatedAt: new Date(now - 1_000).toISOString(),
        sequence: feedSequence,
        expiresAt: new Date(now + 60 * 60 * 1_000).toISOString(),
        entries: [feedEntry],
      });
      feedDigest = await sha256(new TextEncoder().encode(feedBody));
    };
    let feedFetches = 0;
    const feedFetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      feedFetches += 1;
      const requestHeaders = new Headers(init?.headers);
      if (requestHeaders.get('if-none-match') === `"${feedDigest}"`) {
        return new Response(null, { status: 304, headers: { etag: `"${feedDigest}"` } });
      }
      return new Response(feedBody, {
        status: 200,
        headers: { 'content-type': 'application/json', etag: `"${feedDigest}"` },
      });
    };

    const consumerStore = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
    const consumerCache = new PersistentOpenClawFeedCache({
      store: consumerStore,
      tenantId: ORGANIZATION_ID,
    });
    const queue = createOpenClawImportQueue({
      repository,
      organizationId: ORGANIZATION_ID,
      namespace: '@acme',
      sourceProviderOrigin: GITHUB_SOURCE_ORIGIN,
    });
    const consumerService = new OpenClawTrustedSnapshotImportService({
      store: consumerStore,
      queue,
      authorize: ({ principal }) => principal.organizationId === ORGANIZATION_ID && principal.namespaces?.includes('@acme') === true,
    });
    const proofStore = new StateRepositoryOpenClawSourceProofStore(repository, {
      isCurrentPolicyApproved: isSkillCurrentlyApproved,
    });
    const publicationManager = new OpenClawPublicationManager(new MemoryOpenClawPublicationStore());
    const handler = createRegistryHandler({
      repository,
      blobs,
      auth,
      config: {
        publicOrigin: ORIGIN,
        maxBodyBytes: 2 * 1024 * 1024,
        organizationId: ORGANIZATION_ID,
        leaseSeconds: 60,
      },
      openClaw: {
        feedId: 'private/openclaw',
        feedUrl: `${ORIGIN}/v1/feeds/skills`,
        publicationManager,
        namespace: '@acme',
        sourceProviderOrigin: GITHUB_SOURCE_ORIGIN,
        trustedFeed: {
          url: FEED_URL,
          expectedFeedId: FEED_ID,
          allowedOrigins: [CATALOG_ORIGIN],
          fetcher: feedFetcher,
        },
        candidatesForTenant: createOpenClawCandidateProvider({
          proofs: proofStore,
          canReadSkill: canReadSkillForPrincipal,
          isCurrentPolicyApproved: isSkillCurrentlyApproved,
        }),
        recordSourceProof: proofStore.recordFromCompletion.bind(proofStore),
        consumer: {
          refresh: async (signal) => {
            const result = await consumerCache.refresh({
              url: FEED_URL,
              expectedFeedId: FEED_ID,
              allowedOrigins: [CATALOG_ORIGIN],
              fetcher: feedFetcher,
              signal,
            });
            return metadataFromRefresh(result);
          },
          selectAndQueue: consumerService.selectAndQueue.bind(consumerService),
        },
        currentTrustedMetadata: async () => {
          const snapshot = await consumerStore.read({
            tenantId: ORGANIZATION_ID,
            feedId: FEED_ID,
            sourceUrl: FEED_URL,
          });
          return snapshot === undefined ? undefined : metadataFromRefresh({ kind: 'not-modified', snapshot }).snapshot;
        },
      },
    });

    const catalog = await requestHandler(handler, '/v1/feeds/skills/catalog', {
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(catalog.status).toBe(200);
    expect(await json(catalog)).toMatchObject({ feed: { id: FEED_ID, entries: [{ id: 'acme/skills/demo' }] } });

    const queued = await requestHandler(handler, '/v1/feeds/skills/import', {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: 'acme/skills/demo' }),
    });
    expect(queued.status).toBe(202);
    const queuedBody = await json(queued);
    expect(queuedBody.operation.state).toBe('queued');
    const queuedJobId = queuedBody.operation.operationId as string;
    expect(repository.state.jobs).toHaveLength(1);
    expect(repository.state.jobs[0]).toMatchObject({
      id: queuedJobId,
      kind: 'import',
      import: { externalId: 'acme/skills/demo', name: expect.stringMatching(/^@acme\/openclaw-/u) },
      openclawSource: { source: { kind: 'public-github', repo: 'acme/skills', path: 'skills/demo', commit: GITHUB_COMMIT }, feed: { id: FEED_ID, sequence: 1 } },
    });

    let artifactFetches = 0;
    const defaultSourceConfiguration = createDefaultOpenClawSourceConfiguration();
    const openClawSourceFetcher = {
      fetch: async (source: Parameters<typeof defaultSourceConfiguration.locator.locate>[0]) => {
        artifactFetches += 1;
        const location: OpenClawSourceLocation = await defaultSourceConfiguration.locator.locate(source);
        // The production default derives this immutable codeload URL from
        // the verified repository/path/commit identity. No per-skill URL map,
        // feed URL, or credential is supplied by the test or the claimed job.
        expect(location).toEqual({
          url: `https://codeload.github.com/acme/skills/tar.gz/${GITHUB_COMMIT}`,
          allowedArtifactOrigins: [GITHUB_ARTIFACT_ORIGIN],
          sourceProviderOrigin: GITHUB_SOURCE_ORIGIN,
        });
        return {
          bytes: archiveBytes,
          requestedUrl: location.url,
          finalUrl: location.url,
          status: 200,
          redirected: false,
          contentType: 'application/gzip',
          sourceProviderOrigin: location.sourceProviderOrigin,
        };
      },
    };
    const worker = new WorkerRunner({
      baseUrl: ORIGIN,
      workerToken: WORKER_TOKEN,
      workerId: 'openclaw-worker-1',
      fetch: async (input, init) => handler(new Request(String(input), init)),
      adapters: [makeScanner()],
      executor: { run: async () => { throw new Error('the injected scanner must bypass command execution'); } },
      acquisition: {
        openClaw: {
          allowedArtifactOrigins: [GITHUB_ARTIFACT_ORIGIN],
          sourceProviderOrigin: GITHUB_SOURCE_ORIGIN,
          fetcher: openClawSourceFetcher,
        },
      },
      openClawProofRecorder: {
        recordFromCompletion: proofStore.recordFromCompletion.bind(proofStore),
      },
    });

    const run = await worker.runOnce();
    expect(run.error).toBeUndefined();
    expect(run.allow).toBe(true);
    expect(run.scannerResults).toEqual([expect.objectContaining({ scannerId: 'skillsguard', status: 'completed' })]);
    expect(artifactFetches).toBe(1);
    const completedState = await repository.read();
    const completedJob = completedState.jobs.find((job) => job.id === queuedJobId);
    expect(completedJob).toMatchObject({ state: 'completed', resourceId: expect.any(String) });
    const importedSkill = completedJob?.resourceId === undefined
      ? undefined
      : completedState.skills.find((skill) => skill.id === completedJob.resourceId);
    expect(importedSkill).toMatchObject({
      state: 'approved',
      version: `0.0.0+openclaw.${GITHUB_COMMIT.slice(0, 32)}`,
      provenance: {
        externalId: 'acme/skills/demo',
        sourceResolutionKind: 'github',
        repository: 'acme/skills',
        path: 'skills/demo',
        resolvedCommit: GITHUB_COMMIT,
        sourceProviderOrigin: GITHUB_SOURCE_ORIGIN,
        externalDigest: sourceDigest,
      },
    });
    expect(completedState.scans).toEqual([expect.objectContaining({ scannerId: 'skillsguard', status: 'completed', policyRevision: FIXED_POLICY.revision })]);
    expect(await proofStore.list(ORGANIZATION_ID)).toHaveLength(1);

    currentPrincipal = userPrincipal();
    const published = await requestHandler(handler, '/v1/feeds/skills/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(published.status).toBe(200);
    expect(await json(published)).toMatchObject({ feed: { id: 'private/openclaw', entryCount: 1 } });

    const privateFeed = await requestHandler(handler, '/v1/feeds/skills', {
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(privateFeed.status).toBe(200);
    const privateFeedForConsumer = privateFeed.clone();
    expect(await json(privateFeed)).toMatchObject({ id: 'private/openclaw', entries: [{ id: 'acme/skills/demo' }] });
    const parsedPrivateFeed = parseOpenClawFeed(await privateFeedForConsumer.text(), {
      expectedFeedId: 'private/openclaw',
      checkExpiry: true,
    });
    expect(parsedPrivateFeed.entries).toMatchObject([{ id: 'acme/skills/demo', version: GITHUB_COMMIT }]);
    expect(parsedPrivateFeed.entries[0]?.install.candidates[0]?.github).toEqual({
      repo: 'acme/skills',
      path: 'skills/demo',
      commit: GITHUB_COMMIT,
      contentHash: GITHUB_CONTENT_HASH,
    });

    // Exercise the pinned consumer parser/cache against the actual published
    // route, including its conditional 304 path. The cache is a reader-side
    // metadata/bundle cache; it performs no source or artifact fetch.
    const privateFeedCache = new OpenClawFeedCache();
    const privateFeedFetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${USER_TOKEN}`);
      return handler(new Request(String(input), { ...init, headers }));
    };
    const cachedPrivateFeed = await privateFeedCache.refresh({
      url: `${ORIGIN}/v1/feeds/skills`,
      expectedFeedId: 'private/openclaw',
      allowedOrigins: [ORIGIN],
      fetcher: privateFeedFetcher,
    });
    expect(cachedPrivateFeed.kind).toBe('accepted');
    expect(cachedPrivateFeed.snapshot?.feed.entries).toHaveLength(1);
    const cachedPrivateFeedAgain = await privateFeedCache.refresh({
      url: `${ORIGIN}/v1/feeds/skills`,
      expectedFeedId: 'private/openclaw',
      allowedOrigins: [ORIGIN],
      fetcher: privateFeedFetcher,
    });
    expect(cachedPrivateFeedAgain.kind).toBe('not-modified');
    expect(cachedPrivateFeedAgain.snapshot?.sha256).toBe(cachedPrivateFeed.snapshot?.sha256);

    const jobsAfterApproval = repository.state.jobs.length;
    const warm = await requestHandler(handler, '/v1/feeds/skills/import', {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: 'acme/skills/demo' }),
    });
    expect(warm.status).toBe(202);
    expect(await json(warm)).toMatchObject({ operation: { operationId: queuedJobId, state: 'running' } });
    expect(repository.state.jobs).toHaveLength(jobsAfterApproval);
    expect(feedFetches).toBeGreaterThanOrEqual(2);
    expect(artifactFetches).toBe(1);

    await replaceFeedEntry({
      ...entry,
      title: 'Demo refreshed',
      publisher: { id: 'acme-maintainers', trust: 'community' },
    });
    const metadataRefresh = await requestHandler(handler, '/v1/feeds/skills/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(metadataRefresh.status).toBe(200);
    expect(await json(metadataRefresh)).toMatchObject({ feed: { id: 'private/openclaw', entryCount: 1 } });
    const refreshedPrivateFeed = await requestHandler(handler, '/v1/feeds/skills', {
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(await json(refreshedPrivateFeed)).toMatchObject({
      entries: [{ id: 'acme/skills/demo', title: 'Demo refreshed', publisher: { id: 'acme-maintainers', trust: 'community' } }],
    });

    await replaceFeedEntry({ ...entry, state: 'blocked' });
    const withdrawn = await requestHandler(handler, '/v1/feeds/skills/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(withdrawn.status).toBe(200);
    expect(await json(withdrawn)).toMatchObject({ feed: { id: 'private/openclaw', entryCount: 0 } });

    // A policy revision invalidates the old scanner evidence even when the
    // trusted catalog row returns to `available`; metadata cannot restore a
    // release without a fresh scan under the current policy.
    await repository.transaction(ORGANIZATION_ID, (state) => {
      state.policy = { ...state.policy, revision: 'openclaw-required-scan-v2' };
    });
    await replaceFeedEntry({ ...entry, state: 'available' });
    const policyWithdrawn = await requestHandler(handler, '/v1/feeds/skills/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(policyWithdrawn.status).toBe(200);
    expect(await json(policyWithdrawn)).toMatchObject({ feed: { id: 'private/openclaw', entryCount: 0 } });
  });
});
