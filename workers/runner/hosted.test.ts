import { describe, expect, it } from 'vitest';

import {
  createHostedWorkerHandler,
  createHostedWorkerHandlerFromEnv,
  type HostedWorkerOptions,
} from './src/hosted.js';
import type { WorkerRunner, WorkerRunnerOptions } from './src/worker.js';

const SECRET = '0123456789abcdef';
const IMAGE = `vcr.private-skills/scanner@sha256:${'b'.repeat(64)}`;

function options(result: { claimed: boolean; jobId?: string; allow?: boolean; error?: string }): HostedWorkerOptions {
  return {
    apiUrl: 'https://registry.example.test',
    workerToken: 'worker-token-fixture',
    cronSecret: SECRET,
    scannerImages: { skillsguard: IMAGE },
    executor: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false }) },
    createRunner: (runnerOptions: WorkerRunnerOptions) => {
      expect(runnerOptions.workerToken).toBe('worker-token-fixture');
      expect(runnerOptions.scannerImages?.skillsguard).toBe(IMAGE);
      return { runOnce: async () => result } as unknown as WorkerRunner;
    },
  };
}

describe('hosted worker route', () => {
  it('requires an exact Bearer CRON_SECRET and only accepts GET', async () => {
    const handler = createHostedWorkerHandler(options({ claimed: false }));
    expect((await handler(new Request('https://app.example.test/api/worker', { method: 'POST' }))).status).toBe(405);
    expect((await handler(new Request('https://app.example.test/api/worker'))).status).toBe(401);
    expect((await handler(new Request('https://app.example.test/api/worker', { headers: { authorization: 'Bearer wrong-secret' } }))).status).toBe(401);
  });

  it('runs one protocol invocation and returns metadata without scanner output', async () => {
    const handler = createHostedWorkerHandler(options({ claimed: true, jobId: 'job-1', allow: true }));
    const response = await handler(new Request('https://app.example.test/api/worker', {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, claimed: true, jobId: 'job-1', allow: true });
  });

  it('returns a generic failure status without exposing worker errors', async () => {
    const handler = createHostedWorkerHandler(options({ claimed: true, jobId: 'job-1', error: 'secret report excerpt' }));
    const response = await handler(new Request('https://app.example.test/api/worker', {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('worker scan failed');
    expect(body).not.toContain('secret report excerpt');
  });

  it('rejects unsupported sandbox driver/provider settings before creating the worker route', () => {
    expect(() => createHostedWorkerHandler({ ...options({ claimed: false }), sandboxDriver: 'docker' as never })).toThrow(
      'PSKILLS_SANDBOX_DRIVER must be computesdk or native',
    );
    expect(() => createHostedWorkerHandler({ ...options({ claimed: false }), sandboxProvider: 'e2b' })).toThrow(
      'Unsupported PSKILLS_SANDBOX_PROVIDER',
    );
  });

  it('builds configuration from the documented environment names', () => {
    const handler = createHostedWorkerHandlerFromEnv({
      PSKILLS_API_URL: 'https://registry.example.test',
      PSKILLS_WORKER_TOKEN: 'worker-token-fixture',
      CRON_SECRET: SECRET,
      PSKILLS_IMAGE_SKILLSGUARD: IMAGE,
    }, {
      executor: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false }) },
      createRunner: (runnerOptions) => {
        expect(runnerOptions.scannerImages?.skillsguard).toBe(IMAGE);
        return { runOnce: async () => ({ claimed: false }) } as unknown as WorkerRunner;
      },
    });
    expect(handler).toBeTypeOf('function');
  });

  it('wires an enabled gateway credential to the hosted runner without exposing its token', async () => {
    const gatewayToken = 'gateway-token-fixture';
    const handler = createHostedWorkerHandlerFromEnv({
      PSKILLS_API_URL: 'https://registry.example.test',
      PSKILLS_WORKER_TOKEN: 'worker-token-fixture',
      CRON_SECRET: SECRET,
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://directory-gateway.example.test/tenant-a',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: gatewayToken,
      PSKILLS_IMAGE_SKILLSGUARD: IMAGE,
    }, {
      executor: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false }) },
      createRunner: (runnerOptions) => {
        const credential = runnerOptions.acquisition?.skillsShGatewayCredential;
        expect(credential?.baseUrl).toBe('https://directory-gateway.example.test/tenant-a');
        expect(credential?.getToken).toBeTypeOf('function');
        return { runOnce: async () => ({ claimed: false }) } as unknown as WorkerRunner;
      },
    });
    const response = await handler(new Request('https://app.example.test/api/worker', {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    expect(response.status).toBe(200);
  });

  it('wires the bounded multi-feed profile through the hosted runner', async () => {
    const handler = createHostedWorkerHandlerFromEnv({
      PSKILLS_API_URL: 'https://registry.example.test',
      PSKILLS_WORKER_TOKEN: 'worker-token-fixture',
      CRON_SECRET: SECRET,
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([
        { baseUrl: 'https://directory-gateway.example.test/tenant-a', tokenEnv: 'PSKILLS_HOSTED_FEED_A' },
        { baseUrl: 'https://directory-gateway.example.test/tenant-b', tokenEnv: 'PSKILLS_HOSTED_FEED_B' },
      ]),
      PSKILLS_HOSTED_FEED_A: 'hosted-token-a',
      PSKILLS_HOSTED_FEED_B: 'hosted-token-b',
      PSKILLS_IMAGE_SKILLSGUARD: IMAGE,
    }, {
      executor: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false }) },
      createRunner: (runnerOptions) => {
        const gateways = runnerOptions.acquisition?.skillsShGatewayCredentials;
        expect(gateways?.map((gateway) => gateway.baseUrl)).toEqual([
          'https://directory-gateway.example.test/tenant-a',
          'https://directory-gateway.example.test/tenant-b',
        ]);
        expect(gateways?.every((gateway) => !('token' in gateway))).toBe(true);
        return { runOnce: async () => ({ claimed: false }) } as unknown as WorkerRunner;
      },
    });
    const response = await handler(new Request('https://app.example.test/api/worker', {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    expect(response.status).toBe(200);
  });

  it('does not wire gateway settings while directory access is disabled', async () => {
    let acquisition: WorkerRunnerOptions['acquisition'] | undefined;
    const handler = createHostedWorkerHandlerFromEnv({
      PSKILLS_API_URL: 'https://registry.example.test',
      PSKILLS_WORKER_TOKEN: 'worker-token-fixture',
      CRON_SECRET: SECRET,
      PSKILLS_DIRECTORY_GATEWAY_URL: 'https://directory-gateway.example.test/tenant-a',
      PSKILLS_DIRECTORY_GATEWAY_TOKEN: 'must-not-be-used',
      PSKILLS_IMAGE_SKILLSGUARD: IMAGE,
    }, {
      executor: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false }) },
      createRunner: (runnerOptions) => {
        acquisition = runnerOptions.acquisition;
        return { runOnce: async () => ({ claimed: false }) } as unknown as WorkerRunner;
      },
    });
    await handler(new Request('https://app.example.test/api/worker', {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    expect(acquisition?.skillsShGatewayCredential).toBeUndefined();
  });

  it('forwards the request-scoped skills.sh token callback without resolving it at startup', async () => {
    const tokenProvider = async (_signal?: AbortSignal): Promise<string> => 'oidc-token-fixture';
    let forwarded: unknown;
    const handler = createHostedWorkerHandler({
      ...options({ claimed: false }),
      acquisition: {
        getSkillsShToken: tokenProvider,
      },
      createRunner: (runnerOptions) => {
        forwarded = runnerOptions.acquisition?.getSkillsShToken;
        return { runOnce: async () => ({ claimed: false }) } as unknown as WorkerRunner;
      },
    });

    const response = await handler(new Request('https://app.example.test/api/worker', {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    expect(response.status).toBe(200);
    expect(forwarded).toBe(tokenProvider);
  });
});
