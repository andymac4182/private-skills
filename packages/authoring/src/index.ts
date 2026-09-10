import type {
  Authenticator,
  BlobStore,
  Digest,
  Principal,
  RegistryState,
  SkillVersion,
  StateRepository,
} from '../../contracts/src/index.js';
import type { UploadReviewPersistenceService } from '../../upload-reviews/src/index.js';
import { decodeBundle } from '../../storage/src/index.js';
import { digestBytes, isSha256Digest } from '../../storage/src/digest.js';

/**
 * Maximum text payload returned by the read-only file view for one file.
 * Files above this bound remain visible in the manifest but are never
 * truncated into a misleading preview.
 */
export const DEFAULT_RELEASE_TEXT_PREVIEW_BYTES = 256 * 1024;

export type ReleaseFilePreviewState = 'text' | 'binary' | 'unsupported' | 'oversize';

export interface ReleaseFileView {
  path: string;
  size: number;
  contentDigest: Digest;
  previewState: ReleaseFilePreviewState;
  executable?: boolean;
  /** Full UTF-8 text, present only when previewState is `text`. */
  contents?: string;
}

export interface ReleaseFilesResponse {
  release: {
    id: string;
    name: string;
    skillName: string;
    version: string;
    digest: SkillVersion['artifact']['digest'];
    fileCount: number;
  };
  files: ReleaseFileView[];
}

export interface AuthoringHandlerConfig {
  organizationId: string;
  maxBodyBytes?: number;
  maxTextPreviewBytes?: number;
}

/**
 * The core handler owns the existing scanner/policy evaluator. Requiring it
 * at this seam prevents an authoring adapter from accidentally treating a
 * metadata-visible but unapproved release as readable content.
 */
export type ReleaseAdmission = (
  state: RegistryState,
  release: SkillVersion,
  principal: Principal,
) => boolean | Promise<boolean>;

export interface AuthoringHandlerDependencies {
  repository: StateRepository;
  blobs: BlobStore;
  auth: Authenticator;
  config: AuthoringHandlerConfig;
  releaseAdmission: ReleaseAdmission;
  /** Synchronous admission predicate evaluated inside the repository CAS transaction. */
  releaseAdmissionAtCommit?: (state: RegistryState, release: SkillVersion, principal: Principal) => boolean;
  /** Optional advisory upload/edit review integration. Scanner admission remains authoritative. */
  uploadReview?: UploadReviewIntegration;
}

export interface UploadReviewIntegration {
  service: UploadReviewPersistenceService;
  model: string;
  reviewerRevision: string;
  /** True only when the runtime has the separate service token and Eve trigger configured. */
  configured?: boolean;
  /** Starts the separate Eve session after its job is durably queued. */
  trigger?: (organizationId: string, jobId: string, service: UploadReviewPersistenceService) => Promise<unknown>;
}

export interface AuthoringHandler {
  (request: Request): Promise<Response>;
}

export interface AuthorizedReleaseSnapshot {
  state: RegistryState;
  release: SkillVersion;
  bytes: Uint8Array;
  bundle: ReturnType<typeof decodeBundle>;
}

export class AuthoringApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AuthoringApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Create the read-only immutable release file route. The route is deliberately
 * a small adapter package so the main registry handler can mount it without
 * making the editor/storage contract depend on a runtime or provider SDK.
 *
 * Canonical route:
 *   GET /v1/skills/:releaseId/files
 *   GET /v1/skills/:releaseId/file?path=canonical/relative/path
 *
 * The selected release is authorized before its sealed object is read. The
 * object is independently hashed and decoded through the canonical bundle
 * validator; the route never creates drafts, transfer grants, releases, or
 * audit events and never returns storage keys or scanner details. A concrete
 * repository may bootstrap an empty tenant on read as part of its existing
 * persistence contract; this adapter performs no authoring mutation.
 */
export function createReleaseFilesHandler(deps: AuthoringHandlerDependencies): AuthoringHandler {
  const maxTextPreviewBytes = normalizePreviewLimit(deps.config.maxTextPreviewBytes);

  return async function releaseFilesHandler(request: Request): Promise<Response> {
    try {
      if (request.method.toUpperCase() !== 'GET') {
        throw new AuthoringApiError('METHOD_NOT_ALLOWED', 'Only GET is supported', 405);
      }

      const principal = await deps.auth.authenticate(request);
      if (!principal || principal.organizationId !== deps.config.organizationId) {
        throw new AuthoringApiError('UNAUTHORIZED', 'Authentication is required', 401);
      }
      assertReader(principal);

      const url = parseRequestUrl(request);
      const segments = splitPath(url.pathname);
      if (
        segments.length !== 4 ||
        segments[0] !== 'v1' ||
        segments[1] !== 'skills' ||
        (segments[3] !== 'files' && segments[3] !== 'file')
      ) {
        throw new AuthoringApiError('NOT_FOUND', 'Route not found', 404);
      }
      const releaseId = decodePathPart(segments[2]);
      if (!isSafeReleaseId(releaseId)) {
        throw new AuthoringApiError('NOT_FOUND', 'Release is unavailable', 404);
      }
      const selectedPath = selectedFilePath(url);
      if (segments[3] === 'file' && selectedPath === undefined) {
        throw new AuthoringApiError('INVALID_REQUEST', 'path is required', 400);
      }
      if (segments[3] === 'files' && selectedPath !== undefined) {
        throw new AuthoringApiError('INVALID_REQUEST', 'Use the singular file route for a selected path', 400);
      }

      const snapshot = await readAuthorizedReleaseSnapshot(deps, principal, releaseId);
      const { release, bundle } = snapshot;

      const files = await Promise.all(bundle.files
        .filter((file) => selectedPath === undefined || file.path === selectedPath)
        .map((file) => viewFile(
          file.path,
          file.content,
          file.executable === true,
          maxTextPreviewBytes,
          selectedPath !== undefined,
        )));
      if (selectedPath !== undefined && files.length === 0) {
        throw unavailable();
      }

      const response: ReleaseFilesResponse = {
        release: {
          id: release.id,
          name: release.name,
          skillName: release.skillName,
          version: release.version,
          digest: release.artifact.digest,
          fileCount: release.fileCount,
        },
        files,
      };
      return jsonResponse(response, 200, { 'cache-control': 'private, no-store' });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * Load one approved, policy-admitted release and verify its sealed object.
 * Draft creation reuses this exact gate so the read-only view and authoring
 * path cannot drift into separate release authorization rules.
 */
export async function readAuthorizedReleaseSnapshot(
  deps: AuthoringHandlerDependencies,
  principal: Principal,
  releaseId: string,
): Promise<AuthorizedReleaseSnapshot> {
  const state = await deps.repository.read(deps.config.organizationId);
  const release = state.skills.find(
    (candidate) =>
      candidate.id === releaseId &&
      candidate.organizationId === deps.config.organizationId &&
      canReadNamespace(principal, candidate.name),
  );

  // Keep existence, namespace, and admission failures indistinguishable. In
  // particular, pending/quarantined/revoked releases never reach the blob
  // store even if the caller knows an internal release id.
  if (!release || release.state !== 'approved' || release.policyRevision !== state.policy.revision) {
    throw unavailable();
  }
  let admitted = false;
  try {
    admitted = await deps.releaseAdmission(state, release, principal);
  } catch {
    throw new AuthoringApiError('RELEASE_UNAVAILABLE', 'Release admission could not be verified', 503);
  }
  if (!admitted) {
    throw unavailable();
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.blobs.get(release.artifact.key);
  } catch {
    throw new AuthoringApiError('ARTIFACT_UNAVAILABLE', 'Release content is temporarily unavailable', 503);
  }
  const actualDigest = await digestBytes(bytes);
  if (actualDigest !== release.artifact.digest || bytes.byteLength !== release.artifact.size) {
    throw new AuthoringApiError('DIGEST_MISMATCH', 'Release content failed integrity verification', 409);
  }
  if (!isSha256Digest(release.artifact.digest)) {
    throw new AuthoringApiError('INTERNAL_STATE_INVALID', 'Release digest is invalid', 500);
  }

  let bundle: ReturnType<typeof decodeBundle>;
  try {
    bundle = decodeBundle(bytes);
  } catch {
    throw new AuthoringApiError('ARTIFACT_INVALID', 'Release content is not a canonical bundle', 409);
  }
  if (release.fileCount !== bundle.files.length) {
    throw new AuthoringApiError('INTERNAL_STATE_INVALID', 'Release file manifest does not match its artifact', 409);
  }
  return { state, release, bytes, bundle };
}

function normalizePreviewLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RELEASE_TEXT_PREVIEW_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10 * 1024 * 1024) {
    throw new Error('maxTextPreviewBytes must be a positive safe integer no greater than 10485760');
  }
  return value;
}

function parseRequestUrl(request: Request): URL {
  try {
    return new URL(request.url);
  } catch {
    throw new AuthoringApiError('INVALID_REQUEST', 'Request URL is invalid', 400);
  }
}

function splitPath(pathname: string): string[] {
  return pathname.replaceAll('\\', '/').split('/').filter(Boolean);
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AuthoringApiError('NOT_FOUND', 'Release is unavailable', 404);
  }
}

/** Validate and normalize one canonical relative file path query value. */
export function selectedFilePath(url: URL): string | undefined {
  const values = url.searchParams.getAll('path');
  if (values.length === 0) return undefined;
  if (values.length !== 1) {
    throw new AuthoringApiError('INVALID_REQUEST', 'path must be provided once', 400);
  }
  const path = values[0];
  if (!path || path.length > 4_096 || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new AuthoringApiError('INVALID_REQUEST', 'path is invalid', 400);
  }
  return path.normalize('NFC');
}

function isSafeReleaseId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f/\\]/u.test(value);
}

export function assertReader(principal: Principal): void {
  const roles = principal.roles;
  if (!Array.isArray(roles)) {
    throw new AuthoringApiError('FORBIDDEN', 'Principal roles are invalid', 403);
  }
  const isReader = roles.includes('reader') || roles.includes('publisher') || roles.includes('admin') || roles.includes('owner');
  const identity = (principal as Principal & { identity?: unknown }).identity;
  if (!isReader || identity === 'worker') {
    throw new AuthoringApiError('FORBIDDEN', 'Reader role required', 403);
  }
  const scopes = (principal as Principal & { scopes?: unknown }).scopes;
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
      throw new AuthoringApiError('FORBIDDEN', 'Principal scopes are invalid', 403);
    }
    const allowed = scopes as string[];
    if (!allowed.includes('*') && !allowed.includes('registry:*') && !allowed.includes('skills:read') && !allowed.includes('registry:read')) {
      throw new AuthoringApiError('FORBIDDEN', 'The principal lacks the required scope', 403);
    }
  }
}

export function assertPublisher(principal: Principal): void {
  if (!Array.isArray(principal.roles)) {
    throw new AuthoringApiError('FORBIDDEN', 'Principal roles are invalid', 403);
  }
  const identity = (principal as Principal & { identity?: unknown }).identity;
  if (identity === 'worker' || (!principal.roles.includes('publisher') && !principal.roles.includes('admin') && !principal.roles.includes('owner'))) {
    throw new AuthoringApiError('FORBIDDEN', 'Publisher role required', 403);
  }
  const scopes = (principal as Principal & { scopes?: unknown }).scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string'))) {
    throw new AuthoringApiError('FORBIDDEN', 'Principal scopes are invalid', 403);
  }
  if (Array.isArray(scopes) && !scopes.includes('*') && !scopes.includes('registry:*') && !scopes.includes('skills:write') && !scopes.includes('skills:publish')) {
    throw new AuthoringApiError('FORBIDDEN', 'The principal lacks the required scope', 403);
  }
}

export function canReadNamespace(principal: Principal, name: string): boolean {
  if (principal.roles.includes('owner') || principal.roles.includes('admin')) return true;
  if (!principal.roles.includes('reader') && !principal.roles.includes('publisher')) return false;
  if (!principal.namespaces || principal.namespaces.length === 0) return true;
  const namespace = name.startsWith('@') ? name.split('/')[0] : name;
  return principal.namespaces.some((candidate) => candidate === namespace || candidate === namespace.slice(1));
}

/** Classify one already validated bundle file for a bounded read-only view. */
export async function viewFile(
  path: string,
  encodedContent: string,
  executable: boolean,
  maxTextPreviewBytes: number,
  includeContents: boolean,
): Promise<ReleaseFileView> {
  const bytes = decodeBase64(encodedContent);
  const contentDigest = await digestBytes(bytes);
  const base = {
    path,
    size: bytes.byteLength,
    contentDigest,
    ...(executable ? { executable: true } : {}),
  };
  if (isBinaryPath(path) || bytes.includes(0)) {
    return { ...base, previewState: 'binary' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ...base, previewState: 'binary' };
  }
  if (!isSupportedTextPath(path)) {
    return { ...base, previewState: 'unsupported' };
  }
  if (bytes.byteLength > maxTextPreviewBytes) {
    return { ...base, previewState: 'oversize' };
  }
  return { ...base, previewState: 'text', ...(includeContents ? { contents: text } : {}) };
}

function decodeBase64(value: string): Uint8Array {
  if (!isCanonicalBase64(value)) {
    throw new AuthoringApiError('ARTIFACT_INVALID', 'Release file content is not canonical base64', 409);
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new AuthoringApiError('ARTIFACT_INVALID', 'Release file content is not canonical base64', 409);
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const dataLength = value.length - padding;
  if (padding === 1 && dataLength % 4 !== 3) return false;
  if (padding === 2 && dataLength % 4 !== 2) return false;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b || code === 0x2f;
    if (!valid) return false;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cfg', 'conf', 'cpp', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'json',
  'jsx', 'md', 'mjs', 'mts', 'py', 'rs', 'sh', 'sql', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
]);
const BINARY_EXTENSIONS = new Set(['7z', 'avi', 'bin', 'bmp', 'class', 'dll', 'doc', 'docx', 'gif', 'gz', 'ico', 'jar', 'jpeg', 'jpg', 'mp3', 'mp4', 'pdf', 'png', 'so', 'tar', 'wasm', 'webp', 'woff', 'woff2', 'zip']);
const TEXT_FILENAMES = new Set(['.editorconfig', '.gitignore', '.npmignore', 'dockerfile', 'license', 'makefile', 'readme']);

function fileExtension(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot + 1) : '';
}

function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(fileExtension(path));
}

function isSupportedTextPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return TEXT_FILENAMES.has(basename) || TEXT_EXTENSIONS.has(fileExtension(path));
}

export function unavailable(): AuthoringApiError {
  return new AuthoringApiError('NOT_FOUND', 'Release is unavailable', 404);
}

export function jsonResponse(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AuthoringApiError) {
    return jsonResponse({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }, error.status, { 'cache-control': 'no-store' });
  }
  return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed' } }, 500, { 'cache-control': 'no-store' });
}
