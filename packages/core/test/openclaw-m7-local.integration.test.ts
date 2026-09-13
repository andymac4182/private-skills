import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

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
  serializeOpenClawFeed,
  sha256,
  type OpenClawFeedEntry,
} from '../../openclaw/src/index.ts';
import { TokenAuthenticator, type BootstrapTokenConfig } from '../../auth/src/index.js';
import { createMemoryStateRepository } from '../../database/src/index.js';
import { DockerExecutor, SKILLSGUARD_PIN, createSkillsGuardAdapter } from '../../scanners/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Policy,
  RegistryState,
  SkillBundle,
  StoredBlob,
} from '../../contracts/src/index.js';
import { digestBytes } from '../../storage/src/index.js';
import { createNodeFilesSdkBlobStore } from '../../storage/src/node.js';
import type { ScannerAdapter, ScanResult as AdapterScanResult } from '../../scanners/src/types.js';
import {
  createDefaultOpenClawSourceConfiguration,
  type OpenClawSourceLocation,
} from '../../upstreams/src/index.js';
import { WorkerRunner } from '../../../workers/runner/src/index.js';

/**
 * This local-only test consumes the previously verified public NVIDIA archive
 * when PRIVATE_SKILLS_M7_NVIDIA_ARCHIVE explicitly points to the operator's
 * cached copy; the archive is never checked into this repository. CI or
 * another checkout without that opt-in records the boundary as skipped; the
 * ordinary synthetic source and worker tests remain portable there. Set
 * PRIVATE_SKILLS_M7_SCANNER=docker-skillsguard to run the same flow through
 * the pinned container; provider findings fail the test and never fall back
 * to the deterministic fixture.
 */
const NVIDIA_ARCHIVE_PATH = process.env.PRIVATE_SKILLS_M7_NVIDIA_ARCHIVE;
const HAS_CACHED_NVIDIA_ARCHIVE = NVIDIA_ARCHIVE_PATH !== undefined && existsSync(NVIDIA_ARCHIVE_PATH);
const SCANNER_MODE = process.env.PRIVATE_SKILLS_M7_SCANNER;
if (SCANNER_MODE !== undefined && SCANNER_MODE !== 'deterministic' && SCANNER_MODE !== 'docker-skillsguard') {
  throw new Error('PRIVATE_SKILLS_M7_SCANNER must be deterministic or docker-skillsguard');
}
const RUN_REAL_SKILLSGUARD = SCANNER_MODE === 'docker-skillsguard';
const SKILLSGUARD_IMAGE = 'private-skills/skillsguard:1.1.1';
const SKILLSGUARD_IMAGE_ID = 'sha256:4173ec0a31e37a572b94f88cb596e8b76aa9309beef06c16bb2e4ba2f6463aa0';
const EXPECTED_ARCHIVE_FILE_COUNT = 7;
const execFileAsync = promisify(execFile);

const ORIGIN = 'https://m7-registry.test';
const ORGANIZATION_ID = 'org-m7-local';
const USER_TOKEN = 'm7-local-user-token';
const WORKER_TOKEN = 'm7-local-worker-token';
const FEED_ID = 'clawhub-official';
const FEED_URL = 'https://catalog.example/v1/feeds/skills';
const CATALOG_ORIGIN = 'https://catalog.example';
const SOURCE_ORIGIN = 'https://github.com';
const ARTIFACT_ORIGIN = 'https://codeload.github.com';
const EXTERNAL_ID = '@nvidia/doca-version';
const GITHUB_REPOSITORY = 'NVIDIA/skills';
const GITHUB_PATH = 'skills/doca-version';
const GITHUB_COMMIT = '27fa3e16d95f32b55843da712f163754395bd05f';
const GITHUB_CONTENT_HASH = '4887325e8386bc9a713e38c4dbf05081abdaeb7a6ec1649bb692ce48d015df34';
const EXTERNAL_DIGEST = `sha256:${GITHUB_CONTENT_HASH}` as `sha256:${string}`;
const ARCHIVE_DIGEST = 'sha256:6cca84521b3bd68f6aa1ecc6244b03a6cea03fc3703c5f20ac74edebf94fa807';

const POLICY: Policy = {
  revision: 'm7-required-skillsguard',
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

class BlobReadback implements BlobStore {
  constructor(private readonly inner: BlobStore) {}

  readonly reads: string[] = [];

  put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.inner.put(bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    this.reads.push(key);
    return this.inner.get(key);
  }

  remove(key: string): Promise<void> {
    return this.inner.remove(key);
  }
}

function localScanner(): ScannerAdapter {
  return {
    id: 'skillsguard',
    command: 'm7-deterministic-scanner-fixture',
    metadata: {
      id: 'skillsguard',
      version: 'm7-fixture-1',
      engineVersion: 'm7-fixture-1',
      rulesRevision: 'm7-fixture-rules-1',
    },
    scan: async (input) => {
      const entries = await readdir(input.inputDir, { recursive: true, withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile()).length;
      const result: AdapterScanResult = {
        schemaVersion: 1,
        organizationId: input.organizationId,
        jobId: input.jobId,
        invocationId: `m7-fixture-${input.jobId}`,
        artifactDigest: input.artifactDigest,
        policyRevision: input.policyRevision,
        adapter: {
          id: 'skillsguard',
          version: 'm7-fixture-1',
          engineVersion: 'm7-fixture-1',
          rulesRevision: 'm7-fixture-rules-1',
          configurationHash: `sha256:${'7'.repeat(64)}`,
        },
        status: 'completed',
        durationMs: 1,
        coverage: {
          filesEnumerated: files,
          filesAnalyzed: files,
          filesSkipped: 0,
          filesUnsupported: 0,
          limitations: ['deterministic local scanner fixture; no provider analysis'],
          externalDestinations: [],
        },
        findings: [],
      };
      return { result };
    },
  };
}

async function assertPinnedSkillsGuardImage(): Promise<void> {
  const { stdout } = await execFileAsync('docker', [
    'image',
    'inspect',
    SKILLSGUARD_IMAGE,
    '--format',
    '{{.Id}}',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 });
  expect(stdout.trim()).toBe(SKILLSGUARD_IMAGE_ID);
}

function metadataFromRefresh(result: {
  kind: string;
  snapshot?: {
    feed: OpenClawMetadataSnapshot['feed'];
    sha256: OpenClawMetadataSnapshot['sha256'];
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

async function json<T = any>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function request(
  handler: RegistryHandler,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return handler(new Request(`${ORIGIN}${path}`, init));
}

function jsonHeaders(token: string): Headers {
  return new Headers({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });
}

describe('OpenClaw M7 local source/worker/producer/consumer composition', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  const archiveTest = RUN_REAL_SKILLSGUARD ? it : it.skipIf(!HAS_CACHED_NVIDIA_ARCHIVE);
  const archiveTestTitle = RUN_REAL_SKILLSGUARD
    ? 'runs pinned SkillsGuard against the real PAX archive and rejects flagged distribution'
    : 'acquires the real PAX GitHub archive, scans and seals it, then serves a private feed to the reference consumer';

  archiveTest(archiveTestTitle, async () => {
    if (!HAS_CACHED_NVIDIA_ARCHIVE || NVIDIA_ARCHIVE_PATH === undefined) {
      throw new Error('PRIVATE_SKILLS_M7_NVIDIA_ARCHIVE must point to the cached NVIDIA archive for this run');
    }
    const archiveBytes = new Uint8Array(await readFile(NVIDIA_ARCHIVE_PATH));
    expect(await sha256(archiveBytes)).toBe(ARCHIVE_DIGEST);
    root = await mkdtemp(join(tmpdir(), 'private-skills-m7-files-'));

    const repository = createMemoryStateRepository({
      stateFactory: (): RegistryState => createEmptyRegistryState(POLICY),
    });
    const rawBlobs = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root,
      prefix: 'm7-private-registry',
    });
    const blobs = new BlobReadback(rawBlobs);
    const userConfig: BootstrapTokenConfig = {
      id: 'm7-user',
      token: USER_TOKEN,
      organizationId: ORGANIZATION_ID,
      subject: 'm7-user',
      roles: ['owner', 'admin', 'publisher', 'reader'],
      namespaces: ['@acme'],
      scopes: ['registry:*'],
    };
    const workerConfig: BootstrapTokenConfig = {
      id: 'm7-worker',
      token: WORKER_TOKEN,
      organizationId: ORGANIZATION_ID,
      subject: 'm7-worker',
      roles: ['worker'],
      kind: 'worker',
      worker: true,
      scopes: ['jobs:*'],
    };
    const tokenAuth = new TokenAuthenticator({
      environment: 'test',
      tokens: [userConfig],
      workerTokens: [workerConfig],
      sessionSecret: 'm7-local-session-secret-that-is-long-enough',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    });
    await tokenAuth.ready();
    const auth: Authenticator = tokenAuth;

    const entry: OpenClawFeedEntry = {
      type: 'skill',
      id: EXTERNAL_ID,
      title: 'DOCA version',
      description: 'Pinned NVIDIA source fixture',
      version: GITHUB_COMMIT,
      state: 'available',
      publisher: { id: 'nvidia', trust: 'official' },
      install: {
        candidates: [{
          sourceRef: 'public-github',
          package: EXTERNAL_ID,
          version: GITHUB_COMMIT,
          integrity: EXTERNAL_DIGEST,
          github: {
            repo: GITHUB_REPOSITORY,
            path: GITHUB_PATH,
            commit: GITHUB_COMMIT,
            contentHash: GITHUB_CONTENT_HASH,
          },
        }],
      },
    };
    const generatedAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const feedBody = serializeOpenClawFeed({
      schemaVersion: 1,
      id: FEED_ID,
      generatedAt,
      sequence: 1,
      expiresAt,
      entries: [entry],
    });
    const feedDigest = await sha256(new TextEncoder().encode(feedBody));
    let feedRequests = 0;
    const feedFetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe(FEED_URL);
      feedRequests += 1;
      const headers = new Headers(init?.headers);
      if (headers.get('if-none-match') === `"${feedDigest}"`) {
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
      sourceProviderOrigin: SOURCE_ORIGIN,
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
    const refreshSnapshot = async (signal: AbortSignal): Promise<{ kind: string; snapshot?: OpenClawMetadataSnapshot }> => {
      const refreshed = await consumerCache.refresh({
        url: FEED_URL,
        expectedFeedId: FEED_ID,
        allowedOrigins: [CATALOG_ORIGIN],
        fetcher: feedFetcher,
        signal,
      });
      return metadataFromRefresh(refreshed);
    };
    const handler = createRegistryHandler({
      repository,
      blobs,
      auth,
      config: {
        publicOrigin: ORIGIN,
        maxBodyBytes: 16 * 1024 * 1024,
        organizationId: ORGANIZATION_ID,
        leaseSeconds: 60,
      },
      openClaw: {
        feedId: 'private/openclaw',
        feedUrl: `${ORIGIN}/v1/feeds/skills`,
        publicationManager,
        namespace: '@acme',
        sourceProviderOrigin: SOURCE_ORIGIN,
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
          refresh: refreshSnapshot,
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

    const catalog = await request(handler, '/v1/feeds/skills/catalog', { headers: { authorization: `Bearer ${USER_TOKEN}` } });
    expect(catalog.status).toBe(200);
    await expect(json(catalog)).resolves.toMatchObject({ feed: { id: FEED_ID, entries: [{ id: EXTERNAL_ID }] } });

    const queued = await request(handler, '/v1/feeds/skills/import', {
      method: 'POST',
      headers: jsonHeaders(USER_TOKEN),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    });
    expect(queued.status).toBe(202);
    const queuedBody = await json<{ operation: { operationId: string; state: string } }>(queued);
    expect(queuedBody.operation.state).toBe('queued');
    const operationId = queuedBody.operation.operationId;
    const queuedState = await repository.read(ORGANIZATION_ID);
    const queuedJob = queuedState.jobs.find((job) => job.id === operationId);
    expect(queuedJob).toMatchObject({
      kind: 'import',
      state: 'queued',
      import: { externalId: EXTERNAL_ID },
      openclawSource: {
        source: {
          kind: 'public-github',
          repo: GITHUB_REPOSITORY,
          path: GITHUB_PATH,
          commit: GITHUB_COMMIT,
          contentHash: GITHUB_CONTENT_HASH,
        },
      },
    });

    const sourceConfiguration = createDefaultOpenClawSourceConfiguration();
    let archiveFetches = 0;
    const sourceFetcher = {
      fetch: async (source: Parameters<typeof sourceConfiguration.locator.locate>[0]) => {
        archiveFetches += 1;
        const location: OpenClawSourceLocation = await sourceConfiguration.locator.locate(source);
        expect(location).toEqual({
          url: `${ARTIFACT_ORIGIN}/${GITHUB_REPOSITORY}/tar.gz/${GITHUB_COMMIT}`,
          allowedArtifactOrigins: [ARTIFACT_ORIGIN],
          sourceProviderOrigin: SOURCE_ORIGIN,
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
    if (RUN_REAL_SKILLSGUARD) await assertPinnedSkillsGuardImage();
    const scanner = RUN_REAL_SKILLSGUARD ? createSkillsGuardAdapter() : localScanner();
    const worker = new WorkerRunner({
      baseUrl: ORIGIN,
      workerToken: WORKER_TOKEN,
      workerId: 'm7-worker',
      fetch: async (input, init) => handler(new Request(String(input), init)),
      adapters: [scanner],
      // The scanner fixture returns a bounded result directly and this
      // executor throws if any deterministic test path attempts to run
      // uploaded content. Real mode uses only the pinned Docker executor.
      executor: RUN_REAL_SKILLSGUARD
        ? new DockerExecutor()
        : { run: async () => { throw new Error('M7 fixture must not execute bundle content'); } },
      ...(RUN_REAL_SKILLSGUARD ? { scannerImages: { skillsguard: SKILLSGUARD_IMAGE_ID } } : {}),
      acquisition: {
        openClaw: {
          allowedArtifactOrigins: [ARTIFACT_ORIGIN],
          sourceProviderOrigin: SOURCE_ORIGIN,
          fetcher: sourceFetcher,
        },
      },
      openClawProofRecorder: {
        recordFromCompletion: proofStore.recordFromCompletion.bind(proofStore),
      },
    });

    const run = await worker.runOnce();
    expect(run).toMatchObject({ claimed: true, jobId: operationId });
    const scannerResult = run.scannerResults?.[0];
    expect(scannerResult).toMatchObject({
      scannerId: 'skillsguard',
      status: RUN_REAL_SKILLSGUARD ? 'degraded' : 'completed',
      policyRevision: POLICY.revision,
      rulesRevision: RUN_REAL_SKILLSGUARD ? SKILLSGUARD_PIN.sourceRevision : 'm7-fixture-rules-1',
    });
    expect(scannerResult?.coverage.filesSkipped).toBe(0);
    expect(scannerResult?.coverage.filesUnsupported).toBe(0);
    if (RUN_REAL_SKILLSGUARD) {
      // This pinned public source is intentionally a flagged negative fixture
      // for the provider-backed mode. SkillsGuard reports six analyzable text
      // files from the seven-file canonical bundle (the signature is not
      // counted by its report), so the coverage difference is retained as
      // evidence instead of being treated as a clean approval.
      expect(scannerResult?.engineVersion).toBe('1.1.1');
      expect(scannerResult?.rulesRevision).toBe(SKILLSGUARD_PIN.sourceRevision);
      expect(scannerResult?.coverage.filesEnumerated).toBe(EXPECTED_ARCHIVE_FILE_COUNT);
      expect(scannerResult?.coverage.filesAnalyzed).toBe(6);
      expect(scannerResult?.coverage.limitations).toContain(
        'scanner coverage mismatch: report enumerated 6 files but worker observed 7',
      );
      expect(scannerResult?.coverage.limitations).toContain('SkillsGuard is pattern/decode-based static analysis and does not observe runtime behavior');
      expect(scannerResult?.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical')).toBe(true);
      expect(run.allow).toBe(false);

      const deniedState = await repository.read(ORGANIZATION_ID);
      const deniedJob = deniedState.jobs.find((job) => job.id === operationId);
      expect(deniedJob).toMatchObject({
        state: 'completed',
        resourceId: expect.any(String),
        error: expect.stringContaining('Required scanner skillsguard returned degraded'),
      });
      const deniedSkill = deniedState.skills.find((value) => value.id === deniedJob?.resourceId);
      expect(deniedSkill).toMatchObject({
        state: 'scan-error',
        fileCount: EXPECTED_ARCHIVE_FILE_COUNT,
      });
      expect(deniedSkill?.state).not.toBe('approved');
      expect(deniedState.scans).toEqual([expect.objectContaining({
        scannerId: 'skillsguard',
        status: 'degraded',
        artifactDigest: deniedSkill?.artifact.digest,
        policyRevision: POLICY.revision,
      })]);
      expect(await proofStore.list(ORGANIZATION_ID)).toHaveLength(0);

      const deniedArtifact = deniedSkill === undefined ? undefined : await blobs.get(deniedSkill.artifact.key);
      expect(deniedArtifact).toBeInstanceOf(Uint8Array);
      expect(deniedArtifact && await digestBytes(deniedArtifact)).toBe(deniedSkill?.artifact.digest);
      const deniedBundle = deniedArtifact === undefined
        ? undefined
        : JSON.parse(new TextDecoder().decode(deniedArtifact)) as SkillBundle;
      expect(deniedBundle).toMatchObject({ format: 'pskills-bundle-v1' });
      expect(deniedBundle?.files).toHaveLength(EXPECTED_ARCHIVE_FILE_COUNT);

      const rejectedPublication = await request(handler, '/v1/feeds/skills/refresh', {
        method: 'POST',
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      });
      expect(rejectedPublication.status).toBe(200);
      await expect(json(rejectedPublication)).resolves.toMatchObject({ feed: { id: 'private/openclaw', entryCount: 0 } });
      const rejectedPrivateFeed = await request(handler, '/v1/feeds/skills', {
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      });
      expect(rejectedPrivateFeed.status).toBe(200);
      await expect(json(rejectedPrivateFeed)).resolves.toMatchObject({ id: 'private/openclaw', entries: [] });

      const rejectedSkillView = await request(handler, `/v1/skills/${encodeURIComponent(deniedSkill!.id)}`, {
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      });
      expect(rejectedSkillView.status).toBe(200);
      await expect(json(rejectedSkillView)).resolves.toMatchObject({ skill: { state: 'scan-error' } });
      const rejectedResolution = await request(handler, '/v1/resolve', {
        method: 'POST',
        headers: jsonHeaders(USER_TOKEN),
        body: JSON.stringify({ kind: 'skill', ref: deniedSkill!.name, version: deniedSkill!.version }),
      });
      expect(rejectedResolution.status).toBe(404);
      const blobReadsBeforeRejectedTransfer = blobs.reads.length;
      const rejectedTransfer = await request(handler, `/v1/artifacts/${encodeURIComponent(deniedSkill!.artifact.digest)}/download`, {
        method: 'POST',
        headers: jsonHeaders(USER_TOKEN),
        body: JSON.stringify({ resourceId: deniedSkill!.id, authorizationId: 'm7-no-authorization' }),
      });
      expect(rejectedTransfer.status).toBe(404);
      expect(blobs.reads.length).toBe(blobReadsBeforeRejectedTransfer);

      const stateAfterRejection = await repository.read(ORGANIZATION_ID);
      expect(stateAfterRejection.authorizations).toHaveLength(0);
      expect(stateAfterRejection.grants).toHaveLength(0);
      expect(archiveFetches).toBe(1);
      return;
    }
    expect(run.allow).toBe(true);
    expect(run.scannerResults).toEqual([expect.objectContaining({
      scannerId: 'skillsguard',
      status: 'completed',
      policyRevision: POLICY.revision,
    })]);
    expect(run.scannerResults?.[0]?.coverage.filesEnumerated).toBeGreaterThan(0);
    expect(run.scannerResults?.[0]?.coverage.filesAnalyzed).toBe(run.scannerResults?.[0]?.coverage.filesEnumerated);
    expect(run.scannerResults?.[0]?.findings).toHaveLength(0);
    expect(run.scannerResults?.[0]?.coverage.limitations).toContain('deterministic local scanner fixture; no provider analysis');
    expect(archiveFetches).toBe(1);

    const completedState = await repository.read(ORGANIZATION_ID);
    const completedJob = completedState.jobs.find((job) => job.id === operationId);
    expect(completedJob).toMatchObject({ state: 'completed', resourceId: expect.any(String) });
    const skill = completedState.skills.find((value) => value.id === completedJob?.resourceId);
    expect(skill).toMatchObject({
      state: 'approved',
      provenance: {
        externalId: EXTERNAL_ID,
        sourceResolutionKind: 'github',
        repository: GITHUB_REPOSITORY,
        path: GITHUB_PATH,
        resolvedCommit: GITHUB_COMMIT,
        sourceProviderOrigin: SOURCE_ORIGIN,
        externalDigest: EXTERNAL_DIGEST,
      },
      artifact: {
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(skill?.artifact.digest).not.toBe(EXTERNAL_DIGEST);
    expect(completedState.scans).toEqual([expect.objectContaining({
      scannerId: 'skillsguard',
      status: 'completed',
      artifactDigest: skill?.artifact.digest,
      policyRevision: POLICY.revision,
    })]);

    const proof = await proofStore.list(ORGANIZATION_ID);
    expect(proof).toHaveLength(1);
    expect(proof[0]).toMatchObject({
      entry: { id: EXTERNAL_ID, version: GITHUB_COMMIT },
      sourceArtifact: {
        verified: true,
        digest: EXTERNAL_DIGEST,
        format: 'github-skill-folder-v1',
        identity: `${GITHUB_REPOSITORY}:${GITHUB_PATH}@${GITHUB_COMMIT}`,
      },
    });

    const artifactBytes = skill === undefined ? undefined : await blobs.get(skill.artifact.key);
    expect(artifactBytes).toBeInstanceOf(Uint8Array);
    expect(artifactBytes && await digestBytes(artifactBytes)).toBe(skill?.artifact.digest);
    expect(artifactBytes?.byteLength).toBe(skill?.artifact.size);
    const canonicalBundle = artifactBytes === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(artifactBytes)) as SkillBundle;
    expect(canonicalBundle).toMatchObject({ format: 'pskills-bundle-v1' });
    expect(canonicalBundle?.files).toHaveLength(EXPECTED_ARCHIVE_FILE_COUNT);
    expect(canonicalBundle?.files.some((file) => file.path === 'SKILL.md')).toBe(true);
    expect(canonicalBundle?.files.every((file) => typeof file.content === 'string' && file.content.length > 0)).toBe(true);

    const publication = await request(handler, '/v1/feeds/skills/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(publication.status).toBe(200);
    await expect(json(publication)).resolves.toMatchObject({ feed: { id: 'private/openclaw', entryCount: 1 } });
    const privateFeed = await request(handler, '/v1/feeds/skills', {
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(privateFeed.status).toBe(200);
    await expect(json(privateFeed)).resolves.toMatchObject({ id: 'private/openclaw', entries: [{ id: EXTERNAL_ID }] });

    const referenceConsumer = new OpenClawFeedCache();
    const privateFeedFetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${USER_TOKEN}`);
      return handler(new Request(String(input), { ...init, headers }));
    };
    const consumed = await referenceConsumer.refresh({
      url: `${ORIGIN}/v1/feeds/skills`,
      expectedFeedId: 'private/openclaw',
      allowedOrigins: [ORIGIN],
      fetcher: privateFeedFetcher,
    });
    expect(consumed.kind).toBe('accepted');
    expect(consumed.snapshot?.feed.entries).toMatchObject([{
      id: EXTERNAL_ID,
      version: GITHUB_COMMIT,
      install: { candidates: [{ github: { repo: GITHUB_REPOSITORY, path: GITHUB_PATH, commit: GITHUB_COMMIT, contentHash: GITHUB_CONTENT_HASH } }] },
    }]);
    const consumedAgain = await referenceConsumer.refresh({
      url: `${ORIGIN}/v1/feeds/skills`,
      expectedFeedId: 'private/openclaw',
      allowedOrigins: [ORIGIN],
      fetcher: privateFeedFetcher,
    });
    expect(consumedAgain.kind).toBe('not-modified');

    const resolved = await request(handler, '/v1/resolve', {
      method: 'POST',
      headers: jsonHeaders(USER_TOKEN),
      body: JSON.stringify({ kind: 'skill', ref: skill?.name, version: skill?.version }),
    });
    expect(resolved.status).toBe(200);
    const resolution = await json<{ resolution: { digest: string; members: unknown[] } }>(resolved);
    expect(resolution.resolution.digest).toBe(skill?.artifact.digest);
    expect(resolution.resolution.members).toHaveLength(1);
    const installAuthorization = await request(handler, '/v1/install-authorizations', {
      method: 'POST',
      headers: jsonHeaders(USER_TOKEN),
      body: JSON.stringify({ resolution: resolution.resolution }),
    });
    expect(installAuthorization.status).toBe(201);
    const authorization = await json<{ authorization: { id: string } }>(installAuthorization);
    const descriptor = await request(handler, `/v1/artifacts/${encodeURIComponent(skill!.artifact.digest)}/download`, {
      method: 'POST',
      headers: jsonHeaders(USER_TOKEN),
      body: JSON.stringify({ resourceId: skill!.id, authorizationId: authorization.authorization.id }),
    });
    expect(descriptor.status).toBe(200);
    const transfer = await json<{ url: string; digest: string }>(descriptor);
    expect(transfer.digest).toBe(skill!.artifact.digest);
    const transferred = await request(handler, new URL(transfer.url).pathname, {
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(transferred.status).toBe(200);
    const transferredBytes = new Uint8Array(await transferred.arrayBuffer());
    expect(await digestBytes(transferredBytes)).toBe(skill!.artifact.digest);
    expect([...transferredBytes]).toEqual([...artifactBytes!]);

    // The queue treats an approved completed source as a warm cache hit and
    // returns its original operation in the running state for the caller's
    // polling contract; it does not enqueue a second source acquisition.
    const warm = await request(handler, '/v1/feeds/skills/import', {
      method: 'POST',
      headers: jsonHeaders(USER_TOKEN),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    });
    expect(warm.status).toBe(202);
    await expect(json(warm)).resolves.toMatchObject({ operation: { operationId, state: 'running' } });
    expect(archiveFetches).toBe(1);
    expect(feedRequests).toBeGreaterThanOrEqual(3);
    expect(blobs.reads.length).toBeGreaterThanOrEqual(2);

    expect(POLICY.allowUnscanned).toBe(false);
    // The default scanner boundary is an explicit deterministic fixture; it
    // does not claim Cisco/NVIDIA/SkillsGuard provider execution.
    expect(run.scannerResults?.[0]?.coverage.limitations).toContain('deterministic local scanner fixture; no provider analysis');
  });
});
