/**
 * The discovery schema used by the official skills CLI for a well-known
 * skills host.  A skills.sh pack is a scoped well-known host at
 * `https://skills.sh/p/<pack-id>`; it is not an /api/v1 catalog resource.
 */
export const SKILLS_SH_PACK_ORIGIN = 'https://skills.sh' as const;
export const SKILLS_DISCOVERY_SCHEMA_V2 =
  'https://schemas.agentskills.io/discovery/0.2.0/schema.json' as const;

const MAX_PACK_ID_BYTES = 256;
const MAX_NAME_BYTES = 64;
const MAX_DESCRIPTION_BYTES = 1_024;
const DEFAULT_LIMITS: Readonly<SkillsPackLimits> = Object.freeze({
  maxManifestBytes: 1 * 1024 * 1024,
  maxMemberBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxMembers: 256,
  maxFiles: 1_000,
  maxPathBytes: 4_096,
  maxDescriptionBytes: MAX_DESCRIPTION_BYTES,
  requestTimeoutMs: 15_000,
});

type JsonRecord = Record<string, unknown>;

/** Fetch is injected so this package remains portable and easy to fixture-test. */
export type SkillsPackFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SkillsPackLimits {
  /** Maximum encoded JSON bytes retained for one discovery index. */
  maxManifestBytes: number;
  /** Maximum bytes retained for one artifact or one legacy file. */
  maxMemberBytes: number;
  /** Maximum bytes fetched by one selected-member operation. */
  maxTotalBytes: number;
  /** Maximum members accepted from one pack or selected in one operation. */
  maxMembers: number;
  /** Maximum files in one legacy member. */
  maxFiles: number;
  /** Maximum UTF-8 bytes in one relative file path. */
  maxPathBytes: number;
  /** Maximum UTF-8 bytes in one manifest description. */
  maxDescriptionBytes: number;
  /** Deadline passed to the fetch implementation when no caller signal exists. */
  requestTimeoutMs: number;
}

export interface SkillsPackClientOptions {
  /** A request-scoped fetch implementation. No credentials are added by this client. */
  fetch?: SkillsPackFetch;
  /** Backwards-compatible alias for `fetch`. */
  fetchImpl?: SkillsPackFetch;
  /**
   * Explicit artifact origins verified by the server's public DNS/SSRF
   * policy. Same-origin artifacts are always allowed; cross-origin artifacts
   * are rejected unless an origin is listed here or the policy below accepts
   * the fully parsed URL.
   */
  allowedArtifactOrigins?: readonly (string | URL)[];
  /**
   * Optional server-owned URL policy for approved public CDN/blob origins.
   * The callback must perform any DNS rebinding/private-address checks before
   * returning true. It is never called for manifest URLs.
   */
  artifactOriginPolicy?: (artifactUrl: URL, packUrl: URL) => boolean;
  limits?: Partial<SkillsPackLimits>;
}

export type SkillsPackSchemaVersion = '0.1.0' | '0.2.0';
export type SkillsPackArtifactType = 'skill-md' | 'archive';

export interface SkillsPackMember {
  /** The member's pack-local stable name. */
  name: string;
  description: string;
  /** v0.2 artifact type; v0.1 uses `files`. */
  type: SkillsPackArtifactType | 'files';
  /** Resolved URL used by the selected-member operation. */
  artifactUrl: string | null;
  /** v0.2 source digest. Legacy v0.1 has no source digest. */
  externalDigest: `sha256:${string}` | null;
  /** v0.1 relative files, including SKILL.md. */
  files: readonly string[] | null;
}

export interface SkillsPackManifest {
  packUrl: string;
  manifestUrl: string;
  schema: SkillsPackSchemaVersion;
  /** SHA-256 of the raw manifest response bytes, retained as fetch evidence. */
  manifestDigest: `sha256:${string}`;
  members: readonly SkillsPackMember[];
}

export interface SkillsPackFile {
  path: string;
  bytes: Uint8Array;
}

export type SkillsPackMemberCandidate =
  | {
      member: SkillsPackMember;
      source: { kind: 'skill-md'; bytes: Uint8Array };
      /** Digest of the bytes returned by the artifact URL. */
      contentDigest: `sha256:${string}`;
    }
  | {
      member: SkillsPackMember;
      source: { kind: 'archive'; bytes: Uint8Array };
      /** Digest of the bytes returned by the artifact URL. */
      contentDigest: `sha256:${string}`;
    }
  | {
      member: SkillsPackMember;
      source: { kind: 'files'; files: readonly SkillsPackFile[] };
      /** Digest of the selected legacy files in path order. */
      contentDigest: `sha256:${string}`;
    };

export type SkillsPackErrorCode =
  | 'invalid_input'
  | 'invalid_manifest'
  | 'not_found'
  | 'redirect_denied'
  | 'http_error'
  | 'unavailable'
  | 'request_timeout'
  | 'size_limit'
  | 'unsafe_origin'
  | 'unsafe_path'
  | 'artifact_digest_mismatch';

/** Sanitized error for pack discovery and selected-member acquisition. */
export class SkillsPackError extends Error {
  readonly code: SkillsPackErrorCode;
  readonly status?: number;

  constructor(code: SkillsPackErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SkillsPackError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Server-side, non-executing adapter for a user-supplied skills.sh pack URL.
 *
 * `inspect` only resolves and validates the pack index. `fetchMembers` is an
 * explicit, selected operation that returns untrusted source bytes for the
 * existing canonicalisation/scanner pipeline. This class never writes a
 * private pack, creates a release, or treats a remote audit as approval.
 */
export class SkillsPackClient {
  private readonly fetchImpl: SkillsPackFetch;
  private readonly limits: SkillsPackLimits;
  private readonly allowedArtifactOrigins: ReadonlySet<string>;
  private readonly artifactOriginPolicy?: (artifactUrl: URL, packUrl: URL) => boolean;

  constructor(options: SkillsPackClientOptions = {}) {
    this.fetchImpl = options.fetch ?? options.fetchImpl ?? defaultFetch;
    this.limits = normalizeLimits(options.limits);
    this.allowedArtifactOrigins = normalizeAllowedOrigins(options.allowedArtifactOrigins);
    this.artifactOriginPolicy = options.artifactOriginPolicy;
  }

  /** Resolve a strict `https://skills.sh/p/<pack-id>` URL to its manifest. */
  async inspect(input: string | URL): Promise<SkillsPackManifest> {
    const packUrl = normalizePackUrl(input);
    const candidates = discoveryUrls(packUrl);
    let lastError: SkillsPackError | undefined;

    for (const manifestUrl of candidates) {
      try {
        const bytes = await this.getBytes(manifestUrl, this.limits.maxManifestBytes);
        const parsed = await parseManifest(
          packUrl,
          manifestUrl,
          bytes,
          this.limits,
        );
        return parsed;
      } catch (error) {
        const normalized = normalizeError(error);
        lastError = normalized;
        // The official CLI tries the legacy endpoint if the preferred endpoint
        // is missing or is not a usable discovery index. It never widens a
        // scoped pack URL to the host root, so neither do we.
        if (
          normalized.code !== 'not_found' &&
          normalized.code !== 'invalid_manifest'
        ) {
          throw normalized;
        }
      }
    }

    throw lastError ?? new SkillsPackError('not_found', 'Pack discovery index was not found');
  }

  /**
   * Fetch only the selected members from a previously inspected pack.
   * Selection is all-or-nothing: a missing member, unsafe path, bad digest,
   * or failed artifact yields no candidate result.
   */
  async fetchMembers(
    manifest: SkillsPackManifest,
    memberNames: readonly string[],
  ): Promise<SkillsPackMemberCandidate[]> {
    if (!Array.isArray(memberNames) || memberNames.length === 0) {
      throw invalidInput('memberNames');
    }
    if (memberNames.length > this.limits.maxMembers) {
      throw sizeLimit('selected member count');
    }

    const byName = new Map(manifest.members.map((member) => [member.name, member]));
    const selected: SkillsPackMember[] = [];
    const seen = new Set<string>();
    for (const name of memberNames) {
      if (typeof name !== 'string' || !isValidSkillName(name)) {
        throw invalidInput('memberNames');
      }
      if (seen.has(name)) throw invalidInput('memberNames');
      seen.add(name);
      const member = byName.get(name);
      if (!member) {
        throw new SkillsPackError('invalid_input', 'The selected pack member was not found');
      }
      selected.push(member);
    }

    const results: SkillsPackMemberCandidate[] = [];
    let totalBytes = 0;
    for (const member of selected) {
      const candidate = await this.fetchSelectedMember(manifest, member);
      totalBytes += candidateSize(candidate);
      if (totalBytes > this.limits.maxTotalBytes) throw sizeLimit('selected pack bytes');
      results.push(candidate);
    }
    return results;
  }

  async fetchMember(
    manifest: SkillsPackManifest,
    memberName: string,
  ): Promise<SkillsPackMemberCandidate> {
    const candidates = await this.fetchMembers(manifest, [memberName]);
    return candidates[0]!;
  }

  private async fetchSelectedMember(
    manifest: SkillsPackManifest,
    member: SkillsPackMember,
  ): Promise<SkillsPackMemberCandidate> {
    const packUrl = normalizePackUrl(manifest.packUrl);
    if (member.type === 'skill-md' || member.type === 'archive') {
      if (!member.artifactUrl || !member.externalDigest) {
        throw new SkillsPackError('invalid_manifest', 'Pack member artifact metadata is incomplete');
      }
      const artifactUrl = resolveArtifactUrl(
        member.artifactUrl,
        manifest.manifestUrl,
        packUrl,
        (url, sourcePackUrl) => this.isArtifactOriginAllowed(url, sourcePackUrl),
      );
      const bytes = await this.getBytes(artifactUrl, this.limits.maxMemberBytes);
      const contentDigest = await sha256(bytes);
      if (contentDigest !== member.externalDigest) {
        throw new SkillsPackError('artifact_digest_mismatch', 'Pack member artifact digest did not match its manifest');
      }
      if (member.type === 'skill-md') {
        validateSkillMarkdown(bytes);
        return { member, source: { kind: 'skill-md', bytes }, contentDigest };
      }
      return { member, source: { kind: 'archive', bytes }, contentDigest };
    }

    if (!member.artifactUrl || !member.files) {
      throw new SkillsPackError('invalid_manifest', 'Legacy pack member metadata is incomplete');
    }
    const memberBase = resolveArtifactUrl(
      member.artifactUrl,
      manifest.manifestUrl,
      packUrl,
      (url, sourcePackUrl) => this.isArtifactOriginAllowed(url, sourcePackUrl),
    );
    const files: SkillsPackFile[] = [];
    let totalBytes = 0;
    for (const path of member.files) {
      const safePath = validateRelativePath(path, this.limits);
      const encodedPath = safePath.split('/').map((part) => encodeURIComponent(part)).join('/');
      const fileUrl = resolveArtifactUrl(
        encodedPath,
        memberBase,
        packUrl,
        (url, sourcePackUrl) => this.isArtifactOriginAllowed(url, sourcePackUrl),
      );
      const bytes = await this.getBytes(fileUrl, this.limits.maxMemberBytes);
      totalBytes += bytes.byteLength;
      if (totalBytes > this.limits.maxMemberBytes) throw sizeLimit('legacy pack member');
      if (safePath.toLowerCase() === 'skill.md') validateSkillMarkdown(bytes);
      files.push({ path: safePath, bytes });
    }
    return {
      member,
      source: { kind: 'files', files },
      contentDigest: await computeFilesDigest(files),
    };
  }

  private isArtifactOriginAllowed(artifactUrl: URL, packUrl: URL): boolean {
    if (sameOrigin(artifactUrl, packUrl)) return true;
    if (this.allowedArtifactOrigins.has(artifactUrl.origin)) return true;
    try {
      return this.artifactOriginPolicy?.(artifactUrl, packUrl) === true;
    } catch {
      return false;
    }
  }

  private async getBytes(url: string, maxBytes: number): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json, application/octet-stream, text/plain' },
        redirect: 'manual',
        signal: createTimeoutSignal(this.limits.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) throw new SkillsPackError('request_timeout', 'Pack request timed out');
      throw new SkillsPackError('unavailable', 'Pack source is temporarily unavailable');
    }

    if (isRedirectStatus(response.status)) {
      cancelBody(response);
      throw new SkillsPackError('redirect_denied', 'Pack source returned a redirect', response.status);
    }
    if (response.status === 404) {
      cancelBody(response);
      throw new SkillsPackError('not_found', 'Pack source was not found', 404);
    }
    if (response.status < 200 || response.status >= 300) {
      cancelBody(response);
      throw new SkillsPackError('http_error', 'Pack source rejected the request', response.status);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const parsed = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        cancelBody(response);
        throw sizeLimit('pack response');
      }
    }
    try {
      return await readBoundedBody(response, maxBytes);
    } catch (error) {
      if (error instanceof SkillsPackError) throw error;
      if (isAbortError(error)) throw new SkillsPackError('request_timeout', 'Pack request timed out');
      throw new SkillsPackError('unavailable', 'Pack source could not be read');
    }
  }
}

export function createSkillsPackClient(options: SkillsPackClientOptions = {}): SkillsPackClient {
  return new SkillsPackClient(options);
}

async function parseManifest(
  packUrl: URL,
  manifestUrl: string,
  bytes: Uint8Array,
  limits: SkillsPackLimits,
): Promise<SkillsPackManifest> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SkillsPackError('invalid_manifest', 'Pack discovery index is not valid JSON');
  }
  if (!isRecord(value) || !Array.isArray(value.skills)) {
    throw new SkillsPackError('invalid_manifest', 'Pack discovery index has an invalid shape');
  }
  if (value.skills.length === 0 || value.skills.length > limits.maxMembers) {
    throw new SkillsPackError('invalid_manifest', 'Pack discovery index has an invalid member count');
  }

  const schema = value.$schema;
  const members = schema === SKILLS_DISCOVERY_SCHEMA_V2
    ? parseV2Members(value.skills, manifestUrl, packUrl, limits)
    : schema === undefined
      ? parseV1Members(value.skills, manifestUrl, packUrl, limits)
      : (() => {
          throw new SkillsPackError('invalid_manifest', 'Pack discovery schema is unsupported');
        })();

  return {
    packUrl: packUrl.toString(),
    manifestUrl,
    schema: schema === SKILLS_DISCOVERY_SCHEMA_V2 ? '0.2.0' : '0.1.0',
    manifestDigest: await sha256(bytes),
    members,
  };
}

function parseV2Members(
  rawMembers: unknown[],
  manifestUrl: string,
  packUrl: URL,
  limits: SkillsPackLimits,
): SkillsPackMember[] {
  const members: SkillsPackMember[] = [];
  const seen = new Set<string>();
  for (const raw of rawMembers) {
    if (!isRecord(raw)) throw new SkillsPackError('invalid_manifest', 'Pack member is not an object');
    const name = parseName(raw.name);
    if (seen.has(name)) throw new SkillsPackError('invalid_manifest', 'Pack member names must be unique');
    seen.add(name);
    const description = parseDescription(raw.description, limits);
    if (raw.type !== 'skill-md' && raw.type !== 'archive') {
      throw new SkillsPackError('invalid_manifest', 'Pack member type is unsupported');
    }
    if (typeof raw.url !== 'string' || raw.url.length === 0) {
      throw new SkillsPackError('invalid_manifest', 'Pack member artifact URL is invalid');
    }
    // Preview stores the resolved URL but does not decide whether the server
    // may fetch it. Origin/DNS policy is applied immediately before bytes are
    // requested by fetchMembers.
    const artifactUrl = resolveArtifactUrl(raw.url, manifestUrl, packUrl);
    if (typeof raw.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(raw.digest)) {
      throw new SkillsPackError('invalid_manifest', 'Pack member digest is invalid');
    }
    members.push({
      name,
      description,
      type: raw.type,
      artifactUrl,
      externalDigest: raw.digest as `sha256:${string}`,
      files: null,
    });
  }
  return members;
}

function parseV1Members(
  rawMembers: unknown[],
  manifestUrl: string,
  packUrl: URL,
  limits: SkillsPackLimits,
): SkillsPackMember[] {
  const members: SkillsPackMember[] = [];
  const seen = new Set<string>();
  const discoveryPath = discoveryPathFor(manifestUrl);
  for (const raw of rawMembers) {
    if (!isRecord(raw)) throw new SkillsPackError('invalid_manifest', 'Pack member is not an object');
    const name = parseName(raw.name);
    if (seen.has(name)) throw new SkillsPackError('invalid_manifest', 'Pack member names must be unique');
    seen.add(name);
    const description = parseDescription(raw.description, limits);
    if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > limits.maxFiles) {
      throw new SkillsPackError('invalid_manifest', 'Pack member file list is invalid');
    }
    const files: string[] = [];
    const seenPaths = new Set<string>();
    for (const rawPath of raw.files) {
      const path = validateRelativePath(rawPath, limits);
      const key = path.normalize('NFC').toLocaleLowerCase('en-US');
      if (seenPaths.has(key)) throw new SkillsPackError('invalid_manifest', 'Pack member file paths must be unique');
      seenPaths.add(key);
      files.push(path);
    }
    if (!files.some((path) => path.toLowerCase() === 'skill.md')) {
      throw new SkillsPackError('invalid_manifest', 'Pack member file list must contain SKILL.md');
    }
    const artifactUrl = new URL(`${discoveryPath}/${encodeURIComponent(name)}/`, packUrl.toString()).toString();
    members.push({
      name,
      description,
      type: 'files',
      artifactUrl,
      externalDigest: null,
      files,
    });
  }
  return members;
}

function parseName(value: unknown): string {
  if (!isValidSkillName(value)) {
    throw new SkillsPackError('invalid_manifest', 'Pack member name is invalid');
  }
  return value;
}

function parseDescription(value: unknown, limits: SkillsPackLimits): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Bytes(value) > limits.maxDescriptionBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SkillsPackError('invalid_manifest', 'Pack member description is invalid');
  }
  return value;
}

function normalizePackUrl(input: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(input.toString());
  } catch {
    throw invalidInput('packUrl');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new SkillsPackError('invalid_input', 'Pack URL must be an HTTPS URL without credentials');
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
  if (host !== 'skills.sh' || parsed.port) {
    throw new SkillsPackError('invalid_input', 'Pack URL must use the skills.sh origin');
  }
  if (parsed.search || parsed.hash) {
    throw new SkillsPackError('invalid_input', 'Pack URL must not contain a query or fragment');
  }
  const match = parsed.pathname.match(/^\/p\/([^/]+)\/?$/u);
  if (!match?.[1]) throw new SkillsPackError('invalid_input', 'Pack URL must use the /p/<pack-id> path');
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    throw invalidInput('packUrl');
  }
  if (
    utf8Bytes(id) > MAX_PACK_ID_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(id) ||
    id.includes('..')
  ) {
    throw invalidInput('packUrl');
  }
  return new URL(`${SKILLS_SH_PACK_ORIGIN}/p/${encodeURIComponent(id)}`);
}

function discoveryUrls(packUrl: URL): string[] {
  const base = `${packUrl.toString()}/`;
  return [
    new URL('.well-known/agent-skills/index.json', base).toString(),
    new URL('.well-known/skills/index.json', base).toString(),
  ];
}

function discoveryPathFor(manifestUrl: string): string {
  const parsed = new URL(manifestUrl);
  const match = parsed.pathname.match(/^(.*)\/.well-known\/(?:agent-skills|skills)\/index\.json$/u);
  if (!match?.[1]) throw new SkillsPackError('invalid_manifest', 'Pack discovery path is invalid');
  return `${match[1]}/.well-known/${parsed.pathname.includes('/agent-skills/') ? 'agent-skills' : 'skills'}`;
}

function resolveArtifactUrl(
  raw: string,
  baseUrl: string,
  packUrl: URL,
  artifactOriginAllowed?: (artifactUrl: URL, packUrl: URL) => boolean,
): string {
  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    throw new SkillsPackError('invalid_manifest', 'Pack artifact URL is invalid');
  }
  if (resolved.protocol !== 'https:' || resolved.username || resolved.password) {
    throw new SkillsPackError('unsafe_origin', 'Pack artifact URL must be HTTPS without credentials');
  }
  if (artifactOriginAllowed && !artifactOriginAllowed(resolved, packUrl)) {
    throw new SkillsPackError('unsafe_origin', 'Pack artifact URL is not an approved public origin');
  }
  return resolved.toString();
}

function sameOrigin(left: URL, right: URL): boolean {
  const leftHost = left.hostname.toLowerCase().replace(/^www\./u, '');
  const rightHost = right.hostname.toLowerCase().replace(/^www\./u, '');
  return left.protocol === right.protocol && leftHost === rightHost && left.port === right.port;
}

function normalizeAllowedOrigins(
  origins: readonly (string | URL)[] | undefined,
): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const raw of origins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(raw.toString());
    } catch {
      throw invalidInput('allowedArtifactOrigins');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw invalidInput('allowedArtifactOrigins');
    }
    normalized.add(parsed.origin);
  }
  return normalized;
}

function validateRelativePath(value: unknown, limits: SkillsPackLimits): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Bytes(value) > limits.maxPathBytes ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new SkillsPackError('unsafe_path', 'Pack member file path is unsafe');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new SkillsPackError('unsafe_path', 'Pack member file path is unsafe');
  }
  return value;
}

function isValidSkillName(value: unknown): value is string {
  return typeof value === 'string' &&
    utf8Bytes(value) <= MAX_NAME_BYTES &&
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value) &&
    !value.includes('--');
}

function validateSkillMarkdown(bytes: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SkillsPackError('invalid_manifest', 'Pack SKILL.md is not valid UTF-8');
  }
  if (!/^---\r?\n/u.test(text)) {
    throw new SkillsPackError('invalid_manifest', 'Pack SKILL.md is missing frontmatter');
  }
  const openingLength = text.match(/^---\r?\n/u)![0].length;
  const closeRelative = text.slice(openingLength).search(/^---\r?$/mu);
  if (closeRelative < 0) throw new SkillsPackError('invalid_manifest', 'Pack SKILL.md frontmatter is not closed');
  const frontmatter = text.slice(openingLength, openingLength + closeRelative);
  const name = frontmatter.match(/^name\s*:\s*(\S.*)$/mu);
  const description = frontmatter.match(/^description\s*:\s*(\S.*)$/mu);
  if (!name?.[1]?.trim() || !description?.[1]?.trim()) {
    throw new SkillsPackError('invalid_manifest', 'Pack SKILL.md requires name and description frontmatter');
  }
}

function normalizeLimits(input: Partial<SkillsPackLimits> | undefined): SkillsPackLimits {
  const limits = { ...DEFAULT_LIMITS, ...(input ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) throw invalidInput(`limits.${key}`);
  }
  return limits;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw sizeLimit('pack response');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw sizeLimit('pack response');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof SkillsPackError) throw error;
    throw new SkillsPackError('unavailable', 'Pack source could not be read');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeError(error: unknown): SkillsPackError {
  if (error instanceof SkillsPackError) return error;
  if (isAbortError(error)) return new SkillsPackError('request_timeout', 'Pack request timed out');
  return new SkillsPackError('unavailable', 'Pack source is temporarily unavailable');
}

function candidateSize(candidate: SkillsPackMemberCandidate): number {
  if (candidate.source.kind === 'files') {
    return candidate.source.files.reduce((total, file) => total + file.bytes.byteLength, 0);
  }
  return candidate.source.bytes.byteLength;
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new SkillsPackError('unavailable', 'Web Crypto SHA-256 is unavailable');
  let hash: ArrayBuffer;
  try {
    hash = await subtle.digest('SHA-256', bytes.slice());
  } catch {
    throw new SkillsPackError('unavailable', 'Pack digest could not be computed');
  }
  const digest = new Uint8Array(hash);
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

async function computeFilesDigest(files: readonly SkillsPackFile[]): Promise<`sha256:${string}`> {
  const chunks: Uint8Array[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    chunks.push(new TextEncoder().encode(file.path));
    chunks.push(new Uint8Array([0]));
    chunks.push(file.bytes);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return sha256(combined);
}

function invalidInput(field: string): SkillsPackError {
  return new SkillsPackError('invalid_input', `Invalid skills pack ${field}`);
}

function sizeLimit(field: string): SkillsPackError {
  return new SkillsPackError('size_limit', `Skills pack ${field} exceeded its configured limit`);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel();
  } catch {
    // Best effort only; the response is never reused.
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function createTimeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

const defaultFetch: SkillsPackFetch = (input, init) => globalThis.fetch(input, init);
