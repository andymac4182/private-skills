import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { makeSignature } from 'better-auth/crypto';

import {
  createIdentityInfrastructure,
} from '../../apps/web/server/identity-infrastructure.js';
import {
  companySsoSchemaSql,
} from '../../packages/identity/src/company-sso.js';
import {
  PostgresApiTokenRepository,
  postgresApiTokenSchemaSql,
  type ApiTokenPgPool,
  type ApiTokenRecord,
} from '../../packages/api-tokens/src/index.js';
import type { PgPoolLike } from '../../packages/database/src/index.js';
import { bundleFor } from './harness.js';
import { digestBytes, encodeBundle } from '../../packages/storage/src/index.js';
import type {
  InstallAnalytics,
  Job,
  PackVersion,
  Resolution,
  SkillBundle,
  SkillVersion,
} from '../../packages/contracts/src/index.js';
import { WorkerRunner } from '../../workers/runner/src/worker.js';
import {
  enumerateRegularFiles,
  resultBase,
  sha256,
  type AdapterScan,
  type ScanRequest,
  type ScannerAdapter,
} from '../../packages/scanners/src/index.js';

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
const RETAIN_FIXTURE = ENABLED && process.env.PSKILLS_NITRO_POSTGRES_RETAIN_FIXTURE === 'true';
const local = describe.skipIf(!ENABLED);

// Retained mode leaves one process alive by design. Per-process identity and
// skill IDs keep that disposable fixture isolated from later local runs.
const INSTANCE_ID = randomUUID().replaceAll('-', '').slice(0, 12);
const DEFAULT_ORGANIZATION = `nitro-runtime-default-${INSTANCE_ID}`;
const TENANT_A = `nitro-runtime-company-a-${INSTANCE_ID}`;
const TENANT_B = `nitro-runtime-company-b-${INSTANCE_ID}`;
const USER_A = `nitro-runtime-user-a-${INSTANCE_ID}`;
const USER_B = `nitro-runtime-user-b-${INSTANCE_ID}`;
const SESSION_A = `nitro-runtime-session-a-${INSTANCE_ID}`;
const SESSION_B = `nitro-runtime-session-b-${INSTANCE_ID}`;
const SESSION_TOKEN_A = `nitro-runtime-session-token-a-${INSTANCE_ID}`;
const SESSION_TOKEN_B = `nitro-runtime-session-token-b-${INSTANCE_ID}`;
const WORKER_A = `nitro-runtime-worker-a-${INSTANCE_ID}`;
const WORKER_B = `nitro-runtime-worker-b-${INSTANCE_ID}`;
const SKILL_NAME_A = `@nitro/company-a-skill-${INSTANCE_ID}`;
const SKILL_NAME_B = `@nitro/company-b-skill-${INSTANCE_ID}`;

type SqlClient = ReturnType<typeof postgres>;

interface SeededIdentity {
  readonly schema: string;
  readonly ssoTable: string;
  readonly cookieA: string;
  readonly cookieB: string;
  readonly apiTokenA: string;
  readonly apiTokenB: string;
  readonly apiTokenIdA: string;
  readonly apiTokenIdB: string;
}

interface RuntimeProcess {
  readonly origin: string;
  readonly storageRoot: string;
  readonly workerTokenA: string;
  readonly workerTokenB: string;
  readonly retained: boolean;
  readonly child: ReturnType<typeof spawn>;
}

interface RetainedFixture {
  readonly path: string;
  readonly organizationId: string;
  readonly skillId: string;
  readonly skillName: string;
  readonly artifactDigest: string;
  readonly registryOrigin: string;
  readonly apiToken: string;
  readonly sessionCookie: string;
  readonly runtimePid: number | undefined;
  readonly storageRoot: string;
  readonly databaseSchema: string;
  readonly ssoTable: string;
}

type WorkerScanResult = NonNullable<Awaited<ReturnType<WorkerRunner['runOnce']>>['scannerResults']>[number];

function retainedFixturePath(runId: string): string {
  const configured = process.env.PSKILLS_NITRO_POSTGRES_RETAIN_FIXTURE_PATH?.trim();
  if (configured !== undefined && configured !== '' && !isAbsolute(configured)) {
    throw new Error('PSKILLS_NITRO_POSTGRES_RETAIN_FIXTURE_PATH must be absolute');
  }
  return configured || join(tmpdir(), `private-skills-nitro-fixture-${runId}.json`);
}

interface HttpResponse<T = unknown> {
  readonly response: Response;
  readonly value?: T;
}

function pgPool(sql: SqlClient): PgPoolLike & ApiTokenPgPool {
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
  } as PgPoolLike & ApiTokenPgPool;
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || value.length > 63) throw new Error('invalid local rehearsal identifier');
  return `"${value}"`;
}

function tokenHash(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function tokenRecord(
  organizationId: string,
  userId: string,
  id: string,
  token: string,
): ApiTokenRecord {
  const now = new Date();
  return {
    id,
    organizationId,
    userId,
    name: id,
    tokenHash: tokenHash(token),
    roleCeiling: 'owner',
    scopes: ['registry:*'],
    expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    createdAt: now.toISOString(),
  };
}

async function seedBetterAuth(
  databaseURL: string,
  origin: string,
  secret: string,
  schema: string,
  ssoTable: string,
  runId: string,
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
    await sql.unsafe(companySsoSchemaSql(ssoTable, schema));
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
    const apiTokenA = `psk_nitro_runtime_${runId}_a`;
    const apiTokenB = `psk_nitro_runtime_${runId}_b`;
    const apiTokenIdA = `nitro_api_token_${runId}_a`;
    const apiTokenIdB = `nitro_api_token_${runId}_b`;
    await sql.unsafe(postgresApiTokenSchemaSql());
    const apiTokens = new PostgresApiTokenRepository(pgPool(sql), { autoMigrate: false });
    await apiTokens.create(tokenRecord(TENANT_A, USER_A, apiTokenIdA, apiTokenA));
    await apiTokens.create(tokenRecord(TENANT_B, USER_B, apiTokenIdB, apiTokenB));
    return {
      schema,
      ssoTable,
      cookieA: `${cookieName}=${SESSION_TOKEN_A}.${signatureA}`,
      cookieB: `${cookieName}=${SESSION_TOKEN_B}.${signatureB}`,
      apiTokenA,
      apiTokenB,
      apiTokenIdA,
      apiTokenIdB,
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

interface EmbeddingGatewayFixture {
  readonly origin: string;
  readonly requestCount: number;
  readonly close: () => Promise<void>;
}

/**
 * A loopback implementation of the AI Gateway embedding protocol. It keeps
 * the composed runtime on the real Gateway SDK path while making the test
 * deterministic and preventing prompts or credentials from leaving the
 * machine. The vectors are intentionally constant; search authorization and
 * artifact revalidation remain the production code under test.
 */
async function startEmbeddingGateway(): Promise<EmbeddingGatewayFixture> {
  let requestCount = 0;
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/embedding-model') {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (request.headers.authorization !== 'Bearer local-embedding-fixture-key') {
      response.statusCode = 401;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes <= 256 * 1024) chunks.push(buffer);
    });
    request.on('end', () => {
      if (bytes > 256 * 1024) {
        response.statusCode = 413;
        response.end();
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { values?: unknown };
        if (!Array.isArray(body.values) || body.values.length === 0 || body.values.length > 60 || body.values.some((value) => typeof value !== 'string')) {
          response.statusCode = 400;
          response.end();
          return;
        }
        requestCount += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ embeddings: body.values.map(() => [1, 0]) }));
      } catch {
        response.statusCode = 400;
        response.end();
      }
    });
    request.on('error', () => {
      if (!response.writableEnded) response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Unable to start the local embedding Gateway fixture');
  }
  return {
    origin: `http://127.0.0.1:${address.port}/v1`,
    get requestCount() { return requestCount; },
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
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
  runtimeOverrides: Record<string, string | undefined> = {},
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
      ...runtimeOverrides,
    },
    detached: RETAIN_FIXTURE,
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Nitro process exited before health check (${child.exitCode})`);
      try {
        const response = await fetch(`${origin}/health`);
        if (response.ok) {
          if (RETAIN_FIXTURE) child.unref();
          return { origin, storageRoot, workerTokenA, workerTokenB, retained: RETAIN_FIXTURE, child };
        }
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
  if (runtime.retained) return;
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

function createFilesystemScannerFixture(): ScannerAdapter {
  return {
    id: 'skillsguard',
    metadata: {
      id: 'skillsguard',
      version: 'local-filesystem-reader-v1',
      engineVersion: 'local-deterministic-skillsguard-v1',
      rulesRevision: 'local-deterministic-rules-v1',
    },
    command: 'local-filesystem-reader',
    async scan(request: ScanRequest): Promise<AdapterScan> {
      const started = Date.now();
      if (request.mode !== 'required') throw new Error('local scanner fixture must run as a required scanner');
      const files = await enumerateRegularFiles(request.inputDir);
      const observations: string[] = [];
      for (const relativePath of files) {
        // The fixture consumes the materialized files and hashes their bytes;
        // it never accepts a caller-supplied file count or prebuilt report.
        const bytes = new Uint8Array(await readFile(join(request.inputDir, ...relativePath.split('/'))));
        observations.push(`${relativePath}\u0000${sha256(bytes)}`);
      }
      const configurationHash = sha256(observations.join('\n'));
      return {
        result: resultBase(
          request,
          'skillsguard',
          {
            id: 'skillsguard',
            version: 'local-filesystem-reader-v1',
            engineVersion: 'local-deterministic-skillsguard-v1',
            rulesRevision: 'local-deterministic-rules-v1',
            configurationHash,
          },
          'completed',
          Math.max(1, Date.now() - started),
          {
            filesEnumerated: files.length,
            filesAnalyzed: files.length,
            filesSkipped: 0,
            filesUnsupported: 0,
            limitations: [],
            externalDestinations: [],
          },
          [],
        ),
      };
    },
  };
}

async function runWorkerScan(
  runtime: RuntimeProcess,
  workerToken: string,
  tenantId: string,
  expectedJobId: string,
): Promise<{ scannerResults: readonly WorkerScanResult[]; events: string[] }> {
  const events: string[] = [];
  const runner = new WorkerRunner({
    baseUrl: runtime.origin,
    workerToken,
    workerId: `${tenantId}-worker`,
    tenantId,
    adapters: [createFilesystemScannerFixture()],
    // This assertion ensures the deterministic fixture is reached through
    // the adapter path and does not silently fall back to command execution.
    executor: { async run() { throw new Error('local acceptance fixture executor must not run'); } },
    onEvent: (event) => { events.push(event.type); },
  });
  const result = await runner.runOnce();
  expect(result.claimed).toBe(true);
  expect(result.jobId).toBe(expectedJobId);
  expect(result.error).toBeUndefined();
  expect(result.allow).toBe(true);
  expect(events).toEqual(['claimed', 'completed']);
  if (!result.scannerResults) throw new Error('worker completion omitted scanner results');
  return { scannerResults: result.scannerResults, events };
}

async function writeRetainedFixture(
  path: string,
  runtime: RuntimeProcess,
  seeded: SeededIdentity,
  skill: SkillVersion,
): Promise<void> {
  const fixture: RetainedFixture = {
    path,
    organizationId: TENANT_B,
    skillId: skill.id,
    skillName: SKILL_NAME_B,
    artifactDigest: skill.artifact.digest,
    registryOrigin: runtime.origin,
    apiToken: seeded.apiTokenB,
    sessionCookie: seeded.cookieB,
    runtimePid: runtime.child.pid,
    storageRoot: runtime.storageRoot,
    databaseSchema: seeded.schema,
    ssoTable: seeded.ssoTable,
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ version: 1, ...fixture })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
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

  const workerResult = await runWorkerScan(runtime, workerToken, job.organizationId, job.id);
  const requiredScan = workerResult.scannerResults.find((scan) => scan.scannerId === 'skillsguard');
  expect(requiredScan?.status).toBe('completed');
  expect(requiredScan?.coverage.filesEnumerated).toBeGreaterThan(0);

  const skillResponse = await http<{ skill: SkillVersion }>(runtime, `/v1/skills/${encodeURIComponent(job.resourceId ?? '')}`, cookie, { method: 'GET' });
  expect(skillResponse.response.status).toBe(200);
  const skill = skillResponse.value?.skill;
  if (!skill) throw new Error('approved skill response omitted its skill');
  expect(skill.organizationId).toBe(job.organizationId);
  expect(skill.state).toBe('approved');
  expect(skill.artifact.digest).toBe(await digestBytes(bytes));
  return { skill, job, bytes };
}

let runtime: RuntimeProcess | undefined;
let cleanupDatabase: { schema: string; ssoTable: string; apiTokenIdA: string; apiTokenIdB: string } | undefined;
let retainedFixtureWritten = false;

afterEach(async () => {
  if (runtime?.retained && retainedFixtureWritten) {
    // Opt-in fixture mode deliberately leaves the local runtime, database
    // rows, and Files SDK root available for the native install proof.
    runtime = undefined;
    cleanupDatabase = undefined;
    retainedFixtureWritten = false;
    return;
  }
  // If opt-in startup succeeded but the journey failed before its fixture was
  // written, clean up just as the default mode does.
  await stopRuntime(runtime?.retained ? { ...runtime, retained: false } : runtime);
  runtime = undefined;
  if (cleanupDatabase && DATABASE_URL) {
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false, onnotice: () => undefined });
    try {
      await sql.unsafe('DELETE FROM "private_skills_registry_state" WHERE organization_id IN ($1, $2)', [TENANT_A, TENANT_B]).catch(() => undefined);
      await sql.unsafe('DELETE FROM "private_skills_service_tokens" WHERE id IN ($1, $2)', [cleanupDatabase.apiTokenIdA, cleanupDatabase.apiTokenIdB]).catch(() => undefined);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${identifier(cleanupDatabase.schema)} CASCADE`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  cleanupDatabase = undefined;
  retainedFixtureWritten = false;
});

local('real Nitro + PostgreSQL + Files SDK tenant journey', () => {
  it('publishes, requires a tenant scanner, downloads only approved bytes, and denies foreign/revoked access', async () => {
    if (!DATABASE_URL) throw new Error('loopback PostgreSQL URL is required');
    const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const runId = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `nitro_auth_${runId}`;
    const ssoTable = `nitro_sso_${runId}`;
    const secret = `nitro-runtime-acceptance-secret-${runId}-0123456789`;
    cleanupDatabase = {
      schema,
      ssoTable,
      apiTokenIdA: `nitro_api_token_${runId}_a`,
      apiTokenIdB: `nitro_api_token_${runId}_b`,
    };
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    // Better Auth signs the session cookie with the deployment secret and
    // uses this exact origin for trusted-origin checks. Seed against the
    // reserved runtime origin before starting the bundled Nitro process.
    const seeded = await seedBetterAuth(DATABASE_URL, origin, secret, schema, ssoTable, runId);
    await runBuild(repoRoot);
    runtime = await startRuntime(repoRoot, DATABASE_URL, seeded, secret, runId, origin);

    const policyA = await http<{ policy: { allowUnscanned: boolean; scanners: Array<{ id: string; mode: string }> } }>(runtime, '/v1/policy', seeded.cookieA, { method: 'GET' });
    expect(policyA.response.status).toBe(200);
    expect(policyA.value?.policy.allowUnscanned).toBe(false);
    expect(policyA.value?.policy.scanners.find((scanner) => scanner.id === 'skillsguard')?.mode).toBe('required');
    const policyB = await http<{ policy: { allowUnscanned: boolean; scanners: Array<{ id: string; mode: string }> } }>(runtime, '/v1/policy', seeded.cookieB, { method: 'GET' });
    expect(policyB.response.status).toBe(200);
    expect(policyB.value?.policy.allowUnscanned).toBe(false);

    const approvedA = await publishAndApprove(runtime, seeded.cookieA, runtime.workerTokenA, SKILL_NAME_A, 'Company A local Nitro fixture');
    const approvedB = await publishAndApprove(runtime, seeded.cookieB, runtime.workerTokenB, SKILL_NAME_B, 'Company B local Nitro fixture');
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

    const tokenResolutionB = await http<{ resolution: { organizationId: string; digest: string } }>(runtime, '/v1/resolve', '', {
      method: 'POST',
      headers: { authorization: `Bearer ${seeded.apiTokenB}` },
      json: { kind: 'skill', ref: SKILL_NAME_B, version: '1.0.0' },
    });
    expect(tokenResolutionB.response.status).toBe(200);
    expect(tokenResolutionB.value?.resolution.organizationId).toBe(TENANT_B);
    expect(tokenResolutionB.value?.resolution.digest).toBe(approvedB.skill.artifact.digest);
    const tokenForeignResolution = await http(runtime, '/v1/resolve', '', {
      method: 'POST',
      headers: { authorization: `Bearer ${seeded.apiTokenB}` },
      json: { kind: 'skill', ref: SKILL_NAME_A, version: '1.0.0' },
    });
    expect(tokenForeignResolution.response.status).toBe(404);
    await expectNoDigest(tokenForeignResolution.response, approvedA.skill.artifact.digest);

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

    if (RETAIN_FIXTURE) {
      await writeRetainedFixture(retainedFixturePath(runId), runtime, seeded, approvedB.skill);
      retainedFixtureWritten = true;
    }
  }, 180_000);

  it('keeps same-name packs, draft revisions/files, search, and confirmed-install analytics tenant-scoped', async () => {
    if (!DATABASE_URL) throw new Error('loopback PostgreSQL URL is required');
    const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const runId = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `nitro_auth_${runId}`;
    const ssoTable = `nitro_sso_${runId}`;
    const secret = `nitro-runtime-extended-secret-${runId}-0123456789`;
    cleanupDatabase = {
      schema,
      ssoTable,
      apiTokenIdA: `nitro_api_token_${runId}_a`,
      apiTokenIdB: `nitro_api_token_${runId}_b`,
    };
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    let gateway: EmbeddingGatewayFixture | undefined;
    try {
      // Start the local Gateway protocol fixture before the actual runtime so
      // every embedding request stays loopback-only and is observable.
      gateway = await startEmbeddingGateway();
      const seeded = await seedBetterAuth(DATABASE_URL, origin, secret, schema, ssoTable, runId);
      await runBuild(repoRoot);
      runtime = await startRuntime(repoRoot, DATABASE_URL, seeded, secret, runId, origin, {
        PSKILLS_AI_ENABLED: 'true',
        PSKILLS_EMBEDDING_MODEL: 'local/deterministic',
        PSKILLS_EMBEDDING_DIMENSIONS: '2',
        PSKILLS_AI_GATEWAY_BASE_URL: gateway.origin,
        AI_GATEWAY_API_KEY: 'local-embedding-fixture-key',
      });

      const sharedSkillName = `@nitro/shared-skill-${INSTANCE_ID}-${runId.slice(0, 8)}`;
      const sharedPackName = `@nitro/shared-pack-${INSTANCE_ID}-${runId.slice(0, 8)}`;
      const approvedA = await publishAndApprove(
        runtime,
        seeded.cookieA,
        runtime.workerTokenA,
        sharedSkillName,
        'Company A shared search fixture',
      );
      const approvedB = await publishAndApprove(
        runtime,
        seeded.cookieB,
        runtime.workerTokenB,
        sharedSkillName,
        'Company B shared search fixture',
      );
      expect(approvedA.skill.name).toBe(sharedSkillName);
      expect(approvedB.skill.name).toBe(sharedSkillName);
      expect(approvedA.skill.id).not.toBe(approvedB.skill.id);
      expect(approvedA.skill.organizationId).toBe(TENANT_A);
      expect(approvedB.skill.organizationId).toBe(TENANT_B);

      const filesA = await http<{ files: Array<{ path: string }> }>(
        runtime,
        `/v1/skills/${encodeURIComponent(approvedA.skill.id)}/files`,
        seeded.cookieA,
        { method: 'GET' },
      );
      expect(filesA.response.status).toBe(200);
      expect(filesA.value?.files.map((file) => file.path)).toEqual(expect.arrayContaining(['SKILL.md', 'README.md']));
      const foreignFiles = await http(runtime, `/v1/skills/${encodeURIComponent(approvedA.skill.id)}/files`, seeded.cookieB, { method: 'GET' });
      expect(foreignFiles.response.status).toBe(404);

      const packAResponse = await http<{ pack: PackVersion }>(runtime, '/v1/packs', seeded.cookieA, {
        method: 'POST',
        json: {
          name: sharedPackName,
          version: '1.0.0',
          description: 'Company A shared pack',
          skills: [{ ref: sharedSkillName, version: '1.0.0' }],
        },
      });
      expect(packAResponse.response.status).toBe(201);
      const packA = packAResponse.value?.pack;
      if (!packA) throw new Error('Company A pack response omitted its pack');
      const packBResponse = await http<{ pack: PackVersion }>(runtime, '/v1/packs', seeded.cookieB, {
        method: 'POST',
        json: {
          name: sharedPackName,
          version: '1.0.0',
          description: 'Company B shared pack',
          skills: [{ ref: sharedSkillName, version: '1.0.0' }],
        },
      });
      expect(packBResponse.response.status).toBe(201);
      const packB = packBResponse.value?.pack;
      if (!packB) throw new Error('Company B pack response omitted its pack');
      expect(packA.name).toBe(sharedPackName);
      expect(packB.name).toBe(sharedPackName);
      expect(packA.id).not.toBe(packB.id);
      expect(packA.organizationId).toBe(TENANT_A);
      expect(packB.organizationId).toBe(TENANT_B);
      expect(packA.members.map((member) => member.resourceId)).toEqual([approvedA.skill.id]);
      expect(packB.members.map((member) => member.resourceId)).toEqual([approvedB.skill.id]);

      const packsA = await http<{ packs: PackVersion[] }>(runtime, '/v1/packs', seeded.cookieA, { method: 'GET' });
      const packsB = await http<{ packs: PackVersion[] }>(runtime, '/v1/packs', seeded.cookieB, { method: 'GET' });
      expect(packsA.response.status).toBe(200);
      expect(packsB.response.status).toBe(200);
      expect(packsA.value?.packs.map((pack) => pack.id)).toEqual([packA.id]);
      expect(packsB.value?.packs.map((pack) => pack.id)).toEqual([packB.id]);
      const foreignPack = await http(runtime, `/v1/packs/${encodeURIComponent(packA.id)}`, seeded.cookieB, { method: 'GET' });
      expect(foreignPack.response.status).toBe(404);
      await expectNoDigest(foreignPack.response, packA.manifestDigest);

      const packResolutionAResponse = await http<{ resolution: Resolution }>(runtime, '/v1/resolve', seeded.cookieA, {
        method: 'POST',
        json: { kind: 'pack', ref: sharedPackName, version: '1.0.0' },
      });
      expect(packResolutionAResponse.response.status).toBe(200);
      const packResolutionA = packResolutionAResponse.value?.resolution;
      if (!packResolutionA) throw new Error('Company A pack resolution was omitted');
      expect(packResolutionA.kind).toBe('pack');
      expect(packResolutionA.organizationId).toBe(TENANT_A);
      expect(packResolutionA.resourceId).toBe(packA.id);
      expect(packResolutionA.members.map((member) => member.id)).toEqual([approvedA.skill.id]);
      const packResolutionBResponse = await http<{ resolution: Resolution }>(runtime, '/v1/resolve', seeded.cookieB, {
        method: 'POST',
        json: { kind: 'pack', ref: sharedPackName, version: '1.0.0' },
      });
      expect(packResolutionBResponse.response.status).toBe(200);
      const packResolutionB = packResolutionBResponse.value?.resolution;
      if (!packResolutionB) throw new Error('Company B pack resolution was omitted');
      expect(packResolutionB.resourceId).toBe(packB.id);
      expect(packResolutionB.members.map((member) => member.id)).toEqual([approvedB.skill.id]);
      const foreignPackAuthorization = await http(runtime, '/v1/install-authorizations', seeded.cookieB, {
        method: 'POST',
        json: { resolution: packResolutionA },
      });
      expect(foreignPackAuthorization.response.status).toBe(404);
      await expectNoDigest(foreignPackAuthorization.response, packA.manifestDigest);

      type DraftView = { id: string; revision: number; digest: string; files: Array<{ path: string }> };
      const createAndEditDraft = async (
        cookie: string,
        skill: SkillVersion,
        label: string,
      ): Promise<{ created: DraftView; updated: DraftView }> => {
        const createdResponse = await http<{ draft: DraftView }>(
          runtime!,
          `/v1/skills/${encodeURIComponent(skill.id)}/drafts`,
          cookie,
          { method: 'POST', headers: { 'idempotency-key': `draft-create-${runId}-${label}` }, json: { baseDigest: skill.artifact.digest } },
        );
        if (createdResponse.response.status !== 201) {
          throw new Error(`${label} draft creation failed (${createdResponse.response.status}): ${await createdResponse.response.clone().text()}`);
        }
        expect(createdResponse.response.status).toBe(201);
        const created = createdResponse.value?.draft;
        if (!created) throw new Error(`${label} draft creation omitted its draft`);
        const editedBundle = bundleFor(skill.skillName, `Edited ${label} shared draft`) as SkillBundle;
        const updatedResponse = await http<{ draft: DraftView }>(runtime!, `/v1/drafts/${encodeURIComponent(created.id)}`, cookie, {
          method: 'PUT',
          headers: { 'idempotency-key': `draft-update-${runId}-${label}` },
          json: { expectedRevision: 1, files: editedBundle.files },
        });
        expect(updatedResponse.response.status).toBe(200);
        const updated = updatedResponse.value?.draft;
        if (!updated) throw new Error(`${label} draft update omitted its draft`);
        expect(updated.revision).toBe(2);
        expect(updated.files.length).toBeGreaterThan(0);
        const persistedResponse = await http<{ draft: DraftView }>(runtime!, `/v1/drafts/${encodeURIComponent(created.id)}`, cookie, { method: 'GET' });
        expect(persistedResponse.response.status).toBe(200);
        const persisted = persistedResponse.value?.draft;
        if (!persisted) throw new Error(`${label} persisted draft was omitted`);
        expect(persisted).toMatchObject({ id: created.id, revision: 2, digest: updated.digest });
        expect(persisted.files.length).toBeGreaterThan(0);
        return { created, updated: persisted };
      };
      const draftA = await createAndEditDraft(seeded.cookieA, approvedA.skill, 'company-a');
      const draftB = await createAndEditDraft(seeded.cookieB, approvedB.skill, 'company-b');
      const draftFileA = await http<{ file: { path: string; content: string } }>(
        runtime,
        `/v1/drafts/${encodeURIComponent(draftA.updated.id)}/files?path=SKILL.md&revision=2&digest=${encodeURIComponent(draftA.updated.digest)}`,
        seeded.cookieA,
        { method: 'GET' },
      );
      expect(draftFileA.response.status).toBe(200);
      expect(draftFileA.value?.file).toMatchObject({ path: 'SKILL.md', content: expect.any(String) });
      const foreignDraft = await http(runtime, `/v1/drafts/${encodeURIComponent(draftA.updated.id)}`, seeded.cookieB, { method: 'GET' });
      expect(foreignDraft.response.status).toBe(404);
      const foreignDraftFile = await http(runtime, `/v1/drafts/${encodeURIComponent(draftA.updated.id)}/files?path=SKILL.md&revision=2&digest=${encodeURIComponent(draftA.updated.digest)}`, seeded.cookieB, { method: 'GET' });
      expect(foreignDraftFile.response.status).toBe(404);
      expect(draftB.updated.id).not.toBe(draftA.updated.id);

      const searchReindexA = await http<{ indexed: number }>(runtime, '/v1/search/reindex', seeded.cookieA, { method: 'POST' });
      const searchReindexB = await http<{ indexed: number }>(runtime, '/v1/search/reindex', seeded.cookieB, { method: 'POST' });
      expect(searchReindexA.response.status).toBe(200);
      expect(searchReindexB.response.status).toBe(200);
      expect(searchReindexA.value?.indexed).toBe(1);
      expect(searchReindexB.value?.indexed).toBe(1);
      const searchA = await http<{ results: Array<{ resourceId: string }> }>(runtime, '/v1/search?q=shared&limit=20', seeded.cookieA, { method: 'GET' });
      const searchB = await http<{ results: Array<{ resourceId: string }> }>(runtime, '/v1/search?q=shared&limit=20', seeded.cookieB, { method: 'GET' });
      expect(searchA.response.status).toBe(200);
      expect(searchB.response.status).toBe(200);
      const searchIdsA = searchA.value?.results.map((result) => result.resourceId) ?? [];
      const searchIdsB = searchB.value?.results.map((result) => result.resourceId) ?? [];
      expect(searchIdsA).toEqual([approvedA.skill.id]);
      expect(searchIdsB).toEqual([approvedB.skill.id]);
      expect(searchIdsA).not.toContain(approvedB.skill.id);
      expect(searchIdsB).not.toContain(approvedA.skill.id);
      expect(gateway.requestCount).toBeGreaterThan(0);

      const authorizationA = await http<{ authorization: { id: string }; receipt: { id: string } }>(runtime, '/v1/install-authorizations', seeded.cookieA, {
        method: 'POST',
        json: { resolution: packResolutionA },
      });
      expect(authorizationA.response.status).toBe(201);
      const authorizationIdA = authorizationA.value?.authorization.id;
      expect(authorizationA.value?.receipt.id).toBeDefined();
      if (!authorizationIdA) throw new Error('Company A pack authorization omitted its id');
      const authorizationB = await http<{ authorization: { id: string }; receipt: { id: string } }>(runtime, '/v1/install-authorizations', seeded.cookieB, {
        method: 'POST',
        json: { resolution: packResolutionB },
      });
      expect(authorizationB.response.status).toBe(201);
      const authorizationIdB = authorizationB.value?.authorization.id;
      expect(authorizationB.value?.receipt.id).toBeDefined();
      if (!authorizationIdB) throw new Error('Company B pack authorization omitted its id');
      const receiptA = await http(runtime, '/v1/install-receipts', seeded.cookieA, {
        method: 'POST',
        json: { authorizationId: authorizationIdA, changed: true, agent: 'codex', platform: 'linux', clientVersion: `nitro-pack-${runId}` },
      });
      expect(receiptA.response.status).toBe(201);
      const receiptB = await http(runtime, '/v1/install-receipts', seeded.cookieB, {
        method: 'POST',
        json: { authorizationId: authorizationIdB, changed: true, agent: 'codex', platform: 'linux', clientVersion: `nitro-pack-${runId}` },
      });
      expect(receiptB.response.status).toBe(201);
      const analyticsA = await http<InstallAnalytics>(runtime, '/v1/analytics?days=1', seeded.cookieA, { method: 'GET' });
      const analyticsB = await http<InstallAnalytics>(runtime, '/v1/analytics?days=1', seeded.cookieB, { method: 'GET' });
      expect(analyticsA.response.status).toBe(200);
      expect(analyticsB.response.status).toBe(200);
      expect(analyticsA.value?.totals).toMatchObject({ installOperations: 1, skillInstalls: 0, packInstalls: 1 });
      expect(analyticsB.value?.totals).toMatchObject({ installOperations: 1, skillInstalls: 0, packInstalls: 1 });
      expect(analyticsA.value?.topSkills.map((skill) => skill.resourceId)).toEqual([approvedA.skill.id]);
      expect(analyticsB.value?.topSkills.map((skill) => skill.resourceId)).toEqual([approvedB.skill.id]);
      expect(analyticsA.value?.topSkills.map((skill) => skill.resourceId)).not.toContain(approvedB.skill.id);
      expect(analyticsB.value?.topSkills.map((skill) => skill.resourceId)).not.toContain(approvedA.skill.id);
    } finally {
      await gateway?.close();
    }
  }, 240_000);
});
