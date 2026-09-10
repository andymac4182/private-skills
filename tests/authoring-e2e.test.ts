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
  type RegistryHandler,
} from '../packages/core/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import { digestBytes, encodeBundle } from '../packages/storage/src/index.js';
import type {
  BlobStore,
  Policy,
  Principal,
  RegistryConfiguration,
  ScanResult,
  SkillDraftFileManifestEntry,
  SkillBundle,
  SkillVersion,
} from '../packages/contracts/src/index.js';
import type { ScanRequest, ScannerAdapter } from '../packages/scanners/src/types.js';
import { WorkerRunner } from '../workers/runner/src/index.js';

const ORIGIN = 'http://authoring-e2e.test';
const ORGANIZATION = 'org-authoring-e2e';
const PUBLISHER_TOKEN = 'authoring-publisher-token';
const READER_TOKEN = 'authoring-reader-token';
const OTHER_NAMESPACE_TOKEN = 'authoring-other-namespace-token';
const OTHER_TENANT_TOKEN = 'authoring-other-tenant-token';
const WORKER_TOKEN = 'authoring-worker-token';
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
      const files = await readdir(input.inputDir, { withFileTypes: true });
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

async function makeFixture(): Promise<AuthoringFixture> {
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
  const registryHandler = createRegistryHandler({ repository, blobs, auth, config });
  const handler: RegistryHandler = registryHandler;
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
