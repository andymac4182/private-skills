import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const DEFAULT_VERSION = '0.4.0';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const ARCHIVES = new Map([
  ['pskills-x86_64-unknown-linux-gnu.tar.gz', { format: 'tar', member: 'pskills' }],
  ['pskills-aarch64-apple-darwin.tar.gz', { format: 'tar', member: 'pskills' }],
  ['pskills-x86_64-pc-windows-msvc.zip', { format: 'zip', member: 'pskills.exe' }],
]);

const expectedFiles = new Set([...ARCHIVES.keys(), 'SHA256SUMS']);

function usage() {
  return [
    'Usage: node scripts/verify-cli-release.mjs [options]',
    '',
    'Options:',
    '  --version=X.Y.Z       Release version (default: 0.4.0)',
    '  --artifact-dir=DIR    Directory containing all release archives',
    '  --binary=PATH         Smoke one extracted binary for its CLI contract',
    '  --target=TARGET       Target triple for the binary smoke (optional)',
    '  --help                Show this help',
  ].join('\n');
}

function parseArguments(args) {
  let version = DEFAULT_VERSION;
  let versionSeen = false;
  let artifactDirectory;
  let binary;
  let target;

  for (const arg of args) {
    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg.startsWith('--version=')) {
      if (versionSeen) throw new Error('Only one --version option may be supplied');
      versionSeen = true;
      version = arg.slice('--version='.length);
      continue;
    }
    if (arg.startsWith('--artifact-dir=')) {
      if (artifactDirectory !== undefined) throw new Error('Only one --artifact-dir option may be supplied');
      artifactDirectory = arg.slice('--artifact-dir='.length);
      continue;
    }
    if (arg.startsWith('--binary=')) {
      if (binary !== undefined) throw new Error('Only one --binary option may be supplied');
      binary = arg.slice('--binary='.length);
      continue;
    }
    if (arg.startsWith('--target=')) {
      if (target !== undefined) throw new Error('Only one --target option may be supplied');
      target = arg.slice('--target='.length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!VERSION_PATTERN.test(version) || version.length > 64) {
    throw new Error('--version must be a semantic release version such as 0.3.0');
  }
  if (artifactDirectory === undefined && binary === undefined) {
    throw new Error('pass --artifact-dir, --binary, or both');
  }
  if (binary !== undefined && binary.trim() === '') throw new Error('--binary must not be empty');
  if (target !== undefined && target.trim() === '') throw new Error('--target must not be empty');

  return {
    version,
    artifactDirectory: artifactDirectory === undefined ? undefined : resolve(artifactDirectory),
    binary: binary === undefined ? undefined : resolve(binary),
    target,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`${command} could not be started (${result.error.code ?? 'spawn error'})`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new Error(`${command} failed (exit ${result.status ?? 'unknown'})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function lines(output) {
  let normalized = output.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (normalized.endsWith('\n')) normalized = normalized.slice(0, -1);
  return normalized === '' ? [] : normalized.split('\n');
}

function assertRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertHelpMarkers(output, markers, label) {
  for (const marker of markers) {
    if (!output.includes(marker)) throw new Error(`${label} is missing ${marker}`);
  }
}

function assertSafeMemberName(name, expectedMember) {
  const normalized = name.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const absolute =
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[A-Za-z]:\//u.test(normalized);
  if (
    name.length === 0 ||
    name.includes('\0') ||
    absolute ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('release archive contains an unsafe member path');
  }
  if (name !== expectedMember) throw new Error('release archive contains an unexpected member');
}

function assertSingleTarMember(path, expectedMember) {
  const memberList = lines(run('tar', ['-tzf', path]));
  if (memberList.length !== 1) throw new Error('tar release archive must contain exactly one member');
  assertSafeMemberName(memberList[0], expectedMember);

  const detailRows = lines(run('tar', ['-tvzf', path]));
  if (detailRows.length !== 1 || !/^-[^\s]+\s/u.test(detailRows[0])) {
    throw new Error('tar release member must be a regular file');
  }
}

function assertSingleZipMember(path, expectedMember) {
  const command = process.platform === 'win32' ? 'tar' : 'unzip';
  const memberList = command === 'tar'
    ? lines(run(command, ['-tf', path]))
    : lines(run(command, ['-Z1', path]));
  if (memberList.length !== 1) throw new Error('zip release archive must contain exactly one member');
  assertSafeMemberName(memberList[0], expectedMember);

  // The name-only listing cannot distinguish a regular file from a symlink or
  // special entry. Check the archive's type marker before accepting it.
  const detailRows = command === 'tar'
    ? lines(run(command, ['-tvf', path])).filter((line) => line.trimEnd().endsWith(expectedMember))
    : lines(run(command, ['-Z', '-l', path])).filter((line) => line.trimEnd().endsWith(expectedMember));
  if (detailRows.length !== 1 || !detailRows[0].trimStart().startsWith('-')) {
    throw new Error('zip release member must be a regular file');
  }
}

function verifyDownloadedFiles(artifactDirectory) {
  const actual = readdirSync(artifactDirectory);
  if (
    actual.length !== expectedFiles.size ||
    actual.some((name) => !expectedFiles.has(name))
  ) {
    throw new Error('release directory contains unexpected files');
  }
  for (const name of expectedFiles) assertRegularFile(join(artifactDirectory, name), name);
}

function verifyChecksums(artifactDirectory) {
  const checksumLines = lines(readFileSync(join(artifactDirectory, 'SHA256SUMS'), 'utf8'));
  if (checksumLines.length !== ARCHIVES.size) {
    throw new Error('SHA256SUMS does not list exactly the expected release archives');
  }

  const entries = new Map();
  for (const checksumLine of checksumLines) {
    const match = /^([a-f0-9]{64}) {2}([^\s]+)$/u.exec(checksumLine);
    if (!match) throw new Error('SHA256SUMS contains an invalid entry');
    const [, digest, name] = match;
    if (!ARCHIVES.has(name) || entries.has(name)) {
      throw new Error('SHA256SUMS contains an unexpected or duplicate archive');
    }
    entries.set(name, digest);
  }

  for (const [name, expectedDigest] of entries) {
    const actualDigest = sha256(join(artifactDirectory, name));
    if (actualDigest !== expectedDigest) {
      throw new Error(`checksum verification failed for ${name}`);
    }
  }
}

function verifyArchiveMembers(artifactDirectory) {
  for (const [name, archive] of ARCHIVES) {
    const path = join(artifactDirectory, name);
    if (archive.format === 'tar') assertSingleTarMember(path, archive.member);
    else assertSingleZipMember(path, archive.member);
  }
}

function verifyBinary(binaryPath, version, target) {
  assertRegularFile(binaryPath, `binary ${basename(binaryPath)}`);
  if (target !== undefined) {
    const expectedName = target.includes('windows') ? 'pskills.exe' : 'pskills';
    if (basename(binaryPath) !== expectedName) {
      throw new Error(`binary name does not match target ${target}: expected ${expectedName}`);
    }
  }
  if (process.platform !== 'win32' && (lstatSync(binaryPath).mode & 0o111) === 0) {
    throw new Error('extracted Unix binary is not executable');
  }
  const actualVersion = run(binaryPath, ['--version']).trim();
  if (actualVersion !== `pskills ${version}`) {
    throw new Error(`binary version mismatch: expected pskills ${version}, received ${actualVersion}`);
  }

  const help = run(binaryPath, ['--help']);
  assertHelpMarkers(help, ['--feed', '--directory', '--agent', 'directory', 'sources'], 'binary help');

  const directoryHelp = run(binaryPath, ['directory', '--help']);
  assertHelpMarkers(directoryHelp, ['search'], 'directory help');

  const sourcesHelp = run(binaryPath, ['sources', '--help']);
  assertHelpMarkers(sourcesHelp, ['list', 'search'], 'sources help');

  // `source` is the supported short alias. Smoke it separately so a command
  // that only appears in top-level help cannot pass release verification while
  // the alias is broken.
  const sourceAliasHelp = run(binaryPath, ['source', '--help']);
  assertHelpMarkers(sourceAliasHelp, ['list', 'search'], 'source alias help');

  const sourcesSearchHelp = run(binaryPath, ['sources', 'search', '--help']);
  assertHelpMarkers(sourcesSearchHelp, ['--source', '--limit'], 'sources search help');

  const installHelp = run(binaryPath, ['install', '--help']);
  assertHelpMarkers(installHelp, ['--source'], 'install help');

  const updateHelp = run(binaryPath, ['update', '--help']);
  assertHelpMarkers(updateHelp, ['--source'], 'update help');

  const isolatedDirectory = mkdtempSync(join(tmpdir(), 'pskills-release-smoke-'));
  const isolatedList = run(binaryPath, [
    '--feed',
    'release-smoke',
    '--directory',
    isolatedDirectory,
    '--agent',
    'universal',
    '--json',
    'list',
  ]);
  let parsed;
  try {
    parsed = JSON.parse(isolatedList);
  } catch {
    throw new Error('isolated-directory smoke did not return JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 0) {
    throw new Error('isolated-directory smoke did not return an empty skill list');
  }

  const targetNote = target === undefined ? '' : ` target=${target}`;
  console.log(`CLI smoke passed for ${basename(binaryPath)}${targetNote}`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.artifactDirectory !== undefined) {
    verifyDownloadedFiles(options.artifactDirectory);
    verifyChecksums(options.artifactDirectory);
    verifyArchiveMembers(options.artifactDirectory);
    console.log(`Release archive verification passed for v${options.version}`);
  }
  if (options.binary !== undefined) verifyBinary(options.binary, options.version, options.target);
}

main();
