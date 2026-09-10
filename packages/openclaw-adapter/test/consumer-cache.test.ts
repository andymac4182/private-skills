import { describe, expect, it } from 'vitest';
import {
  PersistentOpenClawFeedCache,
  StateRepositoryOpenClawConsumerSnapshotStore,
} from '../src/index.ts';
import { createMemoryStateRepository } from '../../database/src/index.ts';
import {
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

async function snapshot(
  sequence = 1,
  sourceUrl = SOURCE_URL,
  acceptedAt = CLOCK,
): Promise<OpenClawCacheSnapshot> {
  const body = serializeOpenClawFeed({
    schemaVersion: 1,
    id: FEED_ID,
    generatedAt: '2030-01-01T00:00:00.000Z',
    sequence,
    expiresAt: '2030-01-02T00:00:00.000Z',
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
    const first = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
    const original = await snapshot();

    await first.put(key(), original);

    // A fresh adapter over the same StateRepository models a process restart.
    const restarted = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
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
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
    await store.put(key(), await snapshot());

    await expect(store.read(key({ tenantId: 'tenant-b' }))).resolves.toBeUndefined();
    await expect(store.read(key({ feedId: 'other-feed' }))).resolves.toBeUndefined();
    await expect(store.read(key({ sourceUrl: OTHER_SOURCE_URL }))).resolves.toBeUndefined();
  });

  it('rejects replay and same-sequence equivocation while allowing an identical revalidation timestamp', async () => {
    const repository = createMemoryStateRepository();
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
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
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
    const original = await snapshot();
    await store.put(key(), original);
    let calls = 0;
    const fetcher = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls += 1;
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
  });

  it('persists a newly accepted 200 snapshot and enforces per-tenant bounds', async () => {
    const repository = createMemoryStateRepository();
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository, {
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

  it('does not reuse a durable snapshot when the origin changes or the snapshot expires', async () => {
    const repository = createMemoryStateRepository();
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
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
});
