import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TokenAuthenticator, type BootstrapTokenConfig } from '../../packages/auth/src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../packages/database/src/index.js';
import { createRegistryHandler, type RegistryDirectoryClient, type RegistryHandler } from '../../packages/core/src/index.js';
import type {
  Feed,
  Job,
  Policy,
  RegistryConfiguration,
  Resolution,
  TransferDescriptor,
} from '../../packages/contracts/src/index.js';
import type { SkillDetailResponse, V1Skill } from '../../packages/directory/src/types.js';
import { createNodeFilesSdkBlobStore } from '../../packages/storage/src/node.js';
import { digestBytes } from '../../packages/storage/src/index.js';
import type { ScannerAdapter } from '../../packages/scanners/src/types.js';
import type { FetchLike } from '../../packages/upstreams/src/index.js';
import { WorkerRunner, type WorkerRunnerOptions } from '../../workers/runner/src/index.js';

// The source adapter validates DNS before it invokes the injected fetch. The
// fixture stays offline while the production SSRF checks remain enabled.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
}));

const ORIGIN = 'https://source-tenant-isolation.test';
const TENANT_A = 'source-tenant-a';
const TENANT_B = 'source-tenant-b';
const USER_A_TOKEN = 'source-tenant-a-user-token';
const USER_B_TOKEN = 'source-tenant-b-user-token';
const WORKER_A_TOKEN = 'source-tenant-a-worker-token';
const WORKER_B_TOKEN = 'source-tenant-b-worker-token';
const CATALOG_A = 'http://127.0.0.1:55161/catalog/a';
const CATALOG_B = 'http://127.0.0.1:55161/catalog/b';
const CATALOG_TOKEN_A = 'catalog-token-tenant-a';
const CATALOG_TOKEN_B = 'catalog-token-tenant-b';
const SOURCE = 'acme/shared-repo';
const SLUG = 'shared-skill';
const EXTERNAL_ID = `${SOURCE}/${SLUG}`;
const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const SKILL = `---\nname: ${SLUG}\ndescription: A harmless tenant fixture.\n---\n\nNever execute this fixture.\n`;
const README = `# ${SLUG}\n`;

const policy: Policy = {
  revision: 'source-tenant-required',
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function blobSha(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]))
    .digest('hex');
}

function scanner(): ScannerAdapter {
  return {
    id: 'skillsguard',
    command: 'deterministic-local-fixture-scanner',
    metadata: {
      id: 'skillsguard',
      version: 'fixture',
      engineVersion: 'fixture',
      rulesRevision: 'fixture',
    },
    scan: async (input) => {
      const entries = await readdir(input.inputDir, { withFileTypes: true });
      const fileCount = entries.filter((entry) => entry.isFile()).length;
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
            filesEnumerated: fileCount,
            filesAnalyzed: fileCount,
            filesSkipped: 0,
            filesUnsupported: 0,
            limitations: ['deterministic local fixture scanner; no third-party provider was invoked'],
            externalDestinations: [],
          },
          findings: [],
        },
      };
    },
  };
}

function headers(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function body<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function call(
  handler: RegistryHandler,
  path: string,
  token: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, ...requestInit } = init;
  const requestHeaders = new Headers(requestInit.headers ?? headers(token));
  if (!requestHeaders.has('authorization')) requestHeaders.set('authorization', `Bearer ${token}`);
  if (json !== undefined) {
    requestInit.body = JSON.stringify(json);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
  }
  return handler(new Request(new URL(path, ORIGIN), { ...requestInit, headers: requestHeaders }));
}

function catalogDetail(): SkillDetailResponse {
  return {
    id: EXTERNAL_ID,
    source: SOURCE,
    slug: SLUG,
    installs: 1,
    hash: null,
    files: null,
  };
}

function sourceRow(): V1Skill {
  return {
    id: EXTERNAL_ID,
    source: SOURCE,
    slug: SLUG,
    name: SLUG,
    installs: 1,
    sourceType: 'github',
    installUrl: `https://github.com/${SOURCE}`,
    url: `https://skills.sh/${EXTERNAL_ID}`,
  };
}

function sourceFetchFixture(): {
  fetch: FetchLike;
  calls: Array<{ origin: string; path: string; authorization?: string }>;
} {
  const skillSha = blobSha(SKILL);
  const readmeSha = blobSha(README);
  const calls: Array<{ origin: string; path: string; authorization?: string }> = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    calls.push({ origin: url.origin, path: `${url.pathname}${url.search}`, ...(authorization ? { authorization } : {}) });

    const catalogBase = url.pathname.startsWith('/catalog/a/') ? CATALOG_A : url.pathname.startsWith('/catalog/b/') ? CATALOG_B : undefined;
    if (catalogBase && url.pathname === `${new URL(catalogBase).pathname}/api/v1/skills/${EXTERNAL_ID.split('/').map(encodeURIComponent).join('/')}`) {
      const expected = catalogBase === CATALOG_A ? `Bearer ${CATALOG_TOKEN_A}` : `Bearer ${CATALOG_TOKEN_B}`;
      expect(authorization).toBe(expected);
      return jsonResponse({ ...catalogDetail(), ...sourceRow() });
    }

    if (url.origin === 'https://api.github.com') {
      // A catalog credential is scoped to the catalog API. It must not reach
      // the physical public GitHub source or any of its blob requests.
      expect(authorization).toBeUndefined();
      if (url.pathname === `/repos/${SOURCE}`) return jsonResponse({ default_branch: 'main' });
      if (url.pathname === `/repos/${SOURCE}/commits/main`) return jsonResponse({ sha: COMMIT });
      if (url.pathname === `/repos/${SOURCE}/git/trees/${COMMIT}` && url.searchParams.get('recursive') === '1') {
        return jsonResponse({
          sha: COMMIT,
          truncated: false,
          tree: [
            { path: 'skills/shared-skill', type: 'tree', mode: '040000', sha: TREE },
            { path: 'skills/shared-skill/SKILL.md', type: 'blob', mode: '100644', sha: skillSha, size: Buffer.byteLength(SKILL) },
            { path: 'skills/shared-skill/README.md', type: 'blob', mode: '100644', sha: readmeSha, size: Buffer.byteLength(README) },
          ],
        });
      }
      const blobPrefix = `/repos/${SOURCE}/git/blobs/`;
      if (url.pathname === `${blobPrefix}${skillSha}`) return jsonResponse({ content: Buffer.from(SKILL).toString('base64'), encoding: 'base64', size: Buffer.byteLength(SKILL), sha: skillSha });
      if (url.pathname === `${blobPrefix}${readmeSha}`) return jsonResponse({ content: Buffer.from(README).toString('base64'), encoding: 'base64', size: Buffer.byteLength(README), sha: readmeSha });
    }

    throw new Error(`unexpected source fixture request ${init?.method ?? 'GET'} ${url.origin}${url.pathname}${url.search}`);
  });
  return { fetch: fetch as unknown as FetchLike, calls };
}

describe('tenant-scoped transparent source acquisition', () => {
  let blobRoot: string | undefined;

  afterEach(async () => {
    if (blobRoot !== undefined) await rm(blobRoot, { recursive: true, force: true });
    blobRoot = undefined;
  });

  it('keeps cold jobs, catalog credentials, warm cache, and grants tenant-scoped', async () => {
    const repository = createMemoryStateRepository({
      stateFactory: () => ({
        ...defaultRegistryState({ production: false, allowUnscanned: false, policyRevision: policy.revision }),
        policy: structuredClone(policy),
      }),
    });
    blobRoot = await mkdtemp(join(tmpdir(), 'private-skills-source-tenants-'));
    const blobs = await createNodeFilesSdkBlobStore({ provider: 'fs', root: blobRoot, prefix: 'private-registry' });

    const tokenConfigs: BootstrapTokenConfig[] = [
      { id: 'source-a-user', token: USER_A_TOKEN, organizationId: TENANT_A, subject: 'source-a-user', roles: ['owner', 'admin', 'publisher', 'reader'], namespaces: ['@acme'], scopes: ['registry:*'] },
      { id: 'source-b-user', token: USER_B_TOKEN, organizationId: TENANT_B, subject: 'source-b-user', roles: ['owner', 'admin', 'publisher', 'reader'], namespaces: ['@acme'], scopes: ['registry:*'] },
    ];
    const workerConfigs: BootstrapTokenConfig[] = [
      { id: 'source-a-worker', token: WORKER_A_TOKEN, organizationId: TENANT_A, subject: 'source-a-worker', roles: ['worker'], kind: 'worker', worker: true, scopes: ['jobs:*'] },
      { id: 'source-b-worker', token: WORKER_B_TOKEN, organizationId: TENANT_B, subject: 'source-b-worker', roles: ['worker'], kind: 'worker', worker: true, scopes: ['jobs:*'] },
    ];
    const auth = new TokenAuthenticator({
      environment: 'test',
      tokens: tokenConfigs,
      workerTokens: workerConfigs,
      sessionSecret: 'source-tenant-session-secret-that-is-long-enough',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    });
    await auth.ready();

    const directoryCalls = new Map<string, number>([[CATALOG_A, 0], [CATALOG_B, 0]]);
    const directory: RegistryDirectoryClient = {
      detail: async () => catalogDetail(),
      search: async (options) => {
        const base = options.q === SLUG ? CATALOG_A : CATALOG_B;
        directoryCalls.set(base, (directoryCalls.get(base) ?? 0) + 1);
        return { data: [sourceRow()], query: options.q, searchType: 'fuzzy', count: 1, durationMs: 1 };
      },
      list: async () => ({ data: [sourceRow()], pagination: { page: 0, perPage: 500, total: 1, hasMore: false } }),
      curated: async () => ({ data: [], totalOwners: 0, totalSkills: 0, generatedAt: new Date(0).toISOString() }),
      audit: async () => ({ id: EXTERNAL_ID, source: SOURCE, slug: SLUG, audits: [] }),
    };
    const directoryForBase = (base: string): RegistryDirectoryClient | undefined => {
      if (base === CATALOG_A || base === CATALOG_B) return {
        ...directory,
        detail: async () => {
          directoryCalls.set(base, (directoryCalls.get(base) ?? 0) + 1);
          return catalogDetail();
        },
        search: async (options) => {
          directoryCalls.set(base, (directoryCalls.get(base) ?? 0) + 1);
          return { data: [sourceRow()], query: options.q, searchType: 'fuzzy', count: 1, durationMs: 1 };
        },
      };
      return undefined;
    };

    const config = (organizationId: string): RegistryConfiguration => ({
      publicOrigin: ORIGIN,
      maxBodyBytes: 2 * 1024 * 1024,
      organizationId,
      leaseSeconds: 60,
      allowLoopbackUpstreams: true,
    });
    const handlerA = createRegistryHandler({ repository, blobs, auth, config: config(TENANT_A), directoryForBase });
    const handlerB = createRegistryHandler({ repository, blobs, auth, config: config(TENANT_B), directoryForBase });
    const source = sourceFetchFixture();

    const createFeed = async (handler: RegistryHandler, token: string, name: string, baseUrl: string): Promise<Feed> => {
      const response = await call(handler, '/v1/feeds', token, {
        method: 'POST',
        json: { name, kind: 'skills-sh', namespace: '@acme', repositories: [SOURCE], baseUrl },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await body<{ feed: Feed }>(response)).feed;
    };
    const feedA = await createFeed(handlerA, USER_A_TOKEN, 'tenant-a-feed', CATALOG_A);
    const feedB = await createFeed(handlerB, USER_B_TOKEN, 'tenant-b-feed', CATALOG_B);

    // Feed records and source calls are organization-scoped. A valid tenant-B
    // principal cannot select tenant-A's feed, and using it must not query the
    // catalog. The inverse handler/config mismatch is rejected before routing.
    const beforeForeign = source.calls.length;
    const foreignFeed = await call(handlerB, '/v1/proxy/resolve', USER_B_TOKEN, {
      method: 'POST',
      json: { feed: feedA.name, externalId: EXTERNAL_ID },
    });
    expect(foreignFeed.status).toBe(404);
    expect(source.calls.length).toBe(beforeForeign);
    const spoofedPrincipal = await call(handlerA, '/v1/proxy/resolve', USER_B_TOKEN, {
      method: 'POST',
      json: { feed: feedA.name, externalId: EXTERNAL_ID },
    });
    expect(spoofedPrincipal.status).toBe(403);
    expect(source.calls.length).toBe(beforeForeign);

    const resolve = (handler: RegistryHandler, token: string, feed: Feed) => call(handler, '/v1/proxy/resolve', token, {
      method: 'POST',
      json: { feed: feed.name, externalId: EXTERNAL_ID },
    });
    const [coldA1, coldA2, coldB1, coldB2] = await Promise.all([
      resolve(handlerA, USER_A_TOKEN, feedA),
      resolve(handlerA, USER_A_TOKEN, feedA),
      resolve(handlerB, USER_B_TOKEN, feedB),
      resolve(handlerB, USER_B_TOKEN, feedB),
    ]);
    expect([coldA1.status, coldA2.status, coldB1.status, coldB2.status]).toEqual([202, 202, 202, 202]);
    const operationA = (await body<{ operation: Job }>(coldA1)).operation;
    const operationAJoined = (await body<{ operation: Job }>(coldA2)).operation;
    const operationB = (await body<{ operation: Job }>(coldB1)).operation;
    const operationBJoined = (await body<{ operation: Job }>(coldB2)).operation;
    expect(operationAJoined.id).toBe(operationA.id);
    expect(operationBJoined.id).toBe(operationB.id);
    expect(operationA.id).not.toBe(operationB.id);
    expect((await repository.read(TENANT_A)).jobs.filter((job) => job.kind === 'import')).toHaveLength(1);
    expect((await repository.read(TENANT_B)).jobs.filter((job) => job.kind === 'import')).toHaveLength(1);

    const runnerOptions = (handler: RegistryHandler, workerToken: string, workerId: string, baseUrl: string, catalogToken: string): WorkerRunnerOptions => ({
      baseUrl: ORIGIN,
      workerToken,
      workerId,
      fetch: async (input, init) => {
        const target = input instanceof Request ? input.url : String(input);
        return handler(new Request(target, init));
      },
      acquisition: {
        fetchImpl: source.fetch,
        allowLoopbackForTests: true,
        skillsShGatewayCredential: { baseUrl, getToken: async () => catalogToken },
      },
      adapters: [scanner()],
      executor: { run: async () => { throw new Error('the deterministic scanner must not invoke a command executor'); } },
    });
    const runnerA = new WorkerRunner(runnerOptions(handlerA, WORKER_A_TOKEN, 'source-tenant-a-worker', CATALOG_A, CATALOG_TOKEN_A));
    const runnerB = new WorkerRunner(runnerOptions(handlerB, WORKER_B_TOKEN, 'source-tenant-b-worker', CATALOG_B, CATALOG_TOKEN_B));
    const [runA, runB] = await Promise.all([runnerA.runOnce(), runnerB.runOnce()]);
    expect(runA.error).toBeUndefined();
    expect(runB.error).toBeUndefined();
    expect(runA.allow).toBe(true);
    expect(runB.allow).toBe(true);
    expect(runA.scannerResults).toEqual([expect.objectContaining({ scannerId: 'skillsguard', status: 'completed' })]);
    expect(runB.scannerResults).toEqual([expect.objectContaining({ scannerId: 'skillsguard', status: 'completed' })]);

    const catalogCalls = source.calls.filter((entry) => entry.path.includes('/api/v1/skills/'));
    expect(catalogCalls).toHaveLength(2);
    expect(catalogCalls.map((entry) => entry.authorization).sort()).toEqual([
      `Bearer ${CATALOG_TOKEN_A}`,
      `Bearer ${CATALOG_TOKEN_B}`,
    ].sort());
    const githubCalls = source.calls.filter((entry) => entry.origin === 'https://api.github.com');
    expect(githubCalls.length).toBeGreaterThan(0);
    expect(githubCalls.every((entry) => entry.authorization === undefined)).toBe(true);

    const stateA = await repository.read(TENANT_A);
    const stateB = await repository.read(TENANT_B);
    const skillA = stateA.skills[0];
    const skillB = stateB.skills[0];
    expect(skillA).toBeDefined();
    expect(skillB).toBeDefined();
    expect(skillA!.id).not.toBe(skillB!.id);
    expect(skillA!.artifact.digest).toBe(skillB!.artifact.digest);
    expect(skillA!.provenance).toMatchObject({
      sourceResolutionKind: 'github',
      sourceProviderOrigin: 'https://github.com',
      repository: SOURCE,
      skillPath: 'skills/shared-skill',
      resolvedCommit: COMMIT,
      resolvedTree: COMMIT,
    });

    const callsAfterApproval = source.calls.length;
    const directoryCallsAfterApproval = new Map(directoryCalls);
    const warmAResponse = await resolve(handlerA, USER_A_TOKEN, feedA);
    const warmBResponse = await resolve(handlerB, USER_B_TOKEN, feedB);
    expect(warmAResponse.status).toBe(200);
    expect(warmBResponse.status).toBe(200);
    const warmA = (await body<{ resolution: Resolution }>(warmAResponse)).resolution;
    const warmB = (await body<{ resolution: Resolution }>(warmBResponse)).resolution;
    expect(warmA.resourceId).toBe(skillA!.id);
    expect(warmB.resourceId).toBe(skillB!.id);
    expect(source.calls.length).toBe(callsAfterApproval);
    expect(directoryCalls).toEqual(directoryCallsAfterApproval);

    // A same-tenant capability can read the Files SDK object. A tenant-B
    // handler cannot mint a grant from tenant-A's resolution or resource, and
    // the denial occurs before the shared filesystem is read.
    const ownAuthorizationResponse = await call(handlerA, '/v1/install-authorizations', USER_A_TOKEN, {
      method: 'POST',
      json: { resolution: warmA },
    });
    expect(ownAuthorizationResponse.status).toBe(201);
    const ownAuthorization = (await body<{ authorization: { id: string } }>(ownAuthorizationResponse)).authorization;
    const descriptorResponse = await call(handlerA, `/v1/artifacts/${encodeURIComponent(skillA!.artifact.digest)}/download`, USER_A_TOKEN, {
      method: 'POST',
      json: { resourceId: skillA!.id, authorizationId: ownAuthorization.id },
    });
    expect(descriptorResponse.status).toBe(200);
    const descriptor = await body<TransferDescriptor>(descriptorResponse);
    expect(descriptor.digest).toBe(skillA!.artifact.digest);
    const transferred = await call(handlerA, new URL(descriptor.url).pathname, USER_A_TOKEN);
    expect(transferred.status).toBe(200);
    expect(await digestBytes(new Uint8Array(await transferred.arrayBuffer()))).toBe(skillA!.artifact.digest);

    const blobReads = vi.spyOn(blobs, 'get');
    try {
      const foreignAuthorization = await call(handlerB, '/v1/install-authorizations', USER_B_TOKEN, {
        method: 'POST',
        json: { resolution: warmA },
      });
      expect(foreignAuthorization.status).toBe(404);
      const foreignGrant = await call(handlerB, `/v1/artifacts/${encodeURIComponent(skillA!.artifact.digest)}/download`, USER_B_TOKEN, {
        method: 'POST',
        json: { resourceId: skillA!.id, authorizationId: ownAuthorization.id },
      });
      expect(foreignGrant.status).toBe(404);
      expect(blobReads).not.toHaveBeenCalled();
    } finally {
      blobReads.mockRestore();
    }
  });
});
