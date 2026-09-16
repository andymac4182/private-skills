#!/usr/bin/env node

/*
 * Bounded operator proof for one hosted PostgreSQL recovery point.
 *
 * This is deliberately an operation script rather than a runtime backup
 * framework.  It resolves exactly one production DATABASE_URL by Vercel
 * environment-variable ID, holds a repeatable-read source snapshot open while
 * pg_dump runs, encrypts the custom-format dump locally, and restores it into
 * a newly-created PostgreSQL 18 container.  It never applies DDL/DML to the
 * source and it does not enumerate or modify hosted Blob objects.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const DEFAULT_PROJECT_ID = 'prj_vw4QlLtnsPaZm8mtms1HuDqpSNti';
const DEFAULT_LINK_DIR = '/private/tmp/pskills-vercel-link.tCYedK';
const DEFAULT_EVIDENCE = 'docs/evidence/full-postgres-backup-recovery-20260916.json';
const PG_IMAGE = 'postgres:18';
const PG_RESTORE_IMAGE = 'pgvector/pgvector:pg18';
const REGISTRY_TABLE = 'private_skills_registry_state';
const SERVICE_TOKEN_TABLE = 'private_skills_service_tokens';

// These are the twelve identity/SSO/token tables that the current hosted
// composition owns.  The registry table is checked separately because it is
// application state and must never be rewritten by identity recovery.
const EXPECTED_IDENTITY_TABLES = [
  'user',
  'account',
  'session',
  'verification',
  'organization',
  'member',
  'invitation',
  'rateLimit',
  'ssoProvider',
  'private_skills_company_sso_providers',
  'private_skills_identity_operations_events',
  SERVICE_TOKEN_TABLE,
];

const TEXT_HASH_ALGORITHM = 'sha256';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;

let stage = 'initialization';

function usage() {
  process.stdout.write(`Usage: node scripts/full-postgres-backup-recovery-proof.mjs [options]\n\n` +
    `Options:\n` +
    `  --project-id ID       linked Vercel project (default: private-skills project)\n` +
    `  --link-dir PATH       directory containing .vercel/project.json\n` +
    `  --evidence PATH       sanitized evidence output path\n` +
    `  --help                show this message\n\n` +
    `The production DATABASE_URL is fetched by Vercel environment-variable ID\n` +
    `inside this process. It is never accepted as a command-line argument.\n`);
}

function parseArgs(argv) {
  const options = {
    projectId: DEFAULT_PROJECT_ID,
    linkDir: DEFAULT_LINK_DIR,
    evidencePath: resolve(DEFAULT_EVIDENCE),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      usage();
      process.exit(0);
    }
    if (argument === '--project-id' || argument === '--link-dir' || argument === '--evidence') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
      index += 1;
      if (argument === '--project-id') options.projectId = value;
      else if (argument === '--link-dir') options.linkDir = resolve(value);
      else options.evidencePath = resolve(value);
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  if (!/^prj_[A-Za-z0-9]+$/u.test(options.projectId)) throw new Error('project id is invalid');
  return options;
}

function quoteIdentifier(identifier) {
  if (typeof identifier !== 'string' || identifier.length === 0 || identifier.includes('\0')) {
    throw new Error('database identifier is invalid');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedName(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function sha256Bytes(value) {
  return `${TEXT_HASH_ALGORITHM}:${createHash(TEXT_HASH_ALGORITHM).update(value).digest('hex')}`;
}

async function hashFile(filePath) {
  const hash = createHash(TEXT_HASH_ALGORITHM);
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, digest: `${TEXT_HASH_ALGORITHM}:${hash.digest('hex')}` };
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function writeSecure(filePath, data, mode = 0o600) {
  await writeFile(filePath, data, { flag: 'wx', mode });
  await chmod(filePath, mode);
}

function runVercelJson(endpoint, cwd) {
  const result = spawnSync('vercel', ['api', endpoint, '--raw'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length === 0) {
    throw new Error('Vercel API request failed');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Vercel API response was not JSON');
  }
}

function projectEnvList(response) {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object') {
    if (Array.isArray(response.envs)) return response.envs;
    if (Array.isArray(response.data)) return response.data;
  }
  throw new Error('Vercel environment inventory was invalid');
}

function resolveProductionDatabaseUrl(projectId, linkDir) {
  const inventory = projectEnvList(runVercelJson(`/v10/projects/${projectId}/env`, linkDir));
  const candidates = inventory.filter((entry) => (
    entry && entry.key === 'DATABASE_URL' && Array.isArray(entry.target) && entry.target.includes('production') &&
    typeof entry.id === 'string' && entry.id.length > 0
  ));
  if (candidates.length !== 1) throw new Error('expected exactly one production DATABASE_URL environment variable');
  const environmentId = candidates[0].id;
  const detail = runVercelJson(`/v1/projects/${projectId}/env/${environmentId}`, linkDir);
  const value = detail && typeof detail === 'object' && typeof detail.value === 'string'
    ? detail.value
    : detail?.env && typeof detail.env.value === 'string'
      ? detail.env.value
      : undefined;
  if (!value) throw new Error('production DATABASE_URL value was unavailable');
  return { environmentId, value };
}

function connectionEnvironment(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('production DATABASE_URL was not a URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('production DATABASE_URL did not use PostgreSQL');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!parsed.hostname || !database || !user || !password) throw new Error('production DATABASE_URL was incomplete');
  const environment = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: database,
    // Neon/Vercel PostgreSQL URLs carry sslmode=require. Keep the value from
    // the URL, while requiring TLS when the provider omitted the query flag.
    PGSSLMODE: parsed.searchParams.get('sslmode') || 'require',
    PGAPPNAME: 'private-skills-full-backup-proof',
  };
  for (const [key, value] of Object.entries(environment)) {
    if (value.includes('\0')) throw new Error(`${key} contained an invalid character`);
  }
  return environment;
}

function childEnvironment(values) {
  // Values are inherited through the child environment by name. They are not
  // placed in Docker argv, which keeps credentials out of process listings.
  return { ...process.env, ...values };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const output = [];
    let outputBytes = 0;
    child.stdout?.on('data', (chunk) => {
      if (outputBytes < 1024 * 1024) {
        const remaining = 1024 * 1024 - outputBytes;
        output.push(chunk.subarray(0, remaining));
        outputBytes += Math.min(remaining, chunk.byteLength);
      }
    });
    child.on('error', (error) => rejectPromise(error));
    child.on('close', (code, signal) => resolvePromise({
      code: code ?? -1,
      signal: signal ?? null,
      stdout: Buffer.concat(output),
    }));
  });
}

function waitForProcess(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => resolvePromise({ code: code ?? -1, signal: signal ?? null }));
  });
}

async function writeChunk(stream, chunk) {
  if (chunk.byteLength === 0) return;
  if (!stream.write(chunk)) await once(stream, 'drain');
}

async function finishStream(stream) {
  stream.end();
  await finished(stream);
}

async function createEncryptedDump({ connection, snapshot, outputPath, key }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const plainHash = createHash(TEXT_HASH_ALGORITHM);
  const encryptedHash = createHash(TEXT_HASH_ALGORITHM);
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  const header = Buffer.from(`${JSON.stringify({ version: 1, algorithm: ENCRYPTION_ALGORITHM, iv: iv.toString('base64') })}\n`, 'utf8');
  encryptedHash.update(header);
  let plainBytes = 0;
  let outputFinished = false;
  const dumpArgs = [
    'run', '--rm', '--pull=never',
    '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE', '-e', 'PGAPPNAME',
    PG_IMAGE, 'pg_dump',
    '--format=custom', '--no-owner', '--no-privileges', '--snapshot', snapshot,
  ];
  const child = spawn('docker', dumpArgs, {
    env: childEnvironment(connection),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const childStatus = waitForProcess(child);
  child.stderr?.on('data', () => undefined);
  try {
    await writeChunk(output, header);
    if (!child.stdout) throw new Error('pg_dump did not provide stdout');
    for await (const chunk of child.stdout) {
      plainBytes += chunk.byteLength;
      plainHash.update(chunk);
      const encrypted = cipher.update(chunk);
      encryptedHash.update(encrypted);
      await writeChunk(output, encrypted);
    }
    const final = cipher.final();
    encryptedHash.update(final);
    await writeChunk(output, final);
    const tag = cipher.getAuthTag();
    encryptedHash.update(tag);
    await writeChunk(output, tag);
    await finishStream(output);
    outputFinished = true;
    const status = await childStatus;
    if (status.code !== 0) throw new Error('pg_dump failed');
    const fileStats = await stat(outputPath);
    return {
      format: 'pg_dump-custom',
      pgDumpImage: PG_IMAGE,
      encryption: {
        algorithm: ENCRYPTION_ALGORITHM,
        keyBytes: KEY_BYTES,
        keyMode: '0600',
        keyPathOutsideCheckout: true,
        ivStoredInHeader: true,
        authTagBytes: GCM_TAG_BYTES,
      },
      plainBytes,
      plainDigest: `${TEXT_HASH_ALGORITHM}:${plainHash.digest('hex')}`,
      encryptedBytes: fileStats.size,
      encryptedDigest: `${TEXT_HASH_ALGORITHM}:${encryptedHash.digest('hex')}`,
    };
  } catch (error) {
    if (!outputFinished) output.destroy();
    if (child.exitCode === null) child.kill('SIGTERM');
    try { await childStatus; } catch { /* preserve the bounded error */ }
    throw error instanceof Error && error.message === 'pg_dump failed'
      ? error
      : new Error('encrypted pg_dump capture failed');
  }
}

async function readEncryptedHeader(backupPath) {
  const handle = await open(backupPath, 'r');
  try {
    const prefix = Buffer.alloc(8192);
    const read = await handle.read(prefix, 0, prefix.byteLength, 0);
    const newline = prefix.subarray(0, read.bytesRead).indexOf(10);
    if (newline < 1) throw new Error('encrypted backup header was missing');
    const header = JSON.parse(prefix.subarray(0, newline).toString('utf8'));
    if (!header || header.version !== 1 || header.algorithm !== ENCRYPTION_ALGORITHM || typeof header.iv !== 'string') {
      throw new Error('encrypted backup header was invalid');
    }
    const iv = Buffer.from(header.iv, 'base64');
    if (iv.byteLength !== 12) throw new Error('encrypted backup IV was invalid');
    const fileStats = await handle.stat();
    if (fileStats.size <= newline + 1 + GCM_TAG_BYTES) throw new Error('encrypted backup was empty');
    const tag = Buffer.alloc(GCM_TAG_BYTES);
    await handle.read(tag, 0, GCM_TAG_BYTES, fileStats.size - GCM_TAG_BYTES);
    return { newline, size: fileStats.size, iv, tag };
  } finally {
    await handle.close();
  }
}

async function decryptBackup({ backupPath, keyPath, expectedDigest, expectedPlainDigest, outputPath }) {
  const actualEncrypted = await hashFile(backupPath);
  if (actualEncrypted.digest !== expectedDigest) throw new Error('encrypted backup digest mismatch');
  const key = await readFile(keyPath);
  if (key.byteLength !== KEY_BYTES) throw new Error('backup key length was invalid');
  const header = await readEncryptedHeader(backupPath);
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, header.iv);
  decipher.setAuthTag(header.tag);
  const plainHash = createHash(TEXT_HASH_ALGORITHM);
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  try {
    const ciphertextStart = header.newline + 1;
    const ciphertextEnd = header.size - GCM_TAG_BYTES - 1;
    for await (const chunk of createReadStream(backupPath, { start: ciphertextStart, end: ciphertextEnd })) {
      const plain = decipher.update(chunk);
      plainHash.update(plain);
      await writeChunk(output, plain);
    }
    const final = decipher.final();
    plainHash.update(final);
    await writeChunk(output, final);
    await finishStream(output);
    const digest = `${TEXT_HASH_ALGORITHM}:${plainHash.digest('hex')}`;
    if (digest !== expectedPlainDigest) throw new Error('decrypted backup digest mismatch');
    return { digest, bytes: (await stat(outputPath)).size };
  } catch (error) {
    output.destroy();
    try { await rm(outputPath, { force: true }); } catch { /* preserve the bounded error */ }
    throw error instanceof Error && /digest mismatch|key length|backup was empty/u.test(error.message)
      ? error
      : new Error('encrypted backup decryption failed');
  }
}

async function sleep(milliseconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function startRestoreContainer() {
  const suffix = `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
  const name = `pskills-full-pg-restore-${suffix}`;
  const password = randomBytes(24).toString('base64url');
  const run = await runProcess('docker', [
    'run', '-d', '--pull=never', '--name', name,
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB',
    '-p', '127.0.0.1::5432', PG_RESTORE_IMAGE,
  ], { env: childEnvironment({ POSTGRES_PASSWORD: password, POSTGRES_DB: 'private_skills_restore' }) });
  if (run.code !== 0) throw new Error('could not create isolated PostgreSQL restore container');
  let port;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const ready = await runProcess('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'private_skills_restore']);
    if (ready.code === 0) break;
    await sleep(1000);
  }
  const portResult = await runProcess('docker', ['port', name, '5432/tcp']);
  if (portResult.code === 0) {
    const match = portResult.stdout.toString('utf8').match(/127\.0\.0\.1:(\d+)/u);
    if (match) port = Number(match[1]);
  }
  if (!Number.isInteger(port) || port <= 0) throw new Error('isolated PostgreSQL restore container was not loopback-bound');
  return { name, password, port };
}

async function restoreDump(containerName, dumpPath) {
  const child = spawn('docker', [
    'exec', '-i', containerName, 'pg_restore',
    '--username=postgres', '--dbname=private_skills_restore',
    '--exit-on-error', '--no-owner', '--no-privileges',
  ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const childStatus = waitForProcess(child);
  if (!child.stdin) throw new Error('pg_restore did not provide stdin');
  await pipeline(createReadStream(dumpPath), child.stdin);
  const status = await childStatus;
  if (status.code !== 0) throw new Error('pg_restore failed');
}

async function queryRows(connection, statement) {
  const result = await connection.unsafe(statement);
  return [...result];
}

async function collectTableCatalog(connection) {
  const rows = await queryRows(connection, `
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `);
  const tables = [];
  for (const row of rows) {
    const schema = String(row.table_schema);
    const table = String(row.table_name);
    const tableType = String(row.table_type);
    const item = { schema, table, tableType, rowCount: null, rowDigest: null };
    if (tableType === 'BASE TABLE') {
      const stats = await queryRows(connection, `
        SELECT count(*)::text AS row_count,
               md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), '')) AS row_digest
        FROM ${qualifiedName(schema, table)} AS t
      `);
      item.rowCount = String(stats[0]?.row_count ?? '0');
      item.rowDigest = String(stats[0]?.row_digest ?? '');
    }
    tables.push(item);
  }
  return {
    tableCount: tables.length,
    tables,
    catalogDigest: sha256Bytes(JSON.stringify(tables)),
  };
}

function decodeRegistryState(value) {
  let current = value;
  for (let attempt = 0; attempt < 2 && typeof current === 'string'; attempt += 1) {
    try { current = JSON.parse(current); } catch { throw new Error('registry JSONB value was not valid JSON'); }
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('registry JSONB value was not an object');
  return current;
}

async function collectRegistry(connection, catalog) {
  const matches = catalog.tables.filter((item) => item.table === REGISTRY_TABLE && item.tableType === 'BASE TABLE');
  if (matches.length !== 1) throw new Error('registry state table was not unique');
  const location = matches[0];
  const rows = await queryRows(connection, `
    SELECT organization_id, revision::text AS revision, state,
           pg_typeof(state)::text AS state_sql_type,
           jsonb_typeof(state) AS state_json_type,
           octet_length(state::text)::text AS state_bytes,
           md5(state::text) AS state_digest
    FROM ${qualifiedName(location.schema, location.table)}
    ORDER BY organization_id
  `);
  let embeddedRevisionMatches = true;
  const revisions = [];
  const stateBytes = [];
  const sqlTypes = new Set();
  const jsonTypes = new Set();
  const driverTypes = new Set();
  const contentParts = [];
  for (const row of rows) {
    const revision = String(row.revision);
    const numericRevision = Number(revision);
    const decoded = decodeRegistryState(row.state);
    const embedded = decoded.metadataRevision;
    if (embedded !== undefined && Number(embedded) !== numericRevision) embeddedRevisionMatches = false;
    revisions.push(revision);
    stateBytes.push(Number(row.state_bytes));
    sqlTypes.add(String(row.state_sql_type));
    jsonTypes.add(String(row.state_json_type));
    driverTypes.add(Array.isArray(row.state) ? 'array' : typeof row.state);
    contentParts.push(`${revision}:${row.state_bytes}:${row.state_digest}`);
  }
  if (!embeddedRevisionMatches) throw new Error('registry row and embedded state revisions differed');
  const sortedRevisions = [...revisions].sort((left, right) => Number(left) - Number(right));
  return {
    table: { schema: location.schema, table: location.table },
    rowCount: String(rows.length),
    minRevision: sortedRevisions[0] ?? null,
    maxRevision: sortedRevisions.at(-1) ?? null,
    stateSqlTypes: [...sqlTypes].sort(),
    stateJsonbTypes: [...jsonTypes].sort(),
    driverStateTypes: [...driverTypes].sort(),
    minStateBytes: stateBytes.length ? Math.min(...stateBytes) : null,
    maxStateBytes: stateBytes.length ? Math.max(...stateBytes) : null,
    stateSetDigest: sha256Bytes([...contentParts].sort().join('\n')),
    stateContentDigest: sha256Bytes([...contentParts.map((part) => part.split(':').at(-1))].sort().join('\n')),
    embeddedRevisionMatches,
  };
}

function identityCoverage(catalog) {
  const observed = [];
  for (const table of EXPECTED_IDENTITY_TABLES) {
    const matches = catalog.tables.filter((item) => item.table === table && item.tableType === 'BASE TABLE');
    if (matches.length !== 1) throw new Error(`expected identity table ${table} was not unique`);
    if (table === SERVICE_TOKEN_TABLE && matches[0].schema !== 'public') {
      throw new Error('service-token compatibility table was not in public schema');
    }
    observed.push(matches[0]);
  }
  return observed;
}

async function collectDatabase(connection) {
  const catalog = await collectTableCatalog(connection);
  const identityTables = identityCoverage(catalog);
  const registry = await collectRegistry(connection, catalog);
  return { catalog, identityTables, registry };
}

function comparableDatabase(value) {
  return JSON.stringify({
    catalog: value.catalog,
    identityTables: value.identityTables,
    registry: value.registry,
  });
}

async function withSourceSnapshot(databaseUrl, connectionEnvironmentValues, callback) {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined, connect_timeout: 30 });
  const connection = await sql.reserve();
  let transaction = false;
  try {
    await connection.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    const snapshotRows = await connection.unsafe('SELECT pg_export_snapshot()::text AS snapshot');
    const snapshot = String(snapshotRows[0]?.snapshot ?? '');
    if (!/^[0-9A-F-]+$/u.test(snapshot)) throw new Error('PostgreSQL exported snapshot was invalid');
    const sourceDatabase = await collectDatabase(connection);
    const result = await callback({ snapshot, sourceDatabase, connectionEnvironmentValues });
    await connection.unsafe('COMMIT');
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) {
      try { await connection.unsafe('ROLLBACK'); } catch { /* preserve the bounded source error */ }
    }
    throw error;
  } finally {
    try { connection.release(); } catch { /* release is best effort after the transaction */ }
    await sql.end({ timeout: 5 });
  }
}

async function writeJson(filePath, value, mode = 0o600) {
  await ensureDirectory(dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(filePath, mode);
}

function failureRecord(options, source, target) {
  return {
    schemaVersion: 1,
    status: 'blocked',
    capturedAt: new Date().toISOString(),
    source: {
      kind: 'Vercel production DATABASE_URL environment-variable lookup by ID',
      projectId: options.projectId,
      environmentId: source?.environmentId ?? null,
      credentialHandling: 'value held in process memory only; never printed or written to evidence',
    },
    stage,
    target: target ? { containerName: target.name, host: '127.0.0.1', port: target.port, retained: true } : null,
    reason: 'bounded read-only full PostgreSQL backup/restore proof did not complete',
    limitations: [
      'No hosted DDL, DML, environment update, deployment, or Blob mutation was attempted.',
      'A blocked proof is not a recovery point and must not be used as a migration gate.',
    ],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidencePath = isAbsolute(options.evidencePath) ? options.evidencePath : resolve(options.evidencePath);
  let sourceDescriptor;
  let target;
  let artifact;
  let artifactRoot;
  const capturedAt = new Date().toISOString();
  try {
    stage = 'vercel-production-database-lookup';
    sourceDescriptor = resolveProductionDatabaseUrl(options.projectId, options.linkDir);
    const databaseUrl = sourceDescriptor.value;
    const connection = connectionEnvironment(databaseUrl);
    artifactRoot = await mkdtemp(join('/private/tmp', 'pskills-full-postgres-recovery-'));
    await chmod(artifactRoot, 0o700);
    const keyPath = join(artifactRoot, 'backup.key');
    const backupPath = join(artifactRoot, 'database.dump.pgdump.aes256gcm');
    const manifestPath = join(artifactRoot, 'backup-manifest.json');
    const key = randomBytes(KEY_BYTES);
    await writeSecure(keyPath, key, 0o600);

    const capture = await withSourceSnapshot(databaseUrl, connection, async ({ snapshot, sourceDatabase }) => {
      stage = 'postgresql-consistent-pg-dump';
      artifact = await createEncryptedDump({ connection, snapshot, outputPath: backupPath, key });
      return { sourceDatabase, snapshotExported: true };
    });

    stage = 'isolated-postgresql-restore-container';
    target = await startRestoreContainer();
    const restoreUrl = `postgresql://postgres:${encodeURIComponent(target.password)}@127.0.0.1:${target.port}/private_skills_restore`;
    const decryptedPath = join(artifactRoot, 'restore.dump');
    stage = 'encrypted-backup-readback';
    await decryptBackup({
      backupPath,
      keyPath,
      expectedDigest: artifact.encryptedDigest,
      expectedPlainDigest: artifact.plainDigest,
      outputPath: decryptedPath,
    });
    stage = 'postgresql-isolated-restore';
    await restoreDump(target.name, decryptedPath);
    await rm(decryptedPath, { force: true });
    stage = 'restored-catalog-readback';
    const restoredSql = postgres(restoreUrl, { max: 1, prepare: false, onnotice: () => undefined, connect_timeout: 15 });
    const restoredConnection = await restoredSql.reserve();
    let restoredDatabase;
    try {
      restoredDatabase = await collectDatabase(restoredConnection);
    } finally {
      try { restoredConnection.release(); } catch { /* release is best effort */ }
      await restoredSql.end({ timeout: 5 });
    }
    if (comparableDatabase(capture.sourceDatabase) !== comparableDatabase(restoredDatabase)) {
      throw new Error('restored PostgreSQL catalog, counts, digest, or registry representation differed');
    }
    const manifest = {
      schemaVersion: 1,
      status: 'passed',
      capturedAt,
      source: {
        kind: 'Vercel production DATABASE_URL environment-variable lookup by ID',
        projectId: options.projectId,
        environment: 'production',
        environmentId: sourceDescriptor.environmentId,
        credentialHandling: 'value held in process memory only; never printed or written to evidence',
        databaseUrlLogged: false,
      },
      consistency: {
        transaction: 'REPEATABLE READ READ ONLY',
        exportedSnapshotPassedToPgDump: true,
        metadataAndDumpShareSnapshot: true,
      },
      backup: {
        ...artifact,
        backupPath,
        keyPath,
        manifestPath,
        backupFileMode: '0600',
        keyFileMode: '0600',
        keyValueRecorded: false,
        tableRowDigestAlgorithm: 'md5',
      },
      sourceReadback: {
        tableCount: capture.sourceDatabase.catalog.tableCount,
        catalogDigest: capture.sourceDatabase.catalog.catalogDigest,
        tables: capture.sourceDatabase.catalog.tables,
        identityTableCount: capture.sourceDatabase.identityTables.length,
        identityTables: capture.sourceDatabase.identityTables.map(({ schema, table, tableType }) => ({ schema, table, tableType })),
        registry: capture.sourceDatabase.registry,
      },
      restoredReadback: {
        tableCount: restoredDatabase.catalog.tableCount,
        catalogDigest: restoredDatabase.catalog.catalogDigest,
        tables: restoredDatabase.catalog.tables,
        identityTableCount: restoredDatabase.identityTables.length,
        registry: restoredDatabase.registry,
        matchesSourceReadback: true,
      },
      target: {
        image: PG_RESTORE_IMAGE,
        containerName: target.name,
        host: '127.0.0.1',
        port: target.port,
        database: 'private_skills_restore',
        retainedForInspection: true,
        sourceContainersChanged: false,
      },
      coverage: {
        databaseLocalObjects: 'pg_dump custom format over the complete database; all non-system schemas selected by pg_dump',
        verifiedBaseTableCatalogAndRows: true,
        verifiedIdentityTables: EXPECTED_IDENTITY_TABLES.length,
        verifiedRegistryJsonbTypeShapeAndRevision: true,
        blobObjects: 'not included; no Blob listing, write, or delete attempted',
        externalProviderState: 'not included',
      },
      limitations: [
        'pg_dump captures database-local schema and data but not cluster-global roles, tablespaces, or provider-side configuration.',
        'The restored target is a disposable PostgreSQL 18 container with ownership/privilege restoration disabled; it proves data/catalog recovery, not production role parity.',
        'The encrypted recovery point does not include Files SDK Blob objects, billing-provider state, identity-provider credentials, or deployment environment values.',
        'The target container is retained as a new isolated container for inspection; no existing container or source data was removed or changed.',
      ],
    };
    stage = 'manifest-write';
    await writeJson(manifestPath, manifest, 0o600);
    await writeJson(evidencePath, manifest, 0o644);
    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      evidencePath,
      manifestPath,
      backupPath,
      keyPath,
      targetContainer: target.name,
      targetLoopback: `127.0.0.1:${target.port}`,
      sourceTableCount: capture.sourceDatabase.catalog.tableCount,
      identityTableCount: capture.sourceDatabase.identityTables.length,
      registryRevision: capture.sourceDatabase.registry.minRevision,
      plainBytes: artifact.plainBytes,
      plainDigest: artifact.plainDigest,
    }, null, 2)}\n`);
  } catch (error) {
    const record = failureRecord(options, sourceDescriptor, target);
    try { await writeJson(evidencePath, record, 0o644); } catch { /* preserve the process result */ }
    process.stderr.write(`${JSON.stringify({ status: 'blocked', stage, evidencePath, reason: record.reason, targetContainer: target?.name ?? null })}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
