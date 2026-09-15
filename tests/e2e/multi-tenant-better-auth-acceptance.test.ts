import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';

import { TokenAuthenticator, type BootstrapTokenConfig } from '../../packages/auth/src/index.js';
import {
  PostgresStateRepository,
  defaultRegistryState,
  type PgPoolLike,
} from '../../packages/database/src/index.js';
import { createRegistryHandler, type RegistryHandler } from '../../packages/core/src/index.js';
import { createReviewPersistenceService } from '../../packages/reviews/src/index.js';
import { StateSemanticIndex } from '../../packages/search/src/index.js';
import { createIntelligenceHandler, type IntelligenceHandler } from '../../packages/intelligence/src/handler.js';
import type { EmbeddingProvider } from '../../packages/intelligence/src/embeddings.js';
import { createNodeFilesSdkBlobStore } from '../../packages/storage/src/node.js';
import type {
  InstallAuthorization,
  Job,
  PackVersion,
  RegistryConfiguration,
  Resolution,
  SkillVersion,
} from '../../packages/contracts/src/index.js';
import { bundleFor, scannerResult } from './harness.js';
import { digestBytes, encodeBundle } from '../../packages/storage/src/index.js';

const ORIGIN = 'http://better-auth-tenant.test';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const SHARED_SKILL_NAME = '@acme/shared-tenant-skill';
const SHARED_DESCRIPTION = 'The same deterministic bytes are published by both companies.';

const USER_A_TOKEN = 'fixture-user-a-token';
const USER_B_TOKEN = 'fixture-user-b-token';
const WORKER_A_TOKEN = 'fixture-worker-a-token';
const WORKER_B_TOKEN = 'fixture-worker-b-token';
const EVE_A_TOKEN = 'fixture-eve-a-token';
const EVE_B_TOKEN = 'fixture-eve-b-token';
const DATABASE_URL = process.env.PSKILLS_TEST_POSTGRES_URL?.trim();
function isLoopbackDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}
const POSTGRES_ENABLED = isLoopbackDatabaseUrl(DATABASE_URL);
const PROFILE = { id: 'l10-deterministic-v1', model: 'l10-deterministic', dimensions: 2 } as const;

type TenantId = typeof TENANT_A | typeof TENANT_B;

interface TenantRuntime {
  readonly request: (request: Request) => Promise<Response>;
  readonly repository: PostgresStateRepository;
  readonly blobs: Awaited<ReturnType<typeof createNodeFilesSdkBlobStore>>;
  readonly close: () => Promise<void>;
}

interface PublishedFixture {
  readonly job: Job;
  readonly skill: SkillVersion;
}

type SqlClient = ReturnType<typeof postgres>;

function pgPool(sql: SqlClient): PgPoolLike {
  const query = async (
    connection: SqlClient,
    text: string,
    parameters: readonly unknown[] = [],
  ) => {
    const result = await connection.unsafe(text, [...parameters] as never[]);
    return { rows: [...result], rowCount: result.count };
  };
  return {
    query: (text, parameters) => query(sql, text, parameters),
    connect: async () => {
      const connection = await sql.reserve();
      return {
        query: (text, parameters) => query(connection as unknown as SqlClient, text, parameters),
        release: () => connection.release(),
      };
    },
  } as PgPoolLike;
}

function vectorFor(text: string): number[] {
  return /tenant-a|alpha|shared/iu.test(text) ? [1, 0] : [0, 1];
}

function embeddingProvider(): EmbeddingProvider {
  return {
    profile: PROFILE,
    embedMany: async (texts) => texts.map(vectorFor),
    embedQuery: async (text) => vectorFor(text),
  };
}

function tokenConfig(
  id: string,
  token: string,
  organizationId: TenantId,
  subject: string,
  kind: 'user' | 'worker',
): BootstrapTokenConfig {
  return kind === 'worker'
    ? {
        id,
        token,
        organizationId,
        subject,
        roles: ['worker'],
        kind: 'worker',
        worker: true,
        scopes: ['jobs:*'],
      }
    : {
        id,
        token,
        organizationId,
        subject,
        roles: ['owner', 'admin', 'publisher', 'reader'],
        namespaces: ['@acme'],
        scopes: ['registry:*'],
      };
}

function config(organizationId: TenantId): RegistryConfiguration {
  return {
    publicOrigin: ORIGIN,
    maxBodyBytes: 2 * 1024 * 1024,
    organizationId,
    leaseSeconds: 60,
  };
}

function bearer(token: string, organizationId?: TenantId): Headers {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (organizationId !== undefined) headers.set('x-organization-id', organizationId);
  return headers;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(new URL(path, ORIGIN), init);
}

function jsonRequest(path: string, init: RequestInit & { json?: unknown } = {}): Request {
  const { json, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  if (json !== undefined) {
    headers.set('content-type', 'application/json');
    return request(path, { ...requestInit, headers, body: JSON.stringify(json) });
  }
  return request(path, { ...requestInit, headers });
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function denial(status: number, code: string): Response {
  return Response.json({ error: { code, message: 'Request context denied' } }, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function presentedToken(request: Request): string | undefined {
  const bearerValue = /^Bearer[ \t]+([^ \t]+)$/iu.exec(request.headers.get('authorization') ?? '')?.[1];
  return bearerValue ?? request.headers.get('x-pskills-reviewer-token') ?? undefined;
}

/**
 * Compose two real Request handlers behind a request-context fixture. The
 * durable registry state is one PostgreSQL table with one row per company;
 * every route receives a fixed organization boundary after the credential is
 * authenticated. The fixture uses local bootstrap credentials only and never
 * contacts an external provider.
 */
async function createTenantRuntime(): Promise<TenantRuntime> {
  if (!DATABASE_URL) throw new Error('PSKILLS_TEST_POSTGRES_URL is required');
  const sql = postgres(DATABASE_URL, { max: 8, prepare: false });
  const tableName = `private_skills_l10_${crypto.randomUUID().replaceAll('-', '')}`;
  const repository = new PostgresStateRepository(pgPool(sql), {
    tableName,
    autoMigrate: true,
    stateFactory: () => defaultRegistryState({
      production: false,
      allowUnscanned: true,
      policyRevision: 'two-tenant-postgres-acceptance',
    }),
  });
  const root = await mkdtemp(join(tmpdir(), 'private-skills-better-auth-tenant-'));
  const blobs = await createNodeFilesSdkBlobStore({ provider: 'fs', root, prefix: 'private-registry' });

  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: [
      tokenConfig('user-a', USER_A_TOKEN, TENANT_A, 'shared-user', 'user'),
      tokenConfig('user-b', USER_B_TOKEN, TENANT_B, 'shared-user', 'user'),
    ],
    workerTokens: [
      tokenConfig('worker-a', WORKER_A_TOKEN, TENANT_A, 'worker-a', 'worker'),
      tokenConfig('worker-b', WORKER_B_TOKEN, TENANT_B, 'worker-b', 'worker'),
    ],
    sessionSecret: 'better-auth-tenant-acceptance-session-secret',
    publicOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  await auth.ready();

  const index = new StateSemanticIndex({ repository, profile: PROFILE });
  const reviews = createReviewPersistenceService(repository);
  const provider = embeddingProvider();

  const registries = new Map<TenantId, RegistryHandler>();
  const reviewers = new Map<TenantId, IntelligenceHandler>([
    [TENANT_A, createIntelligenceHandler({
      repository,
      blobs,
      authenticate: auth,
      organizationId: TENANT_A,
      publicOrigin: ORIGIN,
      reviewerToken: EVE_A_TOKEN,
      embeddingProvider: provider,
      index,
      reviewService: reviews,
      triggerReview: async () => ({ sessionId: 'fixture-eve-session-a', status: 'started' }),
    })],
    [TENANT_B, createIntelligenceHandler({
      repository,
      blobs,
      authenticate: auth,
      organizationId: TENANT_B,
      publicOrigin: ORIGIN,
      reviewerToken: EVE_B_TOKEN,
      embeddingProvider: provider,
      index,
      reviewService: reviews,
      triggerReview: async () => ({ sessionId: 'fixture-eve-session-b', status: 'started' }),
    })],
  ]);

  for (const organizationId of [TENANT_A, TENANT_B] as const) {
    const registry = createRegistryHandler({ repository, blobs, auth, config: config(organizationId) });
    const intelligence = reviewers.get(organizationId)!;
    registries.set(organizationId, async (incoming) => await intelligence(incoming) ?? registry(incoming));
  }

  const requestRuntime = async (incoming: Request): Promise<Response> => {
    const path = new URL(incoming.url).pathname;
    const requestedOrganization = incoming.headers.get('x-organization-id');

    if (path.startsWith('/internal/reviewer/')) {
      const reviewerOrganization = presentedToken(incoming) === EVE_A_TOKEN
        ? TENANT_A
        : presentedToken(incoming) === EVE_B_TOKEN
          ? TENANT_B
          : undefined;
      if (reviewerOrganization === undefined) return denial(401, 'REVIEWER_UNAUTHORIZED');
      if (requestedOrganization !== null && requestedOrganization !== reviewerOrganization) {
        return denial(403, 'TENANT_CONTEXT_MISMATCH');
      }
      return (await reviewers.get(reviewerOrganization)!(incoming)) ?? denial(404, 'ROUTE_NOT_FOUND');
    }

    // Session exchange has the token in its body, so resolve the company from
    // a cloned body before forwarding the original Request to the registry.
    if (path === '/auth/session' && incoming.method.toUpperCase() === 'POST') {
      let token: unknown;
      try {
        const parsed = await incoming.clone().json() as { token?: unknown };
        token = parsed.token;
      } catch {
        return denial(400, 'INVALID_TOKEN');
      }
      if (typeof token !== 'string') return denial(401, 'UNAUTHORIZED');
      const tokenRequest = new Request(incoming.url, { headers: { authorization: `Bearer ${token}` } });
      const principal = await auth.authenticate(tokenRequest);
      if (!principal || principal.identity !== 'user') return denial(401, 'UNAUTHORIZED');
      if (requestedOrganization !== null && requestedOrganization !== principal.organizationId) {
        return denial(403, 'TENANT_CONTEXT_MISMATCH');
      }
      return registries.get(principal.organizationId as TenantId)?.(incoming) ?? denial(403, 'TENANT_CONTEXT_MISMATCH');
    }

    if (path === '/health') return registries.get(TENANT_A)!(incoming);
    const principal = await auth.authenticate(incoming);
    if (!principal) return denial(401, 'UNAUTHORIZED');
    if (requestedOrganization !== null && requestedOrganization !== principal.organizationId) {
      return denial(403, 'TENANT_CONTEXT_MISMATCH');
    }
    return registries.get(principal.organizationId as TenantId)?.(incoming) ?? denial(403, 'TENANT_CONTEXT_MISMATCH');
  };

  return {
    request: requestRuntime,
    repository,
    blobs,
    close: async () => {
      await rm(root, { recursive: true, force: true });
      await sql.unsafe(`DROP TABLE "${tableName}"`);
      await sql.end({ timeout: 1 });
    },
  };
}

async function publishAndApprove(
  runtime: TenantRuntime,
  organizationId: TenantId,
  userToken: string,
  workerToken: string,
  options: { name?: string; description?: string; bundleName?: string } = {},
): Promise<PublishedFixture> {
  const name = options.name ?? SHARED_SKILL_NAME;
  const description = options.description ?? SHARED_DESCRIPTION;
  const bundleName = options.bundleName ?? name.slice(name.indexOf('/') + 1);
  const publish = await runtime.request(jsonRequest('/v1/publish', {
    method: 'POST',
    headers: bearer(userToken, organizationId),
    json: {
      name,
      version: '1.0.0',
      description,
      bundle: bundleFor(bundleName, description),
    },
  }));
  expect(publish.status).toBe(202);
  const queued = (await body<{ operation: Job }>(publish)).operation;
  const claim = await runtime.request(jsonRequest('/internal/jobs/claim', {
    method: 'POST',
    headers: bearer(workerToken, organizationId),
  }));
  expect(claim.status).toBe(200);
  const claimed = (await body<{ job: Job }>(claim)).job;
  expect(claimed.id).toBe(queued.id);

  const complete = await runtime.request(jsonRequest(`/internal/jobs/${encodeURIComponent(queued.id)}/complete`, {
    method: 'POST',
    headers: bearer(workerToken, organizationId),
    json: {
      leaseToken: claimed.leaseToken,
      scanResults: [scannerResult(
        queued.artifact!.digest,
        queued.id,
        'cisco-skill-scanner',
        'completed',
        organizationId,
        'two-tenant-postgres-acceptance',
      )],
    },
  }));
  expect(complete.status).toBe(200);

  const detail = await runtime.request(request(`/v1/skills/${encodeURIComponent(queued.resourceId!)}`, {
    headers: bearer(userToken, organizationId),
  }));
  expect(detail.status).toBe(200);
  const skill = (await body<{ skill: SkillVersion }>(detail)).skill;
  expect(skill.state).toBe('approved');
  return { job: queued, skill };
}

async function importAndApprove(
  runtime: TenantRuntime,
  organizationId: TenantId,
  userToken: string,
  workerToken: string,
  name: string,
  upstreamName: string,
): Promise<PublishedFixture> {
  const upstreamResponse = await runtime.request(jsonRequest('/v1/upstreams', {
    method: 'POST',
    headers: bearer(userToken, organizationId),
    json: {
      name: upstreamName,
      kind: 'registry',
      namespace: '@acme',
      // The worker completion below is inline and never fetches this URL.
      baseUrl: 'https://fixture.invalid',
    },
  }));
  expect(upstreamResponse.status).toBe(201);
  const upstream = (await body<{ upstream: { id: string } }>(upstreamResponse)).upstream;
  const bundle = bundleFor(name.slice(name.indexOf('/') + 1), `Imported ${name}`);
  const queuedResponse = await runtime.request(jsonRequest('/v1/imports', {
    method: 'POST',
    headers: bearer(userToken, organizationId),
    json: {
      upstreamId: upstream.id,
      repository: 'https://fixture.invalid',
      path: `skills/${name.slice(name.indexOf('/') + 1)}`,
      name,
      version: '1.0.0',
    },
  }));
  expect(queuedResponse.status).toBe(202);
  const queued = (await body<{ operation: Job }>(queuedResponse)).operation;
  const claimResponse = await runtime.request(jsonRequest('/internal/jobs/claim', {
    method: 'POST',
    headers: bearer(workerToken, organizationId),
  }));
  expect(claimResponse.status).toBe(200);
  const claimed = (await body<{ job: Job }>(claimResponse)).job;
  expect(claimed.id).toBe(queued.id);
  const bytes = encodeBundle(bundle);
  const digest = await digestBytes(bytes);
  const completeResponse = await runtime.request(jsonRequest(`/internal/jobs/${encodeURIComponent(queued.id)}/complete`, {
    method: 'POST',
    headers: bearer(workerToken, organizationId),
    json: {
      leaseToken: claimed.leaseToken,
      artifactDigest: digest,
      bundle,
      provenance: {
        kind: 'registry',
        upstreamId: upstream.id,
        repository: 'https://fixture.invalid',
        path: `skills/${name.slice(name.indexOf('/') + 1)}`,
        revision: digest,
      },
      scanResults: [scannerResult(
        digest,
        queued.id,
        'cisco-skill-scanner',
        'completed',
        organizationId,
        'two-tenant-postgres-acceptance',
      )],
    },
  }));
  expect(completeResponse.status).toBe(200);
  const completed = (await body<{ operation: Job }>(completeResponse)).operation;
  expect(completed.state).toBe('completed');
  const operation = await runtime.request(request(`/v1/operations/${encodeURIComponent(queued.id)}`, {
    headers: bearer(userToken, organizationId),
  }));
  expect(operation.status).toBe(200);
  const resourceId = (await body<{ operation: Job }>(operation)).operation.resourceId;
  expect(resourceId).toBeTypeOf('string');
  const detail = await runtime.request(request(`/v1/skills/${encodeURIComponent(resourceId!)}`, {
    headers: bearer(userToken, organizationId),
  }));
  expect(detail.status).toBe(200);
  const skill = (await body<{ skill: SkillVersion }>(detail)).skill;
  expect(skill.state).toBe('approved');
  expect(skill.artifact.digest).toBe(digest);
  return { job: queued, skill };
}

const local = describe.skipIf(!POSTGRES_ENABLED);

local('PostgreSQL multi-tenant acceptance boundary', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('keeps populated skills, packs, files, drafts, imports, scans, downloads, search, analytics, tokens, and Eve callbacks tenant-scoped', async () => {
    const runtime = await createTenantRuntime();
    cleanups.push(runtime.close);

    const [tenantA, tenantB] = await Promise.all([
      publishAndApprove(runtime, TENANT_A, USER_A_TOKEN, WORKER_A_TOKEN),
      publishAndApprove(runtime, TENANT_B, USER_B_TOKEN, WORKER_B_TOKEN),
    ]);
    const [importA, importB] = await Promise.all([
      importAndApprove(runtime, TENANT_A, USER_A_TOKEN, WORKER_A_TOKEN, '@acme/import-a', 'source-a'),
      importAndApprove(runtime, TENANT_B, USER_B_TOKEN, WORKER_B_TOKEN, '@acme/import-b', 'source-b'),
    ]);
    expect(tenantA.skill.name).toBe(SHARED_SKILL_NAME);
    expect(tenantB.skill.name).toBe(SHARED_SKILL_NAME);
    expect(tenantA.skill.id).not.toBe(tenantB.skill.id);
    expect(tenantA.skill.artifact.digest).toBe(tenantB.skill.artifact.digest);
    expect(tenantA.skill.artifact.key).not.toBe(tenantB.skill.artifact.key);
    expect(importA.skill.artifact.digest).not.toBe(importB.skill.artifact.digest);

    const listA = await runtime.request(request('/v1/skills?q=shared-tenant-skill', {
      headers: bearer(USER_A_TOKEN, TENANT_A),
    }));
    const listB = await runtime.request(request('/v1/skills?q=shared-tenant-skill', {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(listA.status).toBe(200);
    expect(listB.status).toBe(200);
    expect((await body<{ skills: SkillVersion[] }>(listA)).skills.map((skill) => skill.id)).toEqual([tenantA.skill.id]);
    expect((await body<{ skills: SkillVersion[] }>(listB)).skills.map((skill) => skill.id)).toEqual([tenantB.skill.id]);

    // Files are read only after the tenant-scoped release has been admitted;
    // a foreign release ID must fail before the shared Files SDK is touched.
    const filesA = await runtime.request(request(`/v1/skills/${encodeURIComponent(tenantA.skill.id)}/files`, {
      headers: bearer(USER_A_TOKEN, TENANT_A),
    }));
    expect(filesA.status).toBe(200);
    expect((await body<{ files: Array<{ path: string }> }>(filesA)).files.map((file) => file.path)).toEqual(expect.arrayContaining(['README.md', 'SKILL.md']));
    const foreignFiles = await runtime.request(request(`/v1/skills/${encodeURIComponent(tenantA.skill.id)}/files`, {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(foreignFiles.status).toBe(404);

    const resolutionResponse = await runtime.request(jsonRequest('/v1/resolve', {
      method: 'POST',
      headers: bearer(USER_A_TOKEN, TENANT_A),
      json: { kind: 'skill', ref: SHARED_SKILL_NAME, version: '1.0.0' },
    }));
    expect(resolutionResponse.status).toBe(200);
    const resolution = (await body<{ resolution: Resolution }>(resolutionResponse)).resolution;
    expect(resolution.organizationId).toBe(TENANT_A);
    expect(resolution.resourceId).toBe(tenantA.skill.id);

    const authorizationResponse = await runtime.request(jsonRequest('/v1/install-authorizations', {
      method: 'POST',
      headers: bearer(USER_A_TOKEN, TENANT_A),
      json: { resolution },
    }));
    expect(authorizationResponse.status).toBe(201);
    const authorization = (await body<{ authorization: InstallAuthorization }>(authorizationResponse)).authorization;

    const packResponses = await Promise.all([
      runtime.request(jsonRequest('/v1/packs', {
        method: 'POST',
        headers: bearer(USER_A_TOKEN, TENANT_A),
        json: { name: '@acme/pack-a', version: '1.0.0', description: 'Tenant A pack', skills: [{ ref: SHARED_SKILL_NAME, version: '1.0.0' }] },
      })),
      runtime.request(jsonRequest('/v1/packs', {
        method: 'POST',
        headers: bearer(USER_B_TOKEN, TENANT_B),
        json: { name: '@acme/pack-b', version: '1.0.0', description: 'Tenant B pack', skills: [{ ref: SHARED_SKILL_NAME, version: '1.0.0' }] },
      })),
    ]);
    expect(packResponses[0].status).toBe(201);
    expect(packResponses[1].status).toBe(201);
    const packA = (await body<{ pack: PackVersion }>(packResponses[0])).pack;
    const packB = (await body<{ pack: PackVersion }>(packResponses[1])).pack;
    expect(packA.members[0]?.resourceId).toBe(tenantA.skill.id);
    expect(packB.members[0]?.resourceId).toBe(tenantB.skill.id);
    const foreignPack = await runtime.request(request(`/v1/packs/${encodeURIComponent(packA.id)}`, {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(foreignPack.status).toBe(404);

    type DraftView = { id: string; revision: number; digest: string; files: Array<{ path: string }> };
    const createDraft = async (organizationId: TenantId, userToken: string, skill: SkillVersion, label: string): Promise<{ created: DraftView; updated: DraftView }> => {
      const createHeaders = bearer(userToken, organizationId);
      createHeaders.set('idempotency-key', `draft-create-${label}`);
      const createdResponse = await runtime.request(jsonRequest(`/v1/skills/${encodeURIComponent(skill.id)}/drafts`, {
        method: 'POST',
        headers: createHeaders,
        json: { baseDigest: skill.artifact.digest },
      }));
      expect(createdResponse.status).toBe(201);
      const created = (await body<{ draft: DraftView }>(createdResponse)).draft;
      const updatedBundle = bundleFor(skill.skillName, `Edited ${label}`);
      const updateHeaders = bearer(userToken, organizationId);
      updateHeaders.set('idempotency-key', `draft-update-${label}`);
      const updatedResponse = await runtime.request(jsonRequest(`/v1/drafts/${encodeURIComponent(created.id)}`, {
        method: 'PUT',
        headers: updateHeaders,
        json: { expectedRevision: 1, files: updatedBundle.files },
      }));
      expect(updatedResponse.status).toBe(200);
      const updated = (await body<{ draft: DraftView }>(updatedResponse)).draft;
      expect(updated.revision).toBe(2);
      return { created, updated };
    };
    const [draftA, draftB] = await Promise.all([
      createDraft(TENANT_A, USER_A_TOKEN, tenantA.skill, 'tenant-a'),
      createDraft(TENANT_B, USER_B_TOKEN, tenantB.skill, 'tenant-b'),
    ]);
    const draftFile = await runtime.request(request(`/v1/drafts/${encodeURIComponent(draftA.updated.id)}/files?path=SKILL.md&revision=2&digest=${encodeURIComponent(draftA.updated.digest)}`, {
      headers: bearer(USER_A_TOKEN, TENANT_A),
    }));
    expect(draftFile.status).toBe(200);
    expect((await body<{ file: { path: string; content?: string } }>(draftFile)).file).toMatchObject({ path: 'SKILL.md', content: expect.any(String) });
    const foreignDraft = await runtime.request(request(`/v1/drafts/${encodeURIComponent(draftA.updated.id)}`, {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(foreignDraft.status).toBe(404);
    const foreignDraftFile = await runtime.request(request(`/v1/drafts/${encodeURIComponent(draftA.updated.id)}/files?path=SKILL.md&revision=2&digest=${encodeURIComponent(draftA.updated.digest)}`, {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(foreignDraftFile.status).toBe(404);

    // The source import is completed with an inline deterministic bundle. The
    // configured fixture URL is never fetched, so this remains a local test.
    const foreignOperation = await runtime.request(request(`/v1/operations/${encodeURIComponent(importA.job.id)}`, {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(foreignOperation.status).toBe(404);
    const scansA = await runtime.request(request(`/v1/scans?artifactDigest=${encodeURIComponent(importA.skill.artifact.digest)}`, {
      headers: bearer(USER_A_TOKEN, TENANT_A),
    }));
    expect(scansA.status).toBe(200);
    expect((await body<{ scans: Array<{ organizationId: string; artifactDigest: string }> }>(scansA)).scans).toEqual([
      expect.objectContaining({ organizationId: TENANT_A, artifactDigest: importA.skill.artifact.digest }),
    ]);
    const foreignScans = await runtime.request(request(`/v1/scans?artifactDigest=${encodeURIComponent(importA.skill.artifact.digest)}`, {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(foreignScans.status).toBe(200);
    expect((await body<{ scans: unknown[] }>(foreignScans)).scans).toEqual([]);

    const descriptor = await runtime.request(jsonRequest(`/v1/artifacts/${encodeURIComponent(tenantA.skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: bearer(USER_A_TOKEN, TENANT_A),
      json: { resourceId: tenantA.skill.id, authorizationId: authorization.id },
    }));
    expect(descriptor.status).toBe(200);
    const transferPath = new URL((await body<{ url: string }>(descriptor)).url).pathname;
    const blobReads = vi.spyOn(runtime.blobs, 'get');
    try {
      const foreignAuthorization = await runtime.request(jsonRequest('/v1/install-authorizations', {
        method: 'POST',
        headers: bearer(USER_B_TOKEN, TENANT_B),
        json: { resolution },
      }));
      expect(foreignAuthorization.status).toBe(404);
      expect(await foreignAuthorization.text()).not.toContain(tenantA.skill.artifact.digest);
      const foreignGrant = await runtime.request(jsonRequest(`/v1/artifacts/${encodeURIComponent(tenantA.skill.artifact.digest)}/download`, {
        method: 'POST',
        headers: bearer(USER_B_TOKEN, TENANT_B),
        json: { resourceId: tenantA.skill.id, authorizationId: authorization.id },
      }));
      expect(foreignGrant.status).toBe(404);
      const foreignTransfer = await runtime.request(request(transferPath, {
        headers: bearer(USER_B_TOKEN, TENANT_B),
      }));
      expect(foreignTransfer.status).toBe(404);
      expect(await foreignTransfer.text()).not.toContain(tenantA.skill.artifact.digest);
      expect(blobReads).not.toHaveBeenCalled();
    } finally {
      blobReads.mockRestore();
    }
    const downloaded = await runtime.request(request(transferPath, {
      headers: bearer(USER_A_TOKEN, TENANT_A),
    }));
    expect(downloaded.status).toBe(200);
    expect(await downloaded.arrayBuffer()).toEqual(encodeBundle(bundleFor('shared-tenant-skill', SHARED_DESCRIPTION)).buffer);

    const receipt = await runtime.request(jsonRequest('/v1/install-receipts', {
      method: 'POST',
      headers: bearer(USER_A_TOKEN, TENANT_A),
      json: { authorizationId: authorization.id, changed: true, agent: 'codex', platform: 'linux', clientVersion: 'l10-fixture' },
    }));
    expect(receipt.status).toBe(201);
    const resolutionBResponse = await runtime.request(jsonRequest('/v1/resolve', {
      method: 'POST',
      headers: bearer(USER_B_TOKEN, TENANT_B),
      json: { kind: 'skill', ref: importB.skill.name, version: importB.skill.version },
    }));
    expect(resolutionBResponse.status).toBe(200);
    const resolutionB = (await body<{ resolution: Resolution }>(resolutionBResponse)).resolution;
    const authorizationBResponse = await runtime.request(jsonRequest('/v1/install-authorizations', {
      method: 'POST',
      headers: bearer(USER_B_TOKEN, TENANT_B),
      json: { resolution: resolutionB },
    }));
    expect(authorizationBResponse.status).toBe(201);
    const authorizationB = (await body<{ authorization: InstallAuthorization }>(authorizationBResponse)).authorization;
    const receiptB = await runtime.request(jsonRequest('/v1/install-receipts', {
      method: 'POST',
      headers: bearer(USER_B_TOKEN, TENANT_B),
      json: { authorizationId: authorizationB.id, changed: true, agent: 'codex', platform: 'linux', clientVersion: 'l10-fixture' },
    }));
    expect(receiptB.status).toBe(201);
    const analyticsA = await runtime.request(request('/v1/analytics?days=1', {
      headers: bearer(USER_A_TOKEN, TENANT_A),
    }));
    const analyticsB = await runtime.request(request('/v1/analytics?days=1', {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(analyticsA.status).toBe(200);
    expect(analyticsB.status).toBe(200);
    const analyticsBodyA = await body<{ totals: { installOperations: number }; topSkills: Array<{ resourceId: string }> }>(analyticsA);
    const analyticsBodyB = await body<{ totals: { installOperations: number }; topSkills: Array<{ resourceId: string }> }>(analyticsB);
    expect(analyticsBodyA.totals.installOperations).toBe(1);
    expect(analyticsBodyA.topSkills.map((skill) => skill.resourceId)).toEqual([tenantA.skill.id]);
    expect(analyticsBodyB.totals.installOperations).toBe(1);
    expect(analyticsBodyB.topSkills.map((skill) => skill.resourceId)).toEqual([importB.skill.id]);

    const searchReindex = await Promise.all([
      runtime.request(jsonRequest('/v1/search/reindex', { method: 'POST', headers: bearer(USER_A_TOKEN, TENANT_A) })),
      runtime.request(jsonRequest('/v1/search/reindex', { method: 'POST', headers: bearer(USER_B_TOKEN, TENANT_B) })),
    ]);
    expect(searchReindex[0].status).toBe(200);
    expect(searchReindex[1].status).toBe(200);
    expect((await body<{ indexed: number }>(searchReindex[0])).indexed).toBe(2);
    expect((await body<{ indexed: number }>(searchReindex[1])).indexed).toBe(2);
    const searchA = await runtime.request(request('/v1/search?q=shared', { headers: bearer(USER_A_TOKEN, TENANT_A) }));
    const searchB = await runtime.request(request('/v1/search?q=shared', { headers: bearer(USER_B_TOKEN, TENANT_B) }));
    expect(searchA.status).toBe(200);
    expect(searchB.status).toBe(200);
    const searchIdsA = (await body<{ results: Array<{ resourceId: string }> }>(searchA)).results.map((result) => result.resourceId);
    const searchIdsB = (await body<{ results: Array<{ resourceId: string }> }>(searchB)).results.map((result) => result.resourceId);
    expect(searchIdsA).toEqual(expect.arrayContaining([tenantA.skill.id, importA.skill.id]));
    expect(searchIdsB).toEqual(expect.arrayContaining([tenantB.skill.id, importB.skill.id]));
    expect(searchIdsA).not.toContain(tenantB.skill.id);
    expect(searchIdsA).not.toContain(importB.skill.id);
    expect(searchIdsB).not.toContain(tenantA.skill.id);
    expect(searchIdsB).not.toContain(importA.skill.id);

    const eveRun = await runtime.request(jsonRequest('/v1/reviews/run', {
      method: 'POST',
      headers: bearer(USER_A_TOKEN, TENANT_A),
      json: {},
    }));
    expect(eveRun.status).toBe(202);
    const evePrepare = await runtime.request(jsonRequest('/internal/reviewer/prepare', {
      method: 'POST',
      headers: bearer(EVE_A_TOKEN, TENANT_A),
      json: { model: 'fixture-eve', eveSessionId: 'eve-session-a' },
    }));
    expect(evePrepare.status).toBe(200);
    const prepared = await body<{ runId: string; leaseToken: string; candidates: Array<{ resourceId: string }> }>(evePrepare);
    expect(prepared.candidates.map((candidate) => candidate.resourceId)).toEqual(expect.arrayContaining([tenantA.skill.id, importA.skill.id]));
    const eveComplete = await runtime.request(jsonRequest('/internal/reviewer/complete', {
      method: 'POST',
      headers: bearer(EVE_A_TOKEN, TENANT_A),
      json: {
        runId: prepared.runId,
        leaseToken: prepared.leaseToken,
        summary: 'Tenant A fixture review',
        suggestions: [{
          skillIds: [tenantA.skill.id, importA.skill.id],
          title: 'Tenant A overlap',
          rationale: 'Both fixture skills are tenant A resources.',
          overlap: ['Both are tenant A fixtures.'],
          differences: ['They came from different local paths.'],
          mergePlan: ['Keep both tenant A resources.'],
          similarity: 0.8,
        }],
      },
    }));
    expect(eveComplete.status).toBe(200);
    const eveAHeaderSpoof = await runtime.request(jsonRequest('/internal/reviewer/prepare', {
      method: 'POST',
      headers: bearer(EVE_A_TOKEN, TENANT_B),
      json: { model: 'fixture-eve' },
    }));
    expect(eveAHeaderSpoof.status).toBe(403);
    const eveBOnA = await runtime.request(jsonRequest('/internal/reviewer/prepare', {
      method: 'POST',
      headers: bearer(EVE_B_TOKEN, TENANT_A),
      json: { model: 'fixture-eve' },
    }));
    expect(eveBOnA.status).toBe(403);
    const reviewsB = await runtime.request(request('/v1/reviews', {
      headers: bearer(USER_B_TOKEN, TENANT_B),
    }));
    expect(reviewsB.status).toBe(200);
    expect((await body<{ suggestions: unknown[] }>(reviewsB)).suggestions).toEqual([]);

    const spoofedHeader = await runtime.request(request('/v1/skills', {
      headers: bearer(USER_A_TOKEN, TENANT_B),
    }));
    expect(spoofedHeader.status).toBe(403);
    const userOnWorkerRoute = await runtime.request(request('/internal/jobs/claim', {
      method: 'POST',
      headers: bearer(USER_A_TOKEN, TENANT_A),
    }));
    expect(userOnWorkerRoute.status).toBe(403);
    const workerOnUserRoute = await runtime.request(request('/v1/me', {
      headers: bearer(WORKER_A_TOKEN, TENANT_A),
    }));
    expect(workerOnUserRoute.status).toBe(403);
    const workerHeaderSpoof = await runtime.request(request('/internal/jobs/claim', {
      method: 'POST',
      headers: bearer(WORKER_A_TOKEN, TENANT_B),
    }));
    expect(workerHeaderSpoof.status).toBe(403);

    const sessionExchange = await runtime.request(jsonRequest('/auth/session', {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-organization-id': TENANT_A },
      json: { token: USER_A_TOKEN },
    }));
    expect(sessionExchange.status).toBe(200);
    const setCookie = sessionExchange.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    const sessionCookie = setCookie!.split(';', 1)[0]!;
    const sessionMe = await runtime.request(request('/v1/me', { headers: { cookie: sessionCookie } }));
    expect(sessionMe.status).toBe(200);
    expect((await body<{ organizationId: string }>(sessionMe)).organizationId).toBe(TENANT_A);
    const sessionSpoof = await runtime.request(request('/v1/me', {
      headers: { cookie: sessionCookie, 'x-organization-id': TENANT_B },
    }));
    expect(sessionSpoof.status).toBe(403);

    const stateA = await runtime.repository.read(TENANT_A);
    const stateB = await runtime.repository.read(TENANT_B);
    expect(stateA.skills).toHaveLength(2);
    expect(stateB.skills).toHaveLength(2);
    expect(stateA.packs).toHaveLength(1);
    expect(stateB.packs).toHaveLength(1);
    expect(stateA.drafts).toHaveLength(1);
    expect(stateB.drafts).toHaveLength(1);
    expect(stateA.upstreams).toHaveLength(1);
    expect(stateB.upstreams).toHaveLength(1);
    expect(stateA.scans).toHaveLength(2);
    expect(stateB.scans).toHaveLength(2);
    expect(stateA.grants).toHaveLength(1);
    expect(stateB.grants).toHaveLength(0);
    expect(stateA.installReceipts).toHaveLength(1);
    expect(stateB.installReceipts).toHaveLength(1);
    const persistedSearchA = (stateA as typeof stateA & { search?: { documents: Array<{ organizationId: string }> } }).search;
    const persistedSearchB = (stateB as typeof stateB & { search?: { documents: Array<{ organizationId: string }> } }).search;
    expect(persistedSearchA?.documents.map((document) => document.organizationId)).toEqual([TENANT_A, TENANT_A]);
    expect(persistedSearchB?.documents.map((document) => document.organizationId)).toEqual([TENANT_B, TENANT_B]);
  });
});
