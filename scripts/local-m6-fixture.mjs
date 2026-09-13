#!/usr/bin/env node

/**
 * Disposable local M6 fixture launcher and control utility.
 *
 * `launch` starts the real Nitro output from this checkout and two authenticated
 * loopback-only HTTP boundaries:
 *
 *   browser -> Nitro -> deterministic builder HTTPS stub -> real registry
 *   Nitro -> deterministic upload-review HTTP stub -> real registry
 *
 * The stubs never execute fixture files and never write prompts, snapshots,
 * credentials, leases, or finding text to logs. `seed` is intentionally
 * separate from `launch`, so a browser run cannot create a draft by accident.
 * The required scanner policy is configured by `seed` and remains required;
 * this harness does not provide scanner-worker credentials to the web app.
 *
 * The external model/Gateway boundary is deterministic and local. This is
 * useful for exercising the real HTTP, persistence, auth, binding, and UI
 * contracts, but it is not hosted Eve or provider/model evidence.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ROOT_PREFIX = '/private/tmp/private-skills-m6-local-';
const DEFAULT_APP_PORT = 5197;
const DEFAULT_BUILDER_PORT = 5196;
const DEFAULT_REVIEWER_PORT = 5195;
const LOCAL_SKILLSGUARD_IMAGE_ID = 'sha256:4173ec0a31e37a572b94f88cb596e8b76aa9309beef06c16bb2e4ba2f6463aa0';
const DEFAULT_SEED_PROFILE = 'two-files';
const LARGE_TREE_SEED_PROFILE = 'large-tree';
const LARGE_TREE_NESTED_FILE_COUNT = 126;
const MAX_SEED_REQUEST_BYTES = 3_000_000;
const STOP_PROTOCOL_VERSION = 1;
const STOP_POLL_INTERVAL_MS = 250;
const ENV_FILES_READ_BY_VITE = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
  '.env.development',
  '.env.development.local',
];

const command = process.argv[2] ?? 'help';

if (command === 'launch') {
  await launch(parseLaunchOptions(process.argv.slice(3)));
} else if (command === 'seed') {
  await seed(requireRunArgument(process.argv[3]), parseSeedOptions(process.argv.slice(4)));
} else if (command === 'status') {
  await status(requireRunArgument(process.argv[3]));
} else if (command === 'advance') {
  await advance(requireRunArgument(process.argv[3]), process.argv[4]);
} else if (command === 'prepare-scan') {
  await prepareScan(requireRunArgument(process.argv[3]), process.argv[4], process.argv[5]);
} else if (command === 'stop') {
  await stop(requireRunArgument(process.argv[3]));
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else {
  throw new Error(`unknown command ${JSON.stringify(command)}; use help`);
}

function printHelp() {
  process.stdout.write([
    'Local M6 fixture (explicit local-only commands):',
    '',
    '  node scripts/local-m6-fixture.mjs launch [--app-port 5197] [--builder-port 5196] [--reviewer-port 5195] [--reviewer-mode hold|auto|delay] [--reviewer-delay-ms N]',
    '  node scripts/local-m6-fixture.mjs seed <run-root> [--profile two-files|large-tree]',
    '  node scripts/local-m6-fixture.mjs status <run-root>',
    '  node scripts/local-m6-fixture.mjs advance <run-root> [reviewer-session-id]',
    '  node scripts/local-m6-fixture.mjs prepare-scan <run-root> <expected-job-id> <expected-artifact-digest>',
    '  node scripts/local-m6-fixture.mjs stop <run-root>',
    '',
    'launch starts the real Nitro build and app plus local builder/reviewer boundaries.',
    'seed sets SkillGuard required/allowUnscanned=false and creates a two-text-file draft by default.',
    'The opt-in large-tree profile creates 128 canonical files, including 126 nested paths and inert TS/JSON long-line proof files.',
    'The browser route is written to the mode-0600 fixture metadata after seed.',
    'Reviewer mode defaults to hold; advance performs the real prepare/complete calls.',
    'prepare-scan writes a mode-0600 WorkerRunner verifier control file; it does not claim or run a scan.',
    'All credentials and logs stay in a private disposable run root under /private/tmp.',
    'The builder and reviewer model boundary is deterministic local fixture behavior.',
  ].join('\n') + '\n');
}

function parseSeedOptions(args) {
  let profile = DEFAULT_SEED_PROFILE;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (name !== '--profile') throw new Error(`unknown seed option ${JSON.stringify(name)}`);
    if (value === undefined || value.startsWith('--')) throw new Error('--profile requires two-files or large-tree');
    if (![DEFAULT_SEED_PROFILE, LARGE_TREE_SEED_PROFILE].includes(value)) {
      throw new Error(`--profile must be ${DEFAULT_SEED_PROFILE} or ${LARGE_TREE_SEED_PROFILE}`);
    }
    profile = value;
    index += 1;
  }
  return { profile };
}

function requireRunArgument(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('a disposable run root is required');
  }
  const runRoot = value.endsWith('.json') ? path.dirname(path.dirname(value)) : value;
  assertSafeRunRoot(runRoot);
  return runRoot;
}

function assertSafeRunRoot(runRoot) {
  if (!runRoot.startsWith(RUN_ROOT_PREFIX) || runRoot.includes('..') || !path.isAbsolute(runRoot)) {
    throw new Error(`run root must be a disposable path under ${RUN_ROOT_PREFIX}`);
  }
}

function parseLaunchOptions(args) {
  const values = {
    appPort: DEFAULT_APP_PORT,
    builderPort: DEFAULT_BUILDER_PORT,
    reviewerPort: DEFAULT_REVIEWER_PORT,
    reviewerMode: 'hold',
    reviewerDelayMs: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (name === '--app-port') {
      values.appPort = parsePort(value, name);
      index += 1;
    } else if (name === '--builder-port') {
      values.builderPort = parsePort(value, name);
      index += 1;
    } else if (name === '--reviewer-port') {
      values.reviewerPort = parsePort(value, name);
      index += 1;
    } else if (name === '--reviewer-mode') {
      if (!new Set(['hold', 'auto', 'delay']).has(value)) {
        throw new Error('--reviewer-mode must be hold, auto, or delay');
      }
      values.reviewerMode = value;
      index += 1;
    } else if (name === '--reviewer-delay-ms') {
      values.reviewerDelayMs = parseDelay(value);
      index += 1;
    } else {
      throw new Error(`unknown launch option ${JSON.stringify(name)}`);
    }
  }
  if (values.reviewerMode === 'delay' && values.reviewerDelayMs === undefined) {
    throw new Error('--reviewer-delay-ms is required with --reviewer-mode delay');
  }
  if (values.appPort === values.builderPort || values.appPort === values.reviewerPort || values.builderPort === values.reviewerPort) {
    throw new Error('app, builder, and reviewer ports must be distinct');
  }
  return values;
}

function parsePort(value, name) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new Error(`${name} must be a numeric port`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error(`${name} is outside the local port range`);
  return port;
}

function parseDelay(value) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new Error('--reviewer-delay-ms must be a non-negative integer');
  const delay = Number(value);
  if (!Number.isSafeInteger(delay) || delay > 60_000) throw new Error('--reviewer-delay-ms must be <= 60000');
  return delay;
}

function writePrivate(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function writeStopRequest(filePath) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writePrivate(temporaryPath, {
      protocolVersion: STOP_PROTOCOL_VERSION,
      kind: 'shutdown',
      requestedAt: new Date().toISOString(),
    });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    try { unlinkSync(temporaryPath); } catch { /* renamed or already absent */ }
  }
}

function makePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function randomToken(label) {
  return `local-m6-${label}-${randomBytes(32).toString('base64url')}`;
}

function createCleanBuildRoot(runRoot, sourceCommit) {
  // The source checkout intentionally contains developer .env files. Build a
  // tracked archive in the disposable run root instead of reading, renaming,
  // or deleting those files. Dependencies stay outside the archive via
  // absolute symlinks and are not treated as configuration.
  const buildRoot = path.join(runRoot, 'source');
  const archivePath = path.join(runRoot, 'source.tar');
  makePrivateDirectory(buildRoot);
  const tar = ['/usr/bin/tar', '/bin/tar'].find((candidate) => existsSync(candidate));
  if (!tar) throw new Error('tar is required to unpack the clean local build source');
  try {
    execFileSync('git', ['archive', '--format=tar', sourceCommit, '-o', archivePath], { cwd: REPO_ROOT, stdio: 'ignore' });
    execFileSync(tar, ['-xf', archivePath, '-C', buildRoot], { cwd: REPO_ROOT, stdio: 'ignore' });
  } catch {
    throw new Error('could not create a clean tracked-source build checkout');
  }
  try { unlinkSync(archivePath); } catch { /* no archive remains on success */ }
  const rootDependencies = path.join(REPO_ROOT, 'node_modules');
  if (!existsSync(rootDependencies)) throw new Error('root node_modules is required for the local build');
  symlinkSync(rootDependencies, path.join(buildRoot, 'node_modules'), 'dir');
  const appsRoot = path.join(REPO_ROOT, 'apps');
  for (const app of ['web', 'skill-builder', 'upload-reviewer', 'reviewer']) {
    const dependencies = path.join(appsRoot, app, 'node_modules');
    if (!existsSync(dependencies)) continue;
    const target = path.join(buildRoot, 'apps', app, 'node_modules');
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    symlinkSync(dependencies, target, 'dir');
  }
  for (const root of [buildRoot, path.join(buildRoot, 'apps/web')]) {
    for (const name of ENV_FILES_READ_BY_VITE) {
      if (existsSync(path.join(root, name))) throw new Error(`clean build unexpectedly contains ${name}`);
    }
  }
  return buildRoot;
}

function resolveInstalledViteEntry() {
  const viteEntry = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteEntry)) {
    throw new Error(`the pinned Vite entrypoint is unavailable at ${viteEntry}`);
  }
  return viteEntry;
}

function createLocalTls(tlsRoot) {
  const openssl = ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl'].find((candidate) => existsSync(candidate));
  if (!openssl) throw new Error('openssl is required to create the disposable builder certificate');
  const certificatePath = path.join(tlsRoot, 'local-builder.crt');
  const keyPath = path.join(tlsRoot, 'local-builder.key');
  try {
    execFileSync(openssl, [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-days',
      '1',
    ], { cwd: REPO_ROOT, stdio: 'ignore' });
  } catch {
    throw new Error('openssl could not create the disposable builder certificate');
  }
  chmodSync(certificatePath, 0o600);
  chmodSync(keyPath, 0o600);
  return { certificatePath, keyPath };
}

function bootstrapTokenList(userToken, builderRegistryToken, organizationId) {
  return JSON.stringify([
    {
      id: 'local-m6-owner',
      token: userToken,
      organizationId,
      subject: 'local-m6-owner',
      roles: ['owner', 'admin', 'publisher', 'reader'],
      namespaces: ['@local'],
      kind: 'user',
    },
    {
      id: 'local-m6-builder',
      token: builderRegistryToken,
      organizationId,
      subject: 'local-m6-builder',
      roles: ['publisher'],
      namespaces: ['@local'],
      scopes: ['skills:builder', 'skills:read', 'registry:read'],
      kind: 'user',
    },
  ]);
}

async function launch(options) {
  const runId = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const runRoot = `${RUN_ROOT_PREFIX}${runId}`;
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const workRoot = path.join(runRoot, 'work');
  const dataRoot = path.join(workRoot, 'data');
  const stateRoot = path.join(dataRoot, 'state');
  const blobRoot = path.join(dataRoot, 'blobs');
  const logRoot = path.join(workRoot, 'logs');
  const tlsRoot = path.join(workRoot, 'tls');
  for (const directory of [runRoot, workRoot, dataRoot, stateRoot, blobRoot, logRoot, tlsRoot]) makePrivateDirectory(directory);
  const buildRoot = createCleanBuildRoot(runRoot, sourceCommit);
  const viteEntry = resolveInstalledViteEntry();

  const origin = `http://127.0.0.1:${options.appPort}`;
  const builderOrigin = `https://127.0.0.1:${options.builderPort}`;
  const reviewerOrigin = `http://127.0.0.1:${options.reviewerPort}`;
  const organizationId = 'local-m6';
  const childPath = typeof process.env.PATH === 'string' && process.env.PATH.length > 0 ? process.env.PATH : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  const userToken = randomToken('owner');
  const workerToken = randomToken('worker');
  const builderServiceToken = randomToken('builder-service');
  const builderEveToken = randomToken('builder-eve');
  const builderRegistryToken = randomToken('builder-registry');
  const reviewerEveToken = randomToken('reviewer-eve');
  const reviewerRegistryToken = randomToken('reviewer-registry');
  const reviewerControlToken = randomToken('reviewer-control');
  const sessionSecret = randomBytes(32).toString('base64url');
  const tls = createLocalTls(tlsRoot);

  const credentialsPath = path.join(workRoot, 'local-browser-credentials.json');
  const workerControlPath = path.join(workRoot, 'local-worker-control.json');
  const controlPath = path.join(workRoot, 'local-m6-control.json');
  const fixturePath = path.join(workRoot, 'local-m6-fixture.json');
  const metadataPath = path.join(workRoot, 'launch-metadata.json');
  const processesPath = path.join(workRoot, 'processes.json');
  const stopRequestPath = path.join(workRoot, 'stop-request.json');
  const appLog = path.join(logRoot, 'app.log');
  const builderLog = path.join(logRoot, 'builder.log');
  const reviewerLog = path.join(logRoot, 'reviewer.log');

  writePrivate(credentialsPath, { origin, token: userToken, organizationId, namespace: '@local' });
  writePrivate(workerControlPath, { origin, workerToken, workerId: 'local-m6-worker' });
  writePrivate(controlPath, {
    origin,
    builderOrigin,
    reviewerOrigin,
    ownerCredentialsPath: credentialsPath,
    workerControlPath,
    reviewerControlToken,
    fixturePath,
    runRoot,
    reviewerMode: options.reviewerMode,
  });

  const commonEnv = {
    PATH: childPath,
    TMPDIR: '/private/tmp',
    CI: 'true',
    NODE_ENV: 'production',
    PSKILLS_ENVIRONMENT: 'development',
    PSKILLS_PUBLIC_ORIGIN: origin,
    PSKILLS_API_URL: origin,
    PSKILLS_ORGANIZATION_ID: organizationId,
    PSKILLS_BOOTSTRAP_TOKEN: '',
    PSKILLS_BOOTSTRAP_ROLES: 'owner',
    PSKILLS_BOOTSTRAP_TOKENS: bootstrapTokenList(userToken, builderRegistryToken, organizationId),
    PSKILLS_WORKER_TOKEN: workerToken,
    PSKILLS_WORKER_TOKEN_ID: 'local-m6-worker',
    PSKILLS_WORKER_TOKENS: '[]',
    PSKILLS_WORKER_SUBJECT: 'local-m6-worker',
    PSKILLS_WORKER_NAMESPACES: '@local',
    PSKILLS_WORKER_SCOPES: 'jobs:*',
    PSKILLS_SESSION_SECRET: sessionSecret,
    PSKILLS_GATEWAY_TOKEN: '',
    PSKILLS_ALLOW_UNSCANNED: 'false',
    PSKILLS_STATE_PROVIDER: 'file',
    PSKILLS_STATE_PATH: stateRoot,
    PSKILLS_SINGLE_PROCESS: 'true',
    PSKILLS_STORAGE_PROVIDER: 'filesystem',
    PSKILLS_STORAGE_ROOT: blobRoot,
    PSKILLS_STORAGE_BUILD_PROFILE: 'filesystem',
    PSKILLS_RUNTIME_PROFILE: 'node',
    PSKILLS_HOSTED_WORKER: 'false',
    PSKILLS_AI_ENABLED: 'false',
    PSKILLS_SEARCH_PROVIDER: 'state',
    PSKILLS_DIRECTORY_ENABLED: 'false',
    PSKILLS_PACK_DIRECTORY_ENABLED: 'false',
    PSKILLS_BUILDER_APP_ORIGIN: builderOrigin,
    PSKILLS_BUILDER_SERVICE_TOKEN: builderServiceToken,
    PSKILLS_BUILDER_EVE_API_TOKEN: builderEveToken,
    PSKILLS_UPLOAD_REVIEW_ENABLED: 'true',
    PSKILLS_UPLOAD_REVIEWER_URL: reviewerOrigin,
    PSKILLS_UPLOAD_REVIEW_EVE_API_TOKEN: reviewerEveToken,
    PSKILLS_UPLOAD_REVIEW_REGISTRY_TOKEN: reviewerRegistryToken,
    PSKILLS_UPLOAD_REVIEW_MODEL: 'fixture/local-review',
    PSKILLS_UPLOAD_REVIEW_REVIEWER_REVISION: 'local-upload-review-v1',
    PSKILLS_IMAGE_SKILLSGUARD: '',
    PSKILLS_IMAGE_CISCO: '',
    PSKILLS_IMAGE_NVIDIA: '',
    NODE_EXTRA_CA_CERTS: tls.certificatePath,
  };

  writePrivate(metadataPath, {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    sourceCommit,
    buildRoot,
    origins: { origin, builderOrigin, reviewerOrigin },
    ports: { app: options.appPort, builder: options.builderPort, reviewer: options.reviewerPort },
    paths: {
      credentials: credentialsPath,
      ownerCredentials: credentialsPath,
      workerControl: workerControlPath,
      control: controlPath,
      fixture: fixturePath,
      processes: processesPath,
      stopRequest: stopRequestPath,
      logs: logRoot,
      tls: tlsRoot,
      builderCertificate: tls.certificatePath,
    },
    stopRequestPath,
    reviewer: {
      mode: options.reviewerMode,
      ...(options.reviewerDelayMs === undefined ? {} : { delayMs: options.reviewerDelayMs }),
    },
    stopProtocolVersion: STOP_PROTOCOL_VERSION,
    boundary: {
      real: [
        'Nitro HTTP routes and persistence',
        'builder availability/session/prompt/stream routes',
        'draft context/file/proposal/apply/reload routes',
        'upload-review prepare/complete persistence routes',
        'browser bearer auth and local bootstrap scope checks',
      ],
      deterministic: 'The builder and upload-review Eve/provider boundaries are local deterministic HTTP stubs.',
      limitations: [
        'No hosted Eve model or Vercel AI Gateway call is made.',
        'No scanner worker is started by this launcher; required SkillsGuard remains a separate real-worker step.',
        'No upload-reviewer deployment is connected; the local reviewer is a fixture boundary.',
      ],
    },
  });

  const appFd = openSync(appLog, 'a', 0o600);
  const builderFd = openSync(builderLog, 'a', 0o600);
  const reviewerFd = openSync(reviewerLog, 'a', 0o600);
  const builder = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/local-m6-builder-stub.mjs')], {
    cwd: REPO_ROOT,
    env: {
      PATH: childPath,
      TMPDIR: '/private/tmp',
      NODE_ENV: 'production',
      LOCAL_BUILDER_PORT: String(options.builderPort),
      LOCAL_REGISTRY_ORIGIN: origin,
      LOCAL_BUILDER_SERVICE_TOKEN: builderServiceToken,
      LOCAL_BUILDER_EVE_TOKEN: builderEveToken,
      LOCAL_BUILDER_REGISTRY_TOKEN: builderRegistryToken,
      LOCAL_BUILDER_CERT: tls.certificatePath,
      LOCAL_BUILDER_KEY: tls.keyPath,
      LOCAL_BUILDER_LOG: builderLog,
    },
    stdio: ['ignore', builderFd, builderFd],
  });
  const reviewer = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/local-m6-reviewer-stub.mjs')], {
    cwd: REPO_ROOT,
    env: {
      PATH: childPath,
      TMPDIR: '/private/tmp',
      NODE_ENV: 'production',
      LOCAL_REVIEWER_PORT: String(options.reviewerPort),
      LOCAL_REVIEWER_REGISTRY_ORIGIN: origin,
      LOCAL_REVIEWER_EVE_TOKEN: reviewerEveToken,
      LOCAL_REVIEWER_REGISTRY_TOKEN: reviewerRegistryToken,
      LOCAL_REVIEWER_CONTROL_TOKEN: reviewerControlToken,
      LOCAL_REVIEWER_MODE: options.reviewerMode,
      ...(options.reviewerDelayMs === undefined ? {} : { LOCAL_REVIEWER_AUTOCOMPLETE_MS: String(options.reviewerDelayMs) }),
      LOCAL_REVIEWER_LOG: reviewerLog,
    },
    stdio: ['ignore', reviewerFd, reviewerFd],
  });
  const build = spawn(process.execPath, [viteEntry, 'build'], {
    cwd: path.join(buildRoot, 'apps', 'web'),
    env: { ...commonEnv },
    stdio: ['ignore', appFd, appFd],
  });
  let app;
  let stopping = false;
  let exitCode = 0;
  let stopRequestPoller;

  const writeProcesses = () => writePrivate(processesPath, {
    launcherPid: process.pid,
    builderPid: builder.pid ?? null,
    reviewerPid: reviewer.pid ?? null,
    buildPid: build.pid ?? null,
    appPid: app?.pid ?? null,
    startedAt: new Date().toISOString(),
  });
  writeProcesses();

  const shutdown = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    if (stopRequestPoller) {
      clearInterval(stopRequestPoller);
      stopRequestPoller = undefined;
    }
    stopChildren();
    setTimeout(() => {
      for (const fd of [appFd, builderFd, reviewerFd]) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      process.exit(exitCode);
    }, 1_500).unref();
  };
  const fail = (name, detail = 'failed') => {
    process.stdout.write(`local-${name}-${detail}\n`);
    shutdown(1);
  };

  build.once('error', () => fail('build', 'spawn-failed'));
  builder.once('error', () => fail('builder', 'spawn-failed'));
  reviewer.once('error', () => fail('reviewer', 'spawn-failed'));
  build.once('exit', (code, signal) => {
    if (stopping) return;
    if (code !== 0) {
      fail('build', `failed:${code ?? signal}`);
      return;
    }
    app = spawn(process.execPath, ['apps/web/.output/server/index.mjs'], {
      cwd: buildRoot,
      env: {
        ...commonEnv,
        // The artifact is built in production mode, while this disposable
        // process intentionally runs in development so the app's existing
        // loopback-only builder-origin allowance is active.
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(options.appPort),
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(options.appPort),
      },
      stdio: ['ignore', appFd, appFd],
    });
    writeProcesses();
    process.stdout.write(`local-app-started:${origin}\n`);
    app.once('error', () => fail('app', 'spawn-failed'));
    app.once('exit', (appCode, appSignal) => {
      if (!stopping && appCode !== 0) fail('app', `failed:${appCode ?? appSignal}`);
    });
  });
  const stopChildren = () => {
    for (const child of [app, build, builder, reviewer]) {
      if (!child || child.killed) continue;
      try { child.kill('SIGTERM'); } catch { /* process already exited */ }
    }
  };
  const pollStopRequest = () => {
    if (stopping || !existsSync(stopRequestPath)) return;
    let request;
    try {
      request = readPrivateJson(stopRequestPath);
    } catch {
      fail('stop-request', 'invalid');
      return;
    }
    if (request.protocolVersion !== STOP_PROTOCOL_VERSION || request.kind !== 'shutdown' || typeof request.requestedAt !== 'string') {
      fail('stop-request', 'unsupported-protocol');
      return;
    }
    process.stdout.write('local-stop-request-accepted\n');
    shutdown(0);
  };
  stopRequestPoller = setInterval(pollStopRequest, STOP_POLL_INTERVAL_MS);
  stopRequestPoller.unref();
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  builder.once('exit', (code, signal) => {
    if (!stopping) {
      if (code !== 0) fail('builder', `failed:${code ?? signal}`);
      else fail('builder', 'exited');
    }
  });
  reviewer.once('exit', (code, signal) => {
    if (!stopping) {
      if (code !== 0) fail('reviewer', `failed:${code ?? signal}`);
      else fail('reviewer', 'exited');
    }
  });

  process.stdout.write([
    `local-run-root:${runRoot}`,
    `local-registry:${origin}`,
    `local-builder:${builderOrigin}`,
    `local-reviewer:${reviewerOrigin}`,
    `credentials:${credentialsPath}`,
    `owner-credentials:${credentialsPath}`,
    `worker-control:${workerControlPath}`,
    `stop-request:${stopRequestPath}`,
    `control:${controlPath}`,
    `fixture:${fixturePath}`,
    `logs:${logRoot}`,
    `runner-pid:${process.pid}`,
    `reviewer-mode:${options.reviewerMode}`,
  ].join('\n') + '\n');
}

function readMetadata(runRoot) {
  const metadataPath = path.join(runRoot, 'work', 'launch-metadata.json');
  if (!existsSync(metadataPath)) throw new Error(`launch metadata is missing at ${metadataPath}`);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (metadata?.paths?.credentials === undefined || metadata?.origins?.origin === undefined) throw new Error('launch metadata is invalid');
  return { metadata, metadataPath };
}

function readPrivateJson(filePath) {
  const value = JSON.parse(readFileSync(filePath, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`private JSON object expected at ${filePath}`);
  return value;
}

function assertLoopbackOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new Error('fixture origin is not a plain loopback URL');
  }
  return url;
}

function authFromCredentials(credentialsPath) {
  const credentials = readPrivateJson(credentialsPath);
  if (typeof credentials.origin !== 'string' || typeof credentials.token !== 'string' || credentials.token.length === 0) throw new Error('local browser credentials are invalid');
  assertLoopbackOrigin(credentials.origin);
  return { origin: credentials.origin, headers: { authorization: `Bearer ${credentials.token}` } };
}

async function requestJson(base, requestPath, init = {}) {
  const response = await fetch(new URL(requestPath, `${base.replace(/\/$/u, '')}/`), {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(8_000),
  });
  const value = await response.json().catch(() => ({}));
  return { response, value };
}

async function waitForRegistry(auth) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const result = await requestJson(auth.origin, '/v1/policy', { headers: auth.headers });
      if (result.response.ok && result.value?.policy) return result.value.policy;
    } catch {
      // Build or Nitro may still be starting. The wait is bounded to 30 seconds.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('local Nitro registry did not become ready within 30 seconds');
}

function encodeText(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function makeTextFile(filePath, text) {
  return { path: filePath, content: encodeText(text) };
}

function sha256Text(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function lineCount(text) {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function maxLineBytes(text) {
  return Math.max(...text.split('\n').map((line) => Buffer.byteLength(line, 'utf8')));
}

function pathDepth(filePath) {
  return filePath.split('/').length;
}

function compareFilePaths(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function largeTreePath(index, extension) {
  const cohort = String(Math.floor(index / 16)).padStart(2, '0');
  const lane = String(index % 16).padStart(2, '0');
  const record = String(index).padStart(3, '0');
  return `fixtures/large-tree/archives/2026/region-local/cohort-${cohort}/lane-${lane}/record-${record}.${extension}`;
}

function largeTreeTypeScript() {
  const longLine = `export const browserSelectionProof = "${'safe-browser-proof-'.repeat(18)}end";`;
  const scrollLines = Array.from({ length: 64 }, (_, index) => (
    `export const browserScrollLine${String(index + 1).padStart(2, '0')} = "inert fixture line ${String(index + 1).padStart(2, '0')}";`
  ));
  return [
    '// Inert local fixture text; this file is never imported or executed.',
    'export const fixtureProfile = "large-tree";',
    longLine,
    ...scrollLines,
    '',
  ].join('\n');
}

function largeTreeJson() {
  const longLineValue = `${'safe-json-browser-proof-'.repeat(18)}end`;
  return `${JSON.stringify({
    fixtureProfile: 'large-tree',
    purpose: 'selection-highlight-scroll-proof',
    longLineValue,
    rows: Array.from({ length: 64 }, (_, index) => ({
      id: index + 1,
      pathMarker: `nested-record-${String(index + 1).padStart(3, '0')}`,
      inert: true,
    })),
  }, null, 2)}\n`;
}

function metadataForTextFile(file) {
  const bytes = Buffer.from(file.content, 'base64');
  const text = bytes.toString('utf8');
  return {
    path: file.path,
    digest: sha256Text(text),
    bytes: bytes.byteLength,
    lineCount: lineCount(text),
    maxLineBytes: maxLineBytes(text),
    pathDepth: pathDepth(file.path),
    extension: path.extname(file.path).slice(1) || null,
  };
}

function createLargeTreeManifest(files, proofPaths) {
  const fileMetadata = files.map(metadataForTextFile);
  const nested = fileMetadata.filter((file) => file.path.includes('/'));
  const longLineFiles = fileMetadata.filter((file) => file.maxLineBytes >= 160);
  const distantPaths = [nested[0], nested[Math.floor(nested.length / 2)], nested[nested.length - 1]]
    .filter(Boolean)
    .map((file, index) => ({
      ...file,
      role: ['first-deep-path', 'middle-deep-path', 'last-deep-path'][index],
    }));
  const sortedPaths = fileMetadata.map((file) => file.path).every((filePath, index, paths) => index === 0 || paths[index - 1] < filePath);
  return {
    schemaVersion: 1,
    profile: LARGE_TREE_SEED_PROFILE,
    generator: 'local-m6-large-tree-v1',
    canonicalOrder: sortedPaths ? 'path-ascending' : 'invalid',
    fileCount: fileMetadata.length,
    nestedPathCount: nested.length,
    maxPathDepth: Math.max(...fileMetadata.map((file) => file.pathDepth)),
    totalBytes: fileMetadata.reduce((sum, file) => sum + file.bytes, 0),
    files: fileMetadata,
    distantPaths,
    longLineFiles,
    browserProof: {
      selectionPath: proofPaths.typeScript,
      highlightPath: proofPaths.json,
      scrollPath: proofPaths.scroll,
      expected: {
        selection: 'select a long TypeScript line and retain its path while the tree is scrolled',
        highlighting: 'load the TypeScript and JSON proof paths to inspect syntax highlighting',
        scroll: 'scroll the nested tree to the distant final path and return to the selected file',
      },
    },
    safety: {
      executableFiles: 0,
      pluginBoundaryFiles: 0,
      hooks: false,
      contentExecution: 'none',
    },
  };
}

function createSeedDefinition(profile) {
  const skillText = [
    '---',
    `name: ${profile === LARGE_TREE_SEED_PROFILE ? 'm6-local-large-tree' : 'm6-local-combined'}`,
    `description: Deterministic local ${profile === LARGE_TREE_SEED_PROFILE ? 'large-tree browser' : 'combined'} M6 fixture`,
    '---',
    '',
    profile === LARGE_TREE_SEED_PROFILE ? '# Local large-tree M6 fixture' : '# Local combined M6 fixture',
    '',
    'This is inert local test data.',
    '',
  ].join('\n');
  const readmeText = profile === LARGE_TREE_SEED_PROFILE
    ? '# Local large-tree M6 fixture\n\nThe nested files are inert text for browser tree and editor checks.\n'
    : '# Local combined M6 fixture\n';
  if (profile === DEFAULT_SEED_PROFILE) {
    return {
      profile,
      name: '@local/m6-local-combined-fixture',
      skillText,
      readmeText,
      files: [
        makeTextFile('SKILL.md', skillText),
        makeTextFile('README.md', readmeText),
      ],
    };
  }

  const typeScriptPath = largeTreePath(0, 'ts');
  const jsonPath = largeTreePath(1, 'json');
  const nestedFiles = Array.from({ length: LARGE_TREE_NESTED_FILE_COUNT }, (_, index) => {
    const extension = index === 0 ? 'ts' : index === 1 ? 'json' : 'txt';
    const filePath = largeTreePath(index, extension);
    const text = index === 0
      ? largeTreeTypeScript()
      : index === 1
        ? largeTreeJson()
        : [
          `# Inert nested fixture file ${String(index).padStart(3, '0')}`,
          `path: ${filePath}`,
          'This text is data only; it is never executed.',
          '',
        ].join('\n');
    return makeTextFile(filePath, text);
  });
  const files = [makeTextFile('SKILL.md', skillText), makeTextFile('README.md', readmeText), ...nestedFiles]
    .sort(compareFilePaths);
  return {
    profile,
    name: '@local/m6-large-tree-fixture',
    skillText,
    readmeText,
    files,
    manifest: createLargeTreeManifest(files, {
      typeScript: typeScriptPath,
      json: jsonPath,
      scroll: largeTreePath(LARGE_TREE_NESTED_FILE_COUNT - 1, 'txt'),
    }),
  };
}

function assertSeedDefinition(definition) {
  if (definition.profile === LARGE_TREE_SEED_PROFILE) {
    const paths = definition.files.map((file) => file.path);
    if (paths.length !== LARGE_TREE_NESTED_FILE_COUNT + 2 || paths.filter((filePath) => filePath.includes('/')).length !== LARGE_TREE_NESTED_FILE_COUNT || !paths.every((filePath, index) => index === 0 || paths[index - 1] < filePath)) {
      throw new Error('large-tree seed must contain 128 canonical paths including 126 nested paths');
    }
  }
  // The generated paths/content are deliberately well below the canonical
  // bundle limits; the real upload route remains the final validator.
  if (Buffer.byteLength(JSON.stringify({ name: definition.name, files: definition.files }), 'utf8') > MAX_SEED_REQUEST_BYTES) {
    throw new Error(`seed profile request exceeds the ${MAX_SEED_REQUEST_BYTES}-byte local request limit`);
  }
}

async function seed(runRoot, options = { profile: DEFAULT_SEED_PROFILE }) {
  const { metadata } = readMetadata(runRoot);
  const profile = options.profile ?? DEFAULT_SEED_PROFILE;
  const definition = createSeedDefinition(profile);
  assertSeedDefinition(definition);
  const auth = authFromCredentials(metadata.paths.credentials);
  const currentPolicy = await waitForRegistry(auth);
  if (!Array.isArray(currentPolicy.scanners) || !currentPolicy.scanners.some((scanner) => scanner?.id === 'skillsguard')) {
    throw new Error('local policy does not expose the required skillsguard scanner');
  }
  const desiredPolicy = {
    scanners: currentPolicy.scanners.map((scanner) => ({
      ...scanner,
      mode: scanner.id === 'skillsguard' ? 'required' : 'disabled',
    })),
    allowUnscanned: false,
    evidenceMaxAgeSeconds: currentPolicy.evidenceMaxAgeSeconds,
    hooks: currentPolicy.hooks ?? [],
  };
  const policyUpdate = await requestJson(auth.origin, '/v1/policy', {
    method: 'PUT',
    headers: { ...auth.headers, 'content-type': 'application/json', 'idempotency-key': `local-m6-policy-${randomUUID()}` },
    body: JSON.stringify(desiredPolicy),
  });
  if (!policyUpdate.response.ok || !policyUpdate.value?.policy) throw new Error(`local policy update failed with HTTP ${policyUpdate.response.status}`);
  const policy = policyUpdate.value.policy;

  const draftResponse = await requestJson(auth.origin, '/v1/drafts', {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json', 'idempotency-key': `local-m6-draft-${randomUUID()}` },
    body: JSON.stringify({
      name: definition.name,
      files: definition.files,
    }),
  });
  if (![200, 201].includes(draftResponse.response.status) || !draftResponse.value?.draft) {
    throw new Error(`local draft creation failed with HTTP ${draftResponse.response.status}`);
  }
  const draft = draftResponse.value.draft;
  const fixture = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    origin: auth.origin,
    builderOrigin: metadata.origins.builderOrigin,
    reviewerOrigin: metadata.origins.reviewerOrigin,
    draftRoute: `/app/publish?draft=${encodeURIComponent(draft.id)}`,
    draft: {
      id: draft.id,
      name: draft.name,
      revision: draft.revision,
      digest: draft.digest,
      fileCount: Array.isArray(draft.files) ? draft.files.length : definition.files.length,
      expectedTextBytes: definition.manifest?.totalBytes ?? (Buffer.byteLength(definition.skillText) + Buffer.byteLength(definition.readmeText)),
      skillTextBytes: Buffer.byteLength(definition.skillText),
      skillTextDigest: sha256Text(definition.skillText),
    },
    policy: {
      revision: policy.revision,
      requiredScanners: policy.scanners.filter((scanner) => scanner.mode === 'required').map((scanner) => scanner.id),
      allowUnscanned: policy.allowUnscanned,
    },
    review: {
      mode: metadata.reviewer.mode,
      deterministicFinding: 'one bounded info finding for the first text file',
    },
    ...(definition.manifest === undefined ? {} : { manifest: definition.manifest }),
    limitation: 'The builder and upload reviewer are deterministic local HTTP boundaries; no hosted Eve or Gateway call was made.',
  };
  writePrivate(metadata.paths.fixture, fixture);
  process.stdout.write(JSON.stringify({
    event: 'local_m6_fixture_seeded',
    origin: fixture.origin,
    builderOrigin: fixture.builderOrigin,
    reviewerOrigin: fixture.reviewerOrigin,
    draftRoute: fixture.draftRoute,
    draft: { id: draft.id, revision: draft.revision, digest: draft.digest, fileCount: fixture.draft.fileCount },
    ...(fixture.manifest === undefined ? {} : {
      profile: fixture.manifest.profile,
      nestedPathCount: fixture.manifest.nestedPathCount,
      longLinePathCount: fixture.manifest.longLineFiles.length,
    }),
    policy: fixture.policy,
    reviewerMode: fixture.review.mode,
    fixturePath: metadata.paths.fixture,
  }) + '\n');
}

function requireFixture(metadata) {
  if (!existsSync(metadata.paths.fixture)) throw new Error(`seed has not created ${metadata.paths.fixture}`);
  const fixture = readPrivateJson(metadata.paths.fixture);
  if (typeof fixture?.draft?.id !== 'string' || typeof fixture?.draft?.revision !== 'number' || typeof fixture?.draft?.digest !== 'string') throw new Error('fixture metadata is invalid');
  return fixture;
}

function sanitizeDraft(draft) {
  return draft && typeof draft === 'object' ? {
    id: typeof draft.id === 'string' ? draft.id : undefined,
    name: typeof draft.name === 'string' ? draft.name : undefined,
    revision: Number.isSafeInteger(draft.revision) ? draft.revision : undefined,
    digest: typeof draft.digest === 'string' ? draft.digest : undefined,
    fileCount: Array.isArray(draft.files) ? draft.files.length : undefined,
  } : {};
}

function sanitizeReview(review) {
  return {
    id: review?.id,
    state: review?.state,
    revision: review?.binding?.draftRevision,
    digest: review?.binding?.contentDigest,
    model: review?.model,
    reviewerRevision: review?.reviewerRevision,
    resultId: review?.resultId,
  };
}

function sanitizeResult(result) {
  return {
    id: result?.id,
    jobId: result?.jobId,
    state: result?.state,
    revision: result?.binding?.draftRevision,
    digest: result?.binding?.contentDigest,
    findingCount: Array.isArray(result?.findings) ? result.findings.length : 0,
  };
}

async function collectStatus(metadata, fixture) {
  const auth = authFromCredentials(metadata.paths.credentials);
  const encoded = encodeURIComponent(fixture.draft.id);
  const draftResult = await requestJson(auth.origin, `/v1/drafts/${encoded}`, { headers: auth.headers });
  if (!draftResult.response.ok) throw new Error(`draft GET failed with HTTP ${draftResult.response.status}`);
  const currentDraft = draftResult.value?.draft ?? draftResult.value;
  if (!currentDraft || !Number.isSafeInteger(currentDraft.revision) || typeof currentDraft.digest !== 'string') {
    throw new Error('draft GET returned no usable revision and digest');
  }
  const [reviewsResult, proposalsResult, reviewerResult] = await Promise.all([
    requestJson(auth.origin, `/v1/drafts/${encoded}/reviews`, { headers: auth.headers }),
    requestJson(auth.origin, `/v1/drafts/${encoded}/proposals?revision=${currentDraft.revision}&digest=${encodeURIComponent(currentDraft.digest)}`, { headers: auth.headers }),
    requestJson(metadata.origins.reviewerOrigin, '/control/status', { headers: { authorization: `Bearer ${readPrivateJson(metadata.paths.control).reviewerControlToken}` } }),
  ]);
  if (!reviewsResult.response.ok) throw new Error(`reviews GET failed with HTTP ${reviewsResult.response.status}`);
  if (!proposalsResult.response.ok) throw new Error(`proposals GET failed with HTTP ${proposalsResult.response.status}`);
  if (!reviewerResult.response.ok) throw new Error(`reviewer status failed with HTTP ${reviewerResult.response.status}`);
  const reviewsBody = reviewsResult.value ?? {};
  return {
    observedAt: new Date().toISOString(),
    origin: auth.origin,
    builderOrigin: metadata.origins.builderOrigin,
    reviewerOrigin: metadata.origins.reviewerOrigin,
    draft: sanitizeDraft(draftResult.value?.draft ?? draftResult.value),
    proposals: Array.isArray(proposalsResult.value?.proposals) ? proposalsResult.value.proposals.map((proposal) => ({
      id: proposal?.id,
      state: proposal?.state,
      sessionId: proposal?.sessionId,
      operationCount: Array.isArray(proposal?.operations) ? proposal.operations.length : undefined,
    })) : [],
    reviews: Array.isArray(reviewsBody.reviews) ? reviewsBody.reviews.map(sanitizeReview) : [],
    results: Array.isArray(reviewsBody.results) ? reviewsBody.results.map(sanitizeResult) : [],
    reviewerSessions: Array.isArray(reviewerResult.value?.sessions) ? reviewerResult.value.sessions.map((session) => ({
      sessionId: session?.sessionId,
      jobId: session?.jobId,
      status: session?.status,
      findingCount: session?.findingCount,
    })) : [],
  };
}

async function writeStatus(runRoot, commandName) {
  const { metadata } = readMetadata(runRoot);
  const fixture = requireFixture(metadata);
  const output = await collectStatus(metadata, fixture);
  output.command = commandName;
  const evidencePath = path.join(runRoot, 'work', `status-${Date.now()}.json`);
  writePrivate(evidencePath, output);
  process.stdout.write(JSON.stringify({ ...output, evidencePath }) + '\n');
}

async function status(runRoot) {
  await writeStatus(runRoot, 'status');
}

async function advance(runRoot, sessionId) {
  const { metadata } = readMetadata(runRoot);
  const control = readPrivateJson(metadata.paths.control);
  const body = sessionId === undefined ? {} : { sessionId };
  const result = await requestJson(control.reviewerOrigin, '/control/advance', {
    method: 'POST',
    headers: { authorization: `Bearer ${control.reviewerControlToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!result.response.ok) throw new Error(`reviewer advance failed with HTTP ${result.response.status}`);
  await writeStatus(runRoot, 'advance');
}

async function prepareScan(runRoot, expectedJobId, expectedArtifactDigest) {
  const { metadata } = readMetadata(runRoot);
  const workerControlPath = metadata.paths.workerControl;
  const ownerCredentialsPath = metadata.paths.ownerCredentials ?? metadata.paths.credentials;
  if (typeof workerControlPath !== 'string' || typeof ownerCredentialsPath !== 'string') {
    throw new Error('launch metadata does not contain local worker and owner credential paths');
  }
  assertPathWithinRunRoot(workerControlPath, runRoot, 'worker control path');
  assertPathWithinRunRoot(ownerCredentialsPath, runRoot, 'owner credential path');
  const worker = readPrivateJson(workerControlPath);
  const owner = readPrivateJson(ownerCredentialsPath);
  const origin = requireLocalWorkerOrigin(worker.origin ?? metadata.origins?.origin);
  const metadataOrigin = requireLocalWorkerOrigin(metadata.origins?.origin);
  if (metadataOrigin !== origin) throw new Error('worker control and launch metadata target different local origins');
  const ownerOrigin = requireLocalWorkerOrigin(owner.origin);
  if (ownerOrigin !== origin) throw new Error('worker and owner credentials target different local origins');
  const workerToken = requireLocalToken(worker.workerToken, 'worker token');
  const precheckToken = requireLocalToken(owner.token, 'owner precheck token');
  const workerId = requireLocalWorkerId(worker.workerId);
  const jobId = requireExpectedJobId(expectedJobId);
  const artifactDigest = requireExpectedDigest(expectedArtifactDigest);
  const evidencePath = path.join(runRoot, 'work', `local-authoring-scan-evidence-${Date.now()}.json`);
  const controlPath = path.join(runRoot, 'work', `local-authoring-scan-control-${Date.now()}.json`);
  writePrivate(controlPath, {
    schemaVersion: 1,
    mode: 'local-authoring-worker-runner',
    origin,
    repoRoot: REPO_ROOT,
    workerToken,
    workerId,
    precheckToken,
    expectedJobId: jobId,
    expectedKind: 'scan',
    expectedArtifactDigest: artifactDigest,
    skillsguardImageId: LOCAL_SKILLSGUARD_IMAGE_ID,
    evidencePath,
    timeoutMs: 180_000,
  });
  process.stdout.write(JSON.stringify({
    event: 'local_m6_scan_control_prepared',
    controlPath,
    evidencePath,
    origin,
    workerId,
    expectedJobId: jobId,
    expectedKind: 'scan',
    expectedArtifactDigest: artifactDigest,
    skillsguardImageId: LOCAL_SKILLSGUARD_IMAGE_ID,
  }) + '\n');
}

function assertPathWithinRunRoot(filePath, runRoot, label) {
  const resolvedRoot = path.resolve(runRoot);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`${label} is outside the disposable run root`);
}

function requireLocalWorkerOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value)) throw new Error('local worker origin must be an exact loopback HTTP origin');
  const parsed = new URL(value);
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || parsed.origin !== value || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('local worker origin must be an exact loopback HTTP origin');
  }
  return parsed.origin;
}

function requireLocalToken(value, label) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireLocalWorkerId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('worker id is invalid');
  return value;
}

function requireExpectedJobId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('expected job id is invalid');
  return value;
}

function requireExpectedDigest(value) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error('expected artifact digest must be sha256:<64 lowercase hex>');
  return value;
}

async function stop(runRoot) {
  const { metadata } = readMetadata(runRoot);
  const expectedPath = path.join(runRoot, 'work', 'stop-request.json');
  if (metadata.stopProtocolVersion !== STOP_PROTOCOL_VERSION || metadata.stopRequestPath !== expectedPath || metadata?.paths?.stopRequest !== expectedPath) {
    throw new Error('fixture launcher uses an unsupported stop protocol; refusing persisted PID termination');
  }
  writeStopRequest(expectedPath);
  process.stdout.write(JSON.stringify({ event: 'local_m6_fixture_stop_requested', runRoot, protocolVersion: STOP_PROTOCOL_VERSION, requestPath: expectedPath }) + '\n');
}
