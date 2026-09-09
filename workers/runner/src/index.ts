export * from './bundle.js';
export * from './client.js';
export * from './acquisition.js';
export * from './protocol.js';
export * from './worker.js';
export * from './webhook.js';
export * from './hosted.js';

import { WorkerRunner } from './worker.js';

/**
 * Small process entrypoint for a portable worker image. Deployment wrappers can
 * import WorkerRunner directly; this function keeps the environment contract in
 * one place for Docker/Kubernetes/systemd.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const baseUrl = env.PSKILLS_API_URL;
  const workerToken = env.PSKILLS_WORKER_TOKEN;
  const workerId = env.PSKILLS_WORKER_ID ?? `worker-${process.pid}`;
  if (!baseUrl || !workerToken) throw new Error('PSKILLS_API_URL and PSKILLS_WORKER_TOKEN are required');
  const runner = new WorkerRunner({
    baseUrl,
    workerToken,
    workerId,
    pollIntervalMs: Number(env.PSKILLS_POLL_INTERVAL_MS ?? 1000),
    scannerImages: {
      'cisco-skill-scanner': env.PSKILLS_IMAGE_CISCO,
      'nvidia-skillspector': env.PSKILLS_IMAGE_NVIDIA,
      skillsguard: env.PSKILLS_IMAGE_SKILLSGUARD,
    },
    onEvent(event) {
      // Deliberately metadata-only logs. Never print report excerpts, URLs,
      // artifact bytes, lease tokens, or scanner stderr.
      process.stdout.write(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
    },
  });
  await runner.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
