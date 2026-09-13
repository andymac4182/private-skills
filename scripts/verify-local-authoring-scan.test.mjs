import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IMAGE_ID = 'sha256:4173ec0a31e37a572b94f88cb596e8b76aa9309beef06c16bb2e4ba2f6463aa0';
const EXPECTED_JOB_ID = 'job-local-authoring-expected';
const EXPECTED_DIGEST = `sha256:${'a'.repeat(64)}`;

test('local verifier imports WorkerRunner and rejects mismatched queued jobs before claim', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'private-skills-verifier-test-'));
  const dockerBin = join(tempRoot, 'bin');
  await mkdir(dockerBin);
  await writeFile(
    join(dockerBin, 'docker'),
    `#!/bin/sh
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  printf '%s\\n' '${IMAGE_ID}'
  exit 0
fi
exit 97
`,
    { mode: 0o700 },
  );
  await chmod(join(dockerBin, 'docker'), 0o700);

  try {
    await runImportSmoke(tempRoot, dockerBin);
    await runClaimGuardCase(tempRoot, dockerBin);
    await runPrecheckCase(tempRoot, dockerBin, {
      name: 'wrong digest',
      operation: { kind: 'scan', state: 'queued', artifact: { digest: `sha256:${'b'.repeat(64)}` } },
    });
    await runPrecheckCase(tempRoot, dockerBin, {
      name: 'queued wrong type',
      operation: { kind: 'import', state: 'queued', artifact: { digest: EXPECTED_DIGEST } },
    });
    await runNonLoopbackCase(tempRoot, dockerBin);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function runImportSmoke(tempRoot, dockerBin) {
  const stub = await startRegistryStub({
    operation: { id: EXPECTED_JOB_ID, kind: 'scan', state: 'queued', artifact: { digest: EXPECTED_DIGEST } },
    claimResponse: { status: 204 },
  });
  try {
    const controlPath = await writeControl(tempRoot, 'import-smoke', {
      origin: stub.origin,
      evidencePath: join(tempRoot, 'import-smoke-evidence.json'),
      expectedJobId: EXPECTED_JOB_ID,
      expectedArtifactDigest: EXPECTED_DIGEST,
    });
    const run = await spawnVerifier(controlPath, dockerBin);
    assert.equal(run.status, 1, run.stderr);
    const evidence = JSON.parse(await readFile(join(tempRoot, 'import-smoke-evidence.json'), 'utf8'));
    // A 204 claim keeps this smoke side-effect-free while proving the script
    // loaded WorkerRunner and completed its one-shot idle path.
    assert.equal(evidence.precheck.status, 'passed');
    assert.equal(evidence.image.available, true);
    assert.equal(evidence.result.claimed, false);
    assert.equal(evidence.result.error, null);
    assert.equal(stub.claimCount, 1);
  } finally {
    await stub.close();
  }
}

async function runPrecheckCase(tempRoot, dockerBin, { name, operation }) {
  const stub = await startRegistryStub({ operation });
  try {
    const controlPath = await writeControl(tempRoot, name.replace(/\s+/gu, '-'), {
      origin: stub.origin,
      evidencePath: join(tempRoot, `${name.replace(/\s+/gu, '-')}-evidence.json`),
      expectedJobId: EXPECTED_JOB_ID,
      expectedArtifactDigest: EXPECTED_DIGEST,
    });
    const run = await spawnVerifier(controlPath, dockerBin);
    assert.equal(run.status, 1, run.stderr);
    const evidence = JSON.parse(await readFile(join(tempRoot, `${name.replace(/\s+/gu, '-')}-evidence.json`), 'utf8'));
    assert.equal(evidence.precheck.status, 'failed');
    assert.equal(evidence.result.claimed, false);
    assert.equal(stub.claimCount, 0, `${name} must fail before claim`);
  } finally {
    await stub.close();
  }
}

async function runClaimGuardCase(tempRoot, dockerBin) {
  const stub = await startRegistryStub({
    operation: { kind: 'scan', state: 'queued', artifact: { digest: EXPECTED_DIGEST } },
    claimResponse: {
      status: 200,
      body: { job: { id: 'job-unexpected', kind: 'import' } },
    },
  });
  try {
    const controlPath = await writeControl(tempRoot, 'claim-guard', {
      origin: stub.origin,
      evidencePath: join(tempRoot, 'claim-guard-evidence.json'),
      expectedJobId: EXPECTED_JOB_ID,
      expectedArtifactDigest: EXPECTED_DIGEST,
    });
    const run = await spawnVerifier(controlPath, dockerBin);
    assert.equal(run.status, 1, run.stderr);
    const evidence = JSON.parse(await readFile(join(tempRoot, 'claim-guard-evidence.json'), 'utf8'));
    assert.equal(evidence.precheck.status, 'passed');
    assert.equal(evidence.result.claimed, true);
    assert.equal(evidence.result.jobId, 'job-unexpected');
    assert.equal(evidence.result.kind, 'import');
    assert.equal(evidence.result.jobMatchesExpected, false);
    assert.equal(evidence.result.kindMatchesExpected, false);
    assert.equal(evidence.result.abortedBeforeMaterialization, true);
    assert.match(evidence.result.error, /unexpected job/u);
    assert.equal(stub.requestCount, 2, 'claim guard must stop before artifact download or completion');
  } finally {
    await stub.close();
  }
}

async function runNonLoopbackCase(tempRoot, dockerBin) {
  const stub = await startRegistryStub({
    operation: { id: EXPECTED_JOB_ID, kind: 'scan', state: 'queued', artifact: { digest: EXPECTED_DIGEST } },
  });
  try {
    const controlPath = await writeControl(tempRoot, 'non-loopback', {
      // The server is loopback, but the control file deliberately uses the
      // hostname alias that the verifier must reject before any request.
      origin: stub.origin.replace('127.0.0.1', 'localhost'),
      evidencePath: join(tempRoot, 'non-loopback-evidence.json'),
      expectedJobId: EXPECTED_JOB_ID,
      expectedArtifactDigest: EXPECTED_DIGEST,
    });
    const run = await spawnVerifier(controlPath, dockerBin);
    assert.notEqual(run.status, 0);
    assert.equal(stub.requestCount, 0, 'non-loopback control must not reach the registry');
  } finally {
    await stub.close();
  }
}

async function writeControl(tempRoot, name, overrides) {
  const path = join(tempRoot, `${name}-control.json`);
  await writeFile(path, JSON.stringify({
    ...overrides,
    workerToken: 'local-worker-token-for-test-123456',
    principalToken: 'local-principal-token-for-test-123456',
    workerId: 'local-authoring-test-worker',
  }), { mode: 0o600 });
  return path;
}

function spawnVerifier(controlPath, dockerBin) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.PSKILLS_LOCAL_CONTROL;
    delete env.PSKILLS_LOCAL_EVIDENCE;
    // Ensure the script cannot accidentally use unrelated production values.
    env.PSKILLS_API_URL = 'https://production.invalid';
    env.PSKILLS_WORKER_TOKEN = 'ambient-production-token-that-must-be-ignored';
    env.PATH = `${dockerBin}:${env.PATH ?? ''}`;
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      'scripts/verify-local-authoring-scan.mjs',
      '--control',
      controlPath,
    ], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

async function startRegistryStub({ operation, claimResponse = { status: 404 } }) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method === 'GET' && request.url === `/v1/operations/${EXPECTED_JOB_ID}`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ operation: { id: EXPECTED_JOB_ID, ...operation } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/internal/jobs/claim') {
      response.writeHead(claimResponse.status);
      response.end(claimResponse.body ? JSON.stringify(claimResponse.body) : undefined);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub did not bind a TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get requestCount() { return requests.length; },
    get claimCount() { return requests.filter((request) => request.method === 'POST' && request.url === '/internal/jobs/claim').length; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
