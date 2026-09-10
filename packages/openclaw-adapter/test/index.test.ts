import { describe, expect, it } from 'vitest';
import {
  createOpenClawFeedAdvertisement,
  createOpenClawTenantFeedRoute,
  OPENCLAW_RESERVED_OFFICIAL_FEED_ID,
  MemoryOpenClawPublicationStore,
  OpenClawAdapterError,
  OpenClawPublicationManager,
  createOpenClawSkillsFeedHandler,
  previewOpenClawFeed,
  selectOpenClawEligibleRecords,
  type OpenClawEligibleRecord,
  type OpenClawFeedPublicationSnapshot,
} from '../src/index.ts';
import { OpenClawFeedCache } from '../../openclaw/src/client.ts';
import { serializeOpenClawFeed } from '../../openclaw/src/feed.ts';
import type { OpenClawFeed, OpenClawSkillEntry } from '../../openclaw/src/types.ts';
import type { Principal } from '../../contracts/src/index.ts';

const DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const REGISTRY_DIGEST = 'sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const PRINCIPAL: Principal = {
  organizationId: 'tenant-a',
  subject: 'reader-a',
  roles: ['reader'],
  scopes: ['registry:read'],
};

function record(overrides: Partial<OpenClawSkillEntry> = {}): OpenClawEligibleRecord {
  const entry: OpenClawSkillEntry = {
    type: 'skill',
    id: '@team/demo',
    title: 'Demo skill',
    description: 'A private, approved skill',
    version: '1.0.0',
    state: 'available',
    publisher: { id: 'team', trust: 'community' },
    install: {
      candidates: [{
        sourceRef: 'public-clawhub',
        package: '@team/demo',
        version: '1.0.0',
        integrity: DIGEST,
      }],
    },
    ...overrides,
  };
  return {
    entry,
    registryArtifactDigest: REGISTRY_DIGEST,
    sourceArtifact: {
      verified: true,
      digest: DIGEST,
      format: 'clawhub-skill-v1',
      identity: '@team/demo@1.0.0',
    },
  };
}

function feed(overrides: Partial<OpenClawFeed> = {}): OpenClawFeed {
  return {
    schemaVersion: 1,
    id: 'private/opaque-a',
    generatedAt: '2030-01-01T00:00:00.000Z',
    sequence: 1,
    expiresAt: '2030-01-02T00:00:00.000Z',
    entries: [record().entry],
    ...overrides,
  };
}

describe('private OpenClaw producer route', () => {
  it('emits a deterministic authenticated private feed from eligible records only', async () => {
    let publicationCalls = 0;
    let clock = Date.parse('2030-01-01T00:00:00.000Z');
    const handler = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      publicationForTenant: async () => {
        publicationCalls += 1;
        return {
          id: 'private/opaque-a',
          generatedAt: '2030-01-01T00:00:00.000Z',
          sequence: 7,
          expiresAt: '2030-01-02T00:00:00.000Z',
          records: [record()],
        };
      },
      now: () => clock,
    });

    const response = await handler(new Request('https://registry.example/v1/feeds/skills'));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('tenant-a');
    expect(JSON.parse(body)).toMatchObject({
      schemaVersion: 1,
      id: 'private/opaque-a',
      sequence: 7,
      entries: [{
        id: '@team/demo',
        state: 'available',
        publisher: { id: 'team', trust: 'community' },
        install: { candidates: [{ integrity: DIGEST, sourceRef: 'public-clawhub' }] },
      }],
    });
    expect(publicationCalls).toBe(1);

    clock += 60 * 60 * 1_000;

    const second = await handler(new Request('https://registry.example/v1/feeds/skills', {
      headers: { 'if-none-match': response.headers.get('etag')! },
    }));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(publicationCalls).toBe(2);
  });

  it('rejects unauthenticated or unauthorized readers before consulting the source', async () => {
    let sourceCalls = 0;
    const handler = createOpenClawSkillsFeedHandler({
      authenticate: async () => null,
      publicationForTenant: async () => {
        sourceCalls += 1;
        return {
          id: 'private/opaque-a',
          generatedAt: '2030-01-01T00:00:00.000Z',
          sequence: 1,
          expiresAt: '2030-01-02T00:00:00.000Z',
          records: [record()],
        };
      },
    });
    expect((await handler(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(401);
    expect(sourceCalls).toBe(0);

    const scopedOut = createOpenClawSkillsFeedHandler({
      authenticate: async () => ({ ...PRINCIPAL, scopes: ['registry:write'] }),
      publicationForTenant: async () => {
        sourceCalls += 1;
        return {
          id: 'private/opaque-a',
          generatedAt: '2030-01-01T00:00:00.000Z',
          sequence: 1,
          expiresAt: '2030-01-02T00:00:00.000Z',
          records: [record()],
        };
      },
    });
    expect((await scopedOut(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(401);
    expect(sourceCalls).toBe(0);
  });

  it('fails closed for reserved identities and unapproved or mismatched records', async () => {
    const reserved = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      publicationForTenant: async () => ({
        id: OPENCLAW_RESERVED_OFFICIAL_FEED_ID,
        generatedAt: '2030-01-01T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-02T00:00:00.000Z',
        records: [],
      }),
    });
    expect((await reserved(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(500);

    const blocked = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      publicationForTenant: async () => ({
        id: 'private/opaque-a',
        generatedAt: '2030-01-01T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-02T00:00:00.000Z',
        records: [record({ state: 'blocked' })],
      }),
    });
    expect((await blocked(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(500);

    const mismatch = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      publicationForTenant: async () => ({
        id: 'private/opaque-a',
        generatedAt: '2030-01-01T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-02T00:00:00.000Z',
        records: [{
          ...record(),
          sourceArtifact: {
            ...record().sourceArtifact,
            digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          },
        }],
      }),
    });
    expect((await mismatch(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(500);

    const alternateCandidate = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      publicationForTenant: async () => ({
        id: 'private/opaque-a',
        generatedAt: '2030-01-01T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-02T00:00:00.000Z',
        records: [{
          ...record(),
          entry: {
            ...record().entry,
            install: {
              candidates: [
                ...record().entry.install.candidates,
                {
                  sourceRef: 'public-clawhub',
                  package: '@team/demo',
                  version: '1.0.0',
                  integrity: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                },
              ],
            },
          },
        }],
      }),
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    });
    const alternateResponse = await alternateCandidate(new Request('https://registry.example/v1/feeds/skills'));
    expect(alternateResponse.status).toBe(200);
    expect(JSON.parse(await alternateResponse.text()).entries[0].install.candidates).toHaveLength(1);
  });

  it('does not serve an expired publication until the host supplies a new sequence', async () => {
    let clock = Date.parse('2030-01-03T00:00:00.000Z');
    let publication: OpenClawFeedPublicationSnapshot = {
      id: 'private/opaque-a',
      generatedAt: '2030-01-01T00:00:00.000Z',
      sequence: 1,
      expiresAt: '2030-01-02T00:00:00.000Z',
      records: [record()],
    };
    const handler = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      publicationForTenant: async () => publication,
      now: () => clock,
    });
    expect((await handler(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(503);

    publication = {
      ...publication,
      generatedAt: '2030-01-03T00:00:00.000Z',
      sequence: 2,
      expiresAt: '2030-01-04T00:00:00.000Z',
    };
    clock = Date.parse('2030-01-03T00:00:00.000Z');
    expect((await handler(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(200);
  });

  it('serves the durable tenant snapshot bytes unchanged and isolates tenants', async () => {
    const store = new MemoryOpenClawPublicationStore();
    const manager = new OpenClawPublicationManager(store);
    await manager.publish({
      tenantId: 'tenant-a',
      publication: {
        id: 'private/opaque-a',
        generatedAt: '2030-01-01T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-02T00:00:00.000Z',
        records: [record()],
      },
    });
    await manager.publish({
      tenantId: 'tenant-b',
      publication: {
        id: 'private/opaque-b',
        generatedAt: '2030-01-01T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-02T00:00:00.000Z',
        records: [],
      },
    });
    const first = await manager.get('tenant-a');
    expect(first?.body).toBeTruthy();
    const originalBody = first!.body;
    first!.bytes[0] = first!.bytes[0]! ^ 1;
    expect((await manager.get('tenant-a'))?.body).toBe(originalBody);

    let clock = Date.parse('2030-01-01T01:00:00.000Z');
    const route = createOpenClawTenantFeedRoute({
      manager,
      authenticate: async () => PRINCIPAL,
      now: () => clock,
    });
    const response = await route(new Request('https://registry.example/v1/feeds/skills'));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(first!.etag);
    expect(await response.text()).toBe(originalBody);
    clock = Date.parse('2030-01-01T23:00:00.000Z');
    const notModified = await route(new Request('https://registry.example/v1/feeds/skills', {
      headers: { 'if-none-match': first!.etag },
    }));
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
    expect((await manager.get('tenant-b'))?.id).toBe('private/opaque-b');
  });

  it('keeps publication sequence monotonic under concurrent publication attempts', async () => {
    const store = new MemoryOpenClawPublicationStore();
    const manager = new OpenClawPublicationManager(store);
    const publication = (sequence: number): OpenClawFeedPublicationSnapshot => ({
      id: 'private/opaque-a',
      generatedAt: '2030-01-01T00:00:00.000Z',
      sequence,
      expiresAt: '2030-01-02T00:00:00.000Z',
      records: [record()],
    });
    const results = await Promise.allSettled([
      manager.publish({ tenantId: 'tenant-a', publication: publication(1) }),
      manager.publish({ tenantId: 'tenant-a', publication: publication(2) }),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(OpenClawAdapterError);
    }
    expect((await manager.get('tenant-a'))?.sequence).toBe(2);
    await expect(manager.publish({ tenantId: 'tenant-a', publication: publication(2) })).resolves.toMatchObject({ sequence: 2 });
    await expect(manager.publish({
      tenantId: 'tenant-a',
      publication: {
        ...publication(2),
        records: [record({ title: 'changed at the same sequence' })],
      },
    })).rejects.toMatchObject({ code: 'stale_publication' });
  });

  it('rejects future or overlong publication timestamps before serving them', async () => {
    const future = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      publicationForTenant: async () => ({
        id: 'private/opaque-a',
        generatedAt: '2030-01-02T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-02T01:00:00.000Z',
        records: [],
      }),
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    });
    expect((await future(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(500);

    const tooLong = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      publicationForTenant: async () => ({
        id: 'private/opaque-a',
        generatedAt: '2030-01-01T00:00:00.000Z',
        sequence: 1,
        expiresAt: '2030-01-03T00:00:00.000Z',
        records: [],
      }),
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    });
    expect((await tooLong(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(500);
  });
});

describe('OpenClaw approved-source projection and advertisement', () => {
  it('keeps only current approved records with bound public source proofs', () => {
    const approved = {
      state: 'approved' as const,
      version: '1.0.0',
      policyRevision: 'policy-1',
      artifact: { key: 'blob/a', digest: REGISTRY_DIGEST as `sha256:${string}`, size: 10 },
    };
    const selected = selectOpenClawEligibleRecords([
      { skill: approved, entry: record().entry, sourceArtifact: record().sourceArtifact },
      { skill: { ...approved, state: 'pending' }, entry: record({ id: '@team/pending' }).entry, sourceArtifact: record().sourceArtifact },
      { skill: { ...approved, state: 'revoked' }, entry: record({ id: '@team/revoked' }).entry, sourceArtifact: record().sourceArtifact },
      { skill: { ...approved, policyRevision: 'policy-2' }, entry: record({ id: '@team/stale' }).entry, sourceArtifact: record().sourceArtifact },
      { skill: approved, entry: record({ id: '@team/native' }).entry, sourceArtifact: undefined as never },
    ], (skill) => skill.policyRevision === 'policy-1' && skill.state === 'approved');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.registryArtifactDigest).toBe(REGISTRY_DIGEST);
    expect(selected[0]?.sourceArtifact.digest).toBe(DIGEST);
  });

  it('creates a private link descriptor without inventing an OpenClaw discovery endpoint', () => {
    expect(createOpenClawFeedAdvertisement({
      feedId: 'private/opaque-a',
      feedUrl: 'https://registry.example/v1/feeds/skills',
    })).toEqual({
      schemaVersion: 1,
      feedId: 'private/opaque-a',
      feedUrl: 'https://registry.example/v1/feeds/skills',
      visibility: 'private',
      authentication: 'tenant-reader',
    });
    expect(() => createOpenClawFeedAdvertisement({
      feedId: 'private/opaque-a',
      feedUrl: 'https://registry.example/v1/feeds/skills?token=secret',
    })).toThrow();
  });
});

describe('OpenClaw trusted-profile metadata preview', () => {
  it('returns validated metadata, supports 304, and exposes no body or artifact bytes', async () => {
    const body = serializeOpenClawFeed(feed());
    let calls = 0;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      expect(init?.redirect).toBe('manual');
      if (calls === 1) {
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(new Headers(init?.headers).get('if-none-match')).toMatch(/^"sha256:/u);
      return new Response(null, { status: 304 });
    };
    const cache = new OpenClawFeedCache({ now: () => Date.parse('2029-12-01T00:00:00.000Z') });
    const profile = {
      url: 'https://feeds.example.test/v1/feeds/skills',
      expectedFeedId: 'private/opaque-a',
      allowedOrigins: ['https://feeds.example.test'],
      fetcher,
    } as const;
    const first = await previewOpenClawFeed(profile, { cache });
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') throw new Error('expected accepted preview');
    expect(first.snapshot.feed.entries[0]?.id).toBe('@team/demo');
    expect('body' in first.snapshot).toBe(false);
    expect('bytes' in first.snapshot).toBe(false);

    const second = await previewOpenClawFeed(profile, { cache });
    expect(second.kind).toBe('not-modified');
    expect(calls).toBe(2);
  });

  it('rejects unsafe profiles and followed redirects without retaining a snapshot', async () => {
    let calls = 0;
    const unsafe = await previewOpenClawFeed({
      url: 'https://feeds.example.test/v1/feeds/skills?token=secret',
      expectedFeedId: 'private/opaque-a',
      allowedOrigins: ['https://feeds.example.test'],
      fetcher: async () => { calls += 1; return new Response('unexpected'); },
    });
    expect(unsafe).toMatchObject({ kind: 'rejected', error: 'invalid-url' });
    expect(calls).toBe(0);

    const followed = await previewOpenClawFeed({
      url: 'https://feeds.example.test/v1/feeds/skills',
      expectedFeedId: 'private/opaque-a',
      allowedOrigins: ['https://feeds.example.test'],
      fetcher: async () => {
        const response = new Response(serializeOpenClawFeed(feed()), { status: 200 });
        Object.defineProperty(response, 'url', { value: 'https://other.example.test/v1/feeds/skills' });
        return response;
      },
    });
    expect(followed).toMatchObject({ kind: 'rejected', error: 'invalid-url' });
  });
});
