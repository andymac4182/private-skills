import { describe, expect, it } from 'vitest';

import { shouldDrainHostedWorker } from '../server/hosted-worker';

describe('hosted worker drain route selection', () => {
  it('schedules a queued source resolve and rejects near-match routes', () => {
    const queuedResolve = new Request('https://registry.example.test/v1/sources/tessl/resolve', { method: 'POST' });
    expect(shouldDrainHostedWorker(queuedResolve, new Response(null, { status: 202 }))).toBe(true);

    const cases = [
      new Request('https://registry.example.test/v1/sources/tessl/resolve/', { method: 'POST' }),
      new Request('https://registry.example.test/v1/sources/tessl/resolve', { method: 'GET' }),
      new Request('https://registry.example.test/v1/sources/tessl/search', { method: 'POST' }),
    ];
    for (const request of cases) {
      expect(shouldDrainHostedWorker(request, new Response(null, { status: 202 }))).toBe(false);
    }
    expect(shouldDrainHostedWorker(queuedResolve, new Response(null, { status: 200 }))).toBe(false);
  });
});
