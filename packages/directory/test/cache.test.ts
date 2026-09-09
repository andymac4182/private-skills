import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DIRECTORY_CACHE_OPTIONS,
  DIRECTORY_CACHE_MAX_TTL_MS,
  DirectoryResponseCache,
  directoryCacheKey,
} from '../src/cache.js';

const KEY = directoryCacheKey('https://skills.sh', 'skills', {
  view: 'all-time',
  page: 0,
  per_page: 2,
});

function request<T>(
  key: string,
  load: (credential: unknown) => Promise<{ value: T; status: number }>,
  authenticate: (signal?: AbortSignal) => Promise<unknown> = async () => undefined,
) {
  return {
    endpoint: 'list' as const,
    key,
    authenticate,
    load,
  };
}

describe('DirectoryResponseCache', () => {
  it('keeps official endpoint TTL ceilings and allows shorter operator values', () => {
    expect(DEFAULT_DIRECTORY_CACHE_OPTIONS.ttlMs.list).toBe(DIRECTORY_CACHE_MAX_TTL_MS.list);
    expect(() => new DirectoryResponseCache({ ttlMs: { list: DIRECTORY_CACHE_MAX_TTL_MS.list + 1 } })).toThrow();
    expect(() => new DirectoryResponseCache({ ttlMs: { detail: DIRECTORY_CACHE_MAX_TTL_MS.detail + 1 } })).toThrow();
    expect(() => new DirectoryResponseCache({ ttlMs: { search: 1_000 } })).not.toThrow();
  });

  it('resolves auth before a warm hit and fails closed when auth is unavailable', async () => {
    let now = 100;
    let authCalls = 0;
    let loadCalls = 0;
    let rejectAuth = false;
    const events: unknown[] = [];
    const cache = new DirectoryResponseCache({
      now: () => now,
      observe: (event) => events.push(event),
    });
    const authenticate = async (): Promise<unknown> => {
      authCalls += 1;
      if (rejectAuth) throw new Error('secret-provider-diagnostic');
      return 'secret-bearer';
    };
    const load = async (credential: unknown) => {
      loadCalls += 1;
      expect(credential).toBe('secret-bearer');
      return { value: { page: 1 }, status: 200 };
    };

    expect(await cache.get(request(KEY, load, authenticate))).toEqual({ page: 1 });
    rejectAuth = true;
    await expect(cache.get(request(KEY, load, authenticate))).rejects.toThrow('secret-provider-diagnostic');

    expect(authCalls).toBe(2);
    expect(loadCalls).toBe(1);
    expect(cache.inspect().authFailures).toBe(1);
    expect(JSON.stringify({ events, stats: cache.inspect() })).not.toContain('secret-bearer');
    expect(JSON.stringify({ events, stats: cache.inspect() })).not.toContain('secret-provider-diagnostic');
    now = 101;
  });

  it('expires entries, records age/status/bytes, and reloads after expiry', async () => {
    let now = 0;
    let loads = 0;
    const events: Array<{ type: string; ageMs: number; status?: number; bytes: number }> = [];
    const cache = new DirectoryResponseCache({
      now: () => now,
      ttlMs: { list: 10 },
      observe: (event) => events.push(event),
    });
    const load = async () => ({ value: { page: loads++ }, status: 206 });

    expect(await cache.get(request(KEY, load))).toEqual({ page: 0 });
    now = 9;
    expect(await cache.get(request(KEY, load))).toEqual({ page: 0 });
    now = 10;
    expect(await cache.get(request(KEY, load))).toEqual({ page: 1 });

    expect(loads).toBe(2);
    expect(events.find((event) => event.type === 'hit')).toMatchObject({ ageMs: 9, status: 206 });
    expect(events.find((event) => event.type === 'expired')).toMatchObject({ ageMs: 10, status: 206 });
    expect(events.find((event) => event.type === 'store')).toMatchObject({ status: 206 });
    expect(cache.inspect()).toMatchObject({ entries: 1, totalBytes: expect.any(Number), expirations: 1 });
  });

  it('evicts least recently used entries and enforces the byte budget', async () => {
    let loads = 0;
    const cache = new DirectoryResponseCache({ maxEntries: 2, maxBytes: 150 });
    const load = async (credential: unknown) => ({ value: { key: credential, text: 'x'.repeat(30) }, status: 200 });

    await cache.get(request('https://skills.sh/api/v1/skills?key=a', load, async () => { loads += 1; return 'a'; }));
    await cache.get(request('https://skills.sh/api/v1/skills?key=b', load, async () => { loads += 1; return 'b'; }));
    const afterTwo = cache.inspect();
    expect(afterTwo.entries).toBeLessThanOrEqual(2);
    expect(afterTwo.totalBytes).toBeLessThanOrEqual(150);
    await cache.get(request('https://skills.sh/api/v1/skills?key=c', load, async () => { loads += 1; return 'c'; }));
    expect(cache.inspect().entries).toBeLessThanOrEqual(2);
    expect(cache.inspect().totalBytes).toBeLessThanOrEqual(150);
    expect(cache.inspect().evictions).toBeGreaterThan(0);
    expect(loads).toBe(3);
  });

  it('returns detached values so caller mutation cannot poison a warm entry', async () => {
    let loads = 0;
    const cache = new DirectoryResponseCache();
    const load = async () => ({
      value: { data: [{ id: 'skill/demo', labels: ['safe'] }] },
      status: 200,
    });

    const first = await cache.get(request(KEY, async () => { loads += 1; return load(); }));
    first.data[0]!.labels.push('mutated');
    const second = await cache.get(request(KEY, load));

    expect(loads).toBe(1);
    expect(second).toEqual({ data: [{ id: 'skill/demo', labels: ['safe'] }] });
    expect(second).not.toBe(first);
    expect(second.data).not.toBe(first.data);
  });

  it('coalesces concurrent misses after resolving each caller auth', async () => {
    let resolve!: (result: { value: { revision: number }; status: number }) => void;
    let authCalls = 0;
    let loadCalls = 0;
    const cache = new DirectoryResponseCache();
    const load = async () => {
      loadCalls += 1;
      return new Promise<{ value: { revision: number }; status: number }>((finish) => { resolve = finish; });
    };
    const authenticate = async () => `token-${++authCalls}`;
    const firstPromise = cache.get(request(KEY, load, authenticate));
    const secondPromise = cache.get(request(KEY, load, authenticate));
    await Promise.resolve();
    resolve({ value: { revision: 1 }, status: 200 });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(authCalls).toBe(2);
    expect(loadCalls).toBe(1);
    expect(first).toEqual({ revision: 1 });
    expect(second).toEqual({ revision: 1 });
    expect(first).not.toBe(second);
    expect(cache.inspect()).toMatchObject({ misses: 2, coalesced: 1, stores: 1 });
  });

  it('allows a coalesced caller to cancel its own wait without cancelling the shared load', async () => {
    let resolve!: (result: { value: { revision: number }; status: number }) => void;
    const cache = new DirectoryResponseCache();
    const load = async () => new Promise<{ value: { revision: number }; status: number }>((finish) => { resolve = finish; });
    const firstPromise = cache.get(request(`${KEY}&case=cancel`, load));
    await Promise.resolve();
    const controller = new AbortController();
    const secondPromise = cache.get({ ...request(`${KEY}&case=cancel`, load), signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(secondPromise).rejects.toMatchObject({ name: 'AbortError' });
    resolve({ value: { revision: 2 }, status: 200 });
    await expect(firstPromise).resolves.toEqual({ revision: 2 });
    expect(cache.inspect()).toMatchObject({ coalesced: 1, stores: 1 });
  });

  it('does not cache loader errors or non-success statuses', async () => {
    let errorLoads = 0;
    let statusLoads = 0;
    const cache = new DirectoryResponseCache();
    const errorLoad = async () => {
      errorLoads += 1;
      if (errorLoads === 1) throw new Error('raw-report-secret');
      return { value: { ok: true }, status: 200 };
    };
    await expect(cache.get(request(`${KEY}&case=error`, errorLoad))).rejects.toThrow('raw-report-secret');
    expect(await cache.get(request(`${KEY}&case=error`, errorLoad))).toEqual({ ok: true });
    const unavailableLoad = async () => {
      statusLoads += 1;
      return { value: { status: 'unavailable' }, status: 503 };
    };
    await cache.get(request(`${KEY}&case=503`, unavailableLoad));
    await cache.get(request(`${KEY}&case=503`, unavailableLoad));

    expect(errorLoads).toBe(2);
    expect(statusLoads).toBe(2);
    expect(cache.inspect()).toMatchObject({ loadFailures: 1, entries: 1, bypasses: 2 });
    expect(JSON.stringify(cache.inspect())).not.toContain('raw-report-secret');
  });

  it('canonicalizes keys with base and query identity while exposing only safe metadata', async () => {
    const first = directoryCacheKey('https://skills.sh', 'skills/search', { limit: 10, q: 'react native' });
    const same = directoryCacheKey('https://skills.sh', 'skills/search', { q: 'react native', limit: 10 });
    const differentBase = directoryCacheKey('https://proxy.example.test/catalog', 'skills/search', { q: 'react native', limit: 10 });
    expect(first).toBe(same);
    expect(first).not.toBe(differentBase);

    const events: unknown[] = [];
    let now = 0;
    const cache = new DirectoryResponseCache({ now: () => now, observe: (event) => events.push(event) });
    await cache.get(request(first, async () => ({ value: { count: 1 }, status: 200 }), async () => 'header-secret'));
    const serialized = JSON.stringify({ events, stats: cache.inspect() });
    expect(serialized).toContain(first);
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('authorization');
    expect(cache.inspect().cached[0]).toMatchObject({ endpoint: 'list', status: 200, bytes: expect.any(Number), ageMs: 0 });
  });
});
