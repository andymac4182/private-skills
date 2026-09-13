import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_LAUNCHER = join(REPO_ROOT, 'scripts', 'local-m6-fixture.mjs');
const VITE_ENTRY = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

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
