/**
 * Rehearse the local application serving path from a retained PostgreSQL
 * recovery target and an existing private Files SDK Blob backup.
 *
 * The source PostgreSQL container is read with pg_dump and is never stopped,
 * updated, or removed. The hosted Blob prefix is read with getVerified only;
 * all materialization writes go to a disposable Files SDK filesystem root.
 * A disposable PostgreSQL clone and a disposable Nitro process then exercise
 * the authenticated catalog/detail/files/transfer boundary. The bootstrap
 * credential is generated in process and is never written to evidence.
 *
 * This is an operator rehearsal, not a hosted rollback. Better Auth, billing,
 * directory, worker, and external scanner integrations remain disabled. The
 * persisted admission policy is deliberately left intact, so stale evidence
 * causes the real file/download gates to deny access instead of being
 * refreshed or bypassed by this script.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import {
  createNodeFilesSdkBlobStore,
} from '../packages/storage/src/node.js';
import {
  DockerExecutor,
  createSkillsGuardAdapter,
  SKILLSGUARD_PIN,
} from '../packages/scanners/src/index.js';
import {
  WorkerRunner,
} from '../workers/runner/src/index.js';
import type {
  Digest,
  RegistryState,
  SkillVersion,
  StoredBlob,
} from '../packages/contracts/src/index.js';

type SqlClient = ReturnType<typeof postgres>;

interface BlobManifestEntry {
  readonly sourceKey: string;
  readonly destinationKey: string;
  readonly digest: Digest;
  readonly size: number;
}

interface SourceBlobManifestEntry {
  readonly key: string;
  readonly digest: Digest;
  readonly size: number;
}

interface CloneTarget {
  readonly container: string;
  readonly database: string;
  readonly password: string;
  readonly port: number;
  readonly sql: SqlClient;
}

interface RuntimeTarget {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly storageRoot: string;
  readonly logs: string[];
}

interface ServingSnapshot {
  readonly routes: {
    readonly catalog: number;
    readonly detail: number;
    readonly files: number;
    readonly resolve: number;
    readonly authorization: number | null;
    readonly downloadDescriptor: number | null;
    readonly transfer: number | null;
    readonly unauthenticatedCatalog: number;
  };
  readonly admission: {
    readonly allowed: boolean;
    readonly status: string;
    readonly reason: string;
  };
  readonly filesCount: number | null;
  readonly servedBytes: number | null;
  readonly servedDigest: Digest | null;
  readonly denial: {
    readonly downloadBlockedByCurrentAdmission: boolean;
    readonly downloadBlockStatus: number | null;
    readonly downloadBlockCode: string | null;
  };
}

interface LocalScannerEvidence {
  readonly mode: 'docker-skillsguard';
  readonly policy: {
    readonly revision: string;
    readonly unchangedAfterScan: true;
  };
  readonly image: {
    readonly reference: string;
    readonly id: string;
    readonly verified: true;
  };
  readonly rescan: {
    readonly status: number;
    readonly operationId: string | null;
    readonly resourceId: string | null;
    readonly organizationId: string | null;
    readonly policyRevision: string | null;
  };
  readonly worker: {
    readonly claimed: boolean;
    readonly jobId: string | null;
    readonly allow: boolean | null;
    readonly error: string | null;
    readonly completionState: string | null;
  };
  readonly scanner: {
    readonly scannerId: string;
    readonly artifactDigest: Digest;
    readonly policyRevision: string;
    readonly status: string;
    readonly engineVersion: string;
    readonly rulesRevision: string;
    readonly coverage: {
      readonly filesEnumerated: number;
      readonly filesAnalyzed: number;
      readonly filesSkipped: number;
      readonly filesUnsupported: number;
    };
    readonly findings: number;
  } | null;
  readonly before: ServingSnapshot;
  readonly after: ServingSnapshot;
}

interface HttpResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly value?: unknown;
  readonly bytes?: Uint8Array;
}

interface StoredBlobReference {
  readonly key: string;
  readonly digest: Digest;
  readonly size: number;
  readonly path: string;
}

interface RehearsalResult {
  readonly schemaVersion: 1;
  readonly kind: 'private-skills.local-serving-path-restore-rehearsal';
  readonly observedAt: string;
  readonly status: 'passed' | 'partial' | 'blocked' | 'failed';
  readonly source: {
    readonly postgresContainer: string;
    readonly postgresDatabase: string;
    readonly registryOrganizationId: string;
    readonly registryRevision: number;
    readonly stateReferenceCount: number;
    readonly uniqueReferencedObjects: number;
    readonly referencedTotalBytes: number;
    readonly referenceManifestDigest: Digest;
    readonly sourceUnchanged: true;
  };
  readonly blob: {
    readonly evidenceFile: string;
    readonly destinationPrefix: string;
    readonly manifestObjectCount: number;
    readonly manifestTotalBytes: number;
    readonly manifestDigest: Digest;
    readonly exactStateManifestMatch: boolean;
    readonly hostedReadCount: number;
    readonly hostedWrites: 0;
    readonly hostedDeletes: 0;
    readonly localMaterializedObjectCount: number;
    readonly localMaterializedTotalBytes: number;
    readonly localReadbackVerified: boolean;
  };
  readonly application: {
    readonly runtimeProfile: 'node';
    readonly runtimeBuild: {
      readonly sourceCommit: string;
      readonly binary: string;
      readonly command: string;
    };
    readonly stateProvider: 'postgres';
    readonly storageProvider: 'filesystem';
    readonly betterAuth: 'disabled';
    readonly billing: 'disabled';
    readonly externalDirectory: 'disabled';
    readonly externalScanner: 'disabled';
    readonly localBootstrapPrincipal: 'local-serving-restore-reader';
    readonly selectedSkill: {
      readonly id: string;
      readonly name: string;
      readonly version: string;
      readonly digest: Digest;
      readonly size: number;
      readonly historicalState: string;
    };
    readonly routes: {
      readonly health: number;
      readonly catalog: number;
      readonly detail: number;
      readonly files: number;
      readonly resolve: number;
      readonly authorization: number | null;
      readonly downloadDescriptor: number | null;
      readonly transfer: number | null;
      readonly unauthenticatedCatalog: number;
    };
    readonly servedBytes: number | null;
    readonly servedDigest: Digest | null;
    readonly downloadMetadataWritesOnClone: number;
    readonly admission: {
      readonly allowed: boolean;
      readonly status: string;
      readonly reason: string;
    };
    readonly denial: {
      readonly downloadBlockedByCurrentAdmission: boolean;
      readonly downloadBlockStatus: number | null;
      readonly downloadBlockCode: string | null;
    };
    readonly localScanner?: LocalScannerEvidence;
  };
  readonly mutationBoundary: {
    readonly retainedPostgres: 'read-only pg_dump and bounded SELECT';
    readonly clonePostgres: 'created, restored, and destroyed';
    readonly hostedBlob: 'getVerified reads only';
    readonly localFilesystem: 'writes and readback only';
    readonly application: 'local Nitro process only';
    readonly hostedRollback: 'not run';
    readonly productionConfiguration: 'not changed';
  };
  readonly limits: readonly string[];
  readonly redaction: {
    readonly credentialsIncluded: false;
    readonly statePayloadIncluded: false;
    readonly objectBytesIncluded: false;
    readonly fullEnvironmentExported: false;
    readonly privateUrlsIncluded: false;
  };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_CONTAINER = 'pskills-full-pg-restore-mu3bdlhl-3ffa573c85';
const DEFAULT_SOURCE_DATABASE = 'private_skills_restore';
const DEFAULT_PROOF = join(REPO_ROOT, 'docs/evidence/hosted-blob-restore-proof-20260916.json');
const DEFAULT_RUNTIME = join(REPO_ROOT, 'apps/web/.output/server/index.mjs');
const CLONE_DATABASE = 'private_skills_restore_local';
const CLONE_IMAGE = 'pgvector/pgvector:pg18';
const SELECTED_SKILL_NAME = '@acme/m6-inert-builder-fixture';
const LOCAL_PRINCIPAL = 'local-serving-restore-reader';
const LOCAL_OPERATOR_PRINCIPAL = 'local-serving-restore-operator';
const LOCAL_WORKER_ID = 'local-serving-restore-worker';
const SKILLSGUARD_IMAGE = 'private-skills/skillsguard:1.1.1';
const SKILLSGUARD_IMAGE_ID = 'sha256:4173ec0a31e37a572b94f88cb596e8b76aa9309beef06c16bb2e4ba2f6463aa0';
const MAX_STATE_NODES = 200_000;
const MAX_STATE_DEPTH = 64;
const MAX_MANIFEST_OBJECTS = 14;
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;

function envString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function envBoolean(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

/**
 * Keep Vercel's environment runner (and any operator shell) out of the
 * disposable clone and Nitro child. Only ordinary process plumbing crosses
 * that boundary; all application configuration is supplied explicitly below.
 */
function localProcessEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
  return { ...inherited, ...overrides };
}

function safeId(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function sha256(bytes: Uint8Array | string): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Digest;
}

function aggregateDigest(rows: readonly { key: string; digest: Digest; size: number }[]): Digest {
  const canonical = [...rows]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((row) => `${row.key}\u0000${row.digest}\u0000${row.size}`)
    .join('\n');
  return sha256(canonical);
}

function safeStorageKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !value.startsWith('/') && !value.endsWith('/') && !value.includes('\\') &&
    !value.includes(':') && !value.includes('//') && !value.includes('\u0000') &&
    !value.split('/').some((segment) => segment === '.' || segment === '..');
}

function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isStoredBlobShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return 'key' in record && 'digest' in record && 'size' in record;
}

function collectStoredBlobReferences(value: unknown): StoredBlobReference[] {
  const references: StoredBlobReference[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;

  function visit(candidate: unknown, path: string, depth: number): void {
    if (!candidate || typeof candidate !== 'object') return;
    if (depth > MAX_STATE_DEPTH) throw new Error('state depth exceeds bounded rehearsal limit');
    if (seen.has(candidate)) throw new Error('state contains a cyclic value');
    seen.add(candidate);
    nodes += 1;
    if (nodes > MAX_STATE_NODES) throw new Error('state node count exceeds bounded rehearsal limit');
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (isStoredBlobShape(record)) {
      if (!safeStorageKey(record.key) || !isDigest(record.digest) ||
          typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0) {
        throw new Error(`invalid stored blob reference at ${path}`);
      }
      references.push({
        key: record.key,
        digest: record.digest,
        size: record.size,
        path,
      });
      return;
    }
    for (const [key, entry] of Object.entries(record)) visit(entry, `${path}.${key}`, depth + 1);
  }

  visit(value, 'state', 0);
  return references;
}

function parseState(raw: unknown): RegistryState {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('restored registry state is not an object');
  return parsed as RegistryState;
}

function parseProof(raw: string): {
  readonly evidenceFile: string;
  readonly destinationPrefix: string;
  readonly sourceRows: SourceBlobManifestEntry[];
  readonly destinationRows: BlobManifestEntry[];
  readonly manifestDigest: Digest;
} {
  const parsed = JSON.parse(raw) as {
    source?: { manifest?: Array<{ key?: unknown; digest?: unknown; size?: unknown }> };
    destination?: { manifest?: Array<{ sourceKey?: unknown; destinationKey?: unknown; digest?: unknown; size?: unknown }> };
    operation?: { destinationPrefix?: unknown };
  };
  const sourceRows = (parsed.source?.manifest ?? []).map((row) => {
    if (!safeStorageKey(row.key) || !isDigest(row.digest) || typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0) {
      throw new Error('hosted Blob proof contains an invalid source manifest row');
    }
    return { key: row.key, digest: row.digest, size: row.size };
  });
  const destinationRows = (parsed.destination?.manifest ?? []).map((row) => {
    if (!safeStorageKey(row.sourceKey) || !safeStorageKey(row.destinationKey) || !isDigest(row.digest) ||
        typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0) {
      throw new Error('hosted Blob proof contains an invalid destination manifest row');
    }
    return { sourceKey: row.sourceKey, destinationKey: row.destinationKey, digest: row.digest, size: row.size };
  });
  const destinationPrefix = parsed.operation?.destinationPrefix;
  if (typeof destinationPrefix !== 'string' || destinationPrefix.length === 0) throw new Error('hosted Blob proof has no destination prefix');
  if (sourceRows.length === 0 || destinationRows.length !== sourceRows.length || sourceRows.length > MAX_MANIFEST_OBJECTS) {
    throw new Error('hosted Blob proof manifest is outside bounded rehearsal limits');
  }
  const sourceByKey = new Map(sourceRows.map((row) => [row.key, row]));
  for (const row of destinationRows) {
    const source = sourceByKey.get(row.sourceKey);
    if (!source || source.digest !== row.digest || source.size !== row.size) throw new Error('hosted Blob source/destination manifest mismatch');
    if (!row.destinationKey.startsWith(`${destinationPrefix}/sealed/`)) throw new Error('hosted Blob destination key is outside its sealed prefix');
  }
  const totalBytes = sourceRows.reduce((total, row) => total + row.size, 0);
  if (totalBytes > MAX_MANIFEST_BYTES) throw new Error('hosted Blob proof manifest exceeds bounded rehearsal bytes');
  return {
    evidenceFile: 'docs/evidence/hosted-blob-restore-proof-20260916.json',
    destinationPrefix,
    sourceRows,
    destinationRows,
    manifestDigest: aggregateDigest(sourceRows),
  };
}

async function runQuiet(command: string, args: readonly string[], options: { input?: Uint8Array; timeoutMs?: number; cwd?: string } = {}): Promise<Uint8Array> {
  const child = spawn(command, [...args], { cwd: options.cwd, env: localProcessEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
  const errorOutput: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => errorOutput.push(chunk));
  // pg_restore can close docker exec's stdin as soon as it has enough input;
  // a late pipe close is expected for a disposable dump and must not become
  // an unhandled process error.
  child.stdin?.on('error', () => undefined);
  if (options.input) child.stdin?.end(options.input);
  else child.stdin?.end();
  let timer: NodeJS.Timeout | undefined;
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('bounded subprocess timeout'));
      }, options.timeoutMs);
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (exit.code !== 0) {
    // Keep provider/container diagnostics out of normal evidence. Callers
    // receive the operation and exit shape only, never command output.
    const diagnostic = process.env.PSKILLS_RESTORE_DEBUG === 'true'
      ? Buffer.concat(errorOutput).toString('utf8').trim().slice(-500)
      : '';
    throw new Error(`${command} failed (${exit.code ?? exit.signal ?? 'unknown'})${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  return new Uint8Array(Buffer.concat(output));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error('could not allocate a loopback port');
  }
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForClone(container: string, database: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await runQuiet('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', database], { timeoutMs: 2_000 });
      // pg_isready may report accepting connections during the final startup
      // transition. Confirm a real SQL query before feeding pg_restore.
      await runQuiet('docker', ['exec', '--user', 'postgres', container, 'psql', '-X', '-At', '-d', database, '-c', 'SELECT 1'], { timeoutMs: 2_000 });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error('disposable PostgreSQL clone did not become ready');
}

async function createClone(sourceContainer: string, sourceDatabase: string): Promise<{ clone: CloneTarget; dumpPath: string }> {
  const dumpDirectory = await mkdtemp(join(tmpdir(), 'pskills-local-serving-dump-'));
  const dumpPath = join(dumpDirectory, 'database.dump.pgdump');
  const dump = await runQuiet('docker', [
    'exec', '--user', 'postgres', sourceContainer, 'pg_dump', '-Fc', '-d', sourceDatabase,
  ], { timeoutMs: 120_000 });
  if (dump.byteLength === 0) throw new Error('retained PostgreSQL pg_dump returned no bytes');
  await writeFile(dumpPath, dump, { mode: 0o600 });

  const container = safeId('pskills-local-serving-pg');
  const password = randomBytes(32).toString('hex');
  const port = await freePort();
  await runQuiet('docker', [
    'run', '--detach', '--name', container,
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${CLONE_DATABASE}`,
    '--publish', `127.0.0.1:${port}:5432`,
    CLONE_IMAGE,
  ], { timeoutMs: 120_000 });
  try {
    await waitForClone(container, CLONE_DATABASE);
    const dumpBytes = new Uint8Array(await readFile(dumpPath));
    await runQuiet('docker', [
      'exec', '--interactive', '--user', 'postgres', container,
      'pg_restore', '--dbname', CLONE_DATABASE, '--no-owner', '--no-privileges', '--exit-on-error',
    ], { input: dumpBytes, timeoutMs: 120_000 });
    const sql = postgres({
      host: '127.0.0.1',
      port,
      database: CLONE_DATABASE,
      username: 'postgres',
      password,
      max: 4,
      prepare: false,
      onnotice: () => undefined,
    });
    await sql`SELECT 1`;
    return { clone: { container, database: CLONE_DATABASE, password, port, sql }, dumpPath };
  } catch (error) {
    await runQuiet('docker', ['rm', '--force', container], { timeoutMs: 30_000 }).catch(() => undefined);
    throw error;
  }
}

async function destroyClone(clone: CloneTarget | undefined): Promise<void> {
  if (!clone) return;
  await clone.sql.end({ timeout: 5 }).catch(() => undefined);
  await runQuiet('docker', ['rm', '--force', clone.container], { timeoutMs: 30_000 }).catch(() => undefined);
}

async function readRegistrySnapshot(sql: SqlClient): Promise<{ organizationId: string; revision: number; state: RegistryState }> {
  const rows = await sql.unsafe('SELECT organization_id, revision, state FROM "private_skills_registry_state" WHERE organization_id = $1', ['default']);
  if (rows.length !== 1) throw new Error('restored registry must contain exactly one default organization row');
  const row = rows[0] as { organization_id?: unknown; revision?: unknown; state?: unknown };
  const organizationId = row.organization_id;
  const revision = Number(row.revision);
  if (organizationId !== 'default' || !Number.isSafeInteger(revision)) throw new Error('restored registry identity or revision is invalid');
  return { organizationId, revision, state: parseState(row.state) };
}

async function fetchJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/json')) return undefined;
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

async function request(origin: string, path: string, token: string, init: RequestInit = {}): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  headers.set('origin', origin);
  const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'error' });
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) return { status: response.status, contentType, value: await fetchJson(response) };
  if (response.status === 200) return { status: response.status, contentType, bytes: new Uint8Array(await response.arrayBuffer()) };
  return { status: response.status, contentType };
}

function codeOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { code?: unknown; error?: { code?: unknown } };
  const code = candidate.code ?? candidate.error?.code;
  return typeof code === 'string' ? code : null;
}

function objectField(value: unknown, field: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[field];
}

async function stopRuntime(runtime: RuntimeTarget | undefined): Promise<void> {
  if (!runtime) return;
  if (runtime.child.exitCode === null) {
    runtime.child.kill('SIGTERM');
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        runtime.child.kill('SIGKILL');
        resolveStop();
      }, 5_000);
      runtime.child.once('exit', () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
  }
}

async function assertPinnedSkillsGuardImage(): Promise<void> {
  const inspected = Buffer.from(await runQuiet('docker', [
    'image', 'inspect', SKILLSGUARD_IMAGE, '--format', '{{.Id}}',
  ], { timeoutMs: 30_000 })).toString('utf8').trim();
  if (inspected !== SKILLSGUARD_IMAGE_ID) {
    throw new Error('local SkillsGuard image does not match the pinned image identity');
  }
}

function skillByName(state: RegistryState): SkillVersion {
  const skill = state.skills.find((candidate) => candidate.name === SELECTED_SKILL_NAME);
  if (!skill) throw new Error(`restored fixture ${SELECTED_SKILL_NAME} is missing`);
  return skill;
}

function admissionFromCatalog(value: unknown): ServingSnapshot['admission'] {
  const skill = objectField(value, 'skill');
  const admission = objectField(skill, 'currentAdmission');
  return {
    allowed: objectField(admission, 'allowed') === true,
    status: typeof objectField(admission, 'status') === 'string' ? objectField(admission, 'status') as string : 'unknown',
    reason: typeof objectField(admission, 'reason') === 'string' ? objectField(admission, 'reason') as string : 'unknown',
  };
}

async function readServingSnapshot(runtime: RuntimeTarget, skill: SkillVersion, token: string): Promise<ServingSnapshot> {
  const catalog = await request(runtime.origin, '/v1/skills', token);
  const catalogSkills = objectField(catalog.value, 'skills');
  if (!Array.isArray(catalogSkills) || !catalogSkills.some((entry) => objectField(entry, 'id') === skill.id)) {
    const diagnostics = runtime.logs.join('').trim().slice(-800);
    throw new Error(`catalog did not contain the restored fixture (status ${catalog.status}; code ${codeOf(catalog.value) ?? 'none'}${diagnostics ? `; runtime ${diagnostics}` : ''})`);
  }
  const catalogFixture = catalogSkills.find((entry) => objectField(entry, 'id') === skill.id);
  const admission = admissionFromCatalog({ skill: catalogFixture });
  const detail = await request(runtime.origin, `/v1/skills/${encodeURIComponent(skill.id)}`, token);
  const detailSkill = objectField(detail.value, 'skill');
  if (objectField(detailSkill, 'id') !== skill.id || objectField(objectField(detailSkill, 'artifact'), 'digest') !== skill.artifact.digest) {
    throw new Error('detail did not return the restored fixture digest');
  }
  const files = await request(runtime.origin, `/v1/skills/${encodeURIComponent(skill.id)}/files`, token);
  const filesValue = objectField(files.value, 'files');
  const filesCount = Array.isArray(filesValue) ? filesValue.length : null;
  const resolve = await request(runtime.origin, '/v1/resolve', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'skill', ref: skill.name, version: skill.version }),
  });

  const authorization = resolve.status === 200 && objectField(resolve.value, 'resolution')
    ? await request(runtime.origin, '/v1/install-authorizations', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolution: objectField(resolve.value, 'resolution') }),
    })
    : undefined;
  const resolution = objectField(resolve.value, 'resolution');
  const authorizationValue = objectField(authorization?.value, 'authorization');
  const authorizationId = objectField(authorizationValue, 'id');
  const descriptor = resolve.status === 200 && authorization?.status === 201 && typeof authorizationId === 'string' && resolution
    ? await request(runtime.origin, `/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: skill.id, authorizationId }),
    })
    : undefined;
  const descriptorValue = objectField(descriptor?.value, 'url');
  let transfer: HttpResult | undefined;
  if (descriptor?.status === 200 && typeof descriptorValue === 'string') {
    transfer = await request(runtime.origin, new URL(descriptorValue).pathname, token);
  }

  const unauthenticated = await request(runtime.origin, '/v1/skills', '');
  const transferBytes = transfer?.bytes;
  const servedDigest = transferBytes ? sha256(transferBytes) : null;
  const downloadBlockedByCurrentAdmission = admission.allowed === false &&
    (resolve.status >= 400 || files.status >= 400 || (descriptor?.status ?? 0) >= 400 || (transfer?.status ?? 0) >= 400);
  const downloadBlockResponse = [resolve, files, descriptor, transfer].find((candidate) => (candidate?.status ?? 0) >= 400);
  return {
    routes: {
      catalog: catalog.status,
      detail: detail.status,
      files: files.status,
      resolve: resolve.status,
      authorization: authorization?.status ?? null,
      downloadDescriptor: descriptor?.status ?? null,
      transfer: transfer?.status ?? null,
      unauthenticatedCatalog: unauthenticated.status,
    },
    admission,
    filesCount,
    servedBytes: transferBytes?.byteLength ?? null,
    servedDigest,
    denial: {
      downloadBlockedByCurrentAdmission,
      downloadBlockStatus: downloadBlockResponse?.status ?? null,
      downloadBlockCode: codeOf(downloadBlockResponse?.value),
    },
  };
}

interface ApplicationJourneyOptions {
  readonly runLocalScanner?: boolean;
  readonly operatorToken?: string;
  readonly workerToken?: string;
  readonly expectedPolicyRevision?: string;
}

async function runApplicationJourney(
  runtime: RuntimeTarget,
  skill: SkillVersion,
  token: string,
  options: ApplicationJourneyOptions = {},
): Promise<RehearsalResult['application']> {
  const before = await readServingSnapshot(runtime, skill, token);
  if (options.runLocalScanner !== true) {
    return applicationFromSnapshot(skill, before);
  }

  const operatorToken = options.operatorToken;
  const workerToken = options.workerToken;
  if (!operatorToken || !workerToken) throw new Error('local scanner requires operator and worker tokens');
  if (before.admission.allowed || before.admission.status !== 'needs-rescan' || before.admission.reason !== 'evidence-stale') {
    throw new Error(`expected the restored fixture to be denied before rescan (status ${before.admission.status}; reason ${before.admission.reason})`);
  }
  if (before.routes.files !== 404 || before.routes.resolve !== 404 || !before.denial.downloadBlockedByCurrentAdmission) {
    throw new Error('the stale restored fixture did not demonstrate the pre-scan distribution denial');
  }

  const rescan = await request(runtime.origin, `/v1/skills/${encodeURIComponent(skill.id)}/rescan`, operatorToken, {
    method: 'POST',
  });
  const queuedOperation = objectField(rescan.value, 'operation');
  const operationId = objectField(queuedOperation, 'id');
  const queuedResourceId = objectField(queuedOperation, 'resourceId');
  const queuedOrganizationId = objectField(queuedOperation, 'organizationId');
  const queuedPolicyRevision = objectField(queuedOperation, 'policyRevision');
  if (rescan.status !== 202 || typeof operationId !== 'string' || operationId.length === 0) {
    throw new Error(`rescan did not queue a job (status ${rescan.status}; code ${codeOf(rescan.value) ?? 'none'})`);
  }
  if (
    queuedResourceId !== skill.id ||
    queuedOrganizationId !== 'default' ||
    typeof options.expectedPolicyRevision !== 'string' ||
    queuedPolicyRevision !== options.expectedPolicyRevision
  ) {
    throw new Error('rescan job is not bound to the restored skill, organization, or policy revision');
  }

  const worker = new WorkerRunner({
    baseUrl: runtime.origin,
    workerToken,
    workerId: LOCAL_WORKER_ID,
    adapters: [createSkillsGuardAdapter()],
    executor: new DockerExecutor(),
    scannerImages: { skillsguard: SKILLSGUARD_IMAGE_ID },
  });
  const workerResult = await worker.runOnce();
  if (!workerResult.claimed || workerResult.jobId !== operationId) {
    throw new Error('worker claimed a different job or did not claim the queued rescan');
  }
  const scannerResult = workerResult.scannerResults?.find((result) => result.scannerId === 'skillsguard');
  if (
    scannerResult !== undefined &&
    (
      scannerResult.artifactDigest !== skill.artifact.digest ||
      scannerResult.policyRevision !== options.expectedPolicyRevision
    )
  ) {
    throw new Error('scanner evidence is not bound to the restored artifact and policy revision');
  }
  const operation = await request(runtime.origin, `/v1/operations/${encodeURIComponent(operationId)}`, operatorToken);
  const operationValue = objectField(operation.value, 'operation') ?? operation.value;
  const completionState = typeof objectField(operationValue, 'state') === 'string'
    ? objectField(operationValue, 'state') as string
    : null;
  const after = await readServingSnapshot(runtime, skill, token);
  const localScanner: LocalScannerEvidence = {
    mode: 'docker-skillsguard',
    policy: {
      revision: options.expectedPolicyRevision!,
      unchangedAfterScan: true,
    },
    image: {
      reference: SKILLSGUARD_IMAGE,
      id: SKILLSGUARD_IMAGE_ID,
      verified: true,
    },
    rescan: {
      status: rescan.status,
      operationId,
      resourceId: typeof queuedResourceId === 'string' ? queuedResourceId : null,
      organizationId: typeof queuedOrganizationId === 'string' ? queuedOrganizationId : null,
      policyRevision: typeof queuedPolicyRevision === 'string' ? queuedPolicyRevision : null,
    },
    worker: {
      claimed: workerResult.claimed,
      jobId: workerResult.jobId ?? null,
      allow: workerResult.allow ?? null,
      error: workerResult.error ?? null,
      completionState,
    },
    scanner: scannerResult === undefined ? null : {
      scannerId: scannerResult.scannerId,
      artifactDigest: scannerResult.artifactDigest,
      policyRevision: scannerResult.policyRevision,
      status: scannerResult.status,
      engineVersion: scannerResult.engineVersion,
      rulesRevision: scannerResult.rulesRevision,
      coverage: {
        filesEnumerated: scannerResult.coverage.filesEnumerated,
        filesAnalyzed: scannerResult.coverage.filesAnalyzed,
        filesSkipped: scannerResult.coverage.filesSkipped,
        filesUnsupported: scannerResult.coverage.filesUnsupported,
      },
      findings: scannerResult.findings.length,
    },
    before,
    after,
  };
  if (
    workerResult.allow === true &&
    (
      scannerResult === undefined ||
      scannerResult.status !== 'completed' ||
      scannerResult.engineVersion !== SKILLSGUARD_PIN.release ||
      scannerResult.rulesRevision !== SKILLSGUARD_PIN.sourceRevision ||
      scannerResult.coverage.filesEnumerated !== skill.fileCount ||
      scannerResult.coverage.filesAnalyzed !== skill.fileCount ||
      scannerResult.coverage.filesSkipped !== 0 ||
      scannerResult.coverage.filesUnsupported !== 0 ||
      scannerResult.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical')
    )
  ) {
    throw new Error('worker reported allow without complete, pinned, clean SkillsGuard evidence');
  }
  return {
    ...applicationFromSnapshot(skill, after),
    localScanner,
  };
}

function applicationFromSnapshot(skill: SkillVersion, snapshot: ServingSnapshot): RehearsalResult['application'] {
  return {
    runtimeProfile: 'node',
    stateProvider: 'postgres',
    storageProvider: 'filesystem',
    betterAuth: 'disabled',
    billing: 'disabled',
    externalDirectory: 'disabled',
    externalScanner: 'disabled',
    localBootstrapPrincipal: LOCAL_PRINCIPAL,
    selectedSkill: {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      digest: skill.artifact.digest,
      size: skill.artifact.size,
      historicalState: skill.state,
    },
    routes: {
      health: 200,
      ...snapshot.routes,
    },
    servedBytes: snapshot.servedBytes,
    servedDigest: snapshot.servedDigest,
    // The authorization and grant endpoints append clone-local metadata when
    // admission is current. We cannot inspect a prior count after cleanup, so
    // this reports the bounded route behavior rather than a source mutation.
    downloadMetadataWritesOnClone: snapshot.routes.authorization === 201 ? 1 + (snapshot.routes.downloadDescriptor === 200 ? 1 : 0) : 0,
    admission: snapshot.admission,
    denial: snapshot.denial,
  };
}

function buildResult(input: {
  readonly sourceContainer: string;
  readonly sourceDatabase: string;
  readonly registryRevision: number;
  readonly stateReferenceCount: number;
  readonly uniqueReferencedObjects: number;
  readonly referencedTotalBytes: number;
  readonly referenceManifestDigest: Digest;
  readonly blob: RehearsalResult['blob'];
  readonly application: RehearsalResult['application'];
  readonly runtimeSourceCommit: string;
  readonly runtimeBinary: string;
}): RehearsalResult {
  const applicationPassed = input.application.routes.health === 200 &&
    input.application.routes.catalog === 200 && input.application.routes.detail === 200 &&
    input.application.routes.unauthenticatedCatalog === 401;
  const filesPassed = input.application.routes.files === 200;
  const downloadPassed = input.application.routes.transfer === 200 &&
    input.application.servedBytes === input.application.selectedSkill.size &&
    input.application.servedDigest === input.application.selectedSkill.digest;
  const scannerPassed = input.application.localScanner === undefined || input.application.localScanner.worker.allow === true;
  const status = input.blob.exactStateManifestMatch && input.blob.localReadbackVerified && applicationPassed &&
    filesPassed && downloadPassed && scannerPassed ? 'passed' : applicationPassed ? 'partial' : 'blocked';
  return {
    schemaVersion: 1,
    kind: 'private-skills.local-serving-path-restore-rehearsal',
    observedAt: new Date().toISOString(),
    status,
    source: {
      postgresContainer: input.sourceContainer,
      postgresDatabase: input.sourceDatabase,
      registryOrganizationId: 'default',
      registryRevision: input.registryRevision,
      stateReferenceCount: input.stateReferenceCount,
      uniqueReferencedObjects: input.uniqueReferencedObjects,
      referencedTotalBytes: input.referencedTotalBytes,
      referenceManifestDigest: input.referenceManifestDigest,
      sourceUnchanged: true,
    },
    blob: input.blob,
    application: {
      ...input.application,
      runtimeBuild: {
        sourceCommit: input.runtimeSourceCommit,
        binary: relative(REPO_ROOT, input.runtimeBinary) || '.',
        command: 'PSKILLS_STORAGE_BUILD_PROFILE=filesystem PSKILLS_STORAGE_PROVIDER=filesystem PSKILLS_RUNTIME_PROFILE=node pnpm --filter @private-skills/web build',
      },
    },
    mutationBoundary: {
      retainedPostgres: 'read-only pg_dump and bounded SELECT',
      clonePostgres: 'created, restored, and destroyed',
      hostedBlob: 'getVerified reads only',
      localFilesystem: 'writes and readback only',
      application: 'local Nitro process only',
      hostedRollback: 'not run',
      productionConfiguration: 'not changed',
    },
    limits: [
      'The PostgreSQL clone was copied from the retained local recovery target; this is not a fresh hosted production snapshot.',
      'The PostgreSQL and hosted Blob proofs were captured separately; no shared MVCC/provider snapshot or coordinated freeze was established.',
      'The application used a generated legacy bootstrap token with Better Auth disabled; restored Better Auth sessions, memberships, SSO, and service-token revocations were not exercised.',
      input.application.localScanner === undefined
        ? 'Billing, external directory, hosted worker, and external scanner integrations were disabled. The persisted required-scanner policy was preserved and stale evidence was allowed to deny serving.'
        : 'Billing, external directory, and hosted worker integrations were disabled. The persisted required-scanner policy was preserved: stale evidence denied the pre-scan routes, then the pinned local SkillsGuard Docker worker refreshed the disposable clone through the normal rescan/job path.',
      'The selected snapshot fixture can prove read authorization only for its default organization. No second-company route denial was asserted by this single-tenant restore.',
      'Hosted rollback, hosted filesystem remapping, provider IAM/lifecycle state, and external identity or billing provider state remain outside this rehearsal.',
    ],
    redaction: {
      credentialsIncluded: false,
      statePayloadIncluded: false,
      objectBytesIncluded: false,
      fullEnvironmentExported: false,
      privateUrlsIncluded: false,
    },
  };
}

async function main(): Promise<void> {
  const sourceContainer = envString('PSKILLS_RESTORE_SOURCE_CONTAINER', DEFAULT_SOURCE_CONTAINER);
  const sourceDatabase = envString('PSKILLS_RESTORE_SOURCE_DATABASE', DEFAULT_SOURCE_DATABASE);
  const proofPath = resolve(envString('PSKILLS_RESTORE_BLOB_PROOF', DEFAULT_PROOF));
  const runtimeBinary = resolve(envString('PSKILLS_RESTORE_RUNTIME_BINARY', DEFAULT_RUNTIME));
  const evidencePathRaw = process.env.PSKILLS_RESTORE_EVIDENCE_PATH?.trim();
  const evidencePath = evidencePathRaw ? resolve(evidencePathRaw) : undefined;
  const keepDisposables = envBoolean('PSKILLS_RESTORE_KEEP_DISPOSABLES');
  const runLocalScanner = envBoolean('PSKILLS_RESTORE_RUN_LOCAL_SCANNER');
  let clone: CloneTarget | undefined;
  let dumpPath: string | undefined;
  let runtime: RuntimeTarget | undefined;
  let localRoot: string | undefined;
  let result: RehearsalResult | undefined;
  let stage = 'startup';
  try {
    stage = 'read-source-commit';
    const sourceCommit = Buffer.from(await runQuiet('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).toString('utf8').trim();
    if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error('working tree commit is invalid');
    if (runLocalScanner) {
      stage = 'verify-local-scanner-image';
      await assertPinnedSkillsGuardImage();
    }
    stage = 'load-proof';
    const proof = parseProof(await readFile(proofPath, 'utf8'));
    stage = 'clone-postgres';
    const { clone: createdClone, dumpPath: createdDumpPath } = await createClone(sourceContainer, sourceDatabase);
    clone = createdClone;
    dumpPath = createdDumpPath;
    stage = 'read-restored-registry';
    const restored = await readRegistrySnapshot(clone.sql);
    const references = collectStoredBlobReferences(restored.state);
    const byKey = new Map<string, StoredBlobReference[]>();
    for (const reference of references) byKey.set(reference.key, [...(byKey.get(reference.key) ?? []), reference]);
    for (const entries of byKey.values()) {
      const first = entries[0]!;
      if (entries.some((entry) => entry.digest !== first.digest || entry.size !== first.size)) throw new Error('restored state has conflicting object references');
    }
    const stateRows = [...byKey.values()].map((entries) => entries[0]!).map(({ key, digest, size }) => ({ key, digest, size }));
    const expectedRows = proof.sourceRows.map(({ key, digest, size }) => ({ key, digest, size }));
    const stateByKey = new Map(stateRows.map((row) => [row.key, row]));
    const exactStateManifestMatch = stateRows.length === expectedRows.length && expectedRows.every((row) => {
      const actual = stateByKey.get(row.key);
      return actual?.digest === row.digest && actual.size === row.size;
    });
    if (!exactStateManifestMatch) throw new Error('restored state object manifest does not match hosted Blob proof');

    stage = 'materialize-local-blobs';
    localRoot = await mkdtemp(join(tmpdir(), 'pskills-local-serving-blobs-'));
    const remote = await createNodeFilesSdkBlobStore({
      provider: 'vercel-blob',
      prefix: proof.destinationPrefix,
      credentials: { token: process.env.BLOB_READ_WRITE_TOKEN },
    });
    const local = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root: localRoot,
      providerBinding: 'files-sdk:filesystem:local-serving-restore-v1',
    });
    let hostedReadCount = 0;
    let localMaterializedTotalBytes = 0;
    let localReadbackVerified = true;
    for (const row of proof.destinationRows) {
      const bytes = await remote.getVerified(row.destinationKey, row.digest);
      hostedReadCount += 1;
      if (bytes.byteLength !== row.size) throw new Error('hosted Blob read size mismatch');
      const stored: StoredBlob = await local.putAtKey(row.sourceKey, bytes);
      if (stored.key !== row.sourceKey || stored.digest !== row.digest || stored.size !== row.size) throw new Error('local Files SDK materialization mismatch');
      const readback = await local.getVerified(row.sourceKey, row.digest);
      localReadbackVerified = localReadbackVerified && readback.byteLength === row.size && sha256(readback) === row.digest;
      localMaterializedTotalBytes += readback.byteLength;
    }
    if (!localReadbackVerified) throw new Error('local Files SDK readback verification failed');

    const selectedSkill = skillByName(restored.state);
    if (!proof.sourceRows.some((row) => row.key === selectedSkill.artifact.key && row.digest === selectedSkill.artifact.digest && row.size === selectedSkill.artifact.size)) {
      throw new Error('selected restored skill artifact is absent from the exact Blob manifest');
    }
    const selectedArtifact = proof.destinationRows.find((row) => row.sourceKey === selectedSkill.artifact.key);
    if (!selectedArtifact) throw new Error('selected restored skill has no materialized destination object');

    stage = 'start-nitro';
    // The runtime's bootstrap credential is process-local. It is deliberately
    // generated in this scope and only its public subject is emitted below.
    const runtimeToken = `local-serving-restore-${randomBytes(24).toString('hex')}`;
    const operatorToken = `local-serving-restore-operator-${randomBytes(24).toString('hex')}`;
    const workerToken = `local-serving-restore-worker-${randomBytes(24).toString('hex')}`;
    const runtimeOriginPort = await freePort();
    const runtimeOrigin = `http://127.0.0.1:${runtimeOriginPort}`;
    // Start a fresh process with this explicit token. It remains in this
    // process and the child environment only for the duration of the probe.
    const runtimeStart = await startRuntimeWithToken(runtimeBinary, clone, localRoot, runtimeOrigin, runtimeToken, operatorToken, workerToken);
    runtime = runtimeStart.runtime;
    stage = 'exercise-serving-routes';
    const application = await runApplicationJourney(runtime, selectedSkill, runtimeToken, {
      runLocalScanner,
      ...(runLocalScanner ? { operatorToken, workerToken, expectedPolicyRevision: restored.state.policy.revision } : {}),
    });
    if (runLocalScanner) {
      const restoredAfterScan = await readRegistrySnapshot(clone.sql);
      if (
        JSON.stringify(restoredAfterScan.state.policy) !== JSON.stringify(restored.state.policy)
      ) {
        throw new Error('local scan changed the restored scanner policy or policy revision');
      }
    }
    stage = 'build-evidence';
    result = buildResult({
      sourceContainer,
      sourceDatabase,
      registryRevision: restored.revision,
      stateReferenceCount: references.length,
      uniqueReferencedObjects: byKey.size,
      referencedTotalBytes: stateRows.reduce((total, row) => total + row.size, 0),
      referenceManifestDigest: aggregateDigest(stateRows),
      blob: {
        evidenceFile: proof.evidenceFile,
        destinationPrefix: proof.destinationPrefix,
        manifestObjectCount: proof.sourceRows.length,
        manifestTotalBytes: proof.sourceRows.reduce((total, row) => total + row.size, 0),
        manifestDigest: proof.manifestDigest,
        exactStateManifestMatch,
        hostedReadCount,
        hostedWrites: 0,
        hostedDeletes: 0,
        localMaterializedObjectCount: proof.destinationRows.length,
        localMaterializedTotalBytes,
        localReadbackVerified,
      },
      application,
      runtimeSourceCommit: sourceCommit,
      runtimeBinary,
    });
  } catch (error) {
    throw new Error(`rehearsal stage ${stage} failed`, { cause: error });
  } finally {
    await stopRuntime(runtime);
    if (!keepDisposables) {
      await rm(localRoot ?? '', { recursive: true, force: true }).catch(() => undefined);
      await destroyClone(clone);
      if (dumpPath) await rm(dirname(dumpPath), { recursive: true, force: true }).catch(() => undefined);
    } else {
      // Retained mode is for a separate local inspection process. Do not keep
      // a postgres.js socket open after the rehearsal has finished.
      await clone?.sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }
  if (!result) throw new Error('rehearsal did not produce a result');
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (evidencePath) {
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, text, { mode: 0o600 });
  }
  process.stdout.write(text);
}

interface RuntimeStartWithTokenResult {
  readonly runtime: RuntimeTarget;
}

async function startRuntimeWithToken(
  runtimeBinary: string,
  clone: CloneTarget,
  storageRoot: string,
  origin: string,
  token: string,
  operatorToken: string,
  workerToken: string,
): Promise<RuntimeStartWithTokenResult> {
  const port = Number(new URL(origin).port);
  const bootstrapTokens = JSON.stringify([
    {
      id: LOCAL_PRINCIPAL,
      token,
      organizationId: 'default',
      subject: LOCAL_PRINCIPAL,
      roles: ['reader'],
      scopes: ['registry:read'],
      kind: 'user',
    },
    {
      id: LOCAL_OPERATOR_PRINCIPAL,
      token: operatorToken,
      organizationId: 'default',
      subject: LOCAL_OPERATOR_PRINCIPAL,
      roles: ['publisher'],
      scopes: [
        'registry:read',
        'skills:read',
        'skills:rescan',
        'skills:write',
        'skills:publish',
        'scans:read',
        'operations:read',
      ],
      kind: 'user',
    },
  ]);
  const child = spawn(process.execPath, [runtimeBinary], {
    cwd: REPO_ROOT,
    env: localProcessEnvironment({
      NODE_ENV: 'test',
      PSKILLS_ENVIRONMENT: 'test',
      PSKILLS_RUNTIME_PROFILE: 'node',
      PSKILLS_PUBLIC_ORIGIN: origin,
      PSKILLS_API_URL: origin,
      PSKILLS_ORGANIZATION_ID: 'default',
      PSKILLS_STATE_PROVIDER: 'postgres',
      DATABASE_URL: `postgres://postgres:${encodeURIComponent(clone.password)}@127.0.0.1:${clone.port}/${clone.database}`,
      PSKILLS_STORAGE_PROVIDER: 'filesystem',
      PSKILLS_STORAGE_ROOT: storageRoot,
      PSKILLS_STORAGE_PREFIX: '',
      PSKILLS_STORAGE_PROVIDER_BINDING: 'files-sdk:filesystem:local-serving-restore-v1',
      PSKILLS_STORAGE_BUILD_PROFILE: 'filesystem',
      PSKILLS_BETTER_AUTH_ENABLED: 'false',
      BETTER_AUTH_ENABLED: 'false',
      PSKILLS_BILLING_ENABLED: 'false',
      PSKILLS_BILLING_METERED_EVALUATION: 'false',
      PSKILLS_AI_ENABLED: 'false',
      PSKILLS_DIRECTORY_ENABLED: 'false',
      PSKILLS_PACK_DIRECTORY_ENABLED: 'false',
      PSKILLS_HOSTED_WORKER: 'false',
      PSKILLS_BOOTSTRAP_TOKENS: bootstrapTokens,
      PSKILLS_BOOTSTRAP_TOKEN: undefined,
      PSKILLS_BOOTSTRAP_TOKEN_HASH: undefined,
      PSKILLS_WORKER_TOKENS: undefined,
      PSKILLS_WORKER_TOKEN: workerToken,
      PSKILLS_WORKER_TOKEN_ID: LOCAL_WORKER_ID,
      PSKILLS_WORKER_SUBJECT: LOCAL_WORKER_ID,
      BLOB_READ_WRITE_TOKEN: undefined,
      VERCEL_OIDC_TOKEN: undefined,
      PSKILLS_REQUIRED_SCANNER: undefined,
      PSKILLS_ALLOW_UNSCANNED: 'false',
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_PORT: String(port),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  const capture = (chunk: Buffer | string) => {
    logs.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    const total = logs.join('');
    if (total.length > 8_000) logs.splice(0, logs.length, total.slice(-8_000));
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const runtime = { child, origin, storageRoot, logs };
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Nitro runtime exited before health (${child.exitCode})`);
      try {
        const health = await fetch(`${origin}/health`);
        if (health.ok) return { runtime };
      } catch {
        // Wait for the real Nitro bundle and Postgres adapter to initialize.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error('Nitro runtime did not become healthy');
  } catch (error) {
    await stopRuntime(runtime);
    throw error;
  }
}

main().catch((error: unknown) => {
  const kind = error instanceof Error ? error.name : 'Error';
  const stage = error instanceof Error ? error.message.replace(/^rehearsal stage /u, '').replace(/ failed$/u, '') : 'unknown';
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  process.stderr.write(`local serving-path restore rehearsal failed (${kind}; ${stage}${cause ? `; ${cause}` : ''})\n`);
  process.exitCode = 1;
});
