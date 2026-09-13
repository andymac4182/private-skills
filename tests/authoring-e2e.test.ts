import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TokenAuthenticator,
  type BootstrapTokenConfig,
} from '../packages/auth/src/index.js';
import {
  createMemoryStateRepository,
  defaultRegistryState,
} from '../packages/database/src/index.js';
import {
  createRegistryHandler,
  resolveCurrentUploadReviewBinding,
  type RegistryHandler,
  type RegistryHandlerDependencies,
} from '../packages/core/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import { digestBytes, encodeBundle } from '../packages/storage/src/index.js';
import type {
  BlobStore,
  Policy,
  Principal,
  RegistryConfiguration,
  RegistryState,
  ScanResult,
  SkillDraftFileManifestEntry,
  SkillBundle,
  SkillVersion,
} from '../packages/contracts/src/index.js';
import { createUploadReviewHttpHandler } from '../packages/upload-reviews/src/http.js';
import { createUploadReviewPersistenceService } from '../packages/upload-reviews/src/index.js';
import type { UploadReviewJob, UploadReviewResult } from '../packages/upload-reviews/src/index.js';
import type { ScanRequest, ScannerAdapter } from '../packages/scanners/src/types.js';
import { WorkerRunner } from '../workers/runner/src/index.js';

const ORIGIN = 'http://authoring-e2e.test';
const ORGANIZATION = 'org-authoring-e2e';
const PUBLISHER_TOKEN = 'authoring-publisher-token';
const READER_TOKEN = 'authoring-reader-token';
const OTHER_NAMESPACE_TOKEN = 'authoring-other-namespace-token';
const OTHER_TENANT_TOKEN = 'authoring-other-tenant-token';
const WORKER_TOKEN = 'authoring-worker-token';
const REVIEW_TOKEN = 'authoring-upload-review-token';
const POLICY: Policy = {
  revision: 'authoring-required-scanner',
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

type HttpHandler = (request: Request) => Promise<Response>;

interface AuthoringFixture {
  handler: HttpHandler;
  repository: ReturnType<typeof createMemoryStateRepository>;
  blobs: BlobStore;
  root: string;
  baseRelease: SkillVersion;
  baseBundle: SkillBundle;
  close: () => Promise<void>;
}

type ReviewState = RegistryState & {
  uploadReviewJobs?: UploadReviewJob[];
  uploadReviewResults?: UploadReviewResult[];
};

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

async function draftManifest(files: SkillBundle['files']): Promise<SkillDraftFileManifestEntry[]> {
  return await Promise.all(files.map(async (file) => {
    const bytes = Uint8Array.from(Buffer.from(file.content, 'base64'));
    return {
      path: file.path,
      size: bytes.byteLength,
      digest: await digestBytes(bytes),
      ...(file.executable === true ? { executable: true } : {}),
    };
  }));
}

function bundleWith(description: string, guide: string, safe: boolean): SkillBundle {
  return {
    format: 'pskills-bundle-v1',
    files: [
      {
        path: 'SKILL.md',
        content: base64(`---\nname: base-skill\ndescription: ${description}\n---\n\nNever execute this fixture.\n`),
      },
      { path: 'docs/guide.md', content: base64(`${guide}\n`) },
      { path: 'rules.json', content: base64(JSON.stringify({ safe }) + '\n') },
    ],
  };
}

function principal(
  organizationId: string,
  subject: string,
  roles: Principal['roles'],
  namespaces: string[],
  scopes = ['registry:*'],
): Principal {
  return { organizationId, subject, roles, namespaces, scopes };
}

function deterministicScanner(observe?: (input: ScanRequest) => void): ScannerAdapter {
  return {
    id: 'skillsguard',
    command: 'fixture-deterministic-scanner',
    metadata: {
      id: 'skillsguard',
      version: 'fixture',
      engineVersion: 'fixture',
      rulesRevision: 'fixture',
    },
    scan: async (input) => {
      observe?.(input);
      const files = await readdir(input.inputDir, { withFileTypes: true, recursive: true });
      const count = files.filter((entry) => entry.isFile()).length;
      return {
        result: {
          schemaVersion: 1,
          organizationId: input.organizationId,
          jobId: input.jobId,
          invocationId: `fixture-${input.jobId}`,
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
            filesEnumerated: count,
            filesAnalyzed: count,
            filesSkipped: 0,
            filesUnsupported: 0,
            limitations: ['deterministic local fixture scanner'],
            externalDestinations: [],
          },
          findings: [],
        },
      };
    },
  };
}

function headers(token?: string): HeadersInit {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

async function call(handler: HttpHandler, path: string, token?: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...requestInit } = init;
  const requestHeaders = new Headers({ ...headers(token), ...(requestInit.headers ?? {}) });
  let body = requestInit.body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    requestHeaders.set('content-type', 'application/json');
  }
  return handler(new Request(new URL(path, ORIGIN), { ...requestInit, headers: requestHeaders, body }));
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function makeFixture(options: { uploadReview?: boolean } = {}): Promise<AuthoringFixture> {
  const root = await mkdtemp(join(tmpdir(), 'private-skills-authoring-e2e-'));
  const baseBundle = bundleWith('Base release', 'Base guide', true);
  const baseBytes = encodeBundle(baseBundle);
  const blobs = await createNodeFilesSdkBlobStore({ provider: 'fs', root, prefix: 'authoring-e2e' });
  const stored = await blobs.put(baseBytes);
  const state = defaultRegistryState({
    production: false,
    allowUnscanned: false,
    policyRevision: POLICY.revision,
  });
  state.policy = structuredClone(POLICY);
  const baseScan: ScanResult = {
    id: 'base-scan',
    organizationId: ORGANIZATION,
    jobId: 'base-scan-job',
    artifactDigest: stored.digest,
    policyRevision: POLICY.revision,
    scannerId: 'skillsguard',
    engineVersion: 'fixture',
    rulesRevision: 'fixture',
    configurationHash: `sha256:${'1'.repeat(64)}`,
    status: 'completed',
    findings: [],
    coverage: {
      filesEnumerated: baseBundle.files.length,
      filesAnalyzed: baseBundle.files.length,
      filesSkipped: 0,
      filesUnsupported: 0,
      limitations: ['deterministic local fixture scanner'],
      externalDestinations: [],
    },
    createdAt: new Date().toISOString(),
    durationMs: 1,
  };
  state.scans.push(baseScan);
  const baseRelease: SkillVersion = {
    id: 'skill-base-release',
    organizationId: ORGANIZATION,
    name: '@acme/base-skill',
    skillName: 'base-skill',
    version: '1.0.0',
    description: 'Base release',
    artifact: stored,
    state: 'approved',
    policyRevision: POLICY.revision,
    createdAt: '2026-09-10T00:00:00.000Z',
    approvedAt: '2026-09-10T00:00:01.000Z',
    provenance: {
      kind: 'github',
      upstreamId: 'upstream-base',
      repository: 'acme/upstream',
      path: 'skills/base-skill',
      revision: 'a'.repeat(40),
      sourceProviderOrigin: 'github.com',
      sourceResolutionKind: 'github',
      sourceReference: '@github/acme/upstream/skills/base-skill',
    },
    fileCount: baseBundle.files.length,
    scanIds: [baseScan.id],
  };
  state.skills.push(baseRelease);
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });

  const userConfigs: BootstrapTokenConfig[] = [
    {
      id: 'publisher', token: PUBLISHER_TOKEN, organizationId: ORGANIZATION, subject: 'publisher',
      roles: ['owner', 'admin', 'publisher', 'reader'], namespaces: ['@acme'],
      scopes: ['registry:*', 'skills:read', 'skills:write', 'skills:publish'],
    },
    {
      id: 'reader', token: READER_TOKEN, organizationId: ORGANIZATION, subject: 'reader',
      roles: ['reader'], namespaces: ['@acme'], scopes: ['registry:*', 'skills:read'],
    },
    {
      id: 'other-namespace', token: OTHER_NAMESPACE_TOKEN, organizationId: ORGANIZATION, subject: 'other-namespace',
      roles: ['publisher', 'reader'], namespaces: ['@other'],
      scopes: ['registry:*', 'skills:read', 'skills:write', 'skills:publish'],
    },
    {
      id: 'other-tenant', token: OTHER_TENANT_TOKEN, organizationId: 'org-other', subject: 'other-tenant',
      roles: ['owner', 'admin', 'publisher', 'reader'], namespaces: ['@acme'],
      scopes: ['registry:*', 'skills:read', 'skills:write', 'skills:publish'],
    },
  ];
  const workerConfig: BootstrapTokenConfig = {
    id: 'worker', token: WORKER_TOKEN, organizationId: ORGANIZATION, subject: 'worker',
    roles: ['worker'], kind: 'worker', worker: true, scopes: ['jobs:*'],
  };
  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: userConfigs,
    workerTokens: [workerConfig],
    sessionSecret: 'authoring-e2e-session-secret-that-is-long-enough',
    publicOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  await auth.ready();

  const config: RegistryConfiguration = {
    publicOrigin: ORIGIN,
    maxBodyBytes: 2 * 1024 * 1024,
    organizationId: ORGANIZATION,
    leaseSeconds: 60,
  };
  const uploadReview = options.uploadReview === true
    ? createUploadReviewPersistenceService(repository, {
      resolveCurrentBinding: resolveCurrentUploadReviewBinding,
    })
    : undefined;
  let reviewSessionCounter = 0;
  const uploadReviewIntegration: NonNullable<RegistryHandlerDependencies['uploadReview']> | undefined = uploadReview === undefined
    ? undefined
    : {
      // The composed test completes the separate reviewer HTTP contract with
      // bounded fixture findings; no model or browser is invoked here.
      service: uploadReview,
      model: 'fixture/upload-review',
      reviewerRevision: 'authoring-e2e-upload-review-v1',
      configured: true,
      trigger: async (organizationId, jobId, service) => {
        const sessionId = `authoring-e2e-review-${++reviewSessionCounter}`;
        await service.bindEveSession(organizationId, jobId, sessionId);
        return { sessionId, status: 'started' };
      },
    };
  const registryHandler = createRegistryHandler({
    repository,
    blobs,
    auth,
    config,
    ...(uploadReviewIntegration === undefined ? {} : { uploadReview: uploadReviewIntegration }),
  });
  const internalReviewHandler = uploadReview === undefined
    ? undefined
    : createUploadReviewHttpHandler({
      repository,
      organizationId: ORGANIZATION,
      reviewerToken: REVIEW_TOKEN,
      resolveCurrentBinding: resolveCurrentUploadReviewBinding,
      service: uploadReview,
    });
  const handler: RegistryHandler = async (request) => {
    if (internalReviewHandler !== undefined) {
      const response = await internalReviewHandler(request);
      if (response !== undefined) return response;
    }
    return registryHandler(request);
  };
  return {
    handler,
    repository,
    blobs,
    root,
    baseRelease,
    baseBundle,
    close: async () => rm(root, { recursive: true, force: true }),
  };
}

function draftCreateRequest(baseDigest: string, key: string): { method: 'POST'; headers: HeadersInit; json: unknown } {
  return {
    method: 'POST',
    headers: { 'idempotency-key': key },
    json: { baseDigest },
  };
}

function draftUpdateRequest(revision: number, key: string, files: SkillBundle['files']): { method: 'PUT'; headers: HeadersInit; json: unknown } {
  return {
    method: 'PUT',
    headers: { 'idempotency-key': key },
    json: { expectedRevision: revision, files },
  };
}

function draftPublishRequest(revision: number, key: string, version: string): { method: 'POST'; headers: HeadersInit; json: unknown } {
  return {
    method: 'POST',
    headers: { 'idempotency-key': key },
    json: { expectedRevision: revision, version },
  };
}

function runner(fixture: AuthoringFixture, adapters: ScannerAdapter[]): WorkerRunner {
  return new WorkerRunner({
    baseUrl: ORIGIN,
    workerToken: WORKER_TOKEN,
    workerId: 'authoring-e2e-worker',
    fetch: async (input, init) => fixture.handler(new Request(String(input), init)),
    adapters,
    executor: { run: async () => { throw new Error('fixture scanner must bypass command execution'); } },
  });
}

async function assertInvalidDraftPublication(
  fixture: AuthoringFixture,
  key: string,
  version: string,
  files: SkillBundle['files'],
): Promise<void> {
  const createdResponse = await call(
    fixture.handler,
    `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
    PUBLISHER_TOKEN,
    draftCreateRequest(fixture.baseRelease.artifact.digest, `${key}-create`),
  );
  expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
  const created = await json<{ draft: { id: string } }>(createdResponse);
  const updatedResponse = await call(
    fixture.handler,
    `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
    PUBLISHER_TOKEN,
    draftUpdateRequest(1, `${key}-update`, files),
  );
  expect(updatedResponse.status, await updatedResponse.clone().text()).toBe(200);

  const beforePublish = await fixture.repository.read(ORGANIZATION);
  const publishResponse = await call(
    fixture.handler,
    `/v1/drafts/${encodeURIComponent(created.draft.id)}/publish`,
    PUBLISHER_TOKEN,
    draftPublishRequest(2, `${key}-publish`, version),
  );
  expect(publishResponse.status, await publishResponse.clone().text()).toBe(409);
  expect((await json<{ error: { code: string } }>(publishResponse)).error.code).toBe('DRAFT_INVALID');
  const afterPublish = await fixture.repository.read(ORGANIZATION);
  expect(afterPublish.jobs).toHaveLength(beforePublish.jobs.length);
  expect(afterPublish.skills).toHaveLength(beforePublish.skills.length);
}

describe('authoring draft to scanner-gated release over HTTP', () => {
  const fixtures: AuthoringFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) await fixtures.pop()!.close();
  });

  it('creates, reloads, CAS-updates, publishes an exact revision, scans, and serves approved bytes', async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);

    const unauthenticated = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
      undefined,
      draftCreateRequest(fixture.baseRelease.artifact.digest, 'unauthenticated'),
    );
    expect(unauthenticated.status).toBe(401);

    const readerCreate = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
      READER_TOKEN,
      draftCreateRequest(fixture.baseRelease.artifact.digest, 'reader'),
    );
    expect(readerCreate.status).toBe(403);

    const namespaceDenied = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
      OTHER_NAMESPACE_TOKEN,
      draftCreateRequest(fixture.baseRelease.artifact.digest, 'other-namespace'),
    );
    expect(namespaceDenied.status).toBe(404);

    const tenantDenied = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
      OTHER_TENANT_TOKEN,
      draftCreateRequest(fixture.baseRelease.artifact.digest, 'other-tenant'),
    );
    expect(tenantDenied.status).toBe(403);

    const createdResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
      PUBLISHER_TOKEN,
      draftCreateRequest(fixture.baseRelease.artifact.digest, 'create-1'),
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = await json<{ draft: { id: string; revision: number; digest: string; files: SkillDraftFileManifestEntry[] } }>(createdResponse);
    expect(created.draft).toMatchObject({
      baseResourceId: fixture.baseRelease.id,
      baseDigest: fixture.baseRelease.artifact.digest,
      revision: 1,
      digest: fixture.baseRelease.artifact.digest,
      status: 'open',
    });
    expect(created.draft).not.toHaveProperty('artifact.key');

    const changedBundle = bundleWith('Edited draft', 'Edited guide', false);
    const updateResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
      draftUpdateRequest(1, 'update-1', changedBundle.files),
    );
    expect(updateResponse.status, await updateResponse.clone().text()).toBe(200);
    const updated = await json<{ draft: { revision: number; digest: string; files: SkillDraftFileManifestEntry[] } }>(updateResponse);
    expect(updated.draft.revision).toBe(2);
    expect(updated.draft.digest).not.toBe(fixture.baseRelease.artifact.digest);
    expect(updated.draft.files).toEqual(await draftManifest(changedBundle.files));

    const reloadedResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
    );
    expect(reloadedResponse.status).toBe(200);
    expect((await json<{ draft: unknown }>(reloadedResponse)).draft).toEqual(updated.draft);

    const staleUpdate = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
      draftUpdateRequest(1, 'update-stale', fixture.baseBundle.files),
    );
    expect(staleUpdate.status).toBe(409);
    expect(await json<{ error: { code: string; details?: { currentRevision?: number } } }>(staleUpdate)).toMatchObject({
      error: { code: 'DRAFT_CONFLICT', details: { currentRevision: 2 } },
    });

    const stateAfterEdit = await fixture.repository.read(ORGANIZATION);
    expect(stateAfterEdit.skills.find((skill) => skill.id === fixture.baseRelease.id)?.artifact).toEqual(fixture.baseRelease.artifact);
    const baseBytesBeforePublish = await fixture.blobs.get(fixture.baseRelease.artifact.key);
    expect(await digestBytes(baseBytesBeforePublish)).toBe(fixture.baseRelease.artifact.digest);

    const invalidVersion = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/publish`,
      PUBLISHER_TOKEN,
      draftPublishRequest(2, 'publish-invalid-version', 'not-semver'),
    );
    expect(invalidVersion.status).toBe(400);
    expect((await json<{ error: { code: string } }>(invalidVersion)).error.code).toBe('INVALID_VERSION');
    expect((await fixture.repository.read(ORGANIZATION)).jobs).toHaveLength(0);

    const publishResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/publish`,
      PUBLISHER_TOKEN,
      draftPublishRequest(2, 'publish-1', '1.1.0'),
    );
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(202);
    const publication = await json<{ operation: { id: string; resourceId: string; revision: number; digest: string; state: string; scanRequired: boolean } }>(publishResponse);
    expect(publication.operation).toMatchObject({
      revision: 2,
      digest: updated.draft.digest,
      state: 'queued',
      scanRequired: true,
    });

    const pending = await fixture.repository.read(ORGANIZATION);
    const pendingSkill = pending.skills.find((skill) => skill.id === publication.operation.resourceId);
    expect(pendingSkill).toMatchObject({ state: 'pending', artifact: { digest: updated.draft.digest } });
    expect(pending.jobs.find((job) => job.id === publication.operation.id)).toMatchObject({ kind: 'scan', state: 'queued' });

    const scannerInputs: Array<Pick<ScanRequest, 'jobId' | 'artifactDigest' | 'policyRevision'>> = [];
    const scanRun = await runner(fixture, [deterministicScanner((input) => {
      scannerInputs.push({
        jobId: input.jobId,
        artifactDigest: input.artifactDigest,
        policyRevision: input.policyRevision,
      });
    })]).runOnce();
    expect(scanRun.error).toBeUndefined();
    expect(scanRun.allow).toBe(true);
    expect(scannerInputs).toEqual([{
      jobId: publication.operation.id,
      artifactDigest: updated.draft.digest,
      policyRevision: POLICY.revision,
    }]);
    expect(scanRun.scannerResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ scannerId: 'skillsguard', status: 'completed' }),
    ]));

    const approvedState = await fixture.repository.read(ORGANIZATION);
    const approved = approvedState.skills.find((skill) => skill.id === publication.operation.resourceId);
    expect(approved).toMatchObject({ state: 'approved', artifact: { digest: updated.draft.digest }, version: '1.1.0' });
    expect(approved?.provenance).toMatchObject({ kind: 'native' });
    expect(approved?.scanIds).toHaveLength(1);
    expect(approvedState.scans).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: publication.operation.id, scannerId: 'skillsguard', status: 'completed' }),
    ]));

    const manifestResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(publication.operation.resourceId)}/files`,
      READER_TOKEN,
    );
    expect(manifestResponse.status, await manifestResponse.clone().text()).toBe(200);
    const manifest = await json<{ release: { digest: string; version: string }; files: Array<{ path: string; previewState: string }> }>(manifestResponse);
    expect(manifest.release).toMatchObject({ digest: updated.draft.digest, version: '1.1.0' });
    expect(manifest.files.map((file) => file.path)).toEqual(['SKILL.md', 'docs/guide.md', 'rules.json']);

    const selectedResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(publication.operation.resourceId)}/file?path=SKILL.md`,
      READER_TOKEN,
    );
    expect(selectedResponse.status).toBe(200);
    const selected = await json<{ files: Array<{ path: string; contents?: string; contentDigest: string }> }>(selectedResponse);
    expect(selected.files).toHaveLength(1);
    expect(selected.files[0]).toMatchObject({
      path: 'SKILL.md',
      contents: '---\nname: base-skill\ndescription: Edited draft\n---\n\nNever execute this fixture.\n',
    });
    expect(selected.files[0]?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const readerDraft = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      READER_TOKEN,
    );
    expect(readerDraft.status).toBe(403);
  });

  it('composes upload review persistence with explicit scanner admission and release retrieval', async () => {
    const fixture = await makeFixture({ uploadReview: true });
    fixtures.push(fixture);
    const initialBundle = bundleWith('Uploaded review draft', 'Initial guide', true);
    const createdResponse = await call(
      fixture.handler,
      '/v1/drafts',
      PUBLISHER_TOKEN,
      {
        method: 'POST',
        headers: { 'idempotency-key': 'upload-review-create' },
        json: { name: '@acme/upload-review', files: initialBundle.files },
      },
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = await json<{
      draft: { id: string; origin: string; revision: number; digest: string; files: SkillDraftFileManifestEntry[] };
    }>(createdResponse);
    expect(created.draft).toMatchObject({ origin: 'upload', revision: 1, status: 'open' });
    expect(created.draft.files).toEqual(await draftManifest(initialBundle.files));

    const reloadedResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
    );
    expect(reloadedResponse.status, await reloadedResponse.clone().text()).toBe(200);
    const reloaded = await json<{ draft: typeof created.draft }>(reloadedResponse);
    expect(reloaded.draft).toEqual(created.draft);

    const afterCreate = await fixture.repository.read(ORGANIZATION) as ReviewState;
    const firstJob = afterCreate.uploadReviewJobs?.find((job) => job.binding.draftId === created.draft.id);
    expect(firstJob).toMatchObject({
      state: 'pending',
      model: 'fixture/upload-review',
      reviewerRevision: 'authoring-e2e-upload-review-v1',
      binding: {
        draftId: created.draft.id,
        draftRevision: 1,
        contentDigest: created.draft.digest,
        policyRevision: POLICY.revision,
      },
    });
    expect(firstJob?.eveSessionId).toBe('authoring-e2e-review-1');
    const firstSession = firstJob?.eveSessionId;
    expect(firstSession).toBeDefined();

    const pendingReviewsResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/reviews`,
      PUBLISHER_TOKEN,
    );
    expect(pendingReviewsResponse.status, await pendingReviewsResponse.clone().text()).toBe(200);
    const pendingReviews = await json<{ reviews: UploadReviewJob[]; results: UploadReviewResult[] }>(pendingReviewsResponse);
    expect(pendingReviews.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstJob!.id,
        state: 'pending',
        binding: expect.objectContaining({ draftRevision: 1, contentDigest: created.draft.digest }),
      }),
    ]));
    expect(pendingReviews.results).toHaveLength(0);

    const wrongReviewPrincipal = await call(
      fixture.handler,
      '/internal/upload-review/prepare',
      PUBLISHER_TOKEN,
      { method: 'POST', json: { sessionId: firstSession } },
    );
    expect(wrongReviewPrincipal.status).toBe(401);

    const preparedResponse = await call(
      fixture.handler,
      '/internal/upload-review/prepare',
      REVIEW_TOKEN,
      { method: 'POST', json: { sessionId: firstSession } },
    );
    expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(200);
    const prepared = await json<{
      status: string;
      jobId: string;
      draftId: string;
      draftRevision: number;
      contentDigest: string;
      policyRevision: string;
      leaseToken?: string;
      files?: Array<{ path: string; kind: string; size: number; digest: string; text?: string }>;
    }>(preparedResponse);
    expect(prepared).toMatchObject({
      status: 'prepared',
      jobId: firstJob!.id,
      draftId: created.draft.id,
      draftRevision: 1,
      contentDigest: created.draft.digest,
      policyRevision: POLICY.revision,
    });
    expect(prepared.files).toHaveLength(initialBundle.files.length);
    for (const file of initialBundle.files) {
      const bytes = Uint8Array.from(Buffer.from(file.content, 'base64'));
      const snapshotFile = prepared.files?.find((candidate) => candidate.path === file.path);
      expect(snapshotFile).toMatchObject({
        path: file.path,
        kind: 'text',
        size: bytes.byteLength,
        digest: await digestBytes(bytes),
        text: Buffer.from(bytes).toString('utf8'),
      });
    }
    expect(prepared.leaseToken).toEqual(expect.any(String));

    const completedResponse = await call(
      fixture.handler,
      '/internal/upload-review/complete',
      REVIEW_TOKEN,
      {
        method: 'POST',
        json: {
          sessionId: firstSession,
          jobId: firstJob!.id,
          leaseToken: prepared.leaseToken,
          findings: [{
            severity: 'low',
            category: 'style',
            title: 'Initial review note',
            summary: 'The deterministic reviewer recorded an advisory note.',
            evidence: 'fixture evidence',
            path: 'SKILL.md',
            line: 1,
          }],
        },
      },
    );
    expect(completedResponse.status, await completedResponse.clone().text()).toBe(200);
    const completed = await json<{ status: string; resultId: string; findingCount: number }>(completedResponse);
    expect(completed).toMatchObject({ status: 'passed', findingCount: 1 });

    const reviewedResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/reviews`,
      PUBLISHER_TOKEN,
    );
    expect(reviewedResponse.status).toBe(200);
    const reviewed = await json<{ reviews: UploadReviewJob[]; results: UploadReviewResult[] }>(reviewedResponse);
    const firstResult = reviewed.results.find((result) => result.id === completed.resultId);
    expect(firstResult).toMatchObject({
      state: 'passed',
      jobId: firstJob!.id,
      binding: { draftRevision: 1, contentDigest: created.draft.digest },
      findings: [{ severity: 'low', decision: 'open', path: 'SKILL.md' }],
    });
    const firstFindingId = firstResult?.findings[0]?.id;
    expect(firstFindingId).toEqual(expect.any(String));

    const beforeDismissal = await fixture.repository.read(ORGANIZATION) as ReviewState;
    expect(beforeDismissal.skills).toHaveLength(1);
    expect(beforeDismissal.jobs).toHaveLength(0);

    const dismissedResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/reviews/${encodeURIComponent(completed.resultId)}/decisions`,
      PUBLISHER_TOKEN,
      {
        method: 'POST',
        json: {
          findingId: firstFindingId,
          decision: 'dismissed',
          reason: 'Reviewed in the deterministic local fixture.',
        },
      },
    );
    expect(dismissedResponse.status, await dismissedResponse.clone().text()).toBe(200);
    const dismissed = await json<{ review: UploadReviewResult }>(dismissedResponse);
    expect(dismissed.review.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstFindingId, decision: 'dismissed', decisionReason: 'Reviewed in the deterministic local fixture.' }),
    ]));
    const dismissedState = await fixture.repository.read(ORGANIZATION) as ReviewState;
    expect(dismissedState.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: 'publisher',
        action: 'upload-review.finding.decision',
        resourceId: completed.resultId,
        details: {
          findingId: firstFindingId,
          decision: 'dismissed',
          reason: 'Reviewed in the deterministic local fixture.',
        },
      }),
    ]));

    const editedBundle = bundleWith('Edited upload review', 'Edited guide', false);
    const updateResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
      draftUpdateRequest(1, 'upload-review-update', editedBundle.files),
    );
    expect(updateResponse.status, await updateResponse.clone().text()).toBe(200);
    const updated = await json<{ draft: { id: string; revision: number; digest: string; files: SkillDraftFileManifestEntry[] } }>(updateResponse);
    expect(updated.draft).toMatchObject({ id: created.draft.id, revision: 2 });
    expect(updated.draft.digest).not.toBe(created.draft.digest);
    expect(updated.draft.files).toEqual(await draftManifest(editedBundle.files));

    const afterUpdate = await fixture.repository.read(ORGANIZATION) as ReviewState;
    const oldJob = afterUpdate.uploadReviewJobs?.find((job) => job.id === firstJob!.id);
    const secondJob = afterUpdate.uploadReviewJobs?.find((job) => job.binding.draftRevision === 2);
    const oldResult = afterUpdate.uploadReviewResults?.find((result) => result.id === completed.resultId);
    expect(oldJob).toMatchObject({ state: 'stale', staleReason: 'draft revision changed' });
    expect(oldResult).toMatchObject({ state: 'stale', staleReason: 'draft revision changed' });
    expect(secondJob).toMatchObject({
      state: 'pending',
      binding: { draftId: created.draft.id, draftRevision: 2, contentDigest: updated.draft.digest, policyRevision: POLICY.revision },
    });
    expect(secondJob?.eveSessionId).toBe('authoring-e2e-review-2');

    const staleDecisionResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/reviews/${encodeURIComponent(completed.resultId)}/decisions`,
      PUBLISHER_TOKEN,
      { method: 'POST', json: { findingId: firstFindingId, decision: 'acknowledged' } },
    );
    expect(staleDecisionResponse.status).toBe(409);
    expect((await json<{ error: { code: string } }>(staleDecisionResponse)).error.code).toBe('REVIEW_CONFLICT');

    const secondPreparedResponse = await call(
      fixture.handler,
      '/internal/upload-review/prepare',
      REVIEW_TOKEN,
      { method: 'POST', json: { sessionId: secondJob?.eveSessionId } },
    );
    expect(secondPreparedResponse.status, await secondPreparedResponse.clone().text()).toBe(200);
    const secondPrepared = await json<{ status: string; jobId: string; draftRevision: number; contentDigest: string; leaseToken?: string }>(secondPreparedResponse);
    expect(secondPrepared).toMatchObject({
      status: 'prepared',
      jobId: secondJob!.id,
      draftRevision: 2,
      contentDigest: updated.draft.digest,
    });
    const secondCompletedResponse = await call(
      fixture.handler,
      '/internal/upload-review/complete',
      REVIEW_TOKEN,
      {
        method: 'POST',
        json: {
          sessionId: secondJob?.eveSessionId,
          jobId: secondJob!.id,
          leaseToken: secondPrepared.leaseToken,
          findings: [{
            severity: 'info',
            category: 'freshness',
            title: 'Current review note',
            summary: 'The current revision was reviewed after the edit.',
            path: 'docs/guide.md',
            line: 1,
          }],
        },
      },
    );
    expect(secondCompletedResponse.status, await secondCompletedResponse.clone().text()).toBe(200);
    const secondCompleted = await json<{ status: string; resultId: string; findingCount: number }>(secondCompletedResponse);
    expect(secondCompleted).toMatchObject({ status: 'passed', findingCount: 1 });
    expect(secondCompleted.resultId).not.toBe(completed.resultId);

    const currentReviewsResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/reviews`,
      PUBLISHER_TOKEN,
    );
    expect(currentReviewsResponse.status).toBe(200);
    const currentReviews = await json<{ reviews: UploadReviewJob[]; results: UploadReviewResult[] }>(currentReviewsResponse);
    expect(currentReviews.results.find((result) => result.id === completed.resultId)).toMatchObject({ state: 'stale' });
    expect(currentReviews.results.find((result) => result.id === secondCompleted.resultId)).toMatchObject({
      state: 'passed',
      binding: { draftRevision: 2, contentDigest: updated.draft.digest },
    });

    const beforePublish = await fixture.repository.read(ORGANIZATION) as ReviewState;
    expect(beforePublish.skills).toHaveLength(1);
    expect(beforePublish.jobs).toHaveLength(0);
    const publishResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/publish`,
      PUBLISHER_TOKEN,
      draftPublishRequest(2, 'upload-review-publish', '1.0.0'),
    );
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(202);
    const publication = await json<{ operation: { id: string; resourceId: string; revision: number; digest: string; state: string; scanRequired: boolean } }>(publishResponse);
    expect(publication.operation).toMatchObject({
      revision: 2,
      digest: updated.draft.digest,
      state: 'queued',
      scanRequired: true,
    });
    const pendingReleaseResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(publication.operation.resourceId)}/files`,
      READER_TOKEN,
    );
    expect(pendingReleaseResponse.status).toBe(404);

    const scannerInputs: Array<Pick<ScanRequest, 'jobId' | 'artifactDigest' | 'policyRevision'>> = [];
    const scanRun = await runner(fixture, [deterministicScanner((input) => {
      scannerInputs.push({
        jobId: input.jobId,
        artifactDigest: input.artifactDigest,
        policyRevision: input.policyRevision,
      });
    })]).runOnce();
    expect(scanRun.error).toBeUndefined();
    expect(scanRun.allow).toBe(true);
    expect(scannerInputs).toEqual([{
      jobId: publication.operation.id,
      artifactDigest: updated.draft.digest,
      policyRevision: POLICY.revision,
    }]);
    const scannerResult = scanRun.scannerResults?.find((result) => result.scannerId === 'skillsguard');
    expect(scannerResult).toMatchObject({
      status: 'completed',
      artifactDigest: updated.draft.digest,
      coverage: {
        filesEnumerated: editedBundle.files.length,
        filesAnalyzed: editedBundle.files.length,
        filesSkipped: 0,
        filesUnsupported: 0,
      },
    });

    const approvedState = await fixture.repository.read(ORGANIZATION) as ReviewState;
    const approved = approvedState.skills.find((skill) => skill.id === publication.operation.resourceId);
    expect(approved).toMatchObject({
      state: 'approved',
      version: '1.0.0',
      artifact: { digest: updated.draft.digest },
      provenance: { kind: 'native', sourceDigest: updated.draft.digest },
    });
    expect(approvedState.jobs.find((job) => job.id === publication.operation.id)).toMatchObject({ state: 'completed' });

    const manifestResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(publication.operation.resourceId)}/files`,
      READER_TOKEN,
    );
    expect(manifestResponse.status, await manifestResponse.clone().text()).toBe(200);
    const manifest = await json<{ release: { digest: string; version: string; fileCount: number }; files: Array<{ path: string }> }>(manifestResponse);
    expect(manifest.release).toMatchObject({ digest: updated.draft.digest, version: '1.0.0', fileCount: editedBundle.files.length });
    expect(manifest.files.map((file) => file.path)).toEqual(['SKILL.md', 'docs/guide.md', 'rules.json']);

    const selectedResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(publication.operation.resourceId)}/file?path=docs%2Fguide.md`,
      READER_TOKEN,
    );
    expect(selectedResponse.status, await selectedResponse.clone().text()).toBe(200);
    const selected = await json<{ files: Array<{ path: string; contents?: string; contentDigest: string }> }>(selectedResponse);
    expect(selected.files).toHaveLength(1);
    expect(selected.files[0]).toMatchObject({ path: 'docs/guide.md', contents: 'Edited guide\n' });
    expect(selected.files[0]?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('reloads a draft after a valid reversed file-list PUT without changing its sealed digest', async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const createdResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
      PUBLISHER_TOKEN,
      draftCreateRequest(fixture.baseRelease.artifact.digest, 'reverse-create'),
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = await json<{ draft: { id: string } }>(createdResponse);
    const changedBundle = bundleWith('Reordered draft', 'Reordered guide', false);
    const reversedFiles = [...changedBundle.files].reverse();
    const updatedResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
      draftUpdateRequest(1, 'reverse-update', reversedFiles),
    );
    expect(updatedResponse.status, await updatedResponse.clone().text()).toBe(200);
    const updated = await json<{ draft: { digest: string; files: SkillDraftFileManifestEntry[] } }>(updatedResponse);
    const canonicalFiles = [...changedBundle.files].sort((left, right) => {
      if (left.path < right.path) return -1;
      if (left.path > right.path) return 1;
      return 0;
    });
    expect(updated.draft.files).toEqual(await draftManifest(canonicalFiles));
    expect(updated.draft.digest).toBe(await digestBytes(encodeBundle({ format: 'pskills-bundle-v1', files: canonicalFiles })));

    const reloadedResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
    );
    expect(reloadedResponse.status, await reloadedResponse.clone().text()).toBe(200);
    expect((await json<{ draft: unknown }>(reloadedResponse)).draft).toEqual(updated.draft);
  });

  it('keeps a required scanner failure quarantined and refuses stale-base publication', async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);

    const createdResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
      PUBLISHER_TOKEN,
      draftCreateRequest(fixture.baseRelease.artifact.digest, 'create-negative'),
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = await json<{ draft: { id: string } }>(createdResponse);
    const publishResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/publish`,
      PUBLISHER_TOKEN,
      draftPublishRequest(1, 'publish-negative', '1.2.0'),
    );
    expect(publishResponse.status).toBe(202);
    const publication = await json<{ operation: { id: string; resourceId: string } }>(publishResponse);

    const failedRun = await runner(fixture, []).runOnce();
    expect(failedRun.error).toBeUndefined();
    expect(failedRun.allow).toBe(false);
    expect(failedRun.scannerResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ scannerId: 'skillsguard', status: 'unsupported' }),
    ]));

    const failedState = await fixture.repository.read(ORGANIZATION);
    expect(failedState.skills.find((skill) => skill.id === publication.operation.resourceId)).toMatchObject({ state: 'scan-error' });
    expect(failedState.jobs.find((job) => job.id === publication.operation.id)).toMatchObject({
      state: 'completed',
      error: expect.stringContaining('Required scanner skillsguard returned unsupported'),
    });
    const deniedFiles = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(publication.operation.resourceId)}/files`,
      READER_TOKEN,
    );
    expect(deniedFiles.status).toBe(404);

    const staleDraftResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(fixture.baseRelease.id)}/drafts`,
      PUBLISHER_TOKEN,
      draftCreateRequest(fixture.baseRelease.artifact.digest, 'create-stale'),
    );
    expect(staleDraftResponse.status).toBe(201);
    const staleDraft = await json<{ draft: { id: string } }>(staleDraftResponse);
    await fixture.repository.transaction(ORGANIZATION, (state) => {
      state.skills.find((skill) => skill.id === fixture.baseRelease.id)!.state = 'revoked';
    });
    const beforeStalePublish = await fixture.repository.read(ORGANIZATION);
    const stalePublish = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(staleDraft.draft.id)}/publish`,
      PUBLISHER_TOKEN,
      draftPublishRequest(1, 'publish-stale', '1.3.0'),
    );
    expect(stalePublish.status).toBe(404);
    expect((await json<{ error: { code: string } }>(stalePublish)).error.code).toBe('NOT_FOUND');
    const afterStalePublish = await fixture.repository.read(ORGANIZATION);
    expect(afterStalePublish.jobs).toHaveLength(beforeStalePublish.jobs.length);
    expect(afterStalePublish.skills.filter((skill) => skill.version === '1.3.0')).toHaveLength(0);
  });

  it('rejects publication when the draft is missing root SKILL.md metadata', async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    await assertInvalidDraftPublication(
      fixture,
      'missing-skill-metadata',
      '1.4.0',
      [{ path: 'docs/only.md', content: base64('# No skill metadata\n') }],
    );
  });

  it('rejects publication when SKILL.md frontmatter is unsafe', async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    await assertInvalidDraftPublication(
      fixture,
      'unsafe-skill-metadata',
      '1.5.0',
      [
        {
          path: 'SKILL.md',
          content: base64('---\nname: bad name\ndescription: Unsafe metadata\n---\n'),
        },
        { path: 'docs/guide.md', content: base64('Guide\n') },
      ],
    );
  });
});
