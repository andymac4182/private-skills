import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_LAUNCHER = join(REPO_ROOT, 'scripts', 'local-m6-fixture.mjs');
const VITE_ENTRY = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const STOP_PROTOCOL_VERSION = 1;

test('local fixture builds with the installed Vite entrypoint, without a package-manager process', () => {
  const source = readFileSync(FIXTURE_LAUNCHER, 'utf8');

  assert.match(source, /const viteEntry = resolveInstalledViteEntry\(\);/u);
  assert.match(source, /spawn\(process\.execPath, \[viteEntry, 'build'\]/u);
  assert.match(source, /cwd: path\.join\(buildRoot, 'apps', 'web'\)/u);
  assert.doesNotMatch(source, /\b(?:pnpm|npm|yarn)\b|--filter/iu);
});

test('direct Vite preflight does not rewrite shared package metadata', () => {
  assert.equal(existsSync(VITE_ENTRY), true, `installed Vite entrypoint is missing: ${VITE_ENTRY}`);
  const metadataPaths = [
    join(REPO_ROOT, 'node_modules', '.modules.yaml'),
    join(REPO_ROOT, 'node_modules', '.pnpm-workspace-state-v1.json'),
  ];
  const before = metadataPaths.map((filePath) => {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  });

  const run = spawnSync(process.execPath, [VITE_ENTRY, '--version'], {
    cwd: join(REPO_ROOT, 'apps', 'web'),
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /vite/iu);

  const after = metadataPaths.map((filePath) => {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  assert.deepEqual(after, before, 'direct Vite invocation must not rewrite shared pnpm metadata');
});

test('stop writes a request and never signals a stale persisted PID', async () => {
  const runRoot = mkdtempSync('/private/tmp/private-skills-m6-local-stop-');
  const workRoot = join(runRoot, 'work');
  mkdirSync(workRoot, { mode: 0o700 });
  const processPath = join(workRoot, 'processes.json');
  const credentialsPath = join(workRoot, 'credentials.json');
  const stopRequestPath = join(workRoot, 'stop-request.json');
  const metadataPath = join(workRoot, 'launch-metadata.json');
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    await once(sentinel, 'spawn');
    writeFixtureMetadata({ runRoot, metadataPath, credentialsPath, processPath, stopRequestPath, stopProtocolVersion: STOP_PROTOCOL_VERSION });
    writeFileSync(processPath, JSON.stringify({ buildPid: sentinel.pid }), { mode: 0o600 });
    const run = spawnSync(process.execPath, [FIXTURE_LAUNCHER, 'stop', runRoot], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(stopRequestPath), true);
    const request = JSON.parse(readFileSync(stopRequestPath, 'utf8'));
    assert.equal(request.protocolVersion, STOP_PROTOCOL_VERSION);
    assert.equal(request.kind, 'shutdown');
    assert.equal(typeof request.requestedAt, 'string');
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'stale process metadata must not signal the sentinel');
  } finally {
    if (sentinel.exitCode === null) sentinel.kill('SIGTERM');
    if (sentinel.exitCode === null) await once(sentinel, 'exit');
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('stop refuses old metadata without signaling a stale persisted PID', async () => {
  const runRoot = mkdtempSync('/private/tmp/private-skills-m6-local-stop-old-');
  const workRoot = join(runRoot, 'work');
  mkdirSync(workRoot, { mode: 0o700 });
  const processPath = join(workRoot, 'processes.json');
  const credentialsPath = join(workRoot, 'credentials.json');
  const stopRequestPath = join(workRoot, 'stop-request.json');
  const metadataPath = join(workRoot, 'launch-metadata.json');
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    await once(sentinel, 'spawn');
    writeFixtureMetadata({ runRoot, metadataPath, credentialsPath, processPath, stopRequestPath, stopProtocolVersion: 0 });
    writeFileSync(processPath, JSON.stringify({ buildPid: sentinel.pid }), { mode: 0o600 });
    const run = spawnSync(process.execPath, [FIXTURE_LAUNCHER, 'stop', runRoot], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /unsupported stop protocol/u);
    assert.equal(existsSync(stopRequestPath), false);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'old metadata must not signal the sentinel');
  } finally {
    if (sentinel.exitCode === null) sentinel.kill('SIGTERM');
    if (sentinel.exitCode === null) await once(sentinel, 'exit');
    rmSync(runRoot, { recursive: true, force: true });
  }
});

function writeFixtureMetadata({ runRoot, metadataPath, credentialsPath, processPath, stopRequestPath, stopProtocolVersion }) {
  writeFileSync(credentialsPath, '{}\n', { mode: 0o600 });
  writeFileSync(metadataPath, JSON.stringify({
    stopProtocolVersion,
    stopRequestPath,
    origins: { origin: 'http://127.0.0.1:5197' },
    paths: { credentials: credentialsPath, processes: processPath, stopRequest: stopRequestPath },
  }), { mode: 0o600 });
}

test('status binds proposals to the current draft revision and digest', async () => {
  const runRoot = mkdtempSync('/private/tmp/private-skills-m6-local-status-');
  const workRoot = join(runRoot, 'work');
  mkdirSync(workRoot, { mode: 0o700 });
  const draftId = 'draft-local-status';
  const oldDigest = `sha256:${'a'.repeat(64)}`;
  const currentDigest = `sha256:${'b'.repeat(64)}`;
  const ownerToken = 'local-status-owner-token-123456789';
  const reviewerToken = 'local-status-reviewer-token-123456789';
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === `/v1/drafts/${draftId}`) {
      response.writeHead(200);
      response.end(JSON.stringify({ draft: { id: draftId, name: '@local/status', revision: 2, digest: currentDigest, files: [] } }));
      return;
    }
    if (request.method === 'GET' && request.url === `/v1/drafts/${draftId}/reviews`) {
      response.writeHead(200);
      response.end(JSON.stringify({ reviews: [], results: [] }));
      return;
    }
    if (request.method === 'GET' && request.url === `/v1/drafts/${draftId}/proposals?revision=2&digest=${encodeURIComponent(currentDigest)}`) {
      response.writeHead(200);
      response.end(JSON.stringify({ proposals: [] }));
      return;
    }
    if (request.method === 'GET' && request.url === '/control/status') {
      response.writeHead(200);
      response.end(JSON.stringify({ sessions: [] }));
      return;
    }
    response.writeHead(409);
    response.end(JSON.stringify({ error: 'stale proposal binding' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('status stub did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  const credentialsPath = join(workRoot, 'credentials.json');
  const controlPath = join(workRoot, 'control.json');
  const fixturePath = join(workRoot, 'fixture.json');
  const metadataPath = join(workRoot, 'launch-metadata.json');
  writeFileSync(credentialsPath, JSON.stringify({ origin, token: ownerToken }), { mode: 0o600 });
  writeFileSync(controlPath, JSON.stringify({ reviewerOrigin: origin, reviewerControlToken: reviewerToken }), { mode: 0o600 });
  writeFileSync(fixturePath, JSON.stringify({ draft: { id: draftId, revision: 1, digest: oldDigest } }), { mode: 0o600 });
  writeFileSync(metadataPath, JSON.stringify({
    origins: { origin, builderOrigin: origin, reviewerOrigin: origin },
    paths: { credentials: credentialsPath, control: controlPath, fixture: fixturePath },
    reviewer: { mode: 'hold' },
  }), { mode: 0o600 });
  try {
    const run = await spawnCli([FIXTURE_LAUNCHER, 'status', runRoot]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(requests.includes(`/v1/drafts/${draftId}/proposals?revision=2&digest=${encodeURIComponent(currentDigest)}`), true);
    assert.equal(requests.some((url) => url?.includes(`revision=1&digest=${encodeURIComponent(oldDigest)}`)), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('seed defaults to the unchanged two-file draft and fail-closes an invalid profile', async () => {
  const runRoot = mkdtempSync('/private/tmp/private-skills-m6-local-seed-default-');
  const stub = await startSeedStub();
  try {
    writeSeedMetadata(runRoot, stub.origin);
    const run = await spawnCli([FIXTURE_LAUNCHER, 'seed', runRoot]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(stub.draftBody.files.map((file) => file.path), ['SKILL.md', 'README.md']);
    assert.equal(stub.draftBody.name, '@local/m6-local-combined-fixture');
    const fixture = JSON.parse(readFileSync(join(runRoot, 'work', 'local-m6-fixture.json'), 'utf8'));
    assert.equal(fixture.draft.fileCount, 2);
    assert.equal(fixture.draft.expectedTextBytes, fixture.draft.skillTextBytes + Buffer.byteLength('# Local combined M6 fixture\n'));
    assert.equal(fixture.manifest, undefined);
    assert.equal(stub.policyBody.allowUnscanned, false);
    assert.deepEqual(stub.policyBody.scanners.filter((scanner) => scanner.mode === 'required').map((scanner) => scanner.id), ['skillsguard']);
  } finally {
    await stub.close();
    rmSync(runRoot, { recursive: true, force: true });
  }

  const invalidRoot = mkdtempSync('/private/tmp/private-skills-m6-local-seed-invalid-');
  try {
    const run = await spawnCli([FIXTURE_LAUNCHER, 'seed', invalidRoot, '--profile', 'unknown']);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /--profile must be two-files or large-tree/u);
  } finally {
    rmSync(invalidRoot, { recursive: true, force: true });
  }
});

test('large-tree seed is opt-in, canonical, bounded, and records sanitized browser proof metadata', async () => {
  const runRoot = mkdtempSync('/private/tmp/private-skills-m6-local-seed-large-');
  const stub = await startSeedStub();
  try {
    writeSeedMetadata(runRoot, stub.origin);
    const run = await spawnCli([FIXTURE_LAUNCHER, 'seed', runRoot, '--profile', 'large-tree']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(stub.draftBody.name, '@local/m6-large-tree-fixture');
    assert.equal(stub.draftBody.files.length, 128);
    const paths = stub.draftBody.files.map((file) => file.path);
    assert.equal(paths.filter((filePath) => filePath.includes('/')).length, 126);
    assert.deepEqual(paths, [...paths].sort());
    assert.equal(paths.filter((filePath) => filePath.endsWith('.ts')).length, 1);
    assert.equal(paths.filter((filePath) => filePath.endsWith('.json')).length, 1);
    assert.ok(paths.every((filePath) => filePath.split('/').length >= 8 || ['SKILL.md', 'README.md'].includes(filePath)));

    const fixture = JSON.parse(readFileSync(join(runRoot, 'work', 'local-m6-fixture.json'), 'utf8'));
    assert.equal(fixture.manifest.profile, 'large-tree');
    assert.equal(fixture.manifest.fileCount, 128);
    assert.equal(fixture.manifest.nestedPathCount, 126);
    assert.equal(fixture.draft.expectedTextBytes, fixture.manifest.totalBytes);
    assert.equal(fixture.manifest.canonicalOrder, 'path-ascending');
    assert.equal(fixture.manifest.longLineFiles.length, 2);
    assert.ok(fixture.manifest.longLineFiles.every((file) => file.maxLineBytes >= 160));
    assert.match(fixture.manifest.browserProof.selectionPath, /\.ts$/u);
    assert.match(fixture.manifest.browserProof.highlightPath, /\.json$/u);
    assert.match(fixture.manifest.browserProof.scrollPath, /record-125\.txt$/u);
    assert.equal(fixture.manifest.safety.executableFiles, 0);
    assert.equal(fixture.manifest.safety.contentExecution, 'none');
    assert.doesNotMatch(JSON.stringify(fixture.manifest), /token|secret|authorization/iu);
    assert.doesNotMatch(run.stdout, /local-seed-test-token/u);
  } finally {
    await stub.close();
    rmSync(runRoot, { recursive: true, force: true });
  }
});

function writeSeedMetadata(runRoot, origin) {
  const workRoot = join(runRoot, 'work');
  mkdirSync(workRoot, { mode: 0o700 });
  writeFileSync(join(workRoot, 'credentials.json'), JSON.stringify({ origin, token: 'local-seed-test-token' }), { mode: 0o600 });
  writeFileSync(join(workRoot, 'launch-metadata.json'), JSON.stringify({
    origins: { origin, builderOrigin: origin, reviewerOrigin: origin },
    paths: {
      credentials: join(workRoot, 'credentials.json'),
      fixture: join(workRoot, 'local-m6-fixture.json'),
    },
    reviewer: { mode: 'hold' },
  }), { mode: 0o600 });
}

async function startSeedStub() {
  const policy = {
    revision: 'policy-seed-test',
    scanners: [
      { id: 'skillsguard', mode: 'disabled' },
      { id: 'cisco-skill-scanner', mode: 'disabled' },
    ],
    allowUnscanned: true,
    evidenceMaxAgeSeconds: 3600,
    hooks: [],
  };
  let policyBody;
  let draftBody;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/policy') {
      response.writeHead(200);
      response.end(JSON.stringify({ policy }));
      return;
    }
    if (request.method === 'PUT' && request.url === '/v1/policy') {
      policyBody = JSON.parse(await readHttpBody(request));
      response.writeHead(200);
      response.end(JSON.stringify({ policy: { ...policyBody, revision: 'policy-seed-updated' } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/drafts') {
      draftBody = JSON.parse(await readHttpBody(request));
      response.writeHead(201);
      response.end(JSON.stringify({ draft: {
        id: 'draft-seed-test',
        name: draftBody.name,
        revision: 1,
        digest: `sha256:${'d'.repeat(64)}`,
        files: draftBody.files,
      } }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('seed stub did not bind a TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get policyBody() { return policyBody; },
    get draftBody() { return draftBody; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function readHttpBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function spawnCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
