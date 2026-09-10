import { describe, expect, it } from 'vitest';
import {
  PersistentOpenClawFeedCache,
  StateRepositoryOpenClawConsumerSnapshotStore,
} from '../src/index.ts';
import type {
  OpenClawConsumerCacheKey,
  OpenClawConsumerSnapshotStore,
  StateRepositoryOpenClawConsumerSnapshotStoreOptions,
} from '../src/index.ts';
import { createMemoryStateRepository } from '../../database/src/index.ts';
import {
  OPENCLAW_CLAWHUB_SKILLS_API_URL,
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
  parseOpenClawFeed,
  serializeOpenClawFeed,
  sha256,
  utf8Bytes,
  type OpenClawCacheSnapshot,
} from '../../openclaw/src/index.ts';

const TENANT = 'tenant-a';
const FEED_ID = 'clawhub-official';
const SOURCE_URL = 'https://feed.example/v1/feeds/skills';
const OTHER_SOURCE_URL = 'https://other.example/v1/feeds/skills';
const CLOCK = Date.parse('2030-01-01T01:00:00.000Z');
const LAST_MODIFIED = 'Wed, 01 Jan 2030 00:00:00 GMT';

function consumerStore(
  repository: ReturnType<typeof createMemoryStateRepository>,
  options: StateRepositoryOpenClawConsumerSnapshotStoreOptions = {},
): StateRepositoryOpenClawConsumerSnapshotStore {
  return new StateRepositoryOpenClawConsumerSnapshotStore(repository, { now: () => CLOCK, ...options });
}

class DelayedPutStore implements OpenClawConsumerSnapshotStore {
  constructor(
    private readonly inner: OpenClawConsumerSnapshotStore,
    private readonly afterPut: () => void,
  ) {}

  read(key: OpenClawConsumerCacheKey): Promise<OpenClawCacheSnapshot | undefined> {
    return this.inner.read(key);
  }

  async put(key: OpenClawConsumerCacheKey, snapshot: OpenClawCacheSnapshot): Promise<void> {
    await this.inner.put(key, snapshot);
    this.afterPut();
  }

  clear(key: OpenClawConsumerCacheKey): Promise<void> {
    return this.inner.clear(key);
  }
}

async function snapshot(
  sequence = 1,
  sourceUrl = SOURCE_URL,
  acceptedAt = CLOCK,
  generatedAt = '2030-01-01T00:00:00.000Z',
  expiresAt = '2030-01-02T00:00:00.000Z',
): Promise<OpenClawCacheSnapshot> {
  const body = serializeOpenClawFeed({
    schemaVersion: 1,
    id: FEED_ID,
    generatedAt,
    sequence,
    expiresAt,
    entries: [],
  });
  const bytes = utf8Bytes(body);
  const digest = await sha256(bytes);
  return {
    feed: parseOpenClawFeed(body, { expectedFeedId: FEED_ID, checkExpiry: false }),
    body,
    bytes,
    sha256: digest,
    etag: `"${digest}"`,
    lastModified: LAST_MODIFIED,
    acceptedAt,
    sourceUrl,
  };
}

async function liveClawHubSkillsSnapshot(acceptedAt = CLOCK): Promise<OpenClawCacheSnapshot> {
  const body = serializeOpenClawFeed({
    schemaVersion: 1,
    id: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
    generatedAt: '2030-01-01T00:00:00.000Z',
    sequence: 1,
    expiresAt: '2030-01-08T00:00:00.000Z',
    entries: [],
  });
  const bytes = utf8Bytes(body);
  const digest = await sha256(bytes);
  return {
    feed: parseOpenClawFeed(body, { expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID, checkExpiry: false }),
    body,
    bytes,
    sha256: digest,
    etag: `"${digest}"`,
    compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
    transportEtag: `W/"${digest}-gzip"`,
    lastModified: LAST_MODIFIED,
    acceptedAt,
    sourceUrl: OPENCLAW_CLAWHUB_SKILLS_API_URL,
  };
}

function key(overrides: Partial<{ tenantId: string; feedId: string; sourceUrl: string }> = {}) {
  return {
    tenantId: overrides.tenantId ?? TENANT,
    feedId: overrides.feedId ?? FEED_ID,
    sourceUrl: overrides.sourceUrl ?? SOURCE_URL,
  };
}

describe('durable OpenClaw consumer snapshots', () => {
  it('retains bounded bytes, validators, expiry, and identity across repository-backed restarts', async () => {
    const repository = createMemoryStateRepository();
    const first = consumerStore(repository);
    const original = await snapshot();

    await first.put(key(), original);

    // A fresh adapter over the same StateRepository models a process restart.
    const restarted = consumerStore(repository);
    await expect(restarted.read(key())).resolves.toMatchObject({
      body: original.body,
      sha256: original.sha256,
      etag: original.etag,
      lastModified: LAST_MODIFIED,
      acceptedAt: CLOCK,
      sourceUrl: SOURCE_URL,
      feed: { id: FEED_ID, sequence: 1, expiresAt: '2030-01-02T00:00:00.000Z' },
    });

    const state = await repository.read(TENANT);
    const persisted = (state as unknown as { openClawConsumerSnapshots?: Record<string, unknown> }).openClawConsumerSnapshots;
    expect(persisted).toBeDefined();
    expect(Object.values(persisted!)).toHaveLength(1);
    expect(Object.values(persisted!)[0]).toMatchObject({
      feedId: FEED_ID,
      sourceUrl: SOURCE_URL,
      bytesLength: original.bytes.byteLength,
    });
    expect(typeof (Object.values(persisted!)[0] as { bytesBase64: unknown }).bytesBase64).toBe('string');
  });

  it('does not cross tenant, feed, or source identities', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    await store.put(key(), await snapshot());

    await expect(store.read(key({ tenantId: 'tenant-b' }))).resolves.toBeUndefined();
    await expect(store.read(key({ feedId: 'other-feed' }))).resolves.toBeUndefined();
    await expect(store.read(key({ sourceUrl: OTHER_SOURCE_URL }))).resolves.toBeUndefined();
  });

  it('rejects replay and same-sequence equivocation while allowing an identical revalidation timestamp', async () => {
    const repository = createMemoryStateRepository();
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository, { now: () => CLOCK + 2_000 });
    await store.put(key(), await snapshot(2, SOURCE_URL, CLOCK));

    await expect(store.put(key(), await snapshot(1))).rejects.toMatchObject({
      code: 'replay',
    });

    await expect(store.put(key(), await snapshot(2, SOURCE_URL, CLOCK + 1_000))).resolves.toBeUndefined();
    await expect(store.read(key())).resolves.toMatchObject({ acceptedAt: CLOCK + 1_000 });

    const changed = await snapshot(2, SOURCE_URL, CLOCK + 2_000);
    changed.body = changed.body.replace('"entries":[]', '"description":"changed","entries":[]');
    changed.bytes = utf8Bytes(changed.body);
    changed.sha256 = await sha256(changed.bytes);
    changed.etag = `"${changed.sha256}"`;
    changed.feed = parseOpenClawFeed(changed.body, { expectedFeedId: FEED_ID, checkExpiry: false });
    await expect(store.put(key(), changed)).rejects.toMatchObject({
      code: 'equivocation',
    });
  });

  it('hydrates a fresh feed cache instance for a conditional 304 without serving another origin', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const original = await snapshot();
    await store.put(key(), original);
    let calls = 0;
    const seenHeaders: Headers[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      seenHeaders.push(new Headers(init?.headers));
      return new Response(null, {
        status: 304,
        headers: { etag: original.etag, 'last-modified': LAST_MODIFIED },
      });
    };
    const request = {
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher,
    };

    const first = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    await expect(first.refresh(request)).resolves.toMatchObject({
      kind: 'not-modified',
      status: 304,
      snapshot: { sha256: original.sha256, sourceUrl: SOURCE_URL, feed: { sequence: 1 } },
    });

    const restarted = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    await expect(restarted.refresh(request)).resolves.toMatchObject({
      kind: 'not-modified',
      snapshot: { body: original.body, etag: original.etag },
    });
    expect(calls).toBe(2);
    expect(seenHeaders[0]?.get('if-none-match')).toBe(original.etag);
    expect(seenHeaders[0]?.get('if-modified-since')).toBe(LAST_MODIFIED);
    expect(seenHeaders[1]?.get('if-none-match')).toBe(original.etag);
    expect(seenHeaders[1]?.get('if-modified-since')).toBe(LAST_MODIFIED);
  });

  it('hydrates a live ClawHub snapshot across restart when the CDN returns its weak gzip ETag', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const original = await liveClawHubSkillsSnapshot();
    const liveKey = {
      tenantId: TENANT,
      feedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      sourceUrl: OPENCLAW_CLAWHUB_SKILLS_API_URL,
    };
    const initial = new PersistentOpenClawFeedCache({
      store,
      tenantId: TENANT,
      now: () => CLOCK,
    });
    await expect(initial.refresh({
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ['https://clawhub.ai'],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      fetcher: async () => new Response(original.body, {
        status: 200,
        headers: {
          etag: original.transportEtag!,
          'last-modified': LAST_MODIFIED,
        },
      }),
    })).resolves.toMatchObject({ kind: 'accepted', snapshot: { transportEtag: original.transportEtag } });
    await expect(store.read(liveKey)).resolves.toMatchObject({ transportEtag: original.transportEtag });
    const seenHeaders: Headers[] = [];
    const request = {
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ['https://clawhub.ai'],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      fetcher: async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers));
        return new Response(null, {
          status: 304,
          headers: {
            etag: `W/"${original.sha256}-gzip"`,
            'last-modified': LAST_MODIFIED,
          },
        });
      },
    } as const;
    const restarted = new PersistentOpenClawFeedCache({
      store,
      tenantId: TENANT,
      now: () => CLOCK,
      maxStaleMs: 7 * 24 * 60 * 60 * 1_000,
    });
    await expect(restarted.refresh(request)).resolves.toMatchObject({
      kind: 'not-modified',
      status: 304,
      snapshot: { sha256: original.sha256, feed: { id: OPENCLAW_CLAWHUB_SKILLS_FEED_ID } },
    });
    expect(seenHeaders[0]?.get('if-none-match')).toBe(original.transportEtag);
  });

  it('updates a bounded CDN transport validator when the canonical body and sequence stay identical', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const original = await liveClawHubSkillsSnapshot();
    const liveKey = {
      tenantId: TENANT,
      feedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      sourceUrl: OPENCLAW_CLAWHUB_SKILLS_API_URL,
    };
    await store.put(liveKey, original);
    const representationChanged = {
      ...original,
      bytes: original.bytes.slice(),
      transportEtag: `"${original.sha256}-gzip"`,
      lastModified: 'Wed, 01 Jan 2030 01:01:00 GMT',
    };
    await expect(store.put(liveKey, representationChanged)).resolves.toBeUndefined();
    await expect(store.read(liveKey)).resolves.toMatchObject({
      sha256: original.sha256,
      feed: { sequence: original.feed.sequence },
      transportEtag: representationChanged.transportEtag,
      lastModified: representationChanged.lastModified,
      acceptedAt: original.acceptedAt,
    });

    const strictIdentity = await snapshot();
    strictIdentity.sourceUrl = OPENCLAW_CLAWHUB_SKILLS_API_URL;
    strictIdentity.transportEtag = `"${strictIdentity.sha256}-gzip"`;
    await expect(store.put({
      tenantId: TENANT,
      feedId: FEED_ID,
      sourceUrl: OPENCLAW_CLAWHUB_SKILLS_API_URL,
    }, strictIdentity)).rejects.toMatchObject({ code: 'identity-mismatch' });
  });

  it('keeps the durable high-water snapshot when an instance receives an older 200 and then loses the network', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const durable = await snapshot(2);
    const old = await snapshot(1);
    await store.put(key(), durable);

    const first = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    await expect(first.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: async () => new Response(old.body, { status: 200, headers: { etag: old.etag } }),
    })).resolves.toMatchObject({
      kind: 'stale',
      error: 'replay',
      snapshot: { feed: { sequence: 2 }, sha256: durable.sha256 },
    });

    const restarted = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    const networkFailure = await restarted.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: async () => { throw new Error('upstream unavailable'); },
    });
    expect(networkFailure).toMatchObject({ kind: 'stale', snapshot: { feed: { sequence: 2 }, sha256: durable.sha256 } });
    expect(['fetch-failed', 'timeout']).toContain(networkFailure.kind === 'stale' ? networkFailure.error : undefined);
  });

  it('does not serve a same-sequence equivocation from local memory after durable fallback', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const durable = await snapshot(2);
    const changed = await snapshot(2);
    changed.body = changed.body.replace('"entries":[]', '"description":"changed","entries":[]');
    changed.bytes = utf8Bytes(changed.body);
    changed.sha256 = await sha256(changed.bytes);
    changed.etag = `"${changed.sha256}"`;
    changed.feed = parseOpenClawFeed(changed.body, { expectedFeedId: FEED_ID, checkExpiry: false });
    await store.put(key(), durable);

    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    await expect(cache.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: async () => new Response(changed.body, { status: 200, headers: { etag: changed.etag } }),
    })).resolves.toMatchObject({
      kind: 'stale',
      error: 'equivocation',
      snapshot: { feed: { sequence: 2 }, sha256: durable.sha256 },
    });

    const networkFailure = await cache.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: async () => { throw new Error('upstream unavailable'); },
    });
    expect(networkFailure).toMatchObject({ kind: 'stale', snapshot: { feed: { sequence: 2 }, sha256: durable.sha256 } });
    expect(['fetch-failed', 'timeout']).toContain(networkFailure.kind === 'stale' ? networkFailure.error : undefined);
  });

  it('preserves a redirected 304 marker instead of converting it to not-modified', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const original = await snapshot();
    await store.put(key(), original);
    const redirected = new Response(null, {
      status: 304,
      headers: { etag: original.etag, 'last-modified': LAST_MODIFIED },
    });
    Object.defineProperty(redirected, 'redirected', { value: true });

    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    await expect(cache.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: async () => redirected,
    })).resolves.toMatchObject({
      kind: 'stale',
      status: 304,
      error: 'redirected',
      snapshot: { feed: { sequence: 1 }, sha256: original.sha256 },
    });
  });

  it('does not let a durable 304 bypass a changed digest pin or a tighter request body limit', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const original = await snapshot();
    await store.put(key(), original);
    const fetcher = async () => new Response(null, {
      status: 304,
      headers: { etag: original.etag, 'last-modified': LAST_MODIFIED },
    });
    const base = { url: SOURCE_URL, expectedFeedId: FEED_ID, allowedOrigins: ['https://feed.example'], fetcher };
    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });

    await expect(cache.refresh({
      ...base,
      expectedSha256: `sha256:${'f'.repeat(64)}`,
    })).resolves.toMatchObject({ kind: 'rejected', status: 304, error: 'no-cache' });

    await expect(cache.refresh({
      ...base,
      maxBodyBytes: original.bytes.byteLength - 1,
    })).resolves.toMatchObject({ kind: 'rejected', status: 304, error: 'no-cache' });
  });

  it('does not accept a durable 304 when the caller aborts after the response is produced', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const original = await snapshot();
    await store.put(key(), original);
    const controller = new AbortController();
    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    const result = await cache.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      signal: controller.signal,
      fetcher: async () => {
        queueMicrotask(() => controller.abort());
        return new Response(null, {
          status: 304,
          headers: { etag: original.etag, 'last-modified': LAST_MODIFIED },
        });
      },
    });
    expect(result.kind).not.toBe('not-modified');
    expect(['aborted', 'no-cache']).toContain('error' in result ? result.error : undefined);
  });

  it('serializes refreshes for one durable feed key', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const original = await snapshot();
    let calls = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) {
        started();
        await blocked;
      }
      return new Response(original.body, { status: 200, headers: { etag: original.etag } });
    };
    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    const request = { url: SOURCE_URL, expectedFeedId: FEED_ID, allowedOrigins: ['https://feed.example'], fetcher };
    const first = cache.refresh(request);
    await firstStarted;
    const second = cache.refresh(request);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });

  it('persists a newly accepted 200 snapshot and enforces per-tenant bounds', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository, {
      now: () => CLOCK,
      maxEntriesPerTenant: 1,
      maxBytesPerTenant: 64 * 1024,
    });
    const original = await snapshot();
    let calls = 0;
    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    await expect(cache.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: async () => {
        calls += 1;
        return new Response(original.body, {
          status: 200,
          headers: { etag: original.etag, 'last-modified': LAST_MODIFIED },
        });
      },
    })).resolves.toMatchObject({ kind: 'accepted', snapshot: { sha256: original.sha256 } });
    expect(calls).toBe(1);

    const persisted = await store.read(key());
    expect(persisted).toMatchObject({ body: original.body, sourceUrl: SOURCE_URL });
    await expect(store.put(key({ sourceUrl: OTHER_SOURCE_URL }), await snapshot(1, OTHER_SOURCE_URL))).rejects.toMatchObject({
      code: 'capacity',
    });
  });

  it('rechecks feed freshness inside the StateRepository transaction admission boundary', async () => {
    const repository = createMemoryStateRepository();
    const expiry = Date.parse('2030-01-02T00:00:00.000Z');
    let clockReads = 0;
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository, {
      now: () => (clockReads++ === 0 ? CLOCK : expiry),
    });

    await expect(store.put(key(), await snapshot())).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.read(key())).resolves.toBeUndefined();
  });

  it('does not return an accepted 200 when durable persistence crosses feed expiry before put resolves', async () => {
    const repository = createMemoryStateRepository();
    const expiry = Date.parse('2030-01-02T00:00:00.000Z');
    let now = CLOCK;
    const inner = new StateRepositoryOpenClawConsumerSnapshotStore(repository, { now: () => now });
    const store = new DelayedPutStore(inner, () => { now = expiry; });
    const original = await snapshot();
    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => now });

    await expect(cache.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: async () => new Response(original.body, { status: 200, headers: { etag: original.etag } }),
    })).resolves.toMatchObject({ kind: 'rejected', status: 200, error: 'no-cache' });
  });

  it('does not return a not-modified 304 when durable persistence crosses feed expiry before put resolves', async () => {
    const repository = createMemoryStateRepository();
    const expiry = Date.parse('2030-01-02T00:00:00.000Z');
    let now = CLOCK;
    const inner = new StateRepositoryOpenClawConsumerSnapshotStore(repository, { now: () => now });
    const original = await snapshot();
    await inner.put(key(), original);
    const store = new DelayedPutStore(inner, () => { now = expiry; });
    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => now });

    await expect(cache.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: async () => new Response(null, {
        status: 304,
        headers: { etag: original.etag, 'last-modified': LAST_MODIFIED },
      }),
    })).resolves.toMatchObject({ kind: 'rejected', status: 304, error: 'no-cache' });
  });

  it('does not reuse a durable snapshot when the origin changes or the snapshot expires', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const original = await snapshot();
    await store.put(key(), original);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(null, { status: 304, headers: { etag: original.etag, 'last-modified': LAST_MODIFIED } });
    };

    const otherOrigin = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    await expect(otherOrigin.refresh({
      url: OTHER_SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://other.example'],
      fetcher,
    })).resolves.toMatchObject({ kind: 'rejected', status: 304, error: 'no-cache' });

    const expired = new PersistentOpenClawFeedCache({
      store,
      tenantId: TENANT,
      now: () => Date.parse('2030-01-02T00:00:01.000Z'),
    });
    await expect(expired.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher,
    })).resolves.toMatchObject({ kind: 'rejected', status: 304, error: 'no-cache' });
    expect(calls).toBe(2);
  });

  it('does not hydrate a strict snapshot whose generated time is future or TTL exceeds 24 hours', async () => {
    const repository = createMemoryStateRepository();
    const store = consumerStore(repository);
    const future = await snapshot(
      1,
      SOURCE_URL,
      CLOCK,
      '2030-01-01T02:00:00.000Z',
      '2030-01-02T00:00:00.000Z',
    );
    await expect(store.put(key(), future)).rejects.toMatchObject({ code: 'invalid' });
    const cache = new PersistentOpenClawFeedCache({ store, tenantId: TENANT, now: () => CLOCK });
    const response304 = async () => new Response(null, {
      status: 304,
      headers: { etag: future.etag, 'last-modified': LAST_MODIFIED },
    });
    await expect(cache.refresh({
      url: SOURCE_URL,
      expectedFeedId: FEED_ID,
      allowedOrigins: ['https://feed.example'],
      fetcher: response304,
    })).resolves.toMatchObject({ kind: 'rejected', status: 304, error: 'no-cache' });

    const longTtl = await snapshot(
      2,
      SOURCE_URL,
      CLOCK,
      '2030-01-01T00:00:00.000Z',
      '2030-01-03T00:00:00.000Z',
    );
    await expect(store.put(key(), longTtl)).rejects.toMatchObject({ code: 'invalid' });
  });
});
