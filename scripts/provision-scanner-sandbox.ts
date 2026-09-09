import { Sandbox, type CommandFinished, type NetworkPolicy } from '@vercel/sandbox';
import metadata from '../workers/images/scanner-metadata.json' with { type: 'json' };

/**
 * Provisioning is deliberately opt-in. The default invocation only validates
 * the pinned source and prints the mapping that infra CI should persist; it
 * never creates a remote sandbox or snapshot.
 *
 * The snapshot contains only a trusted SkillsGuard source build. Uploaded
 * skills, tenant files, credentials, and package lifecycle hooks are never
 * supplied to the bootstrap VM.
 *
 * Trusted scanner snapshots are nonexpiring by default. Set
 * PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS to a positive integer when an environment
 * requires scheduled rotation. Rotate after a source or build change, and
 * remove superseded snapshots only through an explicit operator action.
 */

const scanner = metadata.scanners.skillsguard;
const SOURCE_URL = scanner.source;
const SOURCE_REF = scanner.sourceRef;
const SOURCE_REVISION = scanner.sourceRevision;
const SOURCE_KIND = scanner.sourceKind;
const VERSION = scanner.version;
const RUNTIME = 'node24';
const EXECUTABLE = '/usr/local/bin/skillsguard';
const INSTALL_DIR = '/opt/private-skills/skillsguard';
const ARTIFACT_MANIFEST = '/usr/local/share/private-skills/skillsguard-artifact-manifest.sha256';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NAME = `private-skills-skillsguard-${SOURCE_REVISION.slice(0, 12)}-${Date.now().toString(36)}`;

const BOOTSTRAP_NETWORK_POLICY: NetworkPolicy = {
  // GitHub is used only to fetch the exact source commit. npm's lockfile
  // resolves solely from the public npm registry. No wildcard or proxy rule
  // is needed for this source tree.
  allow: ['github.com', 'registry.npmjs.org'],
};

const RUNTIME_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  NPM_CONFIG_CACHE: '/tmp/private-skills-sandbox-npm-cache',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_GLOBALCONFIG: '/dev/null',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  NPM_CONFIG_USERCONFIG: '/tmp/private-skills-sandbox-npmrc',
  XDG_CONFIG_HOME: '/tmp/private-skills-sandbox-xdg',
};

export interface ScannerSandboxSnapshotMapping {
  schemaVersion: 1;
  kind: 'private-skills-scanner-sandbox-snapshot';
  scannerId: 'skillsguard';
  scannerVersion: string;
  source: {
    kind: 'source-build';
    repository: string;
    ref: string;
    revision: string;
  };
  artifactDigest: string;
  executorReference: string;
  runtime: {
    id: 'node24';
    executable: '/usr/local/bin/skillsguard';
    networkPolicy: 'deny-all';
  };
  snapshot: {
    id: string;
    status: string;
    sourceSessionId: string;
    createdAt: string;
    expiresAt: string | null;
    expirationDays: number;
  };
  sandbox: {
    name: string;
    region: string;
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateMetadata(): void {
  if (SOURCE_KIND !== 'source-build') {
    throw new Error(`SkillsGuard metadata must be a source build, got ${String(SOURCE_KIND)}`);
  }
  if (SOURCE_REF !== 'main') {
    throw new Error(`SkillsGuard source ref must be main, got ${String(SOURCE_REF)}`);
  }
  if (!/^https:\/\/github\.com\/Teycir\/SkillsGuard(?:\.git)?$/.test(SOURCE_URL)) {
    throw new Error(`unexpected SkillsGuard source URL: ${SOURCE_URL}`);
  }
  if (!/^[0-9a-f]{40}$/.test(SOURCE_REVISION)) {
    throw new Error(`SkillsGuard source revision is not a full SHA: ${SOURCE_REVISION}`);
  }
  if (VERSION !== '1.1.1') {
    throw new Error(`unexpected SkillsGuard package version: ${VERSION}`);
  }
}

function sandboxName(): string {
  const requested = process.env.PSKILLS_SCANNER_SANDBOX_NAME ?? DEFAULT_NAME;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(requested)) {
    throw new Error('PSKILLS_SCANNER_SANDBOX_NAME must be 1-63 alphanumeric, underscore, or hyphen characters');
  }
  return requested;
}

function snapshotTtlDays(): number {
  const raw = process.env.PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS ?? '0';
  if (!/^\d+$/.test(raw)) {
    throw new Error('PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS must be a non-negative integer (0 means no expiry)');
  }
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new Error('PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS is outside the safe integer range');
  }
  return days;
}

function bootstrapScript(): string {
  const repository = shellQuote(SOURCE_URL);
  const revision = shellQuote(SOURCE_REVISION);
  const provenance = JSON.stringify(
    {
      schemaVersion: 1,
      scannerId: 'skillsguard',
      packageVersion: VERSION,
      sourceKind: SOURCE_KIND,
      sourceRepository: SOURCE_URL,
      sourceRef: SOURCE_REF,
      sourceRevision: SOURCE_REVISION,
      runtime: RUNTIME,
      executable: EXECUTABLE,
      artifactDigest: '__ARTIFACT_DIGEST__',
      builtBy: 'scripts/provision-scanner-sandbox.ts',
    },
    null,
    2,
  );

  return `
set -eu
export GIT_CONFIG_GLOBAL=${shellQuote(RUNTIME_ENV.GIT_CONFIG_GLOBAL)}
export GIT_CONFIG_SYSTEM=${shellQuote(RUNTIME_ENV.GIT_CONFIG_SYSTEM)}
export GIT_TERMINAL_PROMPT=${shellQuote(RUNTIME_ENV.GIT_TERMINAL_PROMPT)}
export NPM_CONFIG_CACHE=${shellQuote(RUNTIME_ENV.NPM_CONFIG_CACHE)}
export NPM_CONFIG_FUND=${shellQuote(RUNTIME_ENV.NPM_CONFIG_FUND)}
export NPM_CONFIG_GLOBALCONFIG=${shellQuote(RUNTIME_ENV.NPM_CONFIG_GLOBALCONFIG)}
export NPM_CONFIG_UPDATE_NOTIFIER=${shellQuote(RUNTIME_ENV.NPM_CONFIG_UPDATE_NOTIFIER)}
export NPM_CONFIG_USERCONFIG=${shellQuote(RUNTIME_ENV.NPM_CONFIG_USERCONFIG)}
export XDG_CONFIG_HOME=${shellQuote(RUNTIME_ENV.XDG_CONFIG_HOME)}
mkdir -p "$NPM_CONFIG_CACHE" "$XDG_CONFIG_HOME"
: > "$NPM_CONFIG_USERCONFIG"
sudo rm -rf ${shellQuote(INSTALL_DIR)}
sudo mkdir -p ${shellQuote(INSTALL_DIR)}
sudo chown "$(id -u):$(id -g)" ${shellQuote(INSTALL_DIR)}

git init -q ${shellQuote(INSTALL_DIR)}
git -C ${shellQuote(INSTALL_DIR)} remote add origin ${repository}
git -C ${shellQuote(INSTALL_DIR)} -c protocol.version=2 fetch --quiet --depth=1 origin ${revision}
resolved="$(git -C ${shellQuote(INSTALL_DIR)} rev-parse FETCH_HEAD)"
test "$resolved" = ${revision}
git -C ${shellQuote(INSTALL_DIR)} checkout --quiet --detach ${revision}
test "$(git -C ${shellQuote(INSTALL_DIR)} rev-parse HEAD)" = ${revision}

cd ${shellQuote(INSTALL_DIR)}
npm ci --include=dev --ignore-scripts >&2
npm run build >&2
npm prune --omit=dev --ignore-scripts >&2

sudo mkdir -p /usr/local/bin /usr/local/share/private-skills
sudo chmod 0555 ${shellQuote(`${INSTALL_DIR}/dist/cli.js`)}
sudo ln -sfn ${shellQuote(`${INSTALL_DIR}/dist/cli.js`)} ${shellQuote(EXECUTABLE)}

# Hash the post-prune compiled runtime with stable relative paths and file
# modes. This identifies the actual snapshot artifact independently of Git.
artifact_manifest="/tmp/private-skills-sandbox-artifact-manifest.sha256"
(
  cd ${shellQuote(INSTALL_DIR)}
  find dist node_modules package.json -type f -print | LC_ALL=C sort |
    while IFS= read -r file; do
      printf '%s %s  %s\\n' "$(stat -c '%a' "$file")" "$(sha256sum "$file" | cut -d' ' -f1)" "$file"
    done
) > "$artifact_manifest"
artifact_digest="$(sha256sum "$artifact_manifest" | cut -d' ' -f1)"
provenance_json=${shellQuote(provenance)}
provenance_json="\${provenance_json/__ARTIFACT_DIGEST__/sha256:$artifact_digest}"
printf '%s\\n' "$provenance_json" > .provenance.json
sudo cp .provenance.json /usr/local/share/private-skills/skillsguard-provenance.json
sudo chmod 0444 /usr/local/share/private-skills/skillsguard-provenance.json
sudo cp "$artifact_manifest" ${shellQuote(ARTIFACT_MANIFEST)}
sudo chmod 0444 ${shellQuote(ARTIFACT_MANIFEST)}

# Leave only the compiled CLI and production dependency tree in the snapshot.
# This removes Git metadata, source, tests, lockfiles, and npm caches.
sudo find ${shellQuote(INSTALL_DIR)} -mindepth 1 -maxdepth 1 ! -name dist ! -name node_modules ! -name package.json -exec rm -rf -- {} +
rm -rf "$NPM_CONFIG_CACHE" "$XDG_CONFIG_HOME" "$artifact_manifest"
rm -f "$NPM_CONFIG_USERCONFIG"
test -x ${shellQuote(EXECUTABLE)}
${shellQuote(EXECUTABLE)} --help >/dev/null
printf 'private-skills-artifact-digest=sha256:%s\\n' "$artifact_digest"
`;
}

async function runChecked(
  sandbox: Sandbox,
  command: string,
  args: string[],
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandFinished> {
  const result = await sandbox.runCommand({ cmd: command, args, ...options });
  if (result.exitCode === 0) return result;
  const stderr = (await result.stderr()).trim().split(/\r?\n/).slice(-20).join('\n').slice(0, 4000);
  throw new Error(`${command} failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ''}`);
}

function dryRunMapping(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'private-skills-scanner-sandbox-snapshot',
    scannerId: 'skillsguard',
    scannerVersion: VERSION,
    source: {
      kind: SOURCE_KIND,
      repository: SOURCE_URL,
      ref: SOURCE_REF,
      revision: SOURCE_REVISION,
    },
    runtime: {
      id: RUNTIME,
      executable: EXECUTABLE,
      bootstrapNetworkPolicy: BOOTSTRAP_NETWORK_POLICY,
      snapshotNetworkPolicy: 'deny-all',
    },
    artifactDigest: null,
    executorReference: null,
    snapshot: {
      expirationDays: snapshotTtlDays(),
      provisioning: 'disabled; pass --provision to create a remote snapshot',
      expirationPolicy: '0 means no expiry; rotate on source/build change and remove old snapshots only by operator action',
    },
  };
}

async function provision(): Promise<ScannerSandboxSnapshotMapping> {
  const expirationDays = snapshotTtlDays();
  const expirationMs = expirationDays * DAY_MS;
  const sandbox = await Sandbox.create({
    name: sandboxName(),
    runtime: RUNTIME,
    resources: { vcpus: 1 },
    timeout: 20 * 60 * 1000,
    networkPolicy: BOOTSTRAP_NETWORK_POLICY,
    snapshotExpiration: expirationMs,
    tags: {
      scanner: 'skillsguard',
      sourceRevision: SOURCE_REVISION.slice(0, 12),
      purpose: 'private-skills-scanner',
    },
  });

  let snapshotCreated = false;
  try {
    const bootstrap = await runChecked(sandbox, 'sh', ['-ceu', bootstrapScript()], {
      env: RUNTIME_ENV,
      timeoutMs: 15 * 60 * 1000,
    });
    const artifactDigest = (await bootstrap.stdout())
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.startsWith('private-skills-artifact-digest='))
      .map((line) => line.slice('private-skills-artifact-digest='.length).trim())
      .pop() ?? '';
    if (!/^sha256:[0-9a-f]{64}$/.test(artifactDigest)) {
      throw new Error(`bootstrap returned an invalid artifact digest: ${artifactDigest}`);
    }

    await sandbox.update({ networkPolicy: 'deny-all' });
    if (sandbox.networkPolicy !== 'deny-all') {
      throw new Error('sandbox network policy did not become deny-all before snapshot');
    }
    await runChecked(sandbox, 'node', ['-e', 'process.stdout.write(process.version)'], {
      env: RUNTIME_ENV,
      timeoutMs: 30_000,
    });

    const snapshot = await sandbox.snapshot({ expiration: expirationMs });
    snapshotCreated = true;
    const expiresAt = snapshot.expiresAt?.toISOString() ?? null;
    if (expirationDays > 0 && !expiresAt) throw new Error('snapshot API returned no expiration time for a finite TTL');
    const executorReference = `snapshot:${snapshot.snapshotId}|revision:${SOURCE_REVISION}|artifact:${artifactDigest}`;
    return {
      schemaVersion: 1,
      kind: 'private-skills-scanner-sandbox-snapshot',
      scannerId: 'skillsguard',
      scannerVersion: VERSION,
      source: {
        kind: 'source-build',
        repository: SOURCE_URL,
        ref: SOURCE_REF,
        revision: SOURCE_REVISION,
      },
      artifactDigest,
      executorReference,
      runtime: {
        id: 'node24',
        executable: EXECUTABLE,
        networkPolicy: 'deny-all',
      },
      snapshot: {
        id: snapshot.snapshotId,
        status: snapshot.status,
        sourceSessionId: snapshot.sourceSessionId,
        createdAt: snapshot.createdAt.toISOString(),
        expiresAt,
        expirationDays,
      },
      sandbox: {
        name: sandbox.name,
        region: sandbox.region,
      },
    };
  } finally {
    if (!snapshotCreated) {
      await sandbox.stop().catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  validateMetadata();
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: pnpm exec tsx scripts/provision-scanner-sandbox.ts [--provision]');
    console.log('Default: validate and print the immutable SkillsGuard snapshot mapping without provisioning.');
    return;
  }
  if (args.size > 1 || (args.size === 1 && !args.has('--provision'))) {
    throw new Error('only --provision is accepted; omit it for a non-provisioning metadata check');
  }
  if (!args.has('--provision')) {
    console.log(JSON.stringify(dryRunMapping(), null, 2));
    return;
  }
  console.log(JSON.stringify(await provision(), null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`provision-scanner-sandbox: ${message}`);
  process.exitCode = 1;
});
