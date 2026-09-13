import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// This is the local arm64 image ID that is checked into the disposable
// verification procedure. Callers may replace it only with another immutable
// sha256 ID in the control file; mutable tags are never accepted.
const DEFAULT_SKILLSGUARD_IMAGE_ID = 'sha256:4173ec0a31e37a572b94f88cb596e8b76aa9309beef06c16bb2e4ba2f6463aa0';

const controlPath = requiredAbsolutePath(resolveControlPath(), 'control path');
const control = readControl(controlPath);
const origin = requireLoopbackOrigin(control.origin);
const workerToken = requireToken(control.workerToken, 'worker token');
const precheckToken = requireToken(
  control.precheckToken ?? control.localPrincipalToken ?? control.principalToken ?? control.ownerToken,
  'precheck token',
);
const workerId = requireWorkerId(control.workerId);
const expectedJobId = requireJobId(control.expectedJobId ?? control.expected?.jobId);
const expectedKind = requireJobKind(control.expectedKind ?? control.expected?.kind);
const expectedArtifactDigest = requireDigest(
  control.expectedArtifactDigest ?? control.expected?.artifactDigest ?? control.expected?.digest,
  'expected artifact digest',
);
const imageId = requireDigest(
  control.skillsguardImageId ?? control.skillsGuardImageId ?? DEFAULT_SKILLSGUARD_IMAGE_ID,
  'SkillsGuard image ID',
);
const evidencePath = requiredAbsolutePath(
  control.evidencePath ?? join(dirname(controlPath), 'local-authoring-scan-evidence.json'),
  'evidence path',
);
const timeoutMs = boundedTimeout(control.timeoutMs);
const startedAt = new Date().toISOString();

let imageVerification = { available: false, inspectedId: null };
let precheck = {
  status: 'not-run',
  expectedJobId,
  expectedKind,
  expectedArtifactDigest,
};
let result = { claimed: false, error: 'verifier did not run' };
let observedClaim;

try {
  precheck = await precheckQueuedJob({
    origin,
    token: precheckToken,
    expectedJobId,
    expectedKind,
    expectedArtifactDigest,
    signal: AbortSignal.timeout(timeoutMs),
  });
  imageVerification = await verifySkillsGuardImage(imageId);

  const { WorkerRunner } = await import(
    pathToFileURL(join(REPO_ROOT, 'workers/runner/src/index.ts')).href,
  );
  // Do not inject an executor here. WorkerRunner's default is DockerExecutor,
  // which runs the scanner in the isolated container boundary.
  const runner = new WorkerRunner({
    baseUrl: origin,
    workerToken,
    workerId,
    scannerImages: { skillsguard: imageId },
    onEvent: async (event) => {
      if (event.type !== 'claimed') return;
      observedClaim = { jobId: event.jobId, kind: event.kind };
      if (event.jobId !== expectedJobId || event.kind !== expectedKind) {
        throw new Error('worker claimed an unexpected job');
      }
    },
  });
  result = await runner.runOnce(AbortSignal.timeout(timeoutMs));
} catch (error) {
  result = {
    claimed: observedClaim !== undefined,
    ...(observedClaim === undefined ? {} : { jobId: observedClaim.jobId, kind: observedClaim.kind }),
    error: safeError(error),
  };
  if (precheck.status === 'not-run') {
    precheck = {
      status: 'failed',
      expectedJobId,
      expectedKind,
      expectedArtifactDigest,
      error: safeError(error),
    };
  }
}

const scanners = Array.isArray(result.scannerResults)
  ? result.scannerResults.map((scan) => ({
    scannerId: scan.scannerId,
    artifactDigest: digestOnly(scan.artifactDigest),
    status: scan.status,
    policyRevision: scan.policyRevision,
    engineVersion: scan.engineVersion,
    rulesRevision: scan.rulesRevision,
    coverage: {
      filesEnumerated: scan.coverage.filesEnumerated,
      filesAnalyzed: scan.coverage.filesAnalyzed,
      filesSkipped: scan.coverage.filesSkipped,
      filesUnsupported: scan.coverage.filesUnsupported,
      limitationCount: scan.coverage.limitations.length,
      externalDestinationCount: scan.coverage.externalDestinations.length,
    },
    findingCount: scan.findings.length,
  }))
  : [];
const claimedJobId = typeof result.jobId === 'string' ? result.jobId : observedClaim?.jobId ?? null;
const claimedKind = typeof result.kind === 'string' ? result.kind : observedClaim?.kind ?? null;
const claimedJobMatches = claimedJobId === expectedJobId;
const claimedKindMatches = claimedKind === expectedKind;
const abortedBeforeMaterialization = observedClaim !== undefined && (!claimedJobMatches || !claimedKindMatches);
const scannerDigestMatches = scanners.some(
  (scan) => scan.scannerId === 'skillsguard' && scan.artifactDigest === expectedArtifactDigest,
);
const evidence = {
  schemaVersion: 4,
  mode: 'local-authoring-worker-runner',
  origin,
  executor: 'DockerExecutor',
  startedAt,
  completedAt: new Date().toISOString(),
  expected: {
    jobId: expectedJobId,
    kind: expectedKind,
    artifactDigest: expectedArtifactDigest,
  },
  image: {
    immutableId: imageId,
    available: imageVerification.available,
    inspectedId: imageVerification.inspectedId,
  },
  precheck: sanitizedPrecheck(precheck),
  result: {
    claimed: result.claimed === true || observedClaim !== undefined,
    jobId: claimedJobId,
    kind: claimedKind,
    jobMatchesExpected: claimedJobMatches,
    kindMatchesExpected: claimedKindMatches,
    abortedBeforeMaterialization,
    allow: typeof result.allow === 'boolean' ? result.allow : null,
    error: typeof result.error === 'string' ? safeError(result.error) : null,
    scannerDigestMatches,
    scanners,
  },
};

mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
chmodSync(evidencePath, 0o600);
process.stdout.write(JSON.stringify({
  evidencePath,
  precheck: evidence.precheck.status,
  claimed: evidence.result.claimed,
  jobId: evidence.result.jobId,
  jobMatchesExpected: claimedJobMatches,
  kindMatchesExpected: claimedKindMatches,
  artifactDigest: expectedArtifactDigest,
  scannerDigestMatches,
  allow: evidence.result.allow,
  imageAvailable: imageVerification.available,
  scannerCount: scanners.length,
}) + '\n');

if (
  !imageVerification.available ||
  evidence.precheck.status !== 'passed' ||
  !evidence.result.claimed ||
  !claimedJobMatches ||
  !claimedKindMatches ||
  !scannerDigestMatches ||
  evidence.result.allow !== true ||
  !scanners.some((scan) => scan.scannerId === 'skillsguard' && scan.status === 'completed')
) {
  process.exitCode = 1;
}

function resolveControlPath() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] && !args[0].startsWith('-')) return args[0];
  if (args.length === 2 && args[0] === '--control' && args[1]) return args[1];
  if (args.length > 0) throw new Error('usage: verify-local-authoring-scan.mjs --control /absolute/control.json');
  if (typeof process.env.PSKILLS_LOCAL_CONTROL === 'string' && process.env.PSKILLS_LOCAL_CONTROL.length > 0) {
    return process.env.PSKILLS_LOCAL_CONTROL;
  }
  throw new Error('an explicit local control path is required via --control or PSKILLS_LOCAL_CONTROL');
}

async function verifySkillsGuardImage(immutableId) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'image',
      'inspect',
      immutableId,
      '--format',
      '{{.Id}}',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 });
    const inspectedId = stdout.trim();
    if (inspectedId !== immutableId) throw new Error('SkillsGuard image identity mismatch');
    return { available: true, inspectedId };
  } catch {
    throw new Error('required SkillsGuard image is not available at the pinned immutable ID');
  }
}

async function precheckQueuedJob({ origin: baseUrl, token, expectedJobId: jobId, expectedKind: kind, expectedArtifactDigest: digest, signal }) {
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/operations/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'private-skills-local-authoring-precheck/1',
      },
      redirect: 'error',
      signal,
    });
  } catch {
    throw new Error('precheck request failed');
  }
  if (!response.ok) throw new Error(`precheck request rejected (${response.status})`);

  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error('precheck response was not valid JSON');
  }
  const operation = isObject(value) && isObject(value.operation) ? value.operation : value;
  if (!isObject(operation)) throw new Error('precheck response omitted operation');
  const observedDigest = isObject(operation.artifact) ? operation.artifact.digest : operation.artifactDigest;
  if (operation.id !== jobId) throw new Error('precheck returned a different job');
  if (operation.kind !== kind) throw new Error(`precheck job kind is not ${kind}`);
  if (operation.state !== 'queued') throw new Error(`precheck job is not queued (${String(operation.state)})`);
  if (observedDigest !== digest) throw new Error('precheck artifact digest does not match the expected digest');
  return {
    status: 'passed',
    expectedJobId: jobId,
    expectedKind: kind,
    expectedArtifactDigest: digest,
    observedJobId: jobId,
    observedState: 'queued',
    observedArtifactDigest: digest,
  };
}

function readControl(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error('local worker control file is unreadable');
  }
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('local worker control file is too large');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('local worker control file is invalid JSON');
  }
  if (!isObject(parsed)) throw new Error('local worker control file is invalid');
  return parsed;
}

function requireLoopbackOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value)) {
    throw new Error('local worker origin must be an exact http://127.0.0.1:<port> origin');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('local worker origin is invalid');
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || parsed.origin !== value || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('local worker origin must be an exact http://127.0.0.1:<port> origin');
  }
  return parsed.origin;
}

function requireToken(value, label) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`local ${label} is invalid`);
  }
  return value;
}

function requireWorkerId(value) {
  const worker = value ?? 'local-authoring-worker';
  if (typeof worker !== 'string' || worker.length === 0 || worker.length > 128 || /[\u0000-\u001f\u007f]/u.test(worker)) {
    throw new Error('local worker id is invalid');
  }
  return worker;
}

function requireJobId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('expected job id is required and invalid');
  }
  return value;
}

function requireJobKind(value) {
  const kind = value ?? 'scan';
  if (kind !== 'scan') throw new Error('expected job kind must be scan');
  return kind;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function boundedTimeout(value) {
  const parsed = Number(value ?? 180_000);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(600_000, Math.floor(parsed))) : 180_000;
}

function digestOnly(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : null;
}

function sanitizedPrecheck(value) {
  return {
    status: value.status,
    expectedJobId,
    expectedKind,
    expectedArtifactDigest,
    ...(typeof value.observedJobId === 'string' ? { observedJobId: value.observedJobId } : {}),
    ...(typeof value.observedState === 'string' ? { observedState: value.observedState } : {}),
    ...(typeof value.observedArtifactDigest === 'string' ? { observedArtifactDigest: digestOnly(value.observedArtifactDigest) } : {}),
    ...(typeof value.error === 'string' ? { error: safeError(value.error) } : {}),
  };
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return [workerToken, precheckToken]
    .filter((secret) => secret.length > 0)
    .reduce((safe, secret) => safe.replaceAll(secret, '[redacted]'), text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .slice(0, 512);
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
