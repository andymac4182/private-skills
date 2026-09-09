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
});
