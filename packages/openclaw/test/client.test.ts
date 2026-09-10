import { describe, expect, it } from "vitest";
import {
  OPENCLAW_CLAWHUB_SKILLS_API_URL,
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
  OPENCLAW_OFFICIAL_FEED_ID,
  OPENCLAW_SOURCE_CLAWHUB,
  OpenClawFeedCache,
  serializeOpenClawFeed,
  sha256,
  validateOpenClawFeedUrl,
  type OpenClawFeed,
  type OpenClawSkillEntry,
} from "../src/index.ts";

const FUTURE_GENERATED = "2029-12-01T00:00:00.000Z";
const FUTURE_EXPIRY = "2029-12-02T00:00:00.000Z";

function skillEntry(overrides: Partial<OpenClawSkillEntry> = {}): OpenClawSkillEntry {
  return {
    type: "skill",
    id: "@acme/demo",
    title: "Demo",
    version: "1.0.0",
    state: "available",
    publisher: { id: "acme", trust: "official" },
    install: {
      candidates: [
        {
          sourceRef: OPENCLAW_SOURCE_CLAWHUB,
          package: "@acme/demo",
          version: "1.0.0",
          integrity: "sha256:declared-artifact",
        },
      ],
    },
    ...overrides,
  };
}

function feed(overrides: Partial<OpenClawFeed> = {}): OpenClawFeed {
  return {
    schemaVersion: 1,
    id: OPENCLAW_OFFICIAL_FEED_ID,
    generatedAt: FUTURE_GENERATED,
    sequence: 1,
    expiresAt: FUTURE_EXPIRY,
    entries: [skillEntry()],
    ...overrides,
  };
}

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("OpenClaw feed transport and cache", () => {
  it("uses conditional requests and serves an immutable last-known-good snapshot on 304", async () => {
    const body = serializeOpenClawFeed(feed());
    const requests: RequestInit[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return response(body);
      }
      expect(new Headers(init?.headers).get("if-none-match")).toMatch(/^"sha256:/u);
      return new Response(null, { status: 304 });
    };
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const first = await cache.refresh({
      url: "https://feeds.example.test/api/v1/feeds/skills",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher,
    });
    expect(first.kind).toBe("accepted");
    const second = await cache.refresh({
      url: "https://feeds.example.test/api/v1/feeds/skills",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher,
    });
    expect(second.kind).toBe("not-modified");
    if (first.kind !== "accepted" || second.kind !== "not-modified") {
      throw new Error("expected accepted and not-modified results");
    }
    expect(second.snapshot.sha256).toBe(first.snapshot.sha256);
    const copy = cache.getSnapshot()!;
    copy.feed.entries[0]!.title = "mutated caller copy";
    expect(cache.getSnapshot()!.feed.entries[0]!.title).toBe("Demo");
  });

  it("accepts only the pinned digest ETag for a 200 hosted-feed response", async () => {
    const body = serializeOpenClawFeed(feed());
    const digest = await sha256(new TextEncoder().encode(body));
    const matching = new OpenClawFeedCache({
      now: () => Date.parse("2029-12-01T00:00:00.000Z"),
    });
    const accepted = await matching.refresh({
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async () => response(body, { headers: { etag: `"${digest}"` } }),
    });
    expect(accepted.kind).toBe("accepted");

    const opaque = await new OpenClawFeedCache({
      now: () => Date.parse("2029-12-01T00:00:00.000Z"),
    }).refresh({
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async () => response(body, { headers: { etag: '"opaque-revision-7"' } }),
    });
    expect(opaque.kind).toBe("rejected");
    if (opaque.kind !== "rejected") throw new Error("expected opaque ETag rejection");
    expect(opaque.error).toBe("invalid-etag");
  });

  it("accepts the pinned live ClawHub skills profile only with body-bound CDN validators", async () => {
    const generatedAt = "2029-11-30T02:00:00.000Z";
    const body = serializeOpenClawFeed(
      feed({
        id: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
        generatedAt,
        expiresAt: "2029-12-07T00:00:00.000Z",
      }),
    );
    const digest = await sha256(new TextEncoder().encode(body));
    let calls = 0;
    let conditionalHeader: string | null = null;
    const cache = new OpenClawFeedCache({
      now: () => Date.parse("2029-12-01T00:00:00.000Z"),
    });
    const accepted = await cache.refresh({
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ["https://clawhub.ai"],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      fetcher: async (_input, init) => {
        calls += 1;
        conditionalHeader = new Headers(init?.headers).get("if-none-match");
        expect(init?.redirect).toBe("error");
        return calls === 1
          ? response(body, {
              headers: {
                etag: `W/"${digest}-gzip"`,
                "x-content-sha256": digest,
              },
            })
          : new Response(null, {
              status: 304,
              headers: { etag: `W/"${digest}-gzip"` },
            });
      },
    });
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error("expected live profile acceptance");
    // The CDN validator is transport metadata only; the cache stores the
    // canonical body digest so durable consumers can revalidate it safely.
    expect(accepted.snapshot.etag).toBe(`"${digest}"`);
    expect(accepted.snapshot.transportEtag).toBe(`W/"${digest}-gzip"`);
    expect(accepted.snapshot.sha256).toBe(digest);
    expect(conditionalHeader).toBeNull();
    const revalidated = await cache.refresh({
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ["https://clawhub.ai"],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      fetcher: async (_input, init) => {
        conditionalHeader = new Headers(init?.headers).get("if-none-match");
        return new Response(null, {
          status: 304,
          headers: { etag: `W/"${digest}-gzip"` },
        });
      },
    });
    expect(revalidated.kind).toBe("not-modified");
    expect(conditionalHeader).toBe(`W/"${digest}-gzip"`);

    const mismatchedHeader = await new OpenClawFeedCache({
      now: () => Date.parse("2029-12-01T00:00:00.000Z"),
    }).refresh({
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ["https://clawhub.ai"],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      fetcher: async () => response(body, {
        headers: {
          etag: `"${digest}-gzip"`,
          "x-content-sha256": `sha256:${"0".repeat(64)}`,
        },
      }),
    });
    expect(mismatchedHeader.kind).toBe("rejected");
    if (mismatchedHeader.kind !== "rejected") throw new Error("expected digest rejection");
    expect(mismatchedHeader.error).toBe("digest-mismatch");
  });

  it("keeps the live profile host, path, identity, and wire expiry pinned", async () => {
    const generatedAt = "2029-11-30T00:00:00.000Z";
    const body = serializeOpenClawFeed(
      feed({
        id: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
        generatedAt,
        expiresAt: "2029-12-08T00:00:00.000Z",
      }),
    );
    let calls = 0;
    const base = {
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ["https://clawhub.ai"],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      fetcher: async () => {
        calls += 1;
        return response(body);
      },
    } as const;
    const wrongPath = await new OpenClawFeedCache().refresh({
      ...base,
      url: "https://clawhub.ai/v1/feeds/skills",
    });
    expect(wrongPath.kind).toBe("rejected");
    if (wrongPath.kind !== "rejected") throw new Error("expected path rejection");
    expect(wrongPath.error).toBe("invalid-url");
    expect(calls).toBe(0);

    const wrongIdentity = await new OpenClawFeedCache().refresh({
      ...base,
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
    });
    expect(wrongIdentity.kind).toBe("rejected");
    if (wrongIdentity.kind !== "rejected") throw new Error("expected identity rejection");
    expect(wrongIdentity.error).toBe("invalid-url");
    expect(calls).toBe(0);

    const tooLong = await new OpenClawFeedCache({
      now: () => Date.parse("2029-12-01T00:00:00.000Z"),
    }).refresh({
      ...base,
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      fetcher: async () => response(
        serializeOpenClawFeed(
          feed({
            id: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
            generatedAt,
            expiresAt: "2029-12-08T00:00:00.000Z",
          }),
        ),
      ),
    });
    expect(tooLong.kind).toBe("rejected");
    if (tooLong.kind !== "rejected") throw new Error("expected expiry rejection");
    expect(tooLong.error).toBe("invalid-feed");
  });

  it("uses the effective one-day local expiry for the live seven-day wire profile", async () => {
    const body = serializeOpenClawFeed(
      feed({
        id: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
        generatedAt: "2029-11-30T02:00:00.000Z",
        expiresAt: "2029-12-07T00:00:00.000Z",
      }),
    );
    let now = Date.parse("2029-12-01T01:00:00.000Z");
    const cache = new OpenClawFeedCache({
      now: () => now,
      maxStaleMs: 7 * 24 * 60 * 60 * 1_000,
    });
    const request = {
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ["https://clawhub.ai"],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      fetcher: async () => response(body),
    } as const;
    const first = await cache.refresh(request);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") throw new Error("expected live profile acceptance");
    now = Date.parse("2029-12-01T02:00:00.001Z");
    const laterResult = await cache.refresh({
      ...request,
      fetcher: async () => new Response(null, { status: 304 }),
    });
    expect(laterResult.kind).toBe("rejected");
    if (laterResult.kind !== "rejected") throw new Error("expected effective expiry rejection");
    expect(laterResult.error).toBe("no-cache");
  });

  it("rejects a first 200 at the effective one-day boundary without retaining a snapshot", async () => {
    const body = serializeOpenClawFeed(
      feed({
        id: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
        generatedAt: "2029-11-30T00:00:00.000Z",
        expiresAt: "2029-12-07T00:00:00.000Z",
      }),
    );
    const cache = new OpenClawFeedCache({
      now: () => Date.parse("2029-12-01T00:00:00.000Z"),
    });
    const result = await cache.refresh({
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ["https://clawhub.ai"],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
      fetcher: async () => response(body),
    });
    expect(result).toMatchObject({ kind: "rejected", status: 200, error: "invalid-feed" });
    expect(cache.getSnapshot()).toBeUndefined();
  });

  it("rejects a strict-profile feed whose declared TTL exceeds 24 hours", async () => {
    const body = serializeOpenClawFeed(feed({
      generatedAt: FUTURE_GENERATED,
      expiresAt: "2029-12-03T00:00:00.000Z",
    }));
    const cache = new OpenClawFeedCache({
      now: () => Date.parse("2029-12-01T00:00:00.000Z"),
    });
    const result = await cache.refresh({
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async () => response(body),
    });
    expect(result).toMatchObject({ kind: "rejected", status: 200, error: "invalid-feed" });
    expect(cache.getSnapshot()).toBeUndefined();
  });

  it("rechecks the clock after a delayed 200 body before accepting it", async () => {
    const body = serializeOpenClawFeed(feed());
    const bodyBytes = new TextEncoder().encode(body);
    const expiry = Date.parse(FUTURE_EXPIRY);
    let now = expiry - 1;
    let pulled = false;
    const delayedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulled) return;
        pulled = true;
        await Promise.resolve();
        now = expiry;
        controller.enqueue(bodyBytes);
        controller.close();
      },
    });
    const cache = new OpenClawFeedCache({ now: () => now });
    const result = await cache.refresh({
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async () => new Response(delayedBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    expect(result).toMatchObject({ kind: "rejected", status: 200, error: "invalid-feed" });
    expect(cache.getSnapshot()).toBeUndefined();
  });

  it("rechecks the clock after the asynchronous digest before accepting a 200", async () => {
    const body = serializeOpenClawFeed(feed());
    const expiry = Date.parse(FUTURE_EXPIRY);
    let nowReads = 0;
    const cache = new OpenClawFeedCache({
      // The third read occurs after the awaited WebCrypto digest. Returning
      // the boundary there models expiry while hashing/validator work is in
      // flight without changing the production clock source.
      now: () => (nowReads++ < 2 ? expiry - 1 : expiry),
    });
    const result = await cache.refresh({
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async () => response(body),
    });
    expect(result).toMatchObject({ kind: "rejected", status: 200, error: "invalid-feed" });
    expect(cache.getSnapshot()).toBeUndefined();
  });

  it("rechecks the clock after a delayed 304 before serving the cached snapshot", async () => {
    const body = serializeOpenClawFeed(feed());
    const expiry = Date.parse(FUTURE_EXPIRY);
    let now = expiry - 1;
    let calls = 0;
    const cache = new OpenClawFeedCache({ now: () => now });
    const request = {
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return response(body);
        await Promise.resolve();
        now = expiry;
        return new Response(null, { status: 304 });
      },
    } as const;
    await expect(cache.refresh(request)).resolves.toMatchObject({ kind: "accepted" });
    await expect(cache.refresh(request)).resolves.toMatchObject({ kind: "rejected", status: 304, error: "no-cache" });
  });

  it("does not accept a 304 with conflicting response validators", async () => {
    const body = serializeOpenClawFeed(feed());
    const digest = await sha256(new TextEncoder().encode(body));
    let calls = 0;
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const request = {
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async (): Promise<Response> => {
        calls += 1;
        if (calls === 1) {
          return response(body, {
            headers: {
              etag: `"${digest}"`,
              "last-modified": "Tue, 01 Jan 2030 00:00:00 GMT",
            },
          });
        }
        if (calls === 2) {
          return new Response(null, {
            status: 304,
            headers: { etag: `"sha256:${"0".repeat(64)}"` },
          });
        }
        return new Response(null, {
          status: 304,
          headers: {
            etag: `"${digest}"`,
            "last-modified": "Wed, 02 Jan 2030 00:00:00 GMT",
          },
        });
      },
    } as const;
    expect((await cache.refresh(request)).kind).toBe("accepted");
    const conflictingEtag = await cache.refresh(request);
    expect(conflictingEtag.kind).toBe("stale");
    if (conflictingEtag.kind !== "stale") throw new Error("expected stale ETag conflict");
    expect(conflictingEtag.error).toBe("invalid-etag");
    const conflictingLastModified = await cache.refresh(request);
    expect(conflictingLastModified.kind).toBe("stale");
    if (conflictingLastModified.kind !== "stale") throw new Error("expected stale Last-Modified conflict");
    expect(conflictingLastModified.error).toBe("invalid-feed");
  });

  it("does not replace the cache with malformed, wrong-identity, or oversized responses", async () => {
    const body = serializeOpenClawFeed(feed());
    let call = 0;
    const fetcher = async (): Promise<Response> => {
      call += 1;
      if (call === 1) return response(body);
      if (call === 2) return response(JSON.stringify({ ...feed(), id: "other-feed", sequence: 2 }));
      return response("x", { headers: { "content-length": "9999999" } });
    };
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const request = {
      url: "https://feeds.example.test/v1/feeds/skills",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher,
    } as const;
    expect((await cache.refresh(request)).kind).toBe("accepted");
    const malformed = await cache.refresh(request);
    expect(malformed.kind).toBe("stale");
    if (malformed.kind !== "stale") {
      throw new Error("expected stale result");
    }
    expect(malformed.error).toBe("invalid-feed");
    expect(malformed.snapshot.feed.id).toBe(OPENCLAW_OFFICIAL_FEED_ID);
    const oversized = await cache.refresh(request);
    expect(oversized.kind).toBe("stale");
    if (oversized.kind !== "stale") {
      throw new Error("expected stale result");
    }
    expect(oversized.error).toBe("body-too-large");
  });

  it("supports an optional exact payload checksum without making it a source artifact digest", async () => {
    const body = serializeOpenClawFeed(feed());
    const digest = await sha256(new TextEncoder().encode(body));
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const base = {
      url: "https://feeds.example.test/v1/feeds/skills",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async () => response(body),
    } as const;
    const accepted = await cache.refresh({ ...base, expectedSha256: digest.slice("sha256:".length) });
    expect(accepted.kind).toBe("accepted");
    const rejected = await new OpenClawFeedCache({
      now: () => Date.parse("2029-12-01T00:00:00.000Z"),
    }).refresh({ ...base, expectedSha256: "sha256:" + "0".repeat(64) });
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") throw new Error("expected rejected result");
    expect(rejected.error).toBe("digest-mismatch");
  });

  it("does not return a prior snapshot for an invalid or changed cache identity", async () => {
    const body = serializeOpenClawFeed(feed());
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const base = {
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async () => response(body),
    } as const;
    const accepted = await cache.refresh({
      ...base,
      url: "https://feeds.example.test/feed",
    });
    expect(accepted.kind).toBe("accepted");

    const changedUrl = await cache.refresh({
      ...base,
      url: "https://feeds.example.test/other-feed",
    });
    expect(changedUrl.kind).toBe("rejected");
    if (changedUrl.kind !== "rejected") throw new Error("expected rejected changed identity");
    expect(changedUrl.error).toBe("invalid-url");
    expect(changedUrl.snapshot).toBeUndefined();

    const invalidUrl = await cache.refresh({
      ...base,
      url: "https://feeds.example.test/feed?unexpected=1",
    });
    expect(invalidUrl.kind).toBe("rejected");
    if (invalidUrl.kind !== "rejected") throw new Error("expected rejected invalid url");
    expect(invalidUrl.error).toBe("invalid-url");
    expect(invalidUrl.snapshot).toBeUndefined();
  });

  it("does not reuse a cached snapshot when a 304 violates the current payload pin", async () => {
    const body = serializeOpenClawFeed(feed());
    let calls = 0;
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const request = {
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async (): Promise<Response> => {
        calls += 1;
        return calls === 1 ? response(body) : new Response(null, { status: 304 });
      },
    } as const;
    const first = await cache.refresh(request);
    expect(first.kind).toBe("accepted");
    const second = await cache.refresh({ ...request, expectedSha256: "0".repeat(64) });
    expect(second.kind).toBe("rejected");
    if (second.kind !== "rejected") throw new Error("expected rejected pin mismatch");
    expect(second.error).toBe("digest-mismatch");
    expect(second.status).toBe(304);
    expect(second.snapshot).toBeUndefined();
  });

  it("accepts an identical same-sequence body but rejects same-sequence equivocation", async () => {
    const identicalBody = serializeOpenClawFeed(feed({ sequence: 4 }));
    const changedBody = serializeOpenClawFeed(
      feed({ sequence: 4, entries: [{ ...skillEntry(), title: "Changed" }] }),
    );
    let calls = 0;
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return response(calls <= 2 ? identicalBody : changedBody);
    };
    const request = {
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher,
    } as const;
    expect((await cache.refresh(request)).kind).toBe("accepted");
    expect((await cache.refresh(request)).kind).toBe("accepted");
    const equivocation = await cache.refresh(request);
    expect(equivocation.kind).toBe("stale");
    if (equivocation.kind !== "stale") throw new Error("expected stale equivocation result");
    expect(equivocation.error).toBe("equivocation");
    expect(equivocation.snapshot.feed.entries[0]?.title).toBe("Demo");
  });

  it("serializes refreshes so an older response cannot commit after a newer response", async () => {
    const firstBody = serializeOpenClawFeed(feed({ sequence: 2 }));
    const secondBody = serializeOpenClawFeed(feed({ sequence: 3 }));
    let calls = 0;
    let activeBodies = 0;
    let maxActiveBodies = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      const body = calls === 1 ? firstBody : secondBody;
      const delay = calls === 1 ? 20 : 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            activeBodies += 1;
            maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
              activeBodies -= 1;
            }, delay);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const request = {
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher,
    } as const;
    const [first, second] = await Promise.all([cache.refresh(request), cache.refresh(request)]);
    expect(first.kind).toBe("accepted");
    expect(second.kind).toBe("accepted");
    expect(maxActiveBodies).toBe(1);
    expect(cache.getSnapshot()?.feed.sequence).toBe(3);
  });

  it("rejects redirects before consuming a response body", async () => {
    let calls = 0;
    const cache = new OpenClawFeedCache({ now: () => Date.parse("2029-12-01T00:00:00.000Z") });
    const result = await cache.refresh({
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      fetcher: async (_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe("error");
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.test/feed" },
        });
      },
    });
    expect(calls).toBe(1);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("expected rejected redirect");
    expect(result.error).toBe("redirected");
    expect(result.status).toBe(302);
  });

  it("fails closed on URL credentials, query strings, non-HTTPS, and non-allowlisted origins", () => {
    expect(() => validateOpenClawFeedUrl("https://feeds.example.test/feed?token=secret", ["https://feeds.example.test"])).toThrow();
    expect(() => validateOpenClawFeedUrl("http://feeds.example.test/feed", ["http://feeds.example.test"])).toThrow();
    expect(() => validateOpenClawFeedUrl("https://other.example.test/feed", ["https://feeds.example.test"])).toThrow();
    expect(() => validateOpenClawFeedUrl("https://user:secret@feeds.example.test/feed", ["https://feeds.example.test"])).toThrow();
  });

  it("bounds a non-yielding response body with the request timeout", async () => {
    const fetcher = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Deliberately never enqueue or close.
          },
        }),
        { status: 200 },
      );
    const cache = new OpenClawFeedCache({
      now: () => Date.now(),
      maxStaleMs: 60_000,
    });
    const result = await cache.refresh({
      url: "https://feeds.example.test/feed",
      expectedFeedId: OPENCLAW_OFFICIAL_FEED_ID,
      allowedOrigins: ["https://feeds.example.test"],
      timeoutMs: 20,
      fetcher,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") {
      throw new Error("expected rejected result");
    }
    expect(result.error).toBe("timeout");
  });
});
