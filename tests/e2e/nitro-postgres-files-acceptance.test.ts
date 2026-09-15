import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { makeSignature } from 'better-auth/crypto';

import {
  createIdentityInfrastructure,
} from '../../apps/web/server/identity-infrastructure.js';
import {
  companySsoSchemaSql,
} from '../../packages/identity/src/company-sso.js';
import type { PgPoolLike } from '../../packages/database/src/index.js';
import { bundleFor } from './harness.js';
import { digestBytes, encodeBundle } from '../../packages/storage/src/index.js';
import type { Job, SkillBundle, SkillVersion } from '../../packages/contracts/src/index.js';

/**
 * This is an opt-in loopback acceptance probe. It starts the actual built
 * Nitro server and uses the real Node PostgreSQL and Files SDK adapters. A
 * normal test run must never connect to a developer's or a hosted database.
 */
function loopbackDatabaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined;
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase())) return undefined;
    return value.trim();
  } catch {
    return undefined;
  }
}

const DATABASE_URL = loopbackDatabaseUrl(
  process.env.PSKILLS_NITRO_POSTGRES_URL
    ?? process.env.PSKILLS_TEST_POSTGRES_URL
    ?? process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL,
);
const ENABLED = DATABASE_URL !== undefined && process.env.PSKILLS_NITRO_POSTGRES_ACCEPTANCE === 'true';
const local = describe.skipIf(!ENABLED);

const DEFAULT_ORGANIZATION = 'nitro-runtime-default';
const TENANT_A = 'nitro-runtime-company-a';
const TENANT_B = 'nitro-runtime-company-b';
const USER_A = 'nitro-runtime-user-a';
const USER_B = 'nitro-runtime-user-b';
const SESSION_A = 'nitro-runtime-session-a';
const SESSION_B = 'nitro-runtime-session-b';
const SESSION_TOKEN_A = 'nitro-runtime-session-token-a';
const SESSION_TOKEN_B = 'nitro-runtime-session-token-b';
const WORKER_A = 'nitro-runtime-worker-a';
const WORKER_B = 'nitro-runtime-worker-b';
const SKILL_NAME_A = '@nitro/company-a-skill';
const SKILL_NAME_B = '@nitro/company-b-skill';

type SqlClient = ReturnType<typeof postgres>;

interface SeededIdentity {
  readonly schema: string;
  readonly ssoTable: string;
  readonly cookieA: string;
  readonly cookieB: string;
}

interface RuntimeProcess {
  readonly origin: string;
  readonly storageRoot: string;
  readonly child: ReturnType<typeof spawn>;
}

interface HttpResponse<T = unknown> {
  readonly response: Response;
  readonly value?: T;
}

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

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || value.length > 63) throw new Error('invalid local rehearsal identifier');
  return `"${value}"`;
}

async function seedBetterAuth(
  databaseURL: string,
  origin: string,
  secret: string,
  schema: string,
  ssoTable: string,
): Promise<SeededIdentity> {
  const sql = postgres(databaseURL, { max: 8, prepare: false, onnotice: () => undefined });
  const environment = {
    PSKILLS_BETTER_AUTH_ENABLED: 'true',
    DATABASE_URL: databaseURL,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: origin,
    PSKILLS_PUBLIC_ORIGIN: origin,
    PSKILLS_BETTER_AUTH_SCHEMA: schema,
    PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
    PSKILLS_BETTER_AUTH_AUTO_MIGRATE: 'false',
    PSKILLS_COMPANY_SSO_TABLE_NAME: ssoTable,
    PSKILLS_COMPANY_SSO_AUTO_MIGRATE: 'false',
    PSKILLS_API_TOKEN_AUTO_MIGRATE: 'false',
  } as const;
  let identity: ReturnType<typeof createIdentityInfrastructure>['identity'] = null;
  try {
    const infrastructure = createIdentityInfrastructure(environment, {
      postgresPool: pgPool(sql),
      canonicalOrigin: origin,
      companySsoTableName: ssoTable,
      companySsoAutoMigrate: false,
      apiTokenAutoMigrate: false,
    });
    identity = infrastructure.identity;
    if (!identity) throw new Error('Better Auth did not initialize for the local rehearsal');
    // Keep the private company SSO registry available to the exact runtime
    // composition even though this journey does not invoke an SSO callback.
    await sql.unsafe(companySsoSchemaSql(ssoTable));
    await identity.runMigrations();
    const context = await identity.auth.$context;
    const now = new Date();
    for (const [id, email] of [
      [USER_A, 'company-a@nitro-runtime.test'],
      [USER_B, 'company-b@nitro-runtime.test'],
    ] as const) {
      await context.adapter.create({
        model: 'user',
        data: { id, name: id, email, emailVerified: true, createdAt: now, updatedAt: now },
        forceAllowId: true,
      });
    }
    for (const [organizationId, userId, sessionId, token, name] of [
      [TENANT_A, USER_A, SESSION_A, SESSION_TOKEN_A, 'Nitro Runtime Company A'],
      [TENANT_B, USER_B, SESSION_B, SESSION_TOKEN_B, 'Nitro Runtime Company B'],
    ] as const) {
      await context.adapter.create({
        model: 'organization',
        data: { id: organizationId, name, slug: organizationId, createdAt: now },
        forceAllowId: true,
      });
      await context.adapter.create({
        model: 'member',
        data: { id: `${organizationId}-member`, organizationId, userId, role: 'owner', createdAt: now },
        forceAllowId: true,
      });
      await context.adapter.create({
        model: 'session',
        data: {
          id: sessionId,
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
          token,
          createdAt: now,
          updatedAt: now,
          userId,
          activeOrganizationId: organizationId,
        },
        forceAllowId: true,
      });
    }
    const cookieName = context.authCookies.sessionToken.name;
    const signatureA = await makeSignature(SESSION_TOKEN_A, context.secret);
    const signatureB = await makeSignature(SESSION_TOKEN_B, context.secret);
    return {
      schema,
      ssoTable,
      cookieA: `${cookieName}=${SESSION_TOKEN_A}.${signatureA}`,
      cookieB: `${cookieName}=${SESSION_TOKEN_B}.${signatureB}`,
    };
  } finally {
    await identity?.close().catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Unable to reserve a local Nitro port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function runBuild(repoRoot: string): Promise<void> {
  const viteEntry = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteEntry, 'build'], {
    cwd: join(repoRoot, 'apps', 'web'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PSKILLS_STORAGE_BUILD_PROFILE: 'filesystem',
      PSKILLS_STORAGE_PROVIDER: 'filesystem',
      PSKILLS_RUNTIME_PROFILE: 'node',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk: Buffer) => {
    if (output.length < 12_000) output += chunk.toString('utf8').slice(0, 12_000 - output.length);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) throw new Error(`Nitro build failed with exit ${exitCode}: ${output.slice(-2_000)}`);
}

async function startRuntime(
  repoRoot: string,
  databaseURL: string,
  seeded: SeededIdentity,
  secret: string,
  runId: string,
  origin: string,
): Promise<RuntimeProcess> {
  const port = Number(new URL(origin).port);
  if (!Number.isSafeInteger(port) || port < 1) throw new Error('Nitro runtime origin must include a local port');
  const storageRoot = await mkdtemp(join(tmpdir(), 'private-skills-nitro-files-'));
  const workerTokenA = `local-worker-a-${runId}`;
  const workerTokenB = `local-worker-b-${runId}`;
  const workerTokens = [
    {
      id: WORKER_A,
      token: workerTokenA,
      organizationId: TENANT_A,
      subject: WORKER_A,
      roles: ['worker'],
      kind: 'worker',
      worker: true,
      scopes: ['jobs:*'],
    },
    {
      id: WORKER_B,
      token: workerTokenB,
      organizationId: TENANT_B,
      subject: WORKER_B,
      roles: ['worker'],
      kind: 'worker',
      worker: true,
      scopes: ['jobs:*'],
    },
  ];
  const child = spawn(process.execPath, [join(repoRoot, 'apps', 'web', '.output', 'server', 'index.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PSKILLS_ENVIRONMENT: 'test',
      PSKILLS_RUNTIME_PROFILE: 'node',
      PSKILLS_PUBLIC_ORIGIN: origin,
      PSKILLS_API_URL: origin,
      PSKILLS_ORGANIZATION_ID: DEFAULT_ORGANIZATION,
      PSKILLS_STATE_PROVIDER: 'postgres',
      DATABASE_URL: databaseURL,
      PSKILLS_STORAGE_PROVIDER: 'filesystem',
      PSKILLS_STORAGE_ROOT: storageRoot,
      PSKILLS_STORAGE_BUILD_PROFILE: 'filesystem',
      PSKILLS_BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: origin,
      PSKILLS_BETTER_AUTH_SCHEMA: seeded.schema,
      PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
      PSKILLS_BETTER_AUTH_AUTO_MIGRATE: 'false',
      PSKILLS_API_TOKEN_AUTO_MIGRATE: 'false',
      PSKILLS_COMPANY_SSO_TABLE_NAME: seeded.ssoTable,
      PSKILLS_COMPANY_SSO_AUTO_MIGRATE: 'false',
      PSKILLS_REQUIRED_SCANNER: 'skillsguard',
      PSKILLS_ALLOW_UNSCANNED: 'false',
      PSKILLS_WORKER_TOKENS: JSON.stringify(workerTokens),
      PSKILLS_BOOTSTRAP_TOKEN: '',
      PSKILLS_BOOTSTRAP_TOKEN_HASH: '',
      PSKILLS_WORKER_TOKEN: '',
      PSKILLS_HOSTED_WORKER: 'false',
      PSKILLS_AI_ENABLED: 'false',
      PSKILLS_SEARCH_PROVIDER: 'state',
      PSKILLS_DIRECTORY_ENABLED: 'false',
      PSKILLS_PACK_DIRECTORY_ENABLED: 'false',
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_PORT: String(port),
    },
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Nitro process exited before health check (${child.exitCode})`);
      try {
        const response = await fetch(`${origin}/health`);
        if (response.ok) return { origin, storageRoot, child };
      } catch {
        // The process may need a few seconds to initialize the bundled runtime.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Nitro process did not become healthy within 30 seconds');
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(storageRoot, { recursive: true, force: true });
    throw error;
  }
}

async function stopRuntime(runtime: RuntimeProcess | undefined): Promise<void> {
  if (!runtime) return;
  if (runtime.child.exitCode === null) {
    runtime.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        runtime.child.kill('SIGKILL');
        resolve();
      }, 5_000);
      runtime.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(runtime.storageRoot, { recursive: true, force: true });
}

function headers(cookie: string, origin: string, extra: HeadersInit = {}): Headers {
  const result = new Headers(extra);
  result.set('cookie', cookie);
  result.set('origin', origin);
  return result;
}

async function http<T = unknown>(
  runtime: RuntimeProcess,
  path: string,
  cookie: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<HttpResponse<T>> {
  const { json, ...requestInit } = init;
  const requestHeaders = headers(cookie, runtime.origin, requestInit.headers);
  let body = requestInit.body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    requestHeaders.set('content-type', 'application/json');
  }
  const response = await fetch(new URL(path, runtime.origin), {
    ...requestInit,
    headers: requestHeaders,
    body,
    redirect: 'error',
  });
  let value: T | undefined;
  if (response.headers.get('content-type')?.includes('application/json')) {
    // Keep the original response readable for denial-body assertions; the
    // parsed clone is only a convenience for the typed journey checks.
    value = await response.clone().json() as T;
  }
  return { response, value };
}

function expectNoDigest(response: Response, digest: string): Promise<void> {
  return response.clone().text().then((text) => expect(text).not.toContain(digest));
}

function deterministicScan(job: Job): Record<string, unknown> {
  if (!job.artifact) throw new Error('scan fixture requires a published artifact');
  return {
    id: `scan-local-skillsguard-${job.id}`,
    organizationId: job.organizationId,
    jobId: job.id,
    artifactDigest: job.artifact.digest,
    scannerId: 'skillsguard',
    engineVersion: 'local-deterministic-skillsguard-v1',
    rulesRevision: 'local-deterministic-rules-v1',
    configurationHash: 'local-deterministic-configuration-v1',
    status: 'completed',
    findings: [],
    coverage: {
      filesEnumerated: 2,
      filesAnalyzed: 2,
      filesSkipped: 0,
      filesUnsupported: 0,
      limitations: [],
      externalDestinations: [],
    },
    policyRevision: job.policyRevision,
    createdAt: new Date().toISOString(),
    durationMs: 1,
  };
}

async function publishAndApprove(
  runtime: RuntimeProcess,
  cookie: string,
  workerToken: string,
  name: string,
  description: string,
): Promise<{ skill: SkillVersion; job: Job; bytes: Uint8Array }> {
  const bundle = bundleFor(name.slice(name.indexOf('/') + 1), description) as SkillBundle;
  const bytes = encodeBundle(bundle);
  const published = await http<{ operation: Job }>(runtime, '/v1/publish', cookie, {
    method: 'POST',
    json: { name, version: '1.0.0', description, bundle },
  });
  expect(published.response.status).toBe(202);
  const job = published.value?.operation;
  expect(job?.organizationId).toBeDefined();
  expect(job?.state).toBe('queued');
  if (!job) throw new Error('publish response omitted its scan operation');

  const beforeScan = await http<{ operation?: Job }>(runtime, `/v1/resolve`, cookie, {
    method: 'POST',
    json: { kind: 'skill', ref: name, version: '1.0.0' },
  });
  expect(beforeScan.response.status).toBe(202);
  expect(beforeScan.value?.operation?.id).toBe(job.id);

  const claimed = await http<{ job: (Job & { fencingToken?: string }) | null }>(runtime, '/internal/jobs/claim', '', {
    method: 'POST',
    headers: { authorization: `Bearer ${workerToken}` },
  });
  expect(claimed.response.status).toBe(200);
  expect(claimed.value?.job?.id).toBe(job.id);
  const running = claimed.value?.job;
  if (!running) throw new Error('worker did not claim the tenant scan job');
  const leaseToken = running.leaseToken ?? running.fencingToken;
  if (!leaseToken) throw new Error('claimed job omitted its lease token');

  const completed = await http<{ operation: Job }>(runtime, `/internal/jobs/${encodeURIComponent(job.id)}/complete`, '', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${workerToken}`,
      'x-worker-fencing-token': leaseToken,
    },
    json: { leaseToken, scanResults: [deterministicScan(running)] },
  });
  if (completed.response.status !== 200) {
    throw new Error(`worker completion failed with ${completed.response.status}: ${JSON.stringify(completed.value)}`);
  }
  expect(completed.value?.operation?.state).toBe('completed');

  const skillResponse = await http<{ skill: SkillVersion }>(runtime, `/v1/skills/${encodeURIComponent(running.resourceId ?? '')}`, cookie, { method: 'GET' });
  expect(skillResponse.response.status).toBe(200);
  const skill = skillResponse.value?.skill;
  if (!skill) throw new Error('approved skill response omitted its skill');
  expect(skill.organizationId).toBe(job.organizationId);
  expect(skill.state).toBe('approved');
  expect(skill.artifact.digest).toBe(await digestBytes(bytes));
  return { skill, job, bytes };
}

let runtime: RuntimeProcess | undefined;
let cleanupDatabase: { schema: string; ssoTable: string } | undefined;

afterEach(async () => {
  await stopRuntime(runtime);
  runtime = undefined;
  if (cleanupDatabase && DATABASE_URL) {
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false, onnotice: () => undefined });
    try {
      await sql.unsafe('DELETE FROM "private_skills_registry_state" WHERE organization_id IN ($1, $2)', [TENANT_A, TENANT_B]).catch(() => undefined);
      await sql.unsafe(`DROP TABLE IF EXISTS ${identifier(cleanupDatabase.ssoTable)}`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${identifier(cleanupDatabase.schema)} CASCADE`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  cleanupDatabase = undefined;
});

local('real Nitro + PostgreSQL + Files SDK tenant journey', () => {
  it('publishes, requires a tenant scanner, downloads only approved bytes, and denies foreign/revoked access', async () => {
    if (!DATABASE_URL) throw new Error('loopback PostgreSQL URL is required');
    const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const runId = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `nitro_auth_${runId}`;
    const ssoTable = `nitro_sso_${runId}`;
    const secret = `nitro-runtime-acceptance-secret-${runId}-0123456789`;
    cleanupDatabase = { schema, ssoTable };
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    // Better Auth signs the session cookie with the deployment secret and
    // uses this exact origin for trusted-origin checks. Seed against the
    // reserved runtime origin before starting the bundled Nitro process.
    const seeded = await seedBetterAuth(DATABASE_URL, origin, secret, schema, ssoTable);
    await runBuild(repoRoot);
    runtime = await startRuntime(repoRoot, DATABASE_URL, seeded, secret, runId, origin);

    const policyA = await http<{ policy: { allowUnscanned: boolean; scanners: Array<{ id: string; mode: string }> } }>(runtime, '/v1/policy', seeded.cookieA, { method: 'GET' });
    expect(policyA.response.status).toBe(200);
    expect(policyA.value?.policy.allowUnscanned).toBe(false);
    expect(policyA.value?.policy.scanners.find((scanner) => scanner.id === 'skillsguard')?.mode).toBe('required');
    const policyB = await http<{ policy: { allowUnscanned: boolean; scanners: Array<{ id: string; mode: string }> } }>(runtime, '/v1/policy', seeded.cookieB, { method: 'GET' });
    expect(policyB.response.status).toBe(200);
    expect(policyB.value?.policy.allowUnscanned).toBe(false);

    const approvedA = await publishAndApprove(runtime, seeded.cookieA, `local-worker-a-${runId}`, SKILL_NAME_A, 'Company A local Nitro fixture');
    const approvedB = await publishAndApprove(runtime, seeded.cookieB, `local-worker-b-${runId}`, SKILL_NAME_B, 'Company B local Nitro fixture');
    expect(approvedA.skill.organizationId).not.toBe(approvedB.skill.organizationId);
    expect(approvedA.skill.artifact.digest).not.toBe(approvedB.skill.artifact.digest);

    const foreignDetail = await http(runtime, `/v1/skills/${encodeURIComponent(approvedA.skill.id)}`, seeded.cookieB, { method: 'GET' });
    expect(foreignDetail.response.status).toBe(404);
    await expectNoDigest(foreignDetail.response, approvedA.skill.artifact.digest);

    const resolutionA = await http<{ resolution: { resourceId: string; organizationId: string; digest: string; version: string; name: string; kind: 'skill'; members: unknown[] } }>(runtime, '/v1/resolve', seeded.cookieA, {
      method: 'POST',
      json: { kind: 'skill', ref: SKILL_NAME_A, version: '1.0.0' },
    });
    expect(resolutionA.response.status).toBe(200);
    const resolution = resolutionA.value?.resolution;
    if (!resolution) throw new Error('resolve response omitted its resolution');
    expect(resolution.organizationId).toBe(TENANT_A);
    expect(resolution.digest).toBe(approvedA.skill.artifact.digest);

    const authorizationA = await http<{ authorization: { id: string } }>(runtime, '/v1/install-authorizations', seeded.cookieA, {
      method: 'POST',
      json: { resolution },
    });
    expect(authorizationA.response.status).toBe(201);
    const authorization = authorizationA.value?.authorization;
    if (!authorization) throw new Error('install authorization response omitted its id');

    const descriptorA = await http<{ url: string; digest: string; size: number }>(runtime, `/v1/artifacts/${encodeURIComponent(approvedA.skill.artifact.digest)}/download`, seeded.cookieA, {
      method: 'POST',
      json: { resourceId: approvedA.skill.id, authorizationId: authorization.id },
    });
    expect(descriptorA.response.status).toBe(200);
    expect(descriptorA.value?.digest).toBe(approvedA.skill.artifact.digest);
    const descriptor = descriptorA.value;
    if (!descriptor) throw new Error('download descriptor response omitted its descriptor');
    const transferA = await fetch(descriptor.url, {
      method: 'GET',
      headers: { cookie: seeded.cookieA, origin: runtime.origin },
      redirect: 'error',
    });
    expect(transferA.status).toBe(200);
    const transferBytes = new Uint8Array(await transferA.arrayBuffer());
    expect(transferBytes).toEqual(approvedA.bytes);
    expect(await digestBytes(transferBytes)).toBe(approvedA.skill.artifact.digest);

    const foreignInstall = await http(runtime, '/v1/install-authorizations', seeded.cookieB, {
      method: 'POST',
      json: { resolution },
    });
    expect(foreignInstall.response.status).toBe(404);
    await expectNoDigest(foreignInstall.response, approvedA.skill.artifact.digest);
    const foreignDescriptor = await http(runtime, `/v1/artifacts/${encodeURIComponent(approvedA.skill.artifact.digest)}/download`, seeded.cookieB, {
      method: 'POST',
      json: { resourceId: approvedA.skill.id, authorizationId: authorization.id },
    });
    expect(foreignDescriptor.response.status).toBe(404);
    await expectNoDigest(foreignDescriptor.response, approvedA.skill.artifact.digest);
    const foreignTransfer = await fetch(descriptor.url, {
      method: 'GET',
      headers: { cookie: seeded.cookieB, origin: runtime.origin },
      redirect: 'error',
    });
    expect(foreignTransfer.status).toBe(404);
    await expectNoDigest(foreignTransfer, approvedA.skill.artifact.digest);

    const revoke = await http(runtime, `/v1/skills/${encodeURIComponent(approvedA.skill.id)}/revoke`, seeded.cookieA, {
      method: 'POST',
      json: { reason: 'local acceptance denial proof' },
    });
    expect(revoke.response.status).toBe(200);
    const revokedResolve = await http(runtime, '/v1/resolve', seeded.cookieA, {
      method: 'POST',
      json: { kind: 'skill', ref: SKILL_NAME_A, version: '1.0.0' },
    });
    expect(revokedResolve.response.status).toBe(404);
    await expectNoDigest(revokedResolve.response, approvedA.skill.artifact.digest);
    const revokedDescriptor = await http(runtime, `/v1/artifacts/${encodeURIComponent(approvedA.skill.artifact.digest)}/download`, seeded.cookieA, {
      method: 'POST',
      json: { resourceId: approvedA.skill.id, authorizationId: authorization.id },
    });
    // The stale authorization is rejected by the current-resolution fence
    // before artifact lookup, so this denial is a 409 policy response.
    expect(revokedDescriptor.response.status).toBe(409);
    await expectNoDigest(revokedDescriptor.response, approvedA.skill.artifact.digest);
    const revokedTransfer = await fetch(descriptor.url, {
      method: 'GET',
      headers: { cookie: seeded.cookieA, origin: runtime.origin },
      redirect: 'error',
    });
    expect(revokedTransfer.status).toBe(409);
    await expectNoDigest(revokedTransfer, approvedA.skill.artifact.digest);
  }, 180_000);
});
