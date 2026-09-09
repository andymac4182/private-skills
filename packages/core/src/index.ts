import {
  PROTOCOL_VERSION,
  type AuditEvent,
  type Authenticator,
  type Digest,
  type DistributionState,
  type Finding,
  type ImportRequest,
  type InstallAuthorization,
  type Job,
  type PackMember,
  type PackVersion,
  type Policy,
  type Principal,
  type Provenance,
  type RegistryConfiguration,
  type RegistryDependencies,
  type RegistryState,
  type Resolution,
  type Role,
  type ScanResult,
  type ScannerId,
  type ScannerPolicy,
  type SkillBundle,
  type SkillVersion,
  type StateRepository,
  type StoredBlob,
  type TransferDescriptor,
  type TransferGrant,
  type Upstream,
} from '../../contracts/src/index.js';
import {
  digestBytes,
  encodeBundle,
  parseSkillMetadata,
  validateBundle,
} from '../../storage/src/index.js';

/**
 * The registry handler is deliberately implemented using only Web APIs.  The
 * persistence, authentication, and private object store are injected by the
 * Nitro adapter (or by a test), which keeps this package usable on Node and
 * edge Nitro targets alike.
 */

const SERVICE_VERSION = '0.1.0';
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_LEASE_SECONDS = 300;
const TRANSFER_TTL_SECONDS = 60;
const SUPPORTED_SCANNERS: readonly ScannerId[] = [
  'cisco-skill-scanner',
  'nvidia-skillspector',
  'skillsguard',
];
const SCAN_STATUSES = new Set<ScanResult['status']>([
  'completed',
  'degraded',
  'error',
  'timeout',
  'unsupported',
]);
const JOB_STATES = new Set<Job['state']>(['queued', 'running', 'completed', 'failed']);
const PACK_STATES = new Set<PackVersion['state']>(['approved', 'revoked']);
const SEVERITIES = new Set<Finding['severity']>([
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);
const DISTRIBUTION_STATES = new Set<DistributionState>([
  'pending',
  'approved',
  'quarantined',
  'scan-error',
  'revoked',
]);
const ROLES = new Set<Role>(['owner', 'admin', 'publisher', 'reader', 'worker']);
const POLICY_MODES = new Set<ScannerPolicy['mode']>([
  'disabled',
  'advisory',
  'required',
]);
const HOOK_MODES = new Set<'disabled' | 'advisory' | 'required'>([
  'disabled',
  'advisory',
  'required',
]);
const HOOK_EVENTS = new Set<NonNullable<Policy['hooks']>[number]['event']>([
  'ingest.validate',
  'artifact.evaluate',
  'pack.evaluate',
  'artifact.approved',
  'artifact.quarantined',
]);

type JsonObject = Record<string, unknown>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class RegistryApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    options?: { retryable?: boolean; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'RegistryApiError';
    this.code = code;
    this.status = status;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export interface RegistryHandler {
  (request: Request): Promise<Response>;
}

/** A safe, empty state used by memory repositories and migration shims. */
export function createEmptyRegistryState(policy: Policy = defaultPolicy()): RegistryState {
  return {
    schemaVersion: 1,
    skills: [],
    packs: [],
    jobs: [],
    scans: [],
    policy,
    upstreams: [],
    authorizations: [],
    grants: [],
    audit: [],
  };
}

export function defaultPolicy(): Policy {
  return {
    revision: 'policy-initial',
    scanners: SUPPORTED_SCANNERS.map((id) => ({
      id,
      mode: 'disabled',
      blockSeverities: ['high', 'critical'],
      timeoutSeconds: 300,
    })),
    // A registry must opt in to distribution without scanner evidence.  This
    // default makes an unconfigured deployment fail closed.
    allowUnscanned: false,
    evidenceMaxAgeSeconds: 7 * 24 * 60 * 60,
    hooks: [],
  };
}

/**
 * Create a portable Request -> Response registry API.
 *
 * The handler does not call fetch, read a filesystem, execute an uploaded
 * script, or use a provider SDK.  Network/source acquisition and scanning are
 * worker responsibilities and arrive through the fenced job completion route.
 */
export function createRegistryHandler(deps: RegistryDependencies): RegistryHandler {
  const config = normalizeConfiguration(deps.config);

  return async function registryHandler(request: Request): Promise<Response> {
    const requestId = randomId('req');

    try {
      const url = parseRequestUrl(request, config.publicOrigin);
      const method = request.method.toUpperCase() as HttpMethod;
      const path = normalizePath(url.pathname);
      const segments = splitPath(path);

      // Health is intentionally the first public route and contains no
      // authentication or deployment-specific information.
      if (method === 'GET' && path === '/health') {
        return jsonResponse({
          ok: true,
          service: 'private-skills',
          version: SERVICE_VERSION,
        }, 200, { 'cache-control': 'no-store' });
      }

      // Session exchange is the only authenticated API family that does not
      // require an existing principal.  CLI Bearer authentication is handled
      // by the injected authenticator for all other routes.
      if (segments[0] === 'auth' && segments[1] === 'session') {
        assertSessionRequestSafe(request, config, method);
        if (method === 'POST') {
          return await createSessionResponse(request, deps.auth, config.maxBodyBytes, config.organizationId);
        }
        if (method === 'DELETE') {
          return new Response(null, {
            status: 204,
            headers: {
              'cache-control': 'no-store',
              ...(deps.auth.clearSessionCookie
                ? { 'set-cookie': deps.auth.clearSessionCookie() }
                : {}),
            },
          });
        }
        return methodNotAllowed(['POST', 'DELETE']);
      }

      // A transfer grant is an opaque, short-lived capability.  It is not
      // authenticated with a registry bearer/session token.
      if (segments[0] === 'v1' && segments[1] === 'transfers' && segments.length === 3) {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        return await serveTransferGrant(segments[2], deps, config, requestId);
      }

      const principal = await authenticate(deps.auth, request);
      assertPrincipal(principal, config.organizationId);

      if (path === '/v1/me') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        return jsonResponse(publicPrincipal(principal));
      }

      if (path === '/v1/capabilities') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        requireReader(principal);
        return jsonResponse({
          protocolVersion: PROTOCOL_VERSION,
          schemaVersion: 1,
          service: 'private-skills',
          features: {
            bundles: ['pskills-bundle-v1'],
            packs: true,
            imports: true,
            installAuthorizations: true,
            transferMode: 'gateway',
            rangeSupported: false,
          },
          limits: {
            maxBodyBytes: config.maxBodyBytes,
            leaseSeconds: config.leaseSeconds,
            transferTtlSeconds: TRANSFER_TTL_SECONDS,
          },
          scanners: [...SUPPORTED_SCANNERS],
        });
      }

      if (segments[0] === 'v1' && segments[1] === 'skills') {
        return await handleSkillsRoute(
          method,
          segments,
          url,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'publish' && segments.length === 2) {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        requirePublisher(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await publishSkill(body, principal, deps, config, requestId);
      }

      if (segments[0] === 'v1' && segments[1] === 'resolve' && segments.length === 2) {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        requireReader(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await resolveRoute(body, principal, deps, requestId);
      }

      if (segments[0] === 'v1' && segments[1] === 'operations') {
        return await handleOperationsRoute(
          method,
          segments,
          principal,
          deps,
          requestId,
        );
      }

      if (
        segments[0] === 'v1' &&
        segments[1] === 'install-authorizations'
      ) {
        return await handleInstallAuthorizationRoute(
          method,
          segments,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'artifacts' && segments.length === 4) {
        if (method !== 'POST' || segments[3] !== 'download') {
          return methodNotAllowed(['POST']);
        }
        requireReader(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await createDownloadGrant(
          decodePathPart(segments[2]),
          body,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'packs') {
        return await handlePacksRoute(
          method,
          segments,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      if (segments[0] === 'v1' && segments[1] === 'policy') {
        if (method === 'GET') {
          requireReader(principal);
          const state = await readState(deps.repository, config.organizationId);
          return jsonResponse({ policy: state.policy });
        }
        if (method === 'PUT') {
          requireAdmin(principal);
          const body = await readJson(request, config.maxBodyBytes);
          return await updatePolicy(body, principal, deps, config, requestId);
        }
        return methodNotAllowed(['GET', 'PUT']);
      }

      if (segments[0] === 'v1' && segments[1] === 'scans') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        requireReader(principal);
        const state = await readState(deps.repository, config.organizationId);
        const artifactDigest = url.searchParams.get('artifactDigest');
        if (artifactDigest && !isDigest(artifactDigest)) {
          throw new RegistryApiError('INVALID_DIGEST', 'artifactDigest must be a sha256 digest');
        }
        const accessible = accessibleSkillIds(state, principal);
        const scans = state.scans.filter((scan) => {
          if (artifactDigest && scan.artifactDigest !== artifactDigest) return false;
          return state.skills.some(
            (skill) => skill.artifact.digest === scan.artifactDigest && accessible.has(skill.id),
          );
        });
        return jsonResponse({ scans });
      }

      if (segments[0] === 'v1' && segments[1] === 'upstreams') {
        if (method === 'GET') {
          requireReader(principal);
          const state = await readState(deps.repository, config.organizationId);
          return jsonResponse({
            upstreams: state.upstreams.filter((upstream) => canReadNamespace(principal, upstream.namespace)),
          });
        }
        if (method === 'POST') {
          requireAdmin(principal);
          const body = await readJson(request, config.maxBodyBytes);
          return await createUpstream(body, principal, deps, config, requestId);
        }
        return methodNotAllowed(['GET', 'POST']);
      }

      if (segments[0] === 'v1' && segments[1] === 'imports' && segments.length === 2) {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        requirePublisher(principal);
        const body = await readJson(request, config.maxBodyBytes);
        return await createImportJob(body, principal, deps, config, requestId);
      }

      if (segments[0] === 'v1' && segments[1] === 'audit') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        requireAdmin(principal);
        const state = await readState(deps.repository, config.organizationId);
        return jsonResponse({ events: state.audit });
      }

      if (segments[0] === 'internal' && segments[1] === 'jobs') {
        return await handleJobsRoute(
          method,
          segments,
          request,
          principal,
          deps,
          config,
          requestId,
        );
      }

      throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}

function normalizeConfiguration(config: RegistryConfiguration): Required<RegistryConfiguration> {
  return {
    publicOrigin: config.publicOrigin || 'http://localhost',
    maxBodyBytes:
      Number.isFinite(config.maxBodyBytes) && config.maxBodyBytes > 0
        ? Math.floor(config.maxBodyBytes)
        : DEFAULT_MAX_BODY_BYTES,
    organizationId: config.organizationId,
    leaseSeconds:
      Number.isFinite(config.leaseSeconds) && config.leaseSeconds > 0
        ? Math.floor(config.leaseSeconds)
        : DEFAULT_LEASE_SECONDS,
    allowLoopbackUpstreams: config.allowLoopbackUpstreams ?? false,
  };
}

function assertSessionRequestSafe(
  request: Request,
  config: Required<RegistryConfiguration>,
  method: HttpMethod,
): void {
  if (method !== 'POST' && method !== 'DELETE') return;
  const site = request.headers.get('sec-fetch-site')?.toLowerCase();
  if (site === 'cross-site') {
    throw new RegistryApiError('CSRF_DENIED', 'Cross-site session mutations are not allowed', 403);
  }
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    let origin: string;
    try {
      origin = new URL(originHeader).origin;
    } catch {
      throw new RegistryApiError('CSRF_DENIED', 'Session request origin is invalid', 403);
    }
    let expected: string;
    try {
      expected = new URL(config.publicOrigin).origin;
    } catch {
      throw new RegistryApiError('CSRF_DENIED', 'Session origin policy is invalid', 403);
    }
    if (origin !== expected) {
      throw new RegistryApiError('CSRF_DENIED', 'Session request origin is not allowed', 403);
    }
  }
  // A CLI exchange has no cookie and may omit Origin. Once a browser cookie is
  // present, both login refresh and logout must carry a same-origin Origin.
  if (request.headers.get('cookie') && !originHeader) {
    throw new RegistryApiError('CSRF_DENIED', 'Origin is required for cookie session mutations', 403);
  }
}

async function authenticate(auth: Authenticator, request: Request): Promise<Principal> {
  try {
    const principal = await auth.authenticate(request);
    if (!principal) throw new RegistryApiError('UNAUTHORIZED', 'Authentication required', 401);
    return principal;
  } catch (error) {
    if (error instanceof RegistryApiError) throw error;
    if (isObject(error) && typeof error.code === 'string' && Number.isFinite(Number(error.status))) {
      throw new RegistryApiError(error.code, typeof error.message === 'string' ? error.message : 'Authentication failed', Number(error.status));
    }
    throw new RegistryApiError('UNAUTHORIZED', 'Authentication required', 401);
  }
}

function assertPrincipal(principal: Principal, organizationId: string): void {
  if (
    !principal ||
    typeof principal.subject !== 'string' ||
    principal.subject.trim() === '' ||
    typeof principal.organizationId !== 'string' ||
    principal.organizationId.trim() === ''
  ) {
    throw new RegistryApiError('UNAUTHORIZED', 'Authentication required', 401);
  }
  if (principal.organizationId !== organizationId) {
    throw new RegistryApiError('FORBIDDEN', 'Organization access denied', 403);
  }
  if (
    principal.namespaces !== undefined &&
    (!Array.isArray(principal.namespaces) || principal.namespaces.some((namespace) => typeof namespace !== 'string' || namespace.trim() === ''))
  ) {
    throw new RegistryApiError('FORBIDDEN', 'Principal namespace grants are invalid', 403);
  }
  if (
    !Array.isArray(principal.roles) ||
    principal.roles.length === 0 ||
    principal.roles.some((role) => !ROLES.has(role))
  ) {
    throw new RegistryApiError('FORBIDDEN', 'No registry role is assigned', 403);
  }
}

function publicPrincipal(principal: Principal): Principal {
  return {
    organizationId: principal.organizationId,
    subject: principal.subject,
    roles: [...principal.roles],
    namespaces: principal.namespaces ? [...principal.namespaces] : undefined,
  };
}

function requireReader(principal: Principal): void {
  if (!hasRole(principal, 'reader') && !hasRole(principal, 'publisher') && !hasRole(principal, 'admin') && !hasRole(principal, 'owner')) {
    throw new RegistryApiError('FORBIDDEN', 'Reader role required', 403);
  }
}

function requirePublisher(principal: Principal): void {
  if (!hasRole(principal, 'publisher') && !hasRole(principal, 'admin') && !hasRole(principal, 'owner')) {
    throw new RegistryApiError('FORBIDDEN', 'Publisher role required', 403);
  }
}

function requireAdmin(principal: Principal): void {
  if (!hasRole(principal, 'admin') && !hasRole(principal, 'owner')) {
    throw new RegistryApiError('FORBIDDEN', 'Administrator role required', 403);
  }
}

function requireWorker(principal: Principal): void {
  if (!hasRole(principal, 'worker')) {
    throw new RegistryApiError('FORBIDDEN', 'Worker role required', 403);
  }
}

function hasRole(principal: Principal, role: Role): boolean {
  return Array.isArray(principal.roles) && principal.roles.includes(role);
}

function canReadNamespace(principal: Principal, namespaceOrName: string): boolean {
  if (hasRole(principal, 'owner') || hasRole(principal, 'admin')) return true;
  const namespace = namespaceOrName.startsWith('@')
    ? namespaceOrName.split('/')[0]
    : namespaceOrName;
  if (!hasRole(principal, 'reader') && !hasRole(principal, 'publisher')) return false;
  if (!principal.namespaces || principal.namespaces.length === 0) return true;
  return principal.namespaces.some((candidate) => candidate === namespace || candidate === namespace.slice(1));
}

function canPublishName(principal: Principal, name: string): boolean {
  return (hasRole(principal, 'owner') || hasRole(principal, 'admin') || hasRole(principal, 'publisher')) && canReadNamespace(principal, name);
}

function splitPath(path: string): string[] {
  if (path === '/') return [];
  return path.split('/').filter(Boolean);
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const path = pathname.replaceAll('\\', '/').replace(/\/+/g, '/');
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function parseRequestUrl(request: Request, publicOrigin: string): URL {
  try {
    return new URL(request.url, publicOrigin);
  } catch {
    throw new RegistryApiError('INVALID_REQUEST', 'Request URL is invalid', 400);
  }
}

function decodePathPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new RegistryApiError('INVALID_REQUEST', 'Path parameter is invalid', 400);
  }
}

async function readJson(request: Request, maxBodyBytes: number): Promise<JsonObject> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number.isFinite(Number(declaredLength)) && Number(declaredLength) > maxBodyBytes) {
    throw new RegistryApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit', 413);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    throw new RegistryApiError('INVALID_REQUEST', 'Request body could not be read', 400);
  }
  if (bytes.byteLength > maxBodyBytes) {
    throw new RegistryApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit', 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RegistryApiError('INVALID_JSON', 'Request body must be valid JSON', 400);
  }
  if (!isObject(parsed)) {
    throw new RegistryApiError('INVALID_JSON', 'Request body must be a JSON object', 400);
  }
  return parsed;
}

async function createSessionResponse(
  request: Request,
  auth: Authenticator,
  maxBodyBytes: number,
  organizationId: string,
): Promise<Response> {
  if (!auth.createSession) {
    throw new RegistryApiError('UNSUPPORTED', 'Session authentication is not configured', 501);
  }
  const body = await readJson(request, maxBodyBytes);
  const token = stringValue(body.token);
  if (!token) throw new RegistryApiError('INVALID_TOKEN', 'A session token is required', 400);
  const result = await auth.createSession(token);
  if (!result) throw new RegistryApiError('UNAUTHORIZED', 'Session token is invalid', 401);
  assertPrincipal(result.principal, organizationId);
  return jsonResponse({ principal: publicPrincipal(result.principal) }, 200, {
    'cache-control': 'no-store',
    'set-cookie': result.cookie,
  });
}

async function handleSkillsRoute(
  method: HttpMethod,
  segments: string[],
  url: URL,
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (segments.length === 2) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    requireReader(principal);
    const state = await readState(deps.repository, config.organizationId);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const skills = state.skills.filter((skill) => {
      if (!canReadNamespace(principal, skill.name)) return false;
      if (!q) return true;
      return [skill.name, skill.skillName, skill.description, skill.version]
        .some((value) => value.toLowerCase().includes(q));
    });
    return jsonResponse({ skills });
  }

  if (segments.length === 3) {
    const id = decodePathPart(segments[2]);
    if (method === 'GET') {
      requireReader(principal);
      const state = await readState(deps.repository, config.organizationId);
      const skill = state.skills.find((candidate) => candidate.id === id && canReadNamespace(principal, candidate.name));
      if (!skill) throw unavailable();
      assertKnownDistributionState(skill.state);
      return jsonResponse({ skill });
    }
    return methodNotAllowed(['GET']);
  }

  if (segments.length === 4 && segments[3] === 'rescan') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requirePublisher(principal);
    const id = decodePathPart(segments[2]);
    return await rescanSkill(id, principal, deps, config, requestId);
  }

  if (segments.length === 4 && segments[3] === 'revoke') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requireAdmin(principal);
    const id = decodePathPart(segments[2]);
    return await revokeSkill(id, principal, deps, config, requestId);
  }

  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
}

async function publishSkill(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const name = requireSkillName(body.name);
  if (!canPublishName(principal, name)) throw new RegistryApiError('FORBIDDEN', 'Namespace publish denied', 403);
  const version = requireVersion(body.version);
  if (body.description !== undefined && typeof body.description !== 'string') {
    throw new RegistryApiError('INVALID_REQUEST', 'description must be a string', 400);
  }
  const requestedDescription = stringValue(body.description) || '';
  if (!isObject(body.bundle)) throw new RegistryApiError('BUNDLE_INVALID', 'bundle must be an object', 400);

  let bundle: SkillBundle;
  let bytes: Uint8Array;
  let parsedMetadata: { skillName?: string; description?: string };
  try {
    bundle = validateBundle(body.bundle) as SkillBundle;
    bytes = encodeBundle(bundle);
    parsedMetadata = parseSkillMetadata(bundle) as { skillName?: string; description?: string };
  } catch (error) {
    throw bundleError(error);
  }
  const digest = await digestBytes(bytes);
  const state = await readState(deps.repository, config.organizationId);
  const duplicate = state.skills.find(
    (skill) => skill.name === name && skill.version === version,
  );
  if (duplicate) throw new RegistryApiError('VERSION_CONFLICT', 'That skill version already exists', 409);

  const stored = await putVerifiedBlob(deps, bytes, digest);
  const now = nowIso();
  const policy = clonePolicy(state.policy);
  const jobId = randomId('job');
  const skillId = randomId('skill');
  const skill: SkillVersion = {
    id: skillId,
    organizationId: config.organizationId,
    name,
    skillName: normalizeSkillName(parsedMetadata.skillName) || name.slice(name.indexOf('/') + 1),
    version,
    description: requestedDescription || stringValue(parsedMetadata.description) || '',
    artifact: stored,
    state: 'pending',
    policyRevision: policy.revision,
    createdAt: now,
    provenance: { kind: 'native' },
    fileCount: bundle.files.length,
    scanIds: [],
  };
  const job: Job = {
    id: jobId,
    organizationId: config.organizationId,
    kind: 'scan',
    state: 'queued',
    resourceId: skillId,
    artifact: stored,
    policyRevision: policy.revision,
    policy,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  const result = await deps.repository.transaction(config.organizationId, (current) => {
    const mutable = ensureState(current, state.policy);
    if (mutable.skills.some((candidate) => candidate.name === name && candidate.version === version)) {
      throw new RegistryApiError('VERSION_CONFLICT', 'That skill version already exists', 409);
    }
    mutable.skills.push(skill);
    mutable.jobs.push(job);
    appendAudit(mutable, audit(principal, 'skill.publish.queued', skillId, {
      digest,
      version,
      requestId,
    }, config.organizationId));
    return job;
  });
  return jsonResponse({ operation: result }, 202);
}

async function handleOperationsRoute(
  method: HttpMethod,
  segments: string[],
  principal: Principal,
  deps: RegistryDependencies,
  requestId: string,
): Promise<Response> {
  if (method !== 'GET') return methodNotAllowed(['GET']);
  requireReader(principal);
  const state = await readState(deps.repository, principal.organizationId);
  if (segments.length === 2) {
    const operations = state.jobs.filter((job) => jobVisibleToPrincipal(job, state, principal));
    return jsonResponse({ operations });
  }
  if (segments.length === 3) {
    const id = decodePathPart(segments[2]);
    const job = state.jobs.find((candidate) => candidate.id === id && jobVisibleToPrincipal(candidate, state, principal));
    if (!job) throw unavailable();
    return jsonResponse({ operation: job });
  }
  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404, {
    details: { requestId },
  });
}

function jobVisibleToPrincipal(job: Job, state: RegistryState, principal: Principal): boolean {
  if (hasRole(principal, 'owner') || hasRole(principal, 'admin')) return true;
  if (job.resourceId) {
    const skill = state.skills.find((candidate) => candidate.id === job.resourceId);
    return !!skill && canReadNamespace(principal, skill.name);
  }
  return !!job.import && canPublishName(principal, job.import.name);
}

async function resolveRoute(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  requestId: string,
): Promise<Response> {
  const kind = body.kind;
  if (kind !== 'skill' && kind !== 'pack') {
    throw new RegistryApiError('INVALID_RESOLUTION', 'kind must be skill or pack', 400);
  }
  const ref = stringValue(body.ref);
  if (!ref) throw new RegistryApiError('INVALID_RESOLUTION', 'ref is required', 400);
  const version = body.version === undefined ? undefined : requireVersion(body.version);
  const state = await readState(deps.repository, principal.organizationId);
  const result = resolveResource(state, principal, kind, ref, version);
  if (result.kind === 'pending') return jsonResponse({ operation: result.job }, 202);
  if (result.kind !== 'resolved') throw unavailable();
  return jsonResponse({ resolution: result.resolution });
}

function resolveResource(
  state: RegistryState,
  principal: Principal,
  kind: 'skill' | 'pack',
  ref: string,
  version?: string,
): { kind: 'resolved'; resource: SkillVersion | PackVersion; resolution: Resolution } | { kind: 'pending'; job: Job } | { kind: 'unavailable' } {
  if (kind === 'skill') {
    const candidates = state.skills.filter((skill) => {
      if (!canReadNamespace(principal, skill.name)) return false;
      return skill.id === ref || skill.name === ref || skill.skillName === ref;
    });
    const selected = chooseVersion(candidates, version);
    if (!selected) {
      const pending = state.jobs.find((job) => {
        if (!job.resourceId || job.kind !== 'scan') return false;
        const skill = state.skills.find((candidate) => candidate.id === job.resourceId);
        return !!skill && canReadNamespace(principal, skill.name) && (skill.id === ref || skill.name === ref) && (version === undefined || skill.version === version);
      });
      const pendingImport = pending || state.jobs.find((job) => {
        return job.kind === 'import' && !!job.import && canPublishName(principal, job.import.name) && job.import.name === ref && (version === undefined || job.import.version === version);
      });
      return pendingImport ? { kind: 'pending', job: pendingImport } : { kind: 'unavailable' };
    }
    assertKnownDistributionState(selected.state);
    if (selected.state === 'pending') {
      const job = state.jobs.find((candidate) => candidate.resourceId === selected.id && candidate.kind === 'scan');
      return job ? { kind: 'pending', job } : { kind: 'unavailable' };
    }
    if (!skillCurrentlyApproved(state, selected)) {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'resolved',
      resource: selected,
      resolution: {
        kind: 'skill',
        resourceId: selected.id,
        organizationId: selected.organizationId,
        name: selected.name,
        version: selected.version,
        digest: selected.artifact.digest,
        members: [selected],
      },
    };
  }

  const candidates = state.packs.filter((pack) => {
    if (!canReadNamespace(principal, pack.name)) return false;
    return pack.id === ref || pack.name === ref;
  });
  const selected = chooseVersion(candidates, version);
  if (!selected) return { kind: 'unavailable' };
  if (selected.state !== 'approved' || selected.policyRevision !== state.policy.revision) return { kind: 'unavailable' };
  const members: SkillVersion[] = [];
  for (const member of selected.members) {
    const skill = state.skills.find((candidate) => candidate.id === member.resourceId);
    if (!skill || !skillCurrentlyApproved(state, skill) || skill.artifact.digest !== member.digest || !canReadNamespace(principal, skill.name)) {
      return { kind: 'unavailable' };
    }
    members.push(skill);
  }
  return {
    kind: 'resolved',
    resource: selected,
    resolution: {
      kind: 'pack',
      resourceId: selected.id,
      organizationId: selected.organizationId,
      name: selected.name,
      version: selected.version,
      digest: selected.manifestDigest,
      members,
    },
  };
}

/**
 * Approval is bound to both the policy revision and the evidence age.  A
 * release may remain in the historical `approved` state for audit purposes,
 * but it stops resolving or minting install capabilities when its required
 * evidence is no longer current.
 */
function skillCurrentlyApproved(state: RegistryState, skill: SkillVersion): boolean {
  if (skill.state !== 'approved' || skill.policyRevision !== state.policy.revision) return false;
  const scans = state.scans.filter((scan) => skill.scanIds.includes(scan.id));
  return evaluatePolicy(state.policy, scans, skill.artifact.digest).state === 'approved';
}

async function handleInstallAuthorizationRoute(
  method: HttpMethod,
  segments: string[],
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (segments.length === 2) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requireReader(principal);
    const body = await readJson(request, config.maxBodyBytes);
    return await createInstallAuthorization(body, principal, deps, config, requestId);
  }
  if (segments.length === 4 && segments[3] === 'validate') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    requireReader(principal);
    return await validateInstallAuthorization(decodePathPart(segments[2]), principal, deps, config, requestId);
  }
  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
}

async function createInstallAuthorization(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const state = await readState(deps.repository, principal.organizationId);
  const requested = isObject(body.resolution) ? body.resolution : body;
  const resolution = await resolveRequestedResolution(requested, state, principal);
  assertCurrentResolution(state, principal, resolution);
  const now = Date.now();
  const authorization: InstallAuthorization = {
    id: randomId('authz'),
    organizationId: config.organizationId,
    subject: principal.subject,
    resolution,
    expiresAt: new Date(now + TRANSFER_TTL_SECONDS * 1000).toISOString(),
  };
  const result = await deps.repository.transaction(config.organizationId, (current) => {
    const mutable = ensureState(current, state.policy);
    const currentResolution = resolveResource(
      mutable,
      principal,
      resolution.kind,
      resolution.resourceId,
      resolution.version,
    );
    if (currentResolution.kind !== 'resolved' || !sameResolution(currentResolution.resolution, resolution)) {
      throw new RegistryApiError('POLICY_BLOCKED', 'Resolution changed before authorization', 409, { retryable: true });
    }
    mutable.authorizations.push(authorization);
    appendAudit(mutable, audit(principal, 'install.authorization.create', authorization.id, {
      resourceId: resolution.resourceId,
      digest: resolution.digest,
      requestId,
    }, config.organizationId));
    return authorization;
  });
  return jsonResponse({ authorization: result }, 201);
}

async function validateInstallAuthorization(
  id: string,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const state = await readState(deps.repository, config.organizationId);
  const current = state.authorizations.find(
    (authorization) => authorization.id === id && authorization.subject === principal.subject,
  );
  if (!current) throw unavailable();
  if (timestampExpired(current.expiresAt)) throw unavailable();
  assertCurrentResolution(state, principal, current.resolution);
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const index = mutable.authorizations.findIndex((candidate) => candidate.id === id && candidate.subject === principal.subject);
    if (index < 0) throw unavailable();
    const currentAuthorization = mutable.authorizations[index]!;
    if (timestampExpired(currentAuthorization.expiresAt)) throw unavailable();
    assertCurrentResolution(mutable, principal, currentAuthorization.resolution);
    const authorization: InstallAuthorization = {
      ...currentAuthorization,
      expiresAt: new Date(Date.now() + TRANSFER_TTL_SECONDS * 1000).toISOString(),
    };
    mutable.authorizations[index] = authorization;
    appendAudit(mutable, audit(principal, 'install.authorization.validate', id, {
      resourceId: authorization.resolution.resourceId,
      requestId,
    }, config.organizationId));
    return authorization;
  });
  return jsonResponse({ authorization: result });
}

async function resolveRequestedResolution(
  requested: JsonObject,
  state: RegistryState,
  principal: Principal,
): Promise<Resolution> {
  const kind = requested.kind;
  if (kind !== 'skill' && kind !== 'pack') {
    throw new RegistryApiError('INVALID_RESOLUTION', 'kind must be skill or pack', 400);
  }
  const ref = stringValue(requested.ref) || stringValue(requested.resourceId);
  if (!ref) throw new RegistryApiError('INVALID_RESOLUTION', 'ref or resourceId is required', 400);
  const version = requested.version === undefined ? undefined : requireVersion(requested.version);
  const result = resolveResource(state, principal, kind, ref, version);
  if (result.kind !== 'resolved') {
    if (result.kind === 'pending') throw new RegistryApiError('SCAN_PENDING', 'Resource is still being evaluated', 409, { retryable: true });
    throw unavailable();
  }
  // Callers may provide a previously resolved plan.  Every supplied digest and
  // member must match the current resolution; this prevents a stale or mixed
  // namespace plan from being authorized.
  if (requested.digest !== undefined && requested.digest !== result.resolution.digest) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Resolution digest does not match the current release', 409);
  }
  if (requested.members !== undefined) {
    if (!Array.isArray(requested.members) || requested.members.length !== result.resolution.members.length) {
      throw new RegistryApiError('POLICY_BLOCKED', 'Resolution members do not match the current release', 409);
    }
    for (const [index, rawMember] of requested.members.entries()) {
      if (!isObject(rawMember)) {
        throw new RegistryApiError('INVALID_RESOLUTION', 'Resolution members must be objects', 400);
      }
      const currentMember = result.resolution.members[index];
      const suppliedDigest = isObject(rawMember.artifact) ? stringValue(rawMember.artifact.digest) : undefined;
      if (
        !currentMember ||
        stringValue(rawMember.id) !== currentMember.id ||
        stringValue(rawMember.name) !== currentMember.name ||
        stringValue(rawMember.version) !== currentMember.version ||
        suppliedDigest !== currentMember.artifact.digest
      ) {
        throw new RegistryApiError('DIGEST_MISMATCH', 'Resolution members do not match the current release', 409);
      }
    }
  }
  return result.resolution;
}

function assertCurrentResolution(state: RegistryState, principal: Principal, resolution: Resolution): void {
  const result = resolveResource(state, principal, resolution.kind, resolution.resourceId, resolution.version);
  if (result.kind !== 'resolved' || !sameResolution(result.resolution, resolution)) {
    throw new RegistryApiError('POLICY_BLOCKED', 'Resolution is no longer installable', 409);
  }
}

function sameResolution(a: Resolution, b: Resolution): boolean {
  if (a.kind !== b.kind || a.resourceId !== b.resourceId || a.organizationId !== b.organizationId || a.name !== b.name || a.version !== b.version || a.digest !== b.digest) return false;
  if (a.members.length !== b.members.length) return false;
  return a.members.every((member, index) => {
    const other = b.members[index];
    return !!other && member.id === other.id && member.name === other.name && member.artifact.digest === other.artifact.digest && member.version === other.version;
  });
}

async function createDownloadGrant(
  digest: string,
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (!isDigest(digest)) throw new RegistryApiError('INVALID_DIGEST', 'Artifact digest is invalid', 400);
  const resourceId = stringValue(body.resourceId);
  const authorizationId = stringValue(body.authorizationId);
  if (!resourceId || !authorizationId) throw new RegistryApiError('INVALID_REQUEST', 'resourceId and authorizationId are required', 400);
  const state = await readState(deps.repository, config.organizationId);
  const authorization = state.authorizations.find(
    (candidate) => candidate.id === authorizationId && candidate.subject === principal.subject,
  );
  if (!authorization || timestampExpired(authorization.expiresAt)) throw unavailable();
  assertCurrentResolution(state, principal, authorization.resolution);
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const currentAuthorization = mutable.authorizations.find(
      (candidate) => candidate.id === authorizationId && candidate.subject === principal.subject,
    );
    if (!currentAuthorization || timestampExpired(currentAuthorization.expiresAt)) throw unavailable();
    assertCurrentResolution(mutable, principal, currentAuthorization.resolution);
    const member = currentAuthorization.resolution.members.find(
      (candidate) => candidate.id === resourceId && candidate.artifact.digest === digest,
    );
    if (!member || member.state !== 'approved') throw unavailable();
    const grant: TransferGrant = {
      id: randomId('grant'),
      organizationId: config.organizationId,
      subject: principal.subject,
      resourceId,
      authorizationId,
      digest: member.artifact.digest,
      expiresAt: new Date(Date.now() + TRANSFER_TTL_SECONDS * 1000).toISOString(),
    };
    mutable.grants.push(grant);
    appendAudit(mutable, audit(principal, 'artifact.download.grant', resourceId, {
      digest,
      authorizationId,
      requestId,
    }, config.organizationId));
    return { grant, size: member.artifact.size };
  });
  const descriptor: TransferDescriptor = {
    mode: 'gateway',
    url: `${config.publicOrigin.replace(/\/$/, '')}/v1/transfers/${encodeURIComponent(result.grant.id)}`,
    method: 'GET',
    headers: {},
    expiresAt: result.grant.expiresAt,
    size: result.size,
    digest,
    rangeSupported: false,
  };
  return jsonResponse(descriptor);
}

async function serveTransferGrant(
  grantIdPart: string,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const grantId = decodePathPart(grantIdPart);
  const state = await readState(deps.repository, config.organizationId);
  const grant = state.grants.find((candidate) => candidate.id === grantId);
  if (!grant || grant.organizationId !== config.organizationId || timestampExpired(grant.expiresAt)) {
    throw unavailable();
  }
  const authorization = state.authorizations.find((candidate) => candidate.id === grant.authorizationId && candidate.subject === grant.subject);
  if (!authorization || timestampExpired(authorization.expiresAt)) throw unavailable();
  assertCurrentResolution(state, {
    organizationId: config.organizationId,
    subject: grant.subject,
    roles: ['reader'],
  }, authorization.resolution);
  const skill = state.skills.find((candidate) => candidate.id === grant.resourceId);
  if (!skill || skill.state !== 'approved' || skill.artifact.digest !== grant.digest) throw unavailable();
  let bytes: Uint8Array;
  try {
    bytes = await deps.blobs.get(skill.artifact.key);
  } catch {
    throw new RegistryApiError('ARTIFACT_UNAVAILABLE', 'Artifact is temporarily unavailable', 503, { retryable: true });
  }
  const actualDigest = await digestBytes(bytes);
  if (actualDigest !== grant.digest) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Stored artifact digest does not match its release', 409, {
      details: { requestId },
    });
  }
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'content-disposition': 'attachment',
    },
  });
}

async function handlePacksRoute(
  method: HttpMethod,
  segments: string[],
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  if (segments.length === 2) {
    if (method === 'GET') {
      requireReader(principal);
      const state = await readState(deps.repository, config.organizationId);
      return jsonResponse({
        packs: state.packs.filter((pack) => packVisibleToPrincipal(pack, state, principal)),
      });
    }
    if (method === 'POST') {
      requirePublisher(principal);
      const body = await readJson(request, config.maxBodyBytes);
      return await createPack(body, principal, deps, config, requestId);
    }
    return methodNotAllowed(['GET', 'POST']);
  }
  if (segments.length === 3 && method === 'GET') {
    requireReader(principal);
    const id = decodePathPart(segments[2]);
    const state = await readState(deps.repository, config.organizationId);
    const pack = state.packs.find((candidate) => candidate.id === id && packVisibleToPrincipal(candidate, state, principal));
    if (!pack) throw unavailable();
    return jsonResponse({ pack });
  }
  return methodNotAllowed(['GET']);
}

function packVisibleToPrincipal(pack: PackVersion, state: RegistryState, principal: Principal): boolean {
  if (!canReadNamespace(principal, pack.name)) return false;
  if (hasRole(principal, 'owner') || hasRole(principal, 'admin')) return true;
  return pack.members.every((member) => {
    const skill = state.skills.find((candidate) => candidate.id === member.resourceId);
    return !!skill && canReadNamespace(principal, skill.name);
  });
}

async function createPack(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const name = requireSkillName(body.name);
  if (!canPublishName(principal, name)) throw new RegistryApiError('FORBIDDEN', 'Namespace publish denied', 403);
  const version = requireVersion(body.version);
  if (body.description !== undefined && typeof body.description !== 'string') {
    throw new RegistryApiError('INVALID_PACK', 'description must be a string', 400);
  }
  const description = stringValue(body.description) || '';
  if (!Array.isArray(body.skills) || body.skills.length === 0 || body.skills.length > 500) {
    throw new RegistryApiError('INVALID_PACK', 'skills must contain between 1 and 500 members', 400);
  }
  const state = await readState(deps.repository, config.organizationId);
  if (state.packs.some((pack) => pack.name === name && pack.version === version)) {
    throw new RegistryApiError('VERSION_CONFLICT', 'That pack version already exists', 409);
  }
  const members: PackMember[] = [];
  const ids = new Set<string>();
  for (const raw of body.skills) {
    if (!isObject(raw)) throw new RegistryApiError('INVALID_PACK', 'Each pack member must be an object', 400);
    const ref = stringValue(raw.ref);
    const memberVersion = requireVersion(raw.version);
    if (!ref) throw new RegistryApiError('INVALID_PACK', 'Each pack member requires ref', 400);
    const result = resolveResource(state, principal, 'skill', ref, memberVersion);
    if (result.kind !== 'resolved') {
      if (result.kind === 'pending') throw new RegistryApiError('SCAN_PENDING', 'Pack member is still being evaluated', 409, { retryable: true });
      throw new RegistryApiError('POLICY_BLOCKED', 'Pack members must be approved skills', 409);
    }
    if (result.resource.state !== 'approved') throw new RegistryApiError('POLICY_BLOCKED', 'Pack members must be approved skills', 409);
    if (ids.has(result.resource.id)) throw new RegistryApiError('INVALID_PACK', 'Pack members must be unique', 400);
    ids.add(result.resource.id);
    const skill = result.resource as SkillVersion;
    members.push({
      resourceId: skill.id,
      name: skill.name,
      version: skill.version,
      digest: skill.artifact.digest,
    });
  }
  const manifestBytes = new TextEncoder().encode(stableStringify({ name, version, description, members }));
  const manifestDigest = await digestBytes(manifestBytes);
  const pack: PackVersion = {
    id: randomId('pack'),
    organizationId: config.organizationId,
    name,
    version,
    description,
    members,
    manifestDigest,
    state: 'approved',
    createdAt: nowIso(),
    policyRevision: state.policy.revision,
  };
  const result = await deps.repository.transaction(config.organizationId, (current) => {
    const mutable = ensureState(current, state.policy);
    if (mutable.packs.some((candidate) => candidate.name === name && candidate.version === version)) {
      throw new RegistryApiError('VERSION_CONFLICT', 'That pack version already exists', 409);
    }
    // Recheck exact members in the same transaction as publication.  This is
    // the pack-level race/fencing invariant: a member cannot be revoked or
    // replaced between resolution and the immutable manifest commit.
    for (const member of members) {
      const skill = mutable.skills.find((candidate) => candidate.id === member.resourceId);
      if (!skill || skill.state !== 'approved' || skill.artifact.digest !== member.digest || skill.policyRevision !== mutable.policy.revision) {
        throw new RegistryApiError('POLICY_BLOCKED', 'Pack member changed before publication', 409, { retryable: true });
      }
    }
    mutable.packs.push(pack);
    appendAudit(mutable, audit(principal, 'pack.publish', pack.id, {
      manifestDigest,
      memberCount: members.length,
      requestId,
    }, config.organizationId));
    return pack;
  });
  return jsonResponse({ pack: result }, 201);
}

async function updatePolicy(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const policy = parsePolicy(body);
  const current = await readState(deps.repository, config.organizationId);
  const next: Policy = {
    ...policy,
    // Revisions are server generated. A caller cannot replay or choose an
    // evidence namespace that was created under a different policy.
    revision: randomId('policy'),
  };
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, current.policy);
    mutable.policy = next;
    appendAudit(mutable, audit(principal, 'policy.update', next.revision, {
      allowUnscanned: next.allowUnscanned,
      scannerCount: next.scanners.length,
      requestId,
    }, config.organizationId));
    return next;
  });
  return jsonResponse({ policy: result });
}

async function rescanSkill(
  id: string,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const state = await readState(deps.repository, config.organizationId);
  const skill = state.skills.find((candidate) => candidate.id === id && canReadNamespace(principal, candidate.name));
  if (!skill) throw unavailable();
  const now = nowIso();
  const job: Job = {
    id: randomId('job'),
    organizationId: config.organizationId,
    kind: 'scan',
    state: 'queued',
    resourceId: skill.id,
    artifact: skill.artifact,
    policyRevision: state.policy.revision,
    policy: clonePolicy(state.policy),
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const currentSkill = mutable.skills.find((candidate) => candidate.id === id);
    if (!currentSkill || !canReadNamespace(principal, currentSkill.name)) throw unavailable();
    if (currentSkill.state !== 'revoked') currentSkill.state = 'pending';
    mutable.jobs.push(job);
    appendAudit(mutable, audit(principal, 'skill.rescan.queued', id, {
      digest: skill.artifact.digest,
      requestId,
    }, config.organizationId));
    return job;
  });
  return jsonResponse({ operation: result }, 202);
}

async function revokeSkill(
  id: string,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const state = await readState(deps.repository, config.organizationId);
  const existing = state.skills.find((candidate) => candidate.id === id);
  if (!existing || !canReadNamespace(principal, existing.name)) throw unavailable();
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const skill = mutable.skills.find((candidate) => candidate.id === id);
    if (!skill || !canReadNamespace(principal, skill.name)) throw unavailable();
    skill.state = 'revoked';
    for (const pack of mutable.packs) {
      if (pack.members.some((member) => member.resourceId === id)) pack.state = 'revoked';
    }
    appendAudit(mutable, audit(principal, 'skill.revoke', id, {
      digest: skill.artifact.digest,
      requestId,
    }, config.organizationId));
    return skill;
  });
  return jsonResponse({ skill: result });
}

async function createUpstream(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const name = stringValue(body.name);
  const kind = body.kind;
  const namespace = stringValue(body.namespace);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new RegistryApiError('INVALID_UPSTREAM', 'upstream name is invalid', 400);
  }
  if (kind !== 'github' && kind !== 'registry') throw new RegistryApiError('INVALID_UPSTREAM', 'kind must be github or registry', 400);
  if (!namespace || !/^@[a-z0-9][a-z0-9._-]{0,63}$/.test(namespace)) throw new RegistryApiError('INVALID_UPSTREAM', 'namespace is invalid', 400);
  if (!canReadNamespace(principal, namespace)) throw new RegistryApiError('FORBIDDEN', 'Namespace access denied', 403);
  const baseUrl = stringValue(body.baseUrl);
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new RegistryApiError('INVALID_UPSTREAM', 'baseUrl is invalid', 400);
    }
    if (parsed.username || parsed.password) {
      throw new RegistryApiError('INVALID_UPSTREAM', 'upstream baseUrl must not contain credentials', 400);
    }
    if (parsed.protocol !== 'https:' && !(config.allowLoopbackUpstreams && isLoopbackHost(parsed.hostname) && parsed.protocol === 'http:')) {
      throw new RegistryApiError('INVALID_UPSTREAM', 'upstream baseUrl must use HTTPS', 400);
    }
    if (isLoopbackHost(parsed.hostname) && !config.allowLoopbackUpstreams) {
      throw new RegistryApiError('INVALID_UPSTREAM', 'loopback upstreams are disabled', 400);
    }
  }
  const credentialEnv = stringValue(body.credentialEnv);
  if (credentialEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnv)) {
    throw new RegistryApiError('INVALID_UPSTREAM', 'credentialEnv must be an environment variable name', 400);
  }
  const repositoriesInput = body.repositories;
  const repositories = Array.isArray(repositoriesInput)
    ? repositoriesInput.filter((value): value is string => typeof value === 'string')
    : undefined;
  if (Array.isArray(repositoriesInput) && repositories && repositories.length !== repositoriesInput.length) {
    throw new RegistryApiError('INVALID_UPSTREAM', 'repositories must be strings', 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new RegistryApiError('INVALID_UPSTREAM', 'enabled must be a boolean', 400);
  }
  const upstream: Upstream = {
    id: randomId('upstream'),
    organizationId: config.organizationId,
    name,
    kind,
    enabled: body.enabled === undefined ? true : body.enabled,
    repositories,
    baseUrl,
    credentialEnv,
    namespace,
  };
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, defaultPolicy());
    if (mutable.upstreams.some((candidate) => candidate.name === name)) throw new RegistryApiError('VERSION_CONFLICT', 'That upstream already exists', 409);
    mutable.upstreams.push(upstream);
    appendAudit(mutable, audit(principal, 'upstream.create', upstream.id, {
      kind,
      namespace,
      requestId,
    }, config.organizationId));
    return upstream;
  });
  return jsonResponse({ upstream: result }, 201);
}

async function createImportJob(
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const upstreamId = stringValue(body.upstreamId);
  const path = stringValue(body.path);
  const name = requireSkillName(body.name);
  const version = requireVersion(body.version);
  if (
    !upstreamId ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    path.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new RegistryApiError('INVALID_IMPORT', 'upstreamId and a safe relative path are required', 400);
  }
  if (!canPublishName(principal, name)) throw new RegistryApiError('FORBIDDEN', 'Namespace publish denied', 403);
  const state = await readState(deps.repository, config.organizationId);
  const upstream = state.upstreams.find((candidate) => candidate.id === upstreamId && candidate.enabled);
  if (!upstream || !canReadNamespace(principal, upstream.namespace)) throw unavailable();
  const importRequest: ImportRequest = {
    upstreamId,
    repository: stringValue(body.repository),
    path,
    ref: stringValue(body.ref),
    name,
    version,
  };
  const job: Job = {
    id: randomId('job'),
    organizationId: config.organizationId,
    kind: 'import',
    state: 'queued',
    policyRevision: state.policy.revision,
    policy: clonePolicy(state.policy),
    import: importRequest,
    upstream,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    attempts: 0,
  };
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    if (mutable.skills.some((skill) => skill.name === name && skill.version === version)) throw new RegistryApiError('VERSION_CONFLICT', 'That skill version already exists', 409);
    mutable.jobs.push(job);
    appendAudit(mutable, audit(principal, 'skill.import.queued', job.id, {
      upstreamId,
      name,
      version,
      requestId,
    }, config.organizationId));
    return job;
  });
  return jsonResponse({ operation: result }, 202);
}

async function handleJobsRoute(
  method: HttpMethod,
  segments: string[],
  request: Request,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  requireWorker(principal);
  if (segments.length === 4 && segments[3] === 'artifact') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return await serveJobArtifact(decodePathPart(segments[2]), request, deps, config, requestId);
  }
  if (segments.length === 3 && segments[2] === 'claim') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return await claimJob(principal, deps, config, requestId);
  }
  if (segments.length === 4 && segments[3] === 'complete') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const body = await readJson(request, config.maxBodyBytes);
    const headerToken = request.headers.get('x-worker-fencing-token') || undefined;
    const bodyToken = stringValue(body.fencingToken) || stringValue(body.leaseToken);
    if (headerToken && bodyToken && headerToken !== bodyToken) {
      throw new RegistryApiError('LEASE_FENCED', 'Worker fencing token does not match the request body', 409);
    }
    if (headerToken || bodyToken) body.leaseToken = headerToken || bodyToken;
    return await completeJob(decodePathPart(segments[2]), body, principal, deps, config, requestId);
  }
  throw new RegistryApiError('NOT_FOUND', 'Route not found', 404);
}

async function claimJob(
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const now = Date.now();
  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, defaultPolicy());
    const candidate = mutable.jobs.find((job) => {
      if (job.organizationId !== config.organizationId) return false;
      if (job.state === 'queued') return true;
      return job.state === 'running' && timestampExpired(job.leaseExpiresAt, now);
    });
    if (!candidate) return null;
    candidate.state = 'running';
    candidate.attempts = (candidate.attempts || 0) + 1;
    candidate.leaseToken = randomId('lease');
    candidate.leaseExpiresAt = new Date(now + config.leaseSeconds * 1000).toISOString();
    candidate.updatedAt = new Date(now).toISOString();
    appendAudit(mutable, audit(principal, 'job.claim', candidate.id, {
      attempt: candidate.attempts,
      requestId,
    }, config.organizationId));
    return serializeJobForWorker(candidate);
  });
  return jsonResponse({ job: result });
}

async function serveJobArtifact(
  id: string,
  request: Request,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const token = request.headers.get('x-worker-fencing-token');
  const requestedDigest = request.headers.get('x-artifact-digest');
  if (!token || !requestedDigest || !isDigest(requestedDigest)) {
    throw new RegistryApiError('INVALID_LEASE', 'Worker fencing and artifact digest headers are required', 400);
  }
  const state = await readState(deps.repository, config.organizationId);
  const job = state.jobs.find((candidate) => candidate.id === id);
  if (!job) throw unavailable();
  if (job.state !== 'running' || job.leaseToken !== token) {
    throw new RegistryApiError('LEASE_FENCED', 'Job lease is no longer current', 409);
  }
  if (timestampExpired(job.leaseExpiresAt)) {
    throw new RegistryApiError('LEASE_EXPIRED', 'Job lease has expired', 409, { retryable: true });
  }
  if (!job.artifact || job.artifact.digest !== requestedDigest) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Requested artifact does not match the job', 409);
  }
  let bytes: Uint8Array;
  try {
    bytes = await deps.blobs.get(job.artifact.key);
  } catch {
    throw new RegistryApiError('ARTIFACT_UNAVAILABLE', 'Artifact is temporarily unavailable', 503, { retryable: true });
  }
  const actualDigest = await digestBytes(bytes);
  if (actualDigest !== job.artifact.digest || bytes.byteLength !== job.artifact.size) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Stored artifact digest does not match the job', 409, {
      details: { requestId },
    });
  }
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'x-artifact-digest': job.artifact.digest,
    },
  });
}

function serializeJobForWorker(
  job: Job,
): Job & { fencingToken?: string; artifactDigest?: Digest; attempt?: number; expiresAt?: string } {
  return {
    ...job,
    fencingToken: job.leaseToken,
    artifactDigest: job.artifact?.digest,
    attempt: job.attempts,
    expiresAt: job.leaseExpiresAt,
  };
}

async function completeJob(
  id: string,
  body: JsonObject,
  principal: Principal,
  deps: RegistryDependencies,
  config: Required<RegistryConfiguration>,
  requestId: string,
): Promise<Response> {
  const leaseToken = stringValue(body.leaseToken);
  if (!leaseToken) throw new RegistryApiError('INVALID_LEASE', 'leaseToken is required', 400);
  const state = await readState(deps.repository, config.organizationId);
  const job = state.jobs.find((candidate) => candidate.id === id);
  if (!job) throw unavailable();
  const requestedDigest = stringValue(body.artifactDigest);
  // Scan jobs already carry an immutable artifact. Import jobs only acquire
  // and canonicalize their artifact during completion, so their digest is
  // checked immediately after the bundle has been validated below.
  if (requestedDigest && job.artifact && requestedDigest !== job.artifact.digest) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Completion artifact digest does not match the job', 409);
  }
  if (job.state !== 'running' || job.leaseToken !== leaseToken) {
    throw new RegistryApiError('LEASE_FENCED', 'Job lease is no longer current', 409);
  }
  if (timestampExpired(job.leaseExpiresAt)) {
    throw new RegistryApiError('LEASE_EXPIRED', 'Job lease has expired', 409, { retryable: true });
  }
  if (body.error !== undefined && typeof body.error !== 'string') throw new RegistryApiError('INVALID_JOB_RESULT', 'error must be a string', 400);

  let imported: { bundle: SkillBundle; bytes: Uint8Array; stored: StoredBlob; digest: Digest; metadata: { skillName?: string; description?: string } } | undefined;
  if (job.kind === 'import' && !body.error) {
    if (!isObject(body.bundle)) throw new RegistryApiError('INVALID_JOB_RESULT', 'An import completion requires a bundle', 400);
    try {
      const bundle = validateBundle(body.bundle) as SkillBundle;
      const bytes = encodeBundle(bundle);
      const digest = await digestBytes(bytes);
      const stored = await putVerifiedBlob(deps, bytes, digest);
      const metadata = parseSkillMetadata(bundle) as { skillName?: string; description?: string };
      if (requestedDigest && requestedDigest !== digest) {
        throw new RegistryApiError('DIGEST_MISMATCH', 'Completion artifact digest does not match the imported bundle', 409);
      }
      imported = { bundle, bytes, stored, digest, metadata };
    } catch (error) {
      throw bundleError(error);
    }
  }

  const rawScanResults = body.scanResults;
  let scanResults: ScanResult[] = [];
  if (!body.error && rawScanResults !== undefined) {
    if (!Array.isArray(rawScanResults)) throw new RegistryApiError('INVALID_SCAN_RESULT', 'scanResults must be an array', 400);
    const expectedDigest = imported?.digest || job.artifact?.digest;
    if (!expectedDigest) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan evidence is missing an artifact digest', 400);
    scanResults = rawScanResults.map((value) => parseScanResult(value, job, config.organizationId, expectedDigest));
    const scannerIds = new Set(scanResults.map((scan) => scan.scannerId));
    if (scannerIds.size !== scanResults.length) throw new RegistryApiError('INVALID_SCAN_RESULT', 'A scanner may return only one result per job', 400);
    const resultIds = new Set(scanResults.map((scan) => scan.id));
    if (resultIds.size !== scanResults.length) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result ids must be unique', 400);
  }

  const result = await deps.repository.transaction(config.organizationId, (mutableState) => {
    const mutable = ensureState(mutableState, state.policy);
    const currentJob = mutable.jobs.find((candidate) => candidate.id === id);
    if (!currentJob || currentJob.state !== 'running' || currentJob.leaseToken !== leaseToken || timestampExpired(currentJob.leaseExpiresAt)) {
      throw new RegistryApiError('LEASE_FENCED', 'Job lease is no longer current', 409);
    }
    if (mutable.policy.revision !== currentJob.policyRevision) {
      currentJob.state = 'queued';
      currentJob.policy = clonePolicy(mutable.policy);
      currentJob.policyRevision = mutable.policy.revision;
      currentJob.updatedAt = nowIso();
      currentJob.leaseToken = undefined;
      currentJob.leaseExpiresAt = undefined;
      if (currentJob.resourceId) {
        const staleSkill = mutable.skills.find((candidate) => candidate.id === currentJob.resourceId);
        if (staleSkill && staleSkill.state !== 'revoked') {
          staleSkill.state = 'pending';
          staleSkill.policyRevision = mutable.policy.revision;
        }
      }
      appendAudit(mutable, audit(principal, 'job.requeue.policy-changed', id, { requestId }, config.organizationId));
      return currentJob;
    }
    if (typeof body.error === 'string' && body.error.length > 0) {
      currentJob.state = 'failed';
      currentJob.error = redactJobError(body.error);
      currentJob.updatedAt = nowIso();
      if (currentJob.resourceId) {
        const skill = mutable.skills.find((candidate) => candidate.id === currentJob.resourceId);
        if (skill && skill.state !== 'revoked') skill.state = 'scan-error';
      }
      appendAudit(mutable, audit(principal, 'job.complete.failed', id, {
        requestId,
      }, config.organizationId));
      return currentJob;
    }

    if (currentJob.kind === 'scan') {
      const skill = currentJob.resourceId ? mutable.skills.find((candidate) => candidate.id === currentJob.resourceId) : undefined;
      if (!skill) throw new RegistryApiError('NOT_AVAILABLE', 'Job resource is unavailable', 404);
      if (!currentJob.artifact || skill.artifact.digest !== currentJob.artifact.digest) throw new RegistryApiError('DIGEST_MISMATCH', 'Job artifact changed', 409);
      const evaluation = evaluatePolicy(currentJob.policy, scanResults, currentJob.artifact.digest);
      mutable.scans.push(...scanResults);
      skill.scanIds = [...new Set([...skill.scanIds, ...scanResults.map((scan) => scan.id)])];
      if (skill.state !== 'revoked') skill.state = evaluation.state;
      skill.policyRevision = currentJob.policyRevision;
      if (evaluation.state === 'approved') skill.approvedAt = nowIso();
      currentJob.state = 'completed';
      currentJob.updatedAt = nowIso();
      currentJob.leaseToken = undefined;
      currentJob.leaseExpiresAt = undefined;
      if (evaluation.error) currentJob.error = evaluation.error;
      appendAudit(mutable, audit(principal, `job.complete.${evaluation.state}`, id, {
        resourceId: skill.id,
        digest: skill.artifact.digest,
        scanCount: scanResults.length,
        requestId,
      }, config.organizationId));
      return currentJob;
    }

    if (!currentJob.import || !imported) throw new RegistryApiError('INVALID_JOB_RESULT', 'Import result is incomplete', 400);
    const request = currentJob.import;
    if (mutable.skills.some((skill) => skill.name === request.name && skill.version === request.version)) {
      throw new RegistryApiError('VERSION_CONFLICT', 'That skill version already exists', 409);
    }
    const evaluation = evaluatePolicy(currentJob.policy, scanResults, imported.digest);
    const skill: SkillVersion = {
      id: randomId('skill'),
      organizationId: config.organizationId,
      name: request.name,
      skillName: normalizeSkillName(imported.metadata.skillName) || request.name.slice(request.name.indexOf('/') + 1),
      version: request.version,
      description: stringValue(imported.metadata.description) || '',
      artifact: imported.stored,
      state: evaluation.state,
      policyRevision: currentJob.policyRevision,
      createdAt: nowIso(),
      approvedAt: evaluation.state === 'approved' ? nowIso() : undefined,
      provenance: normalizeProvenance(body.provenance, request, imported.digest),
      fileCount: imported.bundle.files.length,
      scanIds: scanResults.map((scan) => scan.id),
    };
    mutable.skills.push(skill);
    mutable.scans.push(...scanResults);
    currentJob.resourceId = skill.id;
    currentJob.artifact = imported.stored;
    currentJob.state = 'completed';
    currentJob.updatedAt = nowIso();
    currentJob.leaseToken = undefined;
    currentJob.leaseExpiresAt = undefined;
    if (evaluation.error) currentJob.error = evaluation.error;
    appendAudit(mutable, audit(principal, `job.complete.${evaluation.state}`, id, {
      resourceId: skill.id,
      digest: imported.digest,
      scanCount: scanResults.length,
      requestId,
    }, config.organizationId));
    return currentJob;
  });
  return jsonResponse({ operation: result });
}

function parseScanResult(
  raw: unknown,
  job: Job,
  organizationId: string,
  expectedDigest: Digest,
): ScanResult {
  if (!isObject(raw)) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Each scan result must be an object', 400);
  const status = raw.status;
  if (typeof status !== 'string' || !SCAN_STATUSES.has(status as ScanResult['status'])) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Unknown scanner result status', 400);
  }
  const scannerId = raw.scannerId;
  if (typeof scannerId !== 'string' || !SUPPORTED_SCANNERS.includes(scannerId as ScannerId)) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Unknown scanner id', 400);
  }
  const digest = stringValue(raw.artifactDigest);
  if (!digest || digest !== expectedDigest || !isDigest(digest)) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Scan result artifact digest does not match the job', 409);
  }
  if (stringValue(raw.organizationId) !== organizationId || stringValue(raw.jobId) !== job.id) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result is bound to a different job', 400);
  }
  const coverage = raw.coverage;
  if (
    !isObject(coverage) ||
    !nonNegativeInteger(coverage.filesEnumerated) ||
    !nonNegativeInteger(coverage.filesAnalyzed) ||
    !nonNegativeInteger(coverage.filesSkipped) ||
    !nonNegativeInteger(coverage.filesUnsupported) ||
    Number(coverage.filesAnalyzed) + Number(coverage.filesSkipped) + Number(coverage.filesUnsupported) > Number(coverage.filesEnumerated) ||
    !Array.isArray(coverage.limitations) ||
    coverage.limitations.length > 100 ||
    coverage.limitations.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 1024) ||
    !Array.isArray(coverage.externalDestinations) ||
    coverage.externalDestinations.length > 100 ||
    coverage.externalDestinations.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 255)
  ) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result coverage is invalid', 400);
  }
  if (!Array.isArray(raw.findings)) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result findings must be an array', 400);
  if (raw.findings.length > 10_000) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result contains too many findings', 400);
  const findings = raw.findings.map((finding) => parseFinding(finding));
  const id = stringValue(raw.id);
  const policyRevision = stringValue(raw.policyRevision);
  const engineVersion = stringValue(raw.engineVersion);
  const rulesRevision = stringValue(raw.rulesRevision);
  const configurationHash = stringValue(raw.configurationHash);
  if (!id || !policyRevision || !engineVersion || !rulesRevision || !configurationHash) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result identity is incomplete', 400);
  }
  if ([id, policyRevision, engineVersion, rulesRevision, configurationHash].some((value) => value.length > 256)) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result identity is too long', 400);
  }
  const createdAt = stringValue(raw.createdAt);
  const durationMs = raw.durationMs;
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (
    !createdAt ||
    !Number.isFinite(createdAtMs) ||
    createdAtMs > Date.now() ||
    !nonNegativeInteger(durationMs)
  ) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Scan result timestamp/duration is invalid', 400);
  }
  const result: ScanResult = {
    id,
    organizationId,
    jobId: job.id,
    artifactDigest: digest as Digest,
    policyRevision,
    scannerId: scannerId as ScannerId,
    engineVersion,
    rulesRevision,
    configurationHash,
    status: status as ScanResult['status'],
    findings,
    coverage: {
      filesEnumerated: Number(coverage.filesEnumerated),
      filesAnalyzed: Number(coverage.filesAnalyzed),
      filesSkipped: Number(coverage.filesSkipped),
      filesUnsupported: Number(coverage.filesUnsupported),
      limitations: coverage.limitations.filter((value): value is string => typeof value === 'string'),
      externalDestinations: coverage.externalDestinations.filter((value): value is string => typeof value === 'string'),
    },
    createdAt,
    durationMs: Number(durationMs),
    error: stringValue(raw.error) ? redactJobError(stringValue(raw.error)!).slice(0, 2_048) : undefined,
  };
  if (result.policyRevision !== job.policyRevision) throw new RegistryApiError('POLICY_BLOCKED', 'Scan result policy revision is stale', 409);
  return result;
}

function parseFinding(raw: unknown): Finding {
  if (!isObject(raw)) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding must be an object', 400);
  const severity = raw.severity;
  if (typeof severity !== 'string' || !SEVERITIES.has(severity as Finding['severity'])) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding severity is invalid', 400);
  const ruleId = stringValue(raw.ruleId);
  const fingerprint = stringValue(raw.fingerprint);
  const category = stringValue(raw.category);
  const message = stringValue(raw.message);
  if (!ruleId || !fingerprint || !category || !message) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding fields are incomplete', 400);
  if (ruleId.length > 128 || fingerprint.length > 256 || category.length > 128 || message.length > 4_096) throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding fields are too long', 400);
  const line = raw.line === undefined ? undefined : raw.line;
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    throw new RegistryApiError('INVALID_SCAN_RESULT', 'Finding line is invalid', 400);
  }
  return {
    ruleId,
    fingerprint,
    severity: severity as Finding['severity'],
    category,
    message: redactJobError(message),
    file: stringValue(raw.file)?.slice(0, 1_024),
    line: line as number | undefined,
    redactedEvidence: stringValue(raw.redactedEvidence)?.slice(0, 2_048),
  };
}

function evaluatePolicy(
  policy: Policy,
  results: ScanResult[],
  digest: Digest,
): { state: DistributionState; error?: string } {
  const scanners = Array.isArray(policy.scanners) ? policy.scanners : [];
  const relevant = results.filter((result) => result.artifactDigest === digest);
  const required = scanners.filter((scanner) => scanner.mode === 'required');
  const enabled = scanners.filter((scanner) => scanner.mode !== 'disabled');
  for (const scanner of required) {
    const result = relevant.find((candidate) => candidate.scannerId === scanner.id);
    if (!result) return { state: 'scan-error', error: `Required scanner ${scanner.id} did not return evidence` };
    if (result.status !== 'completed') return { state: 'scan-error', error: `Required scanner ${scanner.id} returned ${result.status}` };
    if (evidenceExpired(result, policy.evidenceMaxAgeSeconds)) return { state: 'scan-error', error: `Required scanner ${scanner.id} evidence is stale` };
    if (result.coverage.filesEnumerated <= 0 || result.coverage.filesAnalyzed <= 0) return { state: 'scan-error', error: `Required scanner ${scanner.id} did not analyze any files` };
    if (result.coverage.filesSkipped > 0 || result.coverage.filesUnsupported > 0) return { state: 'scan-error', error: `Required scanner ${scanner.id} did not cover every file` };
    if (result.findings.some((finding) => scanner.blockSeverities.includes(finding.severity))) return { state: 'quarantined', error: `Required scanner ${scanner.id} reported a blocking finding` };
  }
  if (required.length > 0) return { state: 'approved' };
  if (enabled.length === 0) {
    return policy.allowUnscanned
      ? { state: 'approved' }
      : { state: 'scan-error', error: 'No scanner evidence is configured and unscanned distribution is disabled' };
  }
  const missingAdvisory = enabled.some((scanner) => !relevant.some((result) => result.scannerId === scanner.id));
  if (missingAdvisory && !policy.allowUnscanned) return { state: 'scan-error', error: 'Scanner evidence is incomplete and unscanned distribution is disabled' };
  for (const scanner of enabled) {
    const result = relevant.find((candidate) => candidate.scannerId === scanner.id);
    if (result && result.status === 'completed' && result.findings.some((finding) => scanner.blockSeverities.includes(finding.severity))) {
      // Advisory scanners record findings but do not block distribution.
      continue;
    }
  }
  return { state: 'approved' };
}

function evidenceExpired(result: ScanResult, maxAgeSeconds: number): boolean {
  const createdAt = Date.parse(result.createdAt);
  if (!Number.isFinite(createdAt)) return true;
  if (createdAt > Date.now()) return true;
  return maxAgeSeconds >= 0 && Date.now() - createdAt > maxAgeSeconds * 1000;
}

function timestampExpired(value: string | undefined, now = Date.now()): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= now;
}

function normalizeProvenance(raw: unknown, request: ImportRequest, digest: Digest): Provenance {
  const value = isObject(raw) ? raw : {};
  return {
    kind: value.kind === 'github' || value.kind === 'registry' || value.kind === 'native' ? value.kind : 'github',
    upstreamId: request.upstreamId,
    repository: stringValue(value.repository) || request.repository,
    path: stringValue(value.path) || request.path,
    revision: stringValue(value.revision) || request.ref,
    sourceDigest: digest,
  };
}

function parsePolicy(body: JsonObject): Policy {
  if (!Array.isArray(body.scanners)) throw new RegistryApiError('INVALID_POLICY', 'scanners must be an array', 400);
  const scanners: ScannerPolicy[] = body.scanners.map((raw) => {
    if (!isObject(raw)) throw new RegistryApiError('INVALID_POLICY', 'scanner policy must be an object', 400);
    const id = raw.id;
    if (typeof id !== 'string' || !SUPPORTED_SCANNERS.includes(id as ScannerId)) throw new RegistryApiError('INVALID_POLICY', 'Unknown scanner id', 400);
    const mode = raw.mode;
    if (typeof mode !== 'string' || !POLICY_MODES.has(mode as ScannerPolicy['mode'])) throw new RegistryApiError('INVALID_POLICY', 'Unknown scanner mode', 400);
    if (!Array.isArray(raw.blockSeverities) || raw.blockSeverities.some((severity) => typeof severity !== 'string' || !SEVERITIES.has(severity as Finding['severity']))) throw new RegistryApiError('INVALID_POLICY', 'blockSeverities is invalid', 400);
    const timeoutSeconds = Number(raw.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 24 * 60 * 60) throw new RegistryApiError('INVALID_POLICY', 'timeoutSeconds is invalid', 400);
    return {
      id: id as ScannerId,
      mode: mode as ScannerPolicy['mode'],
      blockSeverities: raw.blockSeverities as Finding['severity'][],
      timeoutSeconds,
      configuration: isObject(raw.configuration) ? raw.configuration : undefined,
    };
  });
  if (new Set(scanners.map((scanner) => scanner.id)).size !== scanners.length) throw new RegistryApiError('INVALID_POLICY', 'Each scanner may appear once', 400);
  const allowUnscanned = body.allowUnscanned;
  if (typeof allowUnscanned !== 'boolean') throw new RegistryApiError('INVALID_POLICY', 'allowUnscanned must be boolean', 400);
  const evidenceMaxAgeSeconds = Number(body.evidenceMaxAgeSeconds);
  if (!Number.isFinite(evidenceMaxAgeSeconds) || evidenceMaxAgeSeconds < 0) throw new RegistryApiError('INVALID_POLICY', 'evidenceMaxAgeSeconds is invalid', 400);
  const hooks = body.hooks === undefined ? [] : parseHooks(body.hooks);
  return {
    revision: stringValue(body.revision) || '',
    scanners,
    allowUnscanned,
    evidenceMaxAgeSeconds,
    hooks,
  };
}

function parseHooks(raw: unknown): NonNullable<Policy['hooks']> {
  if (!Array.isArray(raw)) throw new RegistryApiError('INVALID_POLICY', 'hooks must be an array', 400);
  const hooks = raw.map((value) => {
    if (!isObject(value)) throw new RegistryApiError('INVALID_POLICY', 'hook must be an object', 400);
    const id = stringValue(value.id) || randomId('hook');
    const event = value.event;
    const mode = value.mode;
    const timeoutSeconds = Number(value.timeoutSeconds);
    if (typeof event !== 'string' || !HOOK_EVENTS.has(event as NonNullable<Policy['hooks']>[number]['event'])) throw new RegistryApiError('INVALID_POLICY', 'hook event is invalid', 400);
    if (typeof mode !== 'string' || !HOOK_MODES.has(mode as NonNullable<Policy['hooks']>[number]['mode'])) throw new RegistryApiError('INVALID_POLICY', 'hook mode is invalid', 400);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 24 * 60 * 60) throw new RegistryApiError('INVALID_POLICY', 'hook timeoutSeconds is invalid', 400);
    const url = stringValue(value.url);
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new RegistryApiError('INVALID_POLICY', 'hook url is invalid', 400);
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new RegistryApiError('INVALID_POLICY', 'hook url must be HTTPS without credentials', 400);
      }
    }
    const secretEnv = stringValue(value.secretEnv);
    if (secretEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(secretEnv)) {
      throw new RegistryApiError('INVALID_POLICY', 'hook secretEnv is invalid', 400);
    }
    return {
      id,
      event: event as NonNullable<Policy['hooks']>[number]['event'],
      mode: mode as NonNullable<Policy['hooks']>[number]['mode'],
      url,
      secretEnv,
      timeoutSeconds,
    };
  });
  if (new Set(hooks.map((hook) => hook.id)).size !== hooks.length) {
    throw new RegistryApiError('INVALID_POLICY', 'Each hook may appear once', 400);
  }
  return hooks;
}

function assertKnownDistributionState(state: string): asserts state is DistributionState {
  if (!DISTRIBUTION_STATES.has(state as DistributionState)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Resource state is invalid', 500);
}

async function readState(repository: StateRepository, organizationId: string): Promise<RegistryState> {
  try {
    const state = await repository.read(organizationId);
    const normalized = ensureState(state, defaultPolicy());
    validateStateStatuses(normalized);
    return normalized;
  } catch (error) {
    if (error instanceof RegistryApiError) throw error;
    throw new RegistryApiError('PERSISTENCE_UNAVAILABLE', 'Registry state is temporarily unavailable', 503, { retryable: true });
  }
}

function validateStateStatuses(state: RegistryState): void {
  validatePolicyRuntime(state.policy);
  for (const skill of state.skills) assertKnownDistributionState(skill.state);
  for (const pack of state.packs) {
    if (!PACK_STATES.has(pack.state)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Pack state is invalid', 500);
  }
  for (const job of state.jobs) {
    if (!JOB_STATES.has(job.state)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Job state is invalid', 500);
  }
  for (const scan of state.scans) {
    if (!SCAN_STATUSES.has(scan.status)) throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Scan result status is invalid', 500);
  }
}

function validatePolicyRuntime(policy: Policy): void {
  if (!policy || typeof policy.revision !== 'string' || policy.revision.length === 0 || !Array.isArray(policy.scanners) || typeof policy.allowUnscanned !== 'boolean' || !Number.isFinite(policy.evidenceMaxAgeSeconds) || policy.evidenceMaxAgeSeconds < 0) {
    throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Policy state is invalid', 500);
  }
  const seen = new Set<string>();
  for (const scanner of policy.scanners) {
    if (!scanner || !SUPPORTED_SCANNERS.includes(scanner.id) || !POLICY_MODES.has(scanner.mode) || !Array.isArray(scanner.blockSeverities) || scanner.blockSeverities.some((severity) => !SEVERITIES.has(severity)) || !Number.isFinite(scanner.timeoutSeconds) || scanner.timeoutSeconds <= 0 || seen.has(scanner.id)) {
      throw new RegistryApiError('INTERNAL_STATE_INVALID', 'Scanner policy state is invalid', 500);
    }
    seen.add(scanner.id);
  }
}

function ensureState(state: RegistryState | undefined, fallbackPolicy: Policy): RegistryState {
  const target = state || createEmptyRegistryState(fallbackPolicy);
  if (target.schemaVersion !== 1) throw new RegistryApiError('CLIENT_UPGRADE_REQUIRED', 'Registry state schema is unsupported', 500);
  target.skills ||= [];
  target.packs ||= [];
  target.jobs ||= [];
  target.scans ||= [];
  target.upstreams ||= [];
  target.authorizations ||= [];
  target.grants ||= [];
  target.audit ||= [];
  if (!target.policy) target.policy = fallbackPolicy;
  return target;
}

function accessibleSkillIds(state: RegistryState, principal: Principal): Set<string> {
  return new Set(state.skills.filter((skill) => canReadNamespace(principal, skill.name)).map((skill) => skill.id));
}

function chooseVersion<T extends { version: string }>(candidates: T[], version?: string): T | undefined {
  const matching = version ? candidates.filter((candidate) => candidate.version === version) : candidates;
  return [...matching].sort((a, b) => compareVersions(b.version, a.version))[0];
}

function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [main, pre = ''] = version.split('-', 2);
    const nums = main.split('.').map((part) => Number(part));
    return { nums, pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if ((left.nums[index] || 0) !== (right.nums[index] || 0)) return (left.nums[index] || 0) - (right.nums[index] || 0);
  }
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  return left.pre.localeCompare(right.pre);
}

async function putVerifiedBlob(deps: RegistryDependencies, bytes: Uint8Array, digest: Digest): Promise<StoredBlob> {
  let stored: StoredBlob;
  try {
    stored = await deps.blobs.put(bytes);
  } catch {
    throw new RegistryApiError('STORAGE_UNAVAILABLE', 'Artifact storage is temporarily unavailable', 503, { retryable: true });
  }
  if (!stored || stored.digest !== digest || stored.size !== bytes.byteLength || !stored.key) {
    throw new RegistryApiError('DIGEST_MISMATCH', 'Storage returned bytes with an unexpected digest or size', 409);
  }
  return stored;
}

function normalizeSkillName(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined;
}

function requireSkillName(value: unknown): string {
  const name = stringValue(value);
  if (!name || !/^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
    throw new RegistryApiError('INVALID_NAME', 'Skill and pack names must use @namespace/slug', 400);
  }
  return name;
}

function requireVersion(value: unknown): string {
  const version = stringValue(value);
  if (!version || !/^(?:0|[1-9]\d*)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new RegistryApiError('INVALID_VERSION', 'Version must be SemVer', 400);
  }
  return version;
}

function isDigest(value: string): value is Digest {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return numberValue(value) && Number.isInteger(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clonePolicy(policy: Policy): Policy {
  return JSON.parse(JSON.stringify(policy)) as Policy;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function audit(
  principal: Principal,
  action: string,
  resourceId: string | undefined,
  details: Record<string, unknown>,
  organizationId: string,
): AuditEvent {
  return {
    id: randomId('audit'),
    organizationId,
    subject: principal.subject,
    action,
    resourceId,
    createdAt: nowIso(),
    details,
  };
}

function appendAudit(state: RegistryState, event: AuditEvent): void {
  state.audit.push(event);
}

function normalizeProvenanceKind(value: unknown): value is Provenance['kind'] {
  return value === 'native' || value === 'github' || value === 'registry';
}

function redactJobError(error: string): string {
  const redacted = error
    .replace(/(authorization|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted]');
  return redacted.length > 500 ? redacted.slice(0, 500) : redacted;
}

function bundleError(error: unknown): RegistryApiError {
  if (error instanceof RegistryApiError) return error;
  const message = error instanceof Error && error.message ? error.message : 'Bundle validation failed';
  return new RegistryApiError('BUNDLE_INVALID', message.slice(0, 300), 400);
}

function unavailable(): RegistryApiError {
  return new RegistryApiError('NOT_AVAILABLE', 'Resource is not available', 404);
}

function errorResponse(error: unknown, requestId: string): Response {
  const apiError = error instanceof RegistryApiError
    ? error
    : new RegistryApiError('INTERNAL_ERROR', 'An internal error occurred', 500);
  const payload: JsonObject = {
    error: {
      code: apiError.code,
      message: apiError.message,
      requestId,
      retryable: apiError.retryable,
      ...(apiError.details ? { details: apiError.details } : {}),
    },
  };
  return jsonResponse(payload, apiError.status, {
    'cache-control': 'no-store',
    ...(apiError.retryable ? { 'retry-after': '1' } : {}),
  });
}

function jsonResponse(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allow: string[]): Response {
  return jsonResponse({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'HTTP method is not allowed for this route',
      requestId: randomId('req'),
      retryable: false,
    },
  }, 405, { allow: allow.join(', ') });
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const webCrypto = globalThis.crypto;
  const uuid = webCrypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  const bytes = new Uint8Array(16);
  webCrypto?.getRandomValues?.(bytes);
  let encoded = '';
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0');
  if (!encoded) encoded = Math.random().toString(36).slice(2);
  return `${prefix}_${encoded}`;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}
