import { describe, expect, it } from 'vitest';
import {
  OPENCLAW_RESERVED_OFFICIAL_FEED_ID,
  createOpenClawSkillsFeedHandler,
  previewOpenClawFeed,
  type OpenClawEligibleRecord,
} from '../src/index.ts';
import { OpenClawFeedCache } from '../../openclaw/src/client.ts';
import { serializeOpenClawFeed } from '../../openclaw/src/feed.ts';
import type { OpenClawFeed, OpenClawSkillEntry } from '../../openclaw/src/types.ts';
import type { Principal } from '../../contracts/src/index.ts';

const DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
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
  return { entry, canonicalDigest: DIGEST };
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
    let sourceCalls = 0;
    const handler = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      source: {
        listEligible: async () => {
          sourceCalls += 1;
          return [record()];
        },
      },
      feedIdForTenant: () => 'private/opaque-a',
      sequenceForTenant: () => 7,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
      expiresInMs: 60_000,
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
    expect(sourceCalls).toBe(1);

    const repeated = await handler(new Request('https://registry.example/v1/feeds/skills'));
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(body);

    const second = await handler(new Request('https://registry.example/v1/feeds/skills', {
      headers: { 'if-none-match': response.headers.get('etag')! },
    }));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(sourceCalls).toBe(3);
  });

  it('rejects unauthenticated or unauthorized readers before consulting the source', async () => {
    let sourceCalls = 0;
    const handler = createOpenClawSkillsFeedHandler({
      authenticate: async () => null,
      source: { listEligible: async () => { sourceCalls += 1; return [record()]; } },
      feedIdForTenant: () => 'private/opaque-a',
      sequenceForTenant: () => 1,
    });
    expect((await handler(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(401);
    expect(sourceCalls).toBe(0);

    const scopedOut = createOpenClawSkillsFeedHandler({
      authenticate: async () => ({ ...PRINCIPAL, scopes: ['registry:write'] }),
      source: { listEligible: async () => { sourceCalls += 1; return [record()]; } },
      feedIdForTenant: () => 'private/opaque-a',
      sequenceForTenant: () => 1,
    });
    expect((await scopedOut(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(401);
    expect(sourceCalls).toBe(0);
  });

  it('fails closed for reserved identities and unapproved or mismatched records', async () => {
    const reserved = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      source: { listEligible: async () => [] },
      feedIdForTenant: () => OPENCLAW_RESERVED_OFFICIAL_FEED_ID,
      sequenceForTenant: () => 1,
    });
    expect((await reserved(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(500);

    const blocked = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      source: { listEligible: async () => [record({ state: 'blocked' })] },
      feedIdForTenant: () => 'private/opaque-a',
      sequenceForTenant: () => 1,
    });
    expect((await blocked(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(500);

    const mismatch = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      source: {
        listEligible: async () => [{ ...record(), canonicalDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' }],
      },
      feedIdForTenant: () => 'private/opaque-a',
      sequenceForTenant: () => 1,
    });
    expect((await mismatch(new Request('https://registry.example/v1/feeds/skills'))).status).toBe(500);

    const alternateCandidate = createOpenClawSkillsFeedHandler({
      authenticate: async () => PRINCIPAL,
      source: {
        listEligible: async () => [{
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
      },
      feedIdForTenant: () => 'private/opaque-a',
      sequenceForTenant: () => 1,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    });
    const alternateResponse = await alternateCandidate(new Request('https://registry.example/v1/feeds/skills'));
    expect(alternateResponse.status).toBe(200);
    expect(JSON.parse(await alternateResponse.text()).entries[0].install.candidates).toHaveLength(1);
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
