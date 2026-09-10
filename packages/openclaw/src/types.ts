/**
 * The OpenClaw hosted catalog feed contract currently published by ClawHub.
 *
 * This package intentionally carries the wire types locally.  The host can
 * adapt these values into its own directory/contracts package without making
 * a public registry feed a dependency of the private registry.
 */

export const OPENCLAW_FEED_SCHEMA_VERSION = 1 as const;
export const OPENCLAW_SPEC_REPOSITORY = "openclaw/clawhub" as const;
export const OPENCLAW_SPEC_COMMIT = "694ff719e9b161ea770fe2abfdc43f2ff5401fe4" as const;
export const OPENCLAW_HOSTED_FEED_SPEC_BLOB = "9c1cd5c2d67b598bc470e0044713ecfc9725df1c" as const;
export const OPENCLAW_HOSTED_FEED_SPEC_URL =
  "https://github.com/openclaw/clawhub/blob/694ff719e9b161ea770fe2abfdc43f2ff5401fe4/specs/hosted-catalog-feed.md" as const;
export const OPENCLAW_GITHUB_SKILLS_SPEC_URL =
  "https://github.com/openclaw/clawhub/blob/694ff719e9b161ea770fe2abfdc43f2ff5401fe4/specs/github-backed-skills.md" as const;
export const OPENCLAW_GITHUB_SKILLS_SPEC_BLOB = "33f89b51815b4b6a188f2dc6a3e83afcb2835585" as const;
export const OPENCLAW_OFFICIAL_FEED_ID = "clawhub-official" as const;
export const OPENCLAW_SKILLS_FEED_ID = "clawhub-official-skills" as const;
export const OPENCLAW_FEED_ROUTE = "/v1/feeds/skills" as const;
export const OPENCLAW_SOURCE_CLAWHUB = "public-clawhub" as const;
export const OPENCLAW_SOURCE_GITHUB = "public-github" as const;
// Names used by ClawHub's reference schema package, kept as explicit aliases
// for adapters that consume the upstream shape directly.
export const CATALOG_FEED_SCHEMA_VERSION = OPENCLAW_FEED_SCHEMA_VERSION;
export const CATALOG_FEED_ID = OPENCLAW_OFFICIAL_FEED_ID;
export const CATALOG_SKILLS_FEED_ID = OPENCLAW_SKILLS_FEED_ID;
export const CATALOG_FEED_SOURCE_REF = OPENCLAW_SOURCE_CLAWHUB;
export const CATALOG_FEED_GITHUB_SOURCE_REF = OPENCLAW_SOURCE_GITHUB;
export const OPENCLAW_MAX_ENTRIES = 1_000;
export const OPENCLAW_DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const OPENCLAW_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const OPENCLAW_DEFAULT_TIMEOUT_MS = 5_000;
export const OPENCLAW_MAX_TIMEOUT_MS = 30_000;
export const OPENCLAW_DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1_000;
export const OPENCLAW_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1_000;

export type OpenClawFeedState =
  | "available"
  | "recommended"
  | "disabled"
  | "blocked"
  | "deprecated";

export type OpenClawPublisherTrust = "official" | "community";

export interface OpenClawGithubSource {
  repo: string;
  path: string;
  commit: string;
  contentHash: string;
}

export interface OpenClawInstallCandidate {
  sourceRef: string;
  package: string;
  version: string;
  integrity: string;
  github?: OpenClawGithubSource;
}

export interface OpenClawPublisher {
  id: string;
  trust: OpenClawPublisherTrust;
}

export interface OpenClawInstall {
  candidates: OpenClawInstallCandidate[];
}

export interface OpenClawFeedEntryBase {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  version: string;
  state: OpenClawFeedState;
  featured?: boolean;
  featuredAt?: number;
  publisher: OpenClawPublisher;
  install: OpenClawInstall;
}

export interface OpenClawPluginEntry extends OpenClawFeedEntryBase {
  type: "plugin";
}

export interface OpenClawSkillEntry extends OpenClawFeedEntryBase {
  type: "skill";
}

export type OpenClawFeedEntry = OpenClawPluginEntry | OpenClawSkillEntry;

export type CatalogFeed = OpenClawFeed;
export type CatalogFeedEntry = OpenClawFeedEntry;
export type CatalogFeedPluginEntry = OpenClawPluginEntry;
export type CatalogFeedSkillEntry = OpenClawSkillEntry;
export type CatalogFeedInstallCandidate = OpenClawInstallCandidate;
export type CatalogFeedGitHubSource = OpenClawGithubSource;

export interface OpenClawFeed {
  schemaVersion: 1;
  id: string;
  generatedAt: string;
  sequence: number;
  expiresAt: string;
  description?: string;
  entries: OpenClawFeedEntry[];
}

export type OpenClawVisibility = "private" | "public";

/**
 * Producer input.  `visibility` is metadata for the host publication layer;
 * it is deliberately not emitted into the OpenClaw wire payload.
 */
export interface OpenClawFeedPublication extends Omit<OpenClawFeed, "schemaVersion"> {
  visibility?: OpenClawVisibility;
  /** Required for private previews; never serialized into feed bytes. */
  tenantId?: string;
}

export type OpenClawSha256 = `sha256:${string}`;

export interface OpenClawProducedFeed {
  feed: OpenClawFeed;
  body: string;
  bytes: Uint8Array;
  sha256: OpenClawSha256;
  etag: string;
  lastModified: string;
  visibility: OpenClawVisibility;
  tenantId?: string;
}

export interface OpenClawTenantFeedPreviewInput
  extends Omit<OpenClawFeedPublication, "visibility"> {
  /** The already-authenticated tenant selected by the host request layer. */
  authenticatedTenantId: string;
  visibility?: OpenClawVisibility;
}

export interface OpenClawTenantFeedPreview extends OpenClawProducedFeed {
  visibility: "private";
  tenantId: string;
}

export interface OpenClawParseOptions {
  expectedFeedId?: string;
  now?: Date | number;
  /** Defaults to true. Serializer validation disables this only for old fixtures. */
  checkExpiry?: boolean;
  previousSequence?: number;
  maxBytes?: number;
}

export interface OpenClawNormalizedHostedSource {
  kind: "public-clawhub";
  sourceRef: typeof OPENCLAW_SOURCE_CLAWHUB;
  packageName: string;
  version: string;
  artifactDigest: string;
}

export interface OpenClawNormalizedGithubSource {
  kind: "public-github";
  sourceRef: typeof OPENCLAW_SOURCE_GITHUB;
  repo: string;
  path: string;
  commit: string;
  contentHash: string;
}

export type OpenClawNormalizedSource =
  | OpenClawNormalizedHostedSource
  | OpenClawNormalizedGithubSource;

export interface OpenClawNormalizedCandidate {
  entryId: string;
  entryType: OpenClawFeedEntry["type"];
  publisherId: string;
  publisherTrust: OpenClawPublisherTrust;
  candidate: OpenClawInstallCandidate;
  source: OpenClawNormalizedSource;
}

export interface OpenClawCacheSnapshot {
  feed: OpenClawFeed;
  body: string;
  bytes: Uint8Array;
  sha256: OpenClawSha256;
  etag: string;
  lastModified?: string;
  acceptedAt: number;
  sourceUrl: string;
}

export interface OpenClawFeedCacheOptions {
  maxBodyBytes?: number;
  maxStaleMs?: number;
  now?: () => number;
}

export interface OpenClawFeedRefreshRequest {
  url: string | URL;
  expectedFeedId: string;
  /** Exact origin allowlist; a missing allowlist fails closed. */
  allowedOrigins: readonly string[];
  fetcher?: OpenClawFetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Optional payload pin, accepted as `sha256:<hex>` or bare 64-character hex. */
  expectedSha256?: string;
  signal?: AbortSignal;
}

export type OpenClawFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenClawRefreshResult =
  | {
      kind: "accepted";
      status: 200;
      snapshot: OpenClawCacheSnapshot;
    }
  | {
      kind: "not-modified";
      status: 304;
      snapshot: OpenClawCacheSnapshot;
    }
  | {
      kind: "stale";
      status?: number;
      snapshot: OpenClawCacheSnapshot;
      error: OpenClawFeedErrorCode;
    }
  | {
      kind: "rejected";
      status?: number;
      snapshot?: OpenClawCacheSnapshot;
      error: OpenClawFeedErrorCode;
    };

export type OpenClawFeedErrorCode =
  | "aborted"
  | "body-too-large"
  | "digest-mismatch"
  | "fetch-failed"
  | "invalid-etag"
  | "invalid-feed"
  | "invalid-url"
  | "invalid-utf8"
  | "no-cache"
  | "replay"
  | "timeout"
  | "unexpected-status"
  | "webcrypto-unavailable";
