import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';

import type { RegistryHandler } from '../packages/core/src/index.js';

export interface LocalCliRun {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface LocalRegistryOwner {
  readonly handler: RegistryHandler;
  readonly close?: () => Promise<void>;
}

export interface LocalRegistryServer<T extends LocalRegistryOwner> {
  readonly origin: string;
  readonly registry: T;
  readonly close: () => Promise<void>;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  handler: RegistryHandler | undefined,
): Promise<void> {
  if (!handler) {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('local registry is closed');
    return;
  }

  try {
    const method = (request.method ?? 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD'
      ? undefined
      : await readRequestBody(request);
    const webRequest = new Request(new URL(request.url ?? '/', origin), {
      method,
      headers: requestHeaders(request),
      body: body as BodyInit | null | undefined,
    });
    const webResponse = await handler(webRequest);
    const responseBody = method === 'HEAD' ? undefined : Buffer.from(await webResponse.arrayBuffer());
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
    response.end(responseBody);
  } catch {
    // Keep server-side exceptions out of the CLI's output. The test still
    // receives a non-2xx response and can report the sanitized CLI stderr.
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    response.end('local registry request failed');
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('local registry did not expose a TCP address'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port: 0 });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Run a registry harness over a real loopback HTTP server on an ephemeral
 * port. The harness receives the final origin so transfer URLs match the
 * server that the Rust client contacts.
 */
export async function startLocalRegistry<T extends LocalRegistryOwner>(
  create: (origin: string) => Promise<T>,
): Promise<LocalRegistryServer<T>> {
  let handler: RegistryHandler | undefined;
  const server = createServer((request, response) => {
    const port = server.address();
    const origin = port && typeof port !== 'string'
      ? `http://127.0.0.1:${port.port}`
      : 'http://127.0.0.1';
    void serveRequest(request, response, origin, handler);
  });

  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  let registry: T;
  try {
    registry = await create(origin);
    handler = registry.handler;
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  let closed = false;
  return {
    origin,
    registry,
    close: async () => {
      if (closed) return;
      closed = true;
      handler = undefined;
      let closeError: unknown;
      try {
        await closeServer(server);
      } catch (error) {
        closeError = error;
      }
      try {
        await registry.close?.();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError) throw closeError;
    },
  };
}

export async function withLocalTempDirectory<T>(
  prefix: string,
  action: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runLocalCli(options: {
  binaryPath: string;
  registryOrigin: string;
  token: string;
  cwd: string;
  args: readonly string[];
  timeoutMs?: number;
}): Promise<LocalCliRun> {
  if (!isAbsolute(options.binaryPath)) {
    throw new Error(`PSKILLS_TEST_CLI_PATH must be absolute: ${options.binaryPath}`);
  }
  if (!options.token.trim()) throw new Error('local CLI token must not be empty');
  if (!options.registryOrigin.startsWith('http://127.0.0.1:')) {
    throw new Error('local CLI registry must be an ephemeral loopback origin');
  }

  return withLocalTempDirectory('private-skills-cli-home-', async (home) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_DATA_HOME: join(home, 'data'),
      LANG: 'C',
      NO_COLOR: '1',
      PSKILLS_REGISTRY: options.registryOrigin,
      PSKILLS_TOKEN: options.token,
    };
    const child = spawn(options.binaryPath, [...options.args], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeoutMs = options.timeoutMs ?? 30_000;

    return new Promise<LocalCliRun>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
        graceTimer.unref?.();
      }, timeoutMs);
      timeout.unref?.();

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (graceTimer) clearTimeout(graceTimer);
        const redact = (value: string): string => value
          .replaceAll(options.token, '[redacted-token]')
          .replaceAll(options.registryOrigin, '[redacted-loopback-registry]');
        resolve({
          code: code ?? (timedOut ? 124 : 1),
          signal,
          stdout: redact(stdout),
          stderr: redact(stderr),
          timedOut,
        });
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.once('error', (error) => {
        stderr += error.message;
        finish(127, null);
      });
      child.once('close', (code, signal) => finish(code, signal));
    });
  });
}
