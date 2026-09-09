import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SandboxExecutor,
  resolveSandboxImage,
  type SandboxCommand,
  type SandboxCreateOptions,
  type SandboxInstance,
  type SandboxSdk,
} from './src/sandbox-executor.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = `vcr.private-skills/scanner@${DIGEST}`;

interface FakeHarness {
  sdk: SandboxSdk;
  createOptions?: SandboxCreateOptions;
  commandOptions?: Parameters<SandboxInstance['runCommand']>[0];
  written: Map<string, Buffer>;
  killed: string[];
  stopped: number;
  output?: Buffer;
}

function fakeSdk(output?: Buffer, logs: Array<{ stream: 'stdout' | 'stderr'; data: string }> = []): FakeHarness {
  const harness: FakeHarness = {
    sdk: undefined as unknown as SandboxSdk,
    written: new Map(),
    killed: [],
    stopped: 0,
    output,
  };
  const command: SandboxCommand = {
    async *logs() {
      for (const log of logs) yield log;
    },
    async wait() {
      return { exitCode: 0, durationMs: 7 };
    },
    async kill(signal = 'SIGTERM') {
      harness.killed.push(signal);
    },
  };
  const sandbox: SandboxInstance = {
    fs: {
      async stat(path) {
        const content = path === '/vercel/sandbox/private-skills/output/cisco.json' ? harness.output : harness.written.get(path);
        if (!content) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return { size: content.byteLength, isFile: () => true, isSymbolicLink: () => false };
      },
      async lstat(path) {
        const content = path === '/vercel/sandbox/private-skills/output/cisco.json' ? harness.output : harness.written.get(path);
        if (!content) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return { size: content.byteLength, isFile: () => true, isSymbolicLink: () => false };
      },
    },
    async mkDir() { /* directory creation is tracked by writeFiles in this fake */ },
    async writeFiles(files) {
      for (const file of files) harness.written.set(file.path, file.content);
    },
    async runCommand(options) {
      harness.commandOptions = options;
      if (harness.output) harness.written.set('/vercel/sandbox/private-skills/output/cisco.json', harness.output);
      return command;
    },
    async readFileToBuffer(file) {
      return harness.written.get(file.path) ?? null;
    },
    async stop() {
      harness.stopped += 1;
    },
  };
  harness.sdk = { Sandbox: { create: async (options) => { harness.createOptions = options; return sandbox; } } };
  return harness;
}

async function withWorkspace(callback: (inputDir: string, outputDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'private-skills-sandbox-test-'));
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  await mkdir(join(inputDir, 'nested'), { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(inputDir, 'SKILL.md'), '# fixture\n');
  await writeFile(join(inputDir, 'nested', 'run.py'), 'print("fixture")\n', { mode: 0o755 });
  try {
    await callback(inputDir, outputDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('SandboxExecutor', () => {
  it('requires immutable image provenance and supports trusted snapshots', () => {
    expect(() => resolveSandboxImage('vcr.private-skills/scanner:latest')).toThrow(/immutable/);
    expect(resolveSandboxImage(IMAGE).image).toBe(IMAGE);
    expect(resolveSandboxImage(`snapshot:snap_123|revision:7badb5157f8f4e9dd9ee2acb6e0129636e3147e3|source:${DIGEST}`).source).toEqual({ type: 'snapshot', snapshotId: 'snap_123' });
    expect(() => resolveSandboxImage('snapshot:snap_123')).toThrow(/provenance/);
    expect(resolveSandboxImage('snapshot:snap_123', {
      snap_123: { snapshotId: 'snap_123', sourceRevision: '7badb5157f8f4e9dd9ee2acb6e0129636e3147e3', artifactDigest: DIGEST },
    }).artifactDigest).toBe(DIGEST);
  });

  it('stages bounded input, denies network, maps paths, copies reports, and stops the VM', async () => {
    const report = Buffer.from('{"findings":[],"filesScanned":2}', 'utf8');
    const harness = fakeSdk(report, [{ stream: 'stdout', data: 'scanner progress\n' }]);
    await withWorkspace(async (inputDir, outputDir) => {
      const result = await new SandboxExecutor({ sdk: harness.sdk }).run({
        command: 'skill-scanner',
        args: ['scan', inputDir, '--output', join(outputDir, 'cisco.json')],
        cwd: inputDir,
        env: { NO_COLOR: '1' },
        inputDir,
        outputDir,
        image: IMAGE,
        timeoutMs: 1_000,
        maxOutputBytes: 4 * 1024,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('scanner progress\n');
      expect(result.outputTruncated).toBe(false);
      expect(await readFile(join(outputDir, 'cisco.json'), 'utf8')).toBe(report.toString('utf8'));
      expect(harness.createOptions?.networkPolicy).toBe('deny-all');
      expect(harness.createOptions?.persistent).toBe(false);
      expect(harness.createOptions?.image).toBe(IMAGE);
      expect(harness.commandOptions?.cwd).toBe('/vercel/sandbox/private-skills/input');
      expect(harness.commandOptions?.args).toEqual(['scan', '/vercel/sandbox/private-skills/input', '--output', '/vercel/sandbox/private-skills/output/cisco.json']);
      expect(harness.commandOptions?.env).toEqual(expect.objectContaining({ NO_COLOR: '1' }));
      expect(harness.commandOptions?.env).not.toHaveProperty('HOME');
      expect(harness.commandOptions?.env).not.toHaveProperty('PATH');
      expect(harness.commandOptions?.env).not.toHaveProperty('PSKILLS_WORKER_TOKEN');
      expect(harness.written.has('/vercel/sandbox/private-skills/input/SKILL.md')).toBe(true);
      expect(harness.written.has('/vercel/sandbox/private-skills/input/nested/run.py')).toBe(true);
      expect(harness.stopped).toBe(1);
    });
  });

  it('fails closed for scanner credentials and always cleans up', async () => {
    const harness = fakeSdk();
    await withWorkspace(async (inputDir, outputDir) => {
      const result = await new SandboxExecutor({ sdk: harness.sdk }).run({
        command: 'skillsguard',
        args: [inputDir],
        inputDir,
        outputDir,
        image: IMAGE,
        timeoutMs: 1_000,
        maxOutputBytes: 4 * 1024,
        env: { API_TOKEN: 'must-not-enter-sandbox' },
      });
      expect(result.error).toContain('may contain credentials');
      expect(harness.stopped).toBe(1);
    });
  });

  it('rejects sandbox runtime environment overrides', async () => {
    const harness = fakeSdk();
    await withWorkspace(async (inputDir, outputDir) => {
      const result = await new SandboxExecutor({ sdk: harness.sdk }).run({
        command: 'skillsguard',
        args: [inputDir],
        inputDir,
        outputDir,
        image: IMAGE,
        timeoutMs: 1_000,
        maxOutputBytes: 4 * 1024,
        env: { PATH: '/tmp/attacker-controlled-path' },
      });
      expect(result.error).toContain('cannot override sandbox runtime');
      expect(harness.stopped).toBe(1);
    });
  });

  it('terminates and marks a scanner when output exceeds the bound', async () => {
    const harness = fakeSdk(undefined, [{ stream: 'stderr', data: 'x'.repeat(2_048) }]);
    await withWorkspace(async (inputDir, outputDir) => {
      const result = await new SandboxExecutor({ sdk: harness.sdk }).run({
        command: 'skillsguard',
        args: [inputDir],
        inputDir,
        outputDir,
        image: IMAGE,
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      });
      expect(result.outputTruncated).toBe(true);
      expect(result.error).toContain('output exceeded');
      expect(harness.killed).toContain('SIGTERM');
      expect(harness.stopped).toBe(1);
    });
  });

  it('rejects symbolic links in the staged input tree', async () => {
    const harness = fakeSdk();
    await withWorkspace(async (inputDir, outputDir) => {
      await symlink('SKILL.md', join(inputDir, 'alias.md'));
      const result = await new SandboxExecutor({ sdk: harness.sdk }).run({
        command: 'skillsguard',
        args: [inputDir],
        inputDir,
        outputDir,
        image: IMAGE,
        timeoutMs: 1_000,
        maxOutputBytes: 4 * 1024,
      });
      expect(result.error).toContain('symbolic link');
      expect(harness.stopped).toBe(0);
    });
  });
});
