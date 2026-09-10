import {
  OPENCLAW_DEFAULT_MAX_BODY_BYTES,
  OPENCLAW_FEED_SCHEMA_VERSION,
  OPENCLAW_MAX_ENTRIES,
  OPENCLAW_MAX_BODY_BYTES,
  OPENCLAW_OFFICIAL_FEED_ID,
  OPENCLAW_SOURCE_CLAWHUB,
  OPENCLAW_SOURCE_GITHUB,
  type OpenClawFeed,
  type OpenClawFeedEntry,
  type OpenClawFeedPublication,
  type OpenClawGithubSource,
  type OpenClawInstallCandidate,
  type OpenClawNormalizedCandidate,
  type OpenClawParseOptions,
  type OpenClawProducedFeed,
  type OpenClawSha256,
  type OpenClawTenantFeedPreview,
  type OpenClawTenantFeedPreviewInput,
} from "./types.ts";

const MAX_STRING_BYTES = 64 * 1024;
const MAX_CANDIDATES_PER_ENTRY = 32;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;

const textEncoder = new TextEncoder();

export class OpenClawValidationError extends Error {
  readonly code = "invalid-feed" as const;

  constructor(message: string) {
    super(message);
    this.name = "OpenClawValidationError";
  }
}

export class OpenClawDigestMismatchError extends Error {
  readonly code = "digest-mismatch" as const;

  constructor() {
    super("OpenClaw source digest did not match the declared digest");
    this.name = "OpenClawDigestMismatchError";
  }
}

export function utf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new OpenClawValidationError("feed body is not valid UTF-8");
  }
}

/** WebCrypto-only digest helper so the package stays portable across Node/Nitro/edge. */
export async function sha256(value: Uint8Array | string): Promise<OpenClawSha256> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error("WebCrypto is unavailable");
  }
  const bytes = typeof value === "string" ? utf8Bytes(value) : value.slice();
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export function parseOpenClawFeed(
  input: unknown,
  options: OpenClawParseOptions = {},
): OpenClawFeed {
  const maxBytes = boundedMaxBodyBytes(options.maxBytes);
  let body: string;
  let raw: unknown;
  if (typeof input === "string") {
    body = input;
    try {
      raw = JSON.parse(body) as unknown;
    } catch {
      throw new OpenClawValidationError("feed body is not valid JSON");
    }
  } else if (input instanceof Uint8Array) {
    body = decodeUtf8(input);
    try {
      raw = JSON.parse(body) as unknown;
    } catch {
      throw new OpenClawValidationError("feed body is not valid JSON");
    }
  } else {
    try {
      body = JSON.stringify(input);
    } catch {
      throw new OpenClawValidationError("feed value is not serializable");
    }
    if (body === undefined) {
      throw new OpenClawValidationError("feed value is not serializable");
    }
    raw = input;
  }
  const bodyBytes = utf8Bytes(body);
  if (bodyBytes.byteLength > maxBytes) {
    throw new OpenClawValidationError(`feed body exceeds ${maxBytes} bytes`);
  }

  const feed = parseFeedRecord(raw);
  if (options.expectedFeedId !== undefined && feed.id !== options.expectedFeedId) {
    throw new OpenClawValidationError("feed id did not match the configured identity");
  }
  const generatedAtMs = parseDate(feed.generatedAt, "generatedAt");
  const expiresAtMs = parseDate(feed.expiresAt, "expiresAt");
  if (expiresAtMs <= generatedAtMs) {
    throw new OpenClawValidationError("expiresAt must be after generatedAt");
  }
  if ((options.checkExpiry ?? true) && expiresAtMs <= resolveNow(options.now)) {
    throw new OpenClawValidationError("feed has expired");
  }
  if (
    options.previousSequence !== undefined &&
    feed.sequence <= options.previousSequence
  ) {
    throw new OpenClawValidationError("feed sequence is not newer than the cached sequence");
  }
  return feed;
}

/**
 * Serialize the exact v1 object shape with deterministic entry and candidate
 * ordering.  This function never adds a signature, publisher, source, or
 * trust value that was absent from the caller's records.
 */
export function serializeOpenClawFeed(feed: OpenClawFeed): string {
  const parsed = parseOpenClawFeed(JSON.stringify(feedToJson(feed)), {
    checkExpiry: false,
    maxBytes: OPENCLAW_DEFAULT_MAX_BODY_BYTES,
  });
  const entries = [...parsed.entries]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(serializeEntry);
  const output: Record<string, unknown> = {
    schemaVersion: parsed.schemaVersion,
    id: parsed.id,
    generatedAt: parsed.generatedAt,
    sequence: parsed.sequence,
    expiresAt: parsed.expiresAt,
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    entries,
  };
  const body = JSON.stringify(output);
  if (utf8Bytes(body).byteLength > OPENCLAW_DEFAULT_MAX_BODY_BYTES) {
    throw new OpenClawValidationError(
      `serialized feed exceeds ${OPENCLAW_DEFAULT_MAX_BODY_BYTES} bytes`,
    );
  }
  return body;
}

/** Build bytes, an ETag, and a digest without publishing or contacting a registry. */
export async function produceOpenClawFeed(
  publication: OpenClawFeedPublication,
): Promise<OpenClawProducedFeed> {
  const visibility = publication.visibility ?? "private";
  const tenantId = normalizeTenantId(publication.tenantId);
  if (visibility === "private" && !tenantId) {
    throw new OpenClawValidationError("private feed previews require a tenant id");
  }
  if (visibility === "public" && tenantId) {
    throw new OpenClawValidationError("public feeds cannot carry a tenant id");
  }
  if (publication.id === OPENCLAW_OFFICIAL_FEED_ID) {
    throw new OpenClawValidationError("the official feed identity is reserved for ClawHub");
  }
  const feed: OpenClawFeed = {
    schemaVersion: OPENCLAW_FEED_SCHEMA_VERSION,
    id: publication.id,
    generatedAt: publication.generatedAt,
    sequence: publication.sequence,
    expiresAt: publication.expiresAt,
    ...(publication.description === undefined ? {} : { description: publication.description }),
    entries: publication.entries,
  };
  const body = serializeOpenClawFeed(feed);
  const bytes = utf8Bytes(body);
  const digest = await sha256(bytes);
  return {
    feed: parseOpenClawFeed(body, { checkExpiry: false }),
    body,
    bytes,
    sha256: digest,
    etag: `"${digest}"`,
    lastModified: new Date(publication.generatedAt).toUTCString(),
    visibility,
    ...(tenantId ? { tenantId } : {}),
  };
}

/**
 * Produce the first private, tenant-scoped vertical slice. Authentication is
 * deliberately performed by the host request layer; this function accepts
 * only the already-authenticated tenant identity and never serializes it.
 */
export async function createOpenClawTenantFeedPreview(
  input: OpenClawTenantFeedPreviewInput,
): Promise<OpenClawTenantFeedPreview> {
  const tenantId = normalizeTenantId(input.authenticatedTenantId);
  if (!tenantId) {
    throw new OpenClawValidationError("authenticated tenant id is required");
  }
  if (input.visibility === "public") {
    throw new OpenClawValidationError("tenant previews must remain private");
  }
  const produced = await produceOpenClawFeed({
    id: input.id,
    generatedAt: input.generatedAt,
    sequence: input.sequence,
    expiresAt: input.expiresAt,
    ...(input.description === undefined ? {} : { description: input.description }),
    entries: input.entries,
    visibility: "private",
    tenantId,
  });
  return {
    ...produced,
    visibility: "private",
    tenantId,
  };
}

/** Normalize one candidate without guessing a source, URL, or publisher. */
export function normalizeOpenClawCandidate(
  entry: OpenClawFeedEntry,
  candidate: OpenClawInstallCandidate,
): OpenClawNormalizedCandidate {
  if (candidate.package !== entry.id || candidate.version !== entry.version) {
    throw new OpenClawValidationError("install candidate does not match entry identity");
  }
  if (candidate.sourceRef === OPENCLAW_SOURCE_CLAWHUB) {
    if (candidate.github !== undefined) {
      throw new OpenClawValidationError("ClawHub candidates cannot carry GitHub source metadata");
    }
    return {
      entryId: entry.id,
      entryType: entry.type,
      publisherId: entry.publisher.id,
      publisherTrust: entry.publisher.trust,
      candidate,
      source: {
        kind: "public-clawhub",
        sourceRef: OPENCLAW_SOURCE_CLAWHUB,
        packageName: candidate.package,
        version: candidate.version,
        artifactDigest: candidate.integrity,
      },
    };
  }
  if (candidate.sourceRef === OPENCLAW_SOURCE_GITHUB) {
    if (!candidate.github) {
      throw new OpenClawValidationError("GitHub candidates require exact source metadata");
    }
    validateGithubSource(candidate.github);
    if (candidate.version !== candidate.github.commit) {
      throw new OpenClawValidationError("GitHub candidate version must be its immutable commit");
    }
    if (candidate.integrity !== `sha256:${candidate.github.contentHash}`) {
      throw new OpenClawValidationError(
        "GitHub candidate integrity must match its folder content hash",
      );
    }
    return {
      entryId: entry.id,
      entryType: entry.type,
      publisherId: entry.publisher.id,
      publisherTrust: entry.publisher.trust,
      candidate,
      source: {
        kind: "public-github",
        sourceRef: OPENCLAW_SOURCE_GITHUB,
        repo: candidate.github.repo,
        path: candidate.github.path,
        commit: candidate.github.commit,
        contentHash: candidate.github.contentHash,
      },
    };
  }
  throw new OpenClawValidationError("install candidate source is not supported");
}

export function normalizeOpenClawEntry(entry: OpenClawFeedEntry): OpenClawNormalizedCandidate[] {
  return entry.install.candidates.map((candidate) =>
    normalizeOpenClawCandidate(entry, candidate),
  );
}

/** Verify hosted artifact bytes against the v1 `sha256:<hex>` integrity field. */
export async function verifyOpenClawArtifactDigest(
  bytes: Uint8Array,
  expectedIntegrity: string,
): Promise<OpenClawSha256> {
  const expected = /^sha256:([0-9a-f]{64})$/u.exec(expectedIntegrity);
  if (!expected) {
    throw new OpenClawValidationError("artifact integrity is not a SHA-256 digest");
  }
  const actual = await sha256(bytes);
  if (actual !== `sha256:${expected[1]}`) {
    throw new OpenClawDigestMismatchError();
  }
  return actual;
}

export function verifyOpenClawGithubContentHash(
  source: OpenClawNormalizedCandidate["source"],
  actualContentHash: string,
): void {
  if (source.kind !== "public-github" || source.contentHash !== actualContentHash) {
    throw new OpenClawDigestMismatchError();
  }
}

function parseFeedRecord(raw: unknown): OpenClawFeed {
  const record = asRecord(raw, "feed");
  assertKnownKeys(
    record,
    ["schemaVersion", "id", "generatedAt", "sequence", "expiresAt", "description", "entries"],
    "feed",
  );
  if (record.schemaVersion !== OPENCLAW_FEED_SCHEMA_VERSION) {
    throw new OpenClawValidationError(`unsupported feed schema version: ${String(record.schemaVersion)}`);
  }
  const id = readString(record.id, "feed.id");
  const generatedAt = readString(record.generatedAt, "feed.generatedAt");
  const expiresAt = readString(record.expiresAt, "feed.expiresAt");
  const sequence = readSequence(record.sequence);
  const entriesValue = record.entries;
  if (!Array.isArray(entriesValue)) {
    throw new OpenClawValidationError("feed.entries must be an array");
  }
  if (entriesValue.length > OPENCLAW_MAX_ENTRIES) {
    throw new OpenClawValidationError(`feed has more than ${OPENCLAW_MAX_ENTRIES} entries`);
  }
  const seenIds = new Set<string>();
  const entries = entriesValue.map((entry, index) => {
    const parsed = parseEntry(entry, index);
    if (seenIds.has(parsed.id)) {
      throw new OpenClawValidationError(`feed contains duplicate entry id: ${parsed.id}`);
    }
    seenIds.add(parsed.id);
    return parsed;
  });
  const description = readOptionalString(record.description, "feed.description");
  return {
    schemaVersion: 1,
    id,
    generatedAt,
    sequence,
    expiresAt,
    ...(description === undefined ? {} : { description }),
    entries,
  };
}

function parseEntry(raw: unknown, index: number): OpenClawFeedEntry {
  const record = asRecord(raw, `feed.entries[${index}]`);
  assertKnownKeys(
    record,
    [
      "type",
      "id",
      "title",
      "description",
      "icon",
      "version",
      "state",
      "featured",
      "featuredAt",
      "publisher",
      "install",
    ],
    `feed.entries[${index}]`,
  );
  const type = record.type;
  if (type !== "plugin" && type !== "skill") {
    throw new OpenClawValidationError("feed entry type is invalid");
  }
  const id = readString(record.id, `feed.entries[${index}].id`);
  const title = readString(record.title, `feed.entries[${index}].title`);
  const description = readOptionalString(record.description, "entry.description");
  const icon = readOptionalString(record.icon, "entry.icon");
  const version = readString(record.version, `feed.entries[${index}].version`);
  const state = record.state;
  if (
    state !== "available" &&
    state !== "recommended" &&
    state !== "disabled" &&
    state !== "blocked" &&
    state !== "deprecated"
  ) {
    throw new OpenClawValidationError("feed entry state is invalid");
  }
  const publisher = parsePublisher(record.publisher, index);
  const install = parseInstall(record.install, index);
  const featured = record.featured;
  if (featured !== undefined && typeof featured !== "boolean") {
    throw new OpenClawValidationError("entry.featured must be a boolean");
  }
  const featuredAt = record.featuredAt;
  if (
    featuredAt !== undefined &&
    (featured !== true ||
      typeof featuredAt !== "number" ||
      !Number.isSafeInteger(featuredAt) ||
      featuredAt < 0)
  ) {
    throw new OpenClawValidationError("featuredAt requires a featured entry and epoch milliseconds");
  }
  return {
    type,
    id,
    title,
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
    version,
    state,
    ...(featured === undefined ? {} : { featured }),
    ...(featuredAt === undefined ? {} : { featuredAt }),
    publisher,
    install,
  } as OpenClawFeedEntry;
}

function parsePublisher(raw: unknown, index: number): { id: string; trust: "official" | "community" } {
  const record = asRecord(raw, `feed.entries[${index}].publisher`);
  assertKnownKeys(record, ["id", "trust"], "entry.publisher");
  const id = readString(record.id, "entry.publisher.id");
  if (record.trust !== "official" && record.trust !== "community") {
    throw new OpenClawValidationError("entry.publisher.trust is invalid");
  }
  return { id, trust: record.trust };
}

function parseInstall(raw: unknown, index: number): { candidates: OpenClawInstallCandidate[] } {
  const record = asRecord(raw, `feed.entries[${index}].install`);
  assertKnownKeys(record, ["candidates"], "entry.install");
  if (!Array.isArray(record.candidates)) {
    throw new OpenClawValidationError("entry.install.candidates must be an array");
  }
  if (record.candidates.length > MAX_CANDIDATES_PER_ENTRY) {
    throw new OpenClawValidationError(
      `entry.install.candidates exceeds ${MAX_CANDIDATES_PER_ENTRY} items`,
    );
  }
  const seen = new Set<string>();
  const candidates = record.candidates.map((candidate, candidateIndex) => {
    const parsed = parseCandidate(candidate, index, candidateIndex);
    const key = [parsed.sourceRef, parsed.package, parsed.version, parsed.integrity].join("\u0000");
    if (seen.has(key)) {
      throw new OpenClawValidationError("entry.install.candidates contains a duplicate");
    }
    seen.add(key);
    return parsed;
  });
  return { candidates };
}

function parseCandidate(
  raw: unknown,
  entryIndex: number,
  candidateIndex: number,
): OpenClawInstallCandidate {
  const record = asRecord(raw, `candidate ${entryIndex}/${candidateIndex}`);
  assertKnownKeys(record, ["sourceRef", "package", "version", "integrity", "github"], "install candidate");
  const sourceRef = readString(record.sourceRef, "candidate.sourceRef");
  const packageName = readString(record.package, "candidate.package");
  const version = readString(record.version, "candidate.version");
  const integrity = readString(record.integrity, "candidate.integrity");
  const github = record.github === undefined ? undefined : parseGithubSource(record.github);
  return {
    sourceRef,
    package: packageName,
    version,
    integrity,
    ...(github === undefined ? {} : { github }),
  };
}

function parseGithubSource(raw: unknown): OpenClawGithubSource {
  const record = asRecord(raw, "candidate.github");
  assertKnownKeys(record, ["repo", "path", "commit", "contentHash"], "candidate.github");
  const source: OpenClawGithubSource = {
    repo: readString(record.repo, "candidate.github.repo"),
    path: readStringAllowEmpty(record.path, "candidate.github.path"),
    commit: readString(record.commit, "candidate.github.commit"),
    contentHash: readString(record.contentHash, "candidate.github.contentHash"),
  };
  validateGithubSource(source);
  return source;
}

function validateGithubSource(source: OpenClawGithubSource): void {
  if (!/^[^/\\\s]+\/[^/\\\s]+$/u.test(source.repo)) {
    throw new OpenClawValidationError("GitHub source repo must be owner/repository");
  }
  if (
    (source.path !== "" && source.path.startsWith("/")) ||
    source.path.includes("\\") ||
    (source.path !== "" && source.path.split("/").some((part) => part === "" || part === "." || part === ".."))
  ) {
    throw new OpenClawValidationError("GitHub source path is not a safe relative path");
  }
  if (!COMMIT_RE.test(source.commit)) {
    throw new OpenClawValidationError("GitHub source commit must be a 40-character SHA");
  }
}

function serializeEntry(entry: OpenClawFeedEntry): Record<string, unknown> {
  return {
    type: entry.type,
    id: entry.id,
    title: entry.title,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    version: entry.version,
    state: entry.state,
    ...(entry.featured === undefined ? {} : { featured: entry.featured }),
    ...(entry.featuredAt === undefined ? {} : { featuredAt: entry.featuredAt }),
    publisher: {
      id: entry.publisher.id,
      trust: entry.publisher.trust,
    },
    install: {
      candidates: [...entry.install.candidates]
        .sort((left, right) =>
          [left.sourceRef, left.package, left.version, left.integrity]
            .join("\u0000")
            .localeCompare(
              [right.sourceRef, right.package, right.version, right.integrity].join("\u0000"),
            ),
        )
        .map((candidate) => ({
          sourceRef: candidate.sourceRef,
          package: candidate.package,
          version: candidate.version,
          integrity: candidate.integrity,
          ...(candidate.github === undefined
            ? {}
            : {
                github: {
                  repo: candidate.github.repo,
                  path: candidate.github.path,
                  commit: candidate.github.commit,
                  contentHash: candidate.github.contentHash,
                },
              }),
        })),
    },
  };
}

function feedToJson(feed: OpenClawFeed): unknown {
  return {
    schemaVersion: feed.schemaVersion,
    id: feed.id,
    generatedAt: feed.generatedAt,
    sequence: feed.sequence,
    expiresAt: feed.expiresAt,
    ...(feed.description === undefined ? {} : { description: feed.description }),
    entries: feed.entries,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenClawValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new OpenClawValidationError(`${label} contains unsupported field: ${key}`);
    }
  }
}

function readString(value: unknown, label: string): string {
  return readStringAllowEmpty(value, label, false);
}

function readStringAllowEmpty(value: unknown, label: string, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new OpenClawValidationError(`${label} must be a non-empty string`);
  }
  if (utf8Bytes(value).byteLength > MAX_STRING_BYTES) {
    throw new OpenClawValidationError(`${label} is too large`);
  }
  return value;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value, label);
}

function readSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OpenClawValidationError("feed sequence must be a non-negative integer");
  }
  return value;
}

function parseDate(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new OpenClawValidationError(`${label} must be a valid ISO date`);
  }
  return parsed;
}

function resolveNow(now: Date | number | undefined): number {
  if (now instanceof Date) {
    return now.getTime();
  }
  if (typeof now === "number" && Number.isFinite(now)) {
    return now;
  }
  return Date.now();
}

function normalizeTenantId(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  if (utf8Bytes(value).byteLength > 512) {
    throw new OpenClawValidationError("tenant id is too large");
  }
  return value;
}

function boundedMaxBodyBytes(value: number | undefined): number {
  const max = value ?? OPENCLAW_DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(max) || max <= 0 || max > OPENCLAW_MAX_BODY_BYTES) {
    throw new OpenClawValidationError("feed body limit is outside the supported bounds");
  }
  return max;
}
