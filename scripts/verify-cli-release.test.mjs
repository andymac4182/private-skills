import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERIFIER = join(REPO_ROOT, 'scripts', 'verify-cli-release.mjs');

test('release verifier accepts the source discovery and install CLI contract', async (t) => {
  // A shebang fixture is executable on the Unix release runners. The actual
  // Windows release job exercises the verifier against a PE binary; a text
  // fixture cannot be launched by CreateProcess there.
  if (process.platform === 'win32') {
    t.skip('text fixture cannot stand in for a Windows PE executable');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'pskills-cli-release-verifier-'));
  try {
    const binary = join(root, 'pskills');
    await writeFixture(binary, { complete: true });
    const result = runVerifier(binary);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CLI smoke passed for pskills target=aarch64-apple-darwin/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release verifier rejects a source subcommand with an incomplete help contract', async (t) => {
  if (process.platform === 'win32') {
    t.skip('text fixture cannot stand in for a Windows PE executable');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'pskills-cli-release-verifier-'));
  try {
    const binary = join(root, 'pskills');
    await writeFixture(binary, { complete: false });
    const result = runVerifier(binary);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sources help is missing search/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runVerifier(binary) {
  return spawnSync(process.execPath, [
    VERIFIER,
    '--version=0.4.0',
    `--binary=${binary}`,
    '--target=aarch64-apple-darwin',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function writeFixture(path, { complete }) {
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.join(' ');
if (args[0] === '--version') {
  console.log('pskills 0.4.0');
} else if (args[0] === '--help') {
  console.log('--feed --directory --agent directory sources');
} else if (args[0] === 'directory' && args.includes('--help')) {
  console.log('directory search');
} else if (args[0] === 'sources' && args.length === 2 && args[1] === '--help') {
  console.log('list ${complete ? 'search' : ''}');
} else if (args[0] === 'source' && args.length === 2 && args[1] === '--help') {
  console.log('list search');
} else if (args[0] === 'sources' && args[1] === 'search' && args.includes('--help')) {
  console.log('--source --limit');
} else if (args[0] === 'install' && args.includes('--help')) {
  console.log('--source');
} else if (args[0] === 'update' && args.includes('--help')) {
  console.log('--source');
} else if (command.includes('list')) {
  console.log('[]');
} else {
  process.exitCode = 2;
}
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}
