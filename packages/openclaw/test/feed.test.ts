import { describe, expect, it } from "vitest";
import {
  OPENCLAW_OFFICIAL_FEED_ID,
  OPENCLAW_SOURCE_CLAWHUB,
  OPENCLAW_SOURCE_GITHUB,
  createOpenClawTenantFeedPreview,
  normalizeOpenClawCandidate,
  parseOpenClawFeed,
  produceOpenClawFeed,
  serializeOpenClawFeed,
  sha256,
  verifyOpenClawArtifactDigest,
  verifyOpenClawGithubContentHash,
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

describe("OpenClaw hosted feed v1", () => {
  it("round-trips the exact schema-v1 envelope with deterministic ordering", () => {
    const value = feed({
      entries: [skillEntry(), { ...skillEntry(), id: "@acme/alpha", title: "Alpha" }],
    });
    const body = serializeOpenClawFeed(value);
    expect(body.indexOf('"id":"@acme/alpha"')).toBeLessThan(body.indexOf('"id":"@acme/demo"'));
    expect(parseOpenClawFeed(body, { now: Date.parse("2029-12-01T00:00:00.000Z") }).entries).toHaveLength(2);
    expect(parseOpenClawFeed(value, { now: Date.parse("2029-12-01T00:00:00.000Z") }).entries).toHaveLength(2);
  });

  it("rejects wrong schema, duplicate identities, expired/replayed snapshots, and unknown fields", () => {
    expect(() => parseOpenClawFeed(JSON.stringify({ ...feed(), schemaVersion: 2 }))).toThrow(
      "unsupported feed schema version",
    );
    expect(() =>
      parseOpenClawFeed(
        JSON.stringify({ ...feed(), entries: [skillEntry(), skillEntry()] }),
        { now: Date.parse("2029-12-01T00:00:00.000Z") },
      ),
    ).toThrow("duplicate entry id");
    expect(() =>
      parseOpenClawFeed(
        JSON.stringify(
          feed({
            generatedAt: "2028-01-01T00:00:00.000Z",
            expiresAt: "2029-01-01T00:00:00.000Z",
          }),
        ),
        {
        now: Date.parse("2029-12-01T00:00:00.000Z"),
        },
      ),
    ).toThrow("feed has expired");
    expect(() =>
      parseOpenClawFeed(JSON.stringify(feed()), {
        now: Date.parse("2029-12-01T00:00:00.000Z"),
        previousSequence: 1,
      }),
    ).toThrow("not newer");
    expect(() => parseOpenClawFeed(JSON.stringify({ ...feed(), signature: "unsigned" }))).toThrow(
      "unsupported field",
    );
  });

  it("keeps public GitHub identity exact and does not infer source URLs", () => {
    const entry = skillEntry({
      id: "@nvidia/aiq-deploy",
      version: "1111111111111111111111111111111111111111",
      install: {
        candidates: [
          {
            sourceRef: OPENCLAW_SOURCE_GITHUB,
            package: "@nvidia/aiq-deploy",
            version: "1111111111111111111111111111111111111111",
            integrity: "sha256:folder-hash",
              github: {
                repo: "NVIDIA/skills",
                path: "skills/aiq-deploy",
                commit: "1111111111111111111111111111111111111111",
                contentHash: "folder-hash",
              },
          },
        ],
      },
    });
    expect(normalizeOpenClawCandidate(entry, entry.install.candidates[0]!)).toMatchObject({
      source: {
        kind: "public-github",
        repo: "NVIDIA/skills",
        path: "skills/aiq-deploy",
        commit: "1111111111111111111111111111111111111111",
        contentHash: "folder-hash",
      },
    });
    expect(() =>
      normalizeOpenClawCandidate(entry, {
        ...entry.install.candidates[0]!,
        integrity: "sha256:other",
      }),
    ).toThrow("integrity");
    const normalized = normalizeOpenClawCandidate(entry, entry.install.candidates[0]!);
    expect(() => verifyOpenClawGithubContentHash(normalized.source, "changed-hash")).toThrow(
      "digest",
    );
    expect(
      normalizeOpenClawCandidate(
        {
          ...entry,
          id: "@nvidia/root",
          install: {
            candidates: [
              {
                ...entry.install.candidates[0]!,
                package: "@nvidia/root",
                github: { ...entry.install.candidates[0]!.github!, path: "" },
              },
            ],
          },
        },
        {
          ...entry.install.candidates[0]!,
          package: "@nvidia/root",
          github: { ...entry.install.candidates[0]!.github!, path: "" },
        },
      ).source,
    ).toMatchObject({ path: "" });
  });

  it("verifies hosted bytes independently from the feed entry", async () => {
    const bytes = new TextEncoder().encode("hello");
    const digest = await sha256(bytes);
    await expect(verifyOpenClawArtifactDigest(bytes, digest)).resolves.toBe(digest);
    await expect(verifyOpenClawArtifactDigest(bytes, "sha256:abc")).rejects.toThrow(
      "not a SHA-256 digest",
    );
  });

  it("accepts the empty and 1,000-entry boundaries but rejects 1,001 entries and truncation", () => {
    const entries = Array.from({ length: 1_000 }, (_, index) =>
      skillEntry({
        id: `@acme/skill-${index}`,
        title: `Skill ${index}`,
        install: {
          candidates: [
            {
              sourceRef: OPENCLAW_SOURCE_CLAWHUB,
              package: `@acme/skill-${index}`,
              version: "1.0.0",
              integrity: `sha256:declared-${index}`,
            },
          ],
        },
      }),
    );
    expect(parseOpenClawFeed(serializeOpenClawFeed(feed({ entries: [] })), {
      now: Date.parse("2029-12-01T00:00:00.000Z"),
    }).entries).toHaveLength(0);
    expect(parseOpenClawFeed(serializeOpenClawFeed(feed({ entries })), {
      now: Date.parse("2029-12-01T00:00:00.000Z"),
    }).entries).toHaveLength(1_000);
    expect(() => parseOpenClawFeed(serializeOpenClawFeed(feed({ entries: [...entries, skillEntry({ id: "@acme/overflow" })] })), {
      now: Date.parse("2029-12-01T00:00:00.000Z"),
    })).toThrow("more than 1000");
    const body = serializeOpenClawFeed(feed());
    expect(() => parseOpenClawFeed(body.slice(0, -1), {
      now: Date.parse("2029-12-01T00:00:00.000Z"),
    })).toThrow("valid JSON");
  });

  it("defaults production output to private tenant scope and reserves the official id", async () => {
    const produced = await produceOpenClawFeed({
      id: "private/acme",
      generatedAt: FUTURE_GENERATED,
      sequence: 1,
      expiresAt: FUTURE_EXPIRY,
      entries: [skillEntry()],
      tenantId: "tenant-acme",
    });
    expect(produced.visibility).toBe("private");
    expect(produced.tenantId).toBe("tenant-acme");
    expect(produced.body).not.toContain("tenant-acme");
    await expect(
      produceOpenClawFeed({
        ...feed(),
        tenantId: "tenant-acme",
      }),
    ).rejects.toThrow("reserved");
    await expect(
      produceOpenClawFeed({
        id: "public/acme",
        generatedAt: FUTURE_GENERATED,
        sequence: 1,
        expiresAt: FUTURE_EXPIRY,
        entries: [skillEntry()],
        visibility: "public",
        tenantId: "tenant-acme",
      }),
    ).rejects.toThrow("tenant id");
    await expect(
      createOpenClawTenantFeedPreview({
        ...feed({ id: "private/acme" }),
        authenticatedTenantId: "tenant-acme",
      }),
    ).resolves.toMatchObject({ visibility: "private", tenantId: "tenant-acme" });
  });
});

