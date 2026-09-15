import type { Authenticator, BlobStore, Principal } from '../../../../packages/contracts/src/index.js';
import {
  CliReleaseIntegrityError,
  CliReleaseProviderError,
  cliReleaseAssetForTarget,
  createBlobCliReleaseAssetProvider,
  publicCliReleaseManifest,
  verifyCliReleaseAssetBytes,
  type CliReleaseAssetProvider,
  type CliReleaseManifest,
} from '../../../../packages/cli-release/src/index.js';

/** Authenticated company CLI distribution endpoints. */
export const CLI_RELEASE_ROUTE_PATHS = Object.freeze({
  root: '/v1/cli/releases',
  download: '/v1/cli/releases/:version/:target/download',
});

const DOWNLOAD_ROLES = new Set(['owner', 'admin', 'publisher', 'reader']);
const REQUIRED_SCOPES = ['registry:read', 'artifacts:download'] as const;

export interface CliReleaseRoutesOptions {
  /** Current pinned release metadata. */
  manifest: CliReleaseManifest;
  /** Tenant-bound request authenticator supplied by the outer router. */
  authenticate: Authenticator['authenticate'];
  /** Exact organization selected by the tenant router for this handler. */
  organizationId: string;
  /** Private object provider. No GitHub fetches occur in a request. */
  provider?: CliReleaseAssetProvider;
  /** Convenience injection for Node or edge infrastructure. */
  blobs?: BlobStore;
}

export interface CliReleaseRoutes {
  (request: Request): Promise<Response | undefined>;
}

export class CliReleaseRouteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status: number, retryable = false) {
    super(message);
    this.name = 'CliReleaseRouteError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof CliReleaseRouteError) {
    return Response.json({ code: error.code, message: error.message, retryable: error.retryable }, {
      status: error.status,
      headers: { 'cache-control': 'no-store' },
    });
  }
  return Response.json({ code: 'CLI_RELEASE_UNAVAILABLE', message: 'CLI release distribution is temporarily unavailable.', retryable: true }, {
    status: 503,
    headers: { 'cache-control': 'no-store' },
  });
}

function normalizedPath(request: Request): string | undefined {
  try {
    const pathname = new URL(request.url).pathname;
    return pathname.replace(/\/+$/u, '') || '/';
  } catch {
    return undefined;
  }
}

function decodeSegment(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new CliReleaseRouteError('CLI_RELEASE_INVALID_PATH', 'CLI release path is invalid.', 400);
  }
  if (decoded.length === 0 || decoded.includes('/') || decoded.includes('\\') || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new CliReleaseRouteError('CLI_RELEASE_INVALID_PATH', 'CLI release path is invalid.', 400);
  }
  return decoded;
}

function routeParts(pathname: string): { kind: 'root' | 'version' | 'download'; version?: string; target?: string } | undefined {
  if (pathname === CLI_RELEASE_ROUTE_PATHS.root) return { kind: 'root' };
  if (!pathname.startsWith(`${CLI_RELEASE_ROUTE_PATHS.root}/`)) return undefined;
  const raw = pathname.slice(CLI_RELEASE_ROUTE_PATHS.root.length + 1).split('/');
  if (raw.length === 1 && raw[0] !== '') return { kind: 'version', version: decodeSegment(raw[0]!) };
  if (raw.length === 3 && raw[2] === 'download') {
    return { kind: 'download', version: decodeSegment(raw[0]!), target: decodeSegment(raw[1]!) };
  }
  throw new CliReleaseRouteError('CLI_RELEASE_INVALID_PATH', 'CLI release path is invalid.', 400);
}

async function authorizedPrincipal(options: CliReleaseRoutesOptions, request: Request): Promise<Principal> {
  let principal: Principal | null;
  try {
    principal = await options.authenticate(request);
  } catch {
    throw new CliReleaseRouteError('CLI_RELEASE_AUTH_UNAVAILABLE', 'CLI release authorization is temporarily unavailable.', 503, true);
  }
  if (!principal) throw new CliReleaseRouteError('UNAUTHENTICATED', 'Authentication is required.', 401);
  if (
    typeof principal.subject !== 'string' || principal.subject.trim() === '' ||
    typeof principal.organizationId !== 'string' || principal.organizationId.trim() === '' ||
    principal.organizationId !== options.organizationId
  ) {
    throw new CliReleaseRouteError('CLI_RELEASE_TENANT_FORBIDDEN', 'The authenticated company cannot access this release.', 403);
  }
  if (
    !Array.isArray(principal.roles) ||
    principal.roles.includes('worker') ||
    !principal.roles.some((role) => DOWNLOAD_ROLES.has(role))
  ) {
    throw new CliReleaseRouteError('CLI_RELEASE_FORBIDDEN', 'A company member role is required for CLI downloads.', 403);
  }
  if (principal.scopes !== undefined) {
    const scopes = new Set(principal.scopes);
    if (!scopes.has('*') && !REQUIRED_SCOPES.every((scope) => scopes.has(scope))) {
      throw new CliReleaseRouteError('CLI_RELEASE_SCOPE_FORBIDDEN', 'The credential does not include CLI release download scope.', 403);
    }
  }
  return principal;
}

function methodError(request: Request): CliReleaseRouteError | undefined {
  if (request.method.toUpperCase() === 'GET') return undefined;
  return new CliReleaseRouteError('METHOD_NOT_ALLOWED', 'CLI release routes accept GET requests only.', 405);
}

/**
 * Build a tenant-bound handler. The manifest endpoint is authenticated too,
 * so release inventory and private delivery state are not anonymous metadata.
 */
export function createCliReleaseRoutes(options: CliReleaseRoutesOptions): CliReleaseRoutes {
  if (typeof options.organizationId !== 'string' || options.organizationId.trim() === '') {
    throw new CliReleaseRouteError('INVALID_CONFIGURATION', 'CLI release organization binding is invalid.', 500);
  }
  const provider = options.provider ?? (options.blobs === undefined ? undefined : createBlobCliReleaseAssetProvider(options.blobs));
  const publicManifest = publicCliReleaseManifest(options.manifest, (asset) => provider?.availability?.(asset) ?? 'unknown');

  return async (request: Request): Promise<Response | undefined> => {
    const pathname = normalizedPath(request);
    if (pathname === undefined) return undefined;
    let parts: ReturnType<typeof routeParts>;
    try {
      parts = routeParts(pathname);
    } catch (error) {
      return errorResponse(error);
    }
    if (parts === undefined) return undefined;
    const methodErrorResponse = methodError(request);
    if (methodErrorResponse) return errorResponse(methodErrorResponse);
    try {
      await authorizedPrincipal(options, request);
      if (parts.kind === 'root') {
        return Response.json(publicManifest, { headers: { 'cache-control': 'no-store' } });
      }
      if (parts.version !== options.manifest.version) {
        throw new CliReleaseRouteError('CLI_RELEASE_NOT_FOUND', 'CLI release version was not found.', 404);
      }
      if (parts.kind === 'version') {
        return Response.json(publicManifest, { headers: { 'cache-control': 'no-store' } });
      }
      const asset = cliReleaseAssetForTarget(options.manifest, parts.target!);
      if (asset === undefined) throw new CliReleaseRouteError('CLI_RELEASE_UNSUPPORTED_TARGET', 'CLI release target is not available.', 404);
      if (provider === undefined) throw new CliReleaseRouteError('CLI_RELEASE_UNAVAILABLE', 'CLI release storage is not configured.', 503, true);
      let bytes: Uint8Array;
      try {
        bytes = await provider.get(asset);
      } catch (error) {
        if (error instanceof CliReleaseProviderError && error.code === 'not_configured') {
          throw new CliReleaseRouteError('CLI_RELEASE_UNAVAILABLE', 'CLI release storage is not configured.', 503, true);
        }
        if (error instanceof CliReleaseProviderError && error.code === 'invalid') {
          throw new CliReleaseRouteError('CLI_RELEASE_INTEGRITY', 'CLI release storage reference is invalid.', 502, true);
        }
        throw new CliReleaseRouteError('CLI_RELEASE_PROVIDER_ERROR', 'CLI release storage could not be read.', 502, true);
      }
      try {
        bytes = await verifyCliReleaseAssetBytes(asset, bytes);
      } catch (error) {
        if (error instanceof CliReleaseIntegrityError) {
          throw new CliReleaseRouteError('CLI_RELEASE_INTEGRITY', 'CLI release bytes failed integrity verification.', 502, true);
        }
        throw error;
      }
      const contentType = asset.archive === 'zip' ? 'application/zip' : 'application/gzip';
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-type': contentType,
          'content-length': String(bytes.byteLength),
          'content-disposition': `attachment; filename="${asset.filename}"`,
          'etag': `"${asset.digest}"`,
          'x-content-type-options': 'nosniff',
          'x-pskills-release-digest': asset.digest,
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
