import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandExecutor, CommandRequest, CommandResult } from './types.js';

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MEMORY_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CPUS = 1;
const DEFAULT_PIDS_LIMIT = 128;

function safeExecutable(command: string): string {
  if (!command || command.includes('\u0000')) throw new Error('scanner command is empty or contains NUL');
  // Commands are trusted image/configuration inputs. Never allow a shell command
  // string; the child process API receives an argv array below.
  if (/[\r\n]/.test(command)) throw new Error('scanner command contains a newline');
  return command;
}

function mergedEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Avoid inheriting credentials, proxy variables, and user-level scanner
    // configuration into a scan. Scanner images are expected to be self-contained.
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp/empty-home',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function appendBounded(current: string, next: Buffer, max: number): { text: string; truncated: boolean } {
  const remaining = Math.max(0, max - Buffer.byteLength(current, 'utf8'));
  if (remaining === 0) return { text: current, truncated: next.length > 0 };
  if (next.length <= remaining) return { text: current + next.toString('utf8'), truncated: false };
  return { text: current + next.subarray(0, remaining).toString('utf8'), truncated: true };
}

export class TrustedLocalExecutor implements CommandExecutor {
  readonly isolation = 'trusted-local' as const;

  async run(request: CommandRequest): Promise<CommandResult> {
    return runProcess(request);
  }
}

/**
 * Executes the scanner in a disposable Docker container. The input bind is
 * read-only, the output bind is separate, and no Docker socket is mounted.
 * Network is disabled by default. This class intentionally does not attempt to
 * make Docker itself a security boundary for a hostile daemon; deployments
 * must run it against a dedicated worker host/runtime.
 */
export class DockerExecutor implements CommandExecutor {
  readonly isolation = 'container' as const;

  constructor(private readonly dockerCommand = 'docker') {}

  async run(request: CommandRequest): Promise<CommandResult> {
    if (!request.image) throw new Error('container scanner image is required for isolated execution');
    if (!request.inputDir || !request.outputDir) throw new Error('container scanner requires inputDir and outputDir');

    const { uid, gid } = containerUser();
    const args = [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      '--pids-limit', String(request.pidsLimit ?? DEFAULT_PIDS_LIMIT),
      '--memory', String(request.memoryBytes ?? DEFAULT_MEMORY_BYTES),
      '--cpus', String(request.cpus ?? DEFAULT_CPUS),
      '--user', `${uid}:${gid}`,
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=700`,
      '--tmpfs', `/home/worker:rw,noexec,nosuid,nodev,size=8m,uid=${uid},gid=${gid},mode=700`,
      '--env', 'HOME=/home/worker',
      '--env', 'LANG=C.UTF-8',
      '--env', 'LC_ALL=C.UTF-8',
      '--mount', `type=bind,src=${request.inputDir},dst=/input,readonly`,
      '--mount', `type=bind,src=${request.outputDir},dst=/output`,
      '--workdir', '/input',
      request.image,
      safeExecutable(request.command),
      ...request.args,
    ];
    return runProcess({
      ...request,
      command: this.dockerCommand,
      args,
      cwd: undefined,
      // Keep scanner configuration and publisher-controlled values out of the
      // Docker CLI environment. Only explicitly prefixed operator settings
      // select a daemon/context; no socket or ambient credentials are passed.
      env: dockerControlEnv(),
    });
  }
}

function containerUser(): { uid: number; gid: number } {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 65532;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 65532;
  // A root worker would defeat the intended container user. Keep the image's
  // non-root fallback in that case; production workers should themselves run
  // as an unprivileged account so the 0700 materialized workspace is readable.
  return {
    uid: Number.isInteger(uid) && uid > 0 ? uid : 65532,
    gid: Number.isInteger(gid) && gid > 0 ? gid : 65532,
  };
}

function dockerControlEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const context = process.env.PSKILLS_DOCKER_CONTEXT;
  const host = process.env.PSKILLS_DOCKER_HOST;
  if (context && /^[A-Za-z0-9._-]{1,128}$/.test(context)) env.DOCKER_CONTEXT = context;
  if (host && host.length <= 512 && !/[\u0000-\u001f\u007f]/.test(host)) env.DOCKER_HOST = host;
  return env;
}

async function runProcess(request: CommandRequest): Promise<CommandResult> {
  const command = safeExecutable(request.command);
  const args = [...request.args];
  const timeoutMs = Math.max(1, request.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1024, request.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES);
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let outputTruncated = false;
  let timedOut = false;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;

  const child = spawn(command, args, {
    cwd: request.cwd,
    env: mergedEnv(request.env),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const close = new Promise<CommandResult>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        outputTruncated,
        ...(error ? { error } : {}),
      });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const result = appendBounded(stdout, chunk, maxOutputBytes);
      stdout = result.text;
      outputTruncated ||= result.truncated;
      if (outputTruncated && !child.killed) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const result = appendBounded(stderr, chunk, maxOutputBytes);
      stderr = result.text;
      outputTruncated ||= result.truncated;
      if (outputTruncated && !child.killed) child.kill('SIGTERM');
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      const message = error.code === 'ENOENT'
        ? `engine not installed: ${command}`
        : `failed to execute ${command}: ${error.message}`;
      finish(null, null, message);
    });
    child.once('close', (code, signal) => finish(code, signal));
  });

  const timeoutTimer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!settled && !child.killed) child.kill('SIGKILL');
    }, 1000);
  }, timeoutMs);

  const abort = () => {
    if (settled) return;
    child.kill('SIGTERM');
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  const result = await close;
  clearTimeout(timeoutTimer);
  request.signal?.removeEventListener('abort', abort);
  if (request.signal?.aborted && !result.timedOut) {
    return { ...result, timedOut: true, error: result.error ?? 'scan aborted' };
  }
  if (result.outputTruncated) return { ...result, error: result.error ?? 'scanner output exceeded limit' };
  return result;
}

export interface TempScanWorkspace {
  root: string;
  inputDir: string;
  outputDir: string;
  cleanup(): Promise<void>;
}

export async function createTempScanWorkspace(prefix = 'pskills-scan-'): Promise<TempScanWorkspace> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  await mkdir(inputDir, { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  return {
    root,
    inputDir,
    outputDir,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function defaultExecutor(): CommandExecutor {
  // Explicit opt-in only. Production runner construction uses DockerExecutor;
  // this fallback is useful for local adapter tests and is labelled in telemetry.
  return new TrustedLocalExecutor();
}

export const EXECUTOR_DEFAULTS = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  memoryBytes: DEFAULT_MEMORY_BYTES,
  cpus: DEFAULT_CPUS,
  pidsLimit: DEFAULT_PIDS_LIMIT,
  localModeLabel: 'trusted-local-dev-only',
});
