import { describe, expect, it } from "vitest";
import {
  OPENCLAW_OFFICIAL_FEED_ID,
  OPENCLAW_SOURCE_CLAWHUB,
  OpenClawFeedCache,
  serializeOpenClawFeed,
  sha256,
  validateOpenClawFeedUrl,
  type OpenClawFeed,
  type OpenClawSkillEntry,
} from "../src/index.ts";

const FUTURE_GENERATED = "2030-01-01T00:00:00.000Z";
const FUTURE_EXPIRY = "2030-01-02T00:00:00.000Z";

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
