import type {
  Authenticator,
  Principal,
  StateRepository,
} from '../../../packages/contracts/src/index.js';
import type {
  PgClientLike,
  PgPoolLike,
} from '../../../packages/database/src/postgres.js';

/** The only route that can bind a Better Auth user to the existing tenant. */
export const BOOTSTRAP_ADOPTION_PATH = '/auth/identity/bootstrap/adopt' as const;
/** Stable audit action emitted after a successful identity binding. */
export const BOOTSTRAP_ADOPTION_ACTION = 'identity.bootstrap-adopted' as const;
/** Reserved Better Auth organization metadata key for the durable binding. */
export const BOOTSTRAP_ADOPTION_METADATA_KEY = 'pskillsBootstrapAdoption' as const;

const BETTER_AUTH_ORGANIZATION_LOCK_KEY = 2_147_483_647;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_ID_BYTES = 512;
const MAX_NAME_BYTES = 256;
const MAX_SLUG_BYTES = 128;

/**
 * The identity adapter intentionally returns an unknown session shape here.
 * The handler validates the fields it needs instead of trusting an adapter's
 * cast or a browser supplied user id.
 */
export interface BootstrapAdoptionIdentity {
  getSession(request: Request): Promise<unknown> | unknown;
}

export interface BootstrapAdoptionBinding {
  organizationId: string;
  userId: string;
  sessionId: string;
  /** Identifier of the configured owner proof, never its raw token. */
  proofTokenId: string;
  /** Subject attached to the configured owner proof, never the raw token. */
  proofSubject: string;
  /** Optional server-owned values used only when the organization is created. */
  organizationName?: string;
  organizationSlug?: string;
}

export interface BootstrapAdoptionBindingResult {
  replayed: boolean;
  membershipId?: string;
}

/** Atomic persistence boundary for the Better Auth organization binding. */
export interface BootstrapAdoptionStore {
  bindOwner(input: BootstrapAdoptionBinding): Promise<BootstrapAdoptionBindingResult>;
}

export interface BootstrapAdoptionHandlerOptions {
  /** Existing deployment tenant; this value is never selected by a request. */
  defaultOrganizationId: string;
  /** Trusted configured origin used for the mutation CSRF check. */
  canonicalOrigin: string;
  identity: BootstrapAdoptionIdentity;
  /** Existing token authenticator used only to verify the explicit proof. */
  authenticator: Authenticator;
  repository: StateRepository;
  store: BootstrapAdoptionStore;
  /** Exact ids of configured user owner tokens accepted as bootstrap proof. */
  allowedBootstrapTokenIds: readonly string[];
  organizationName?: string;
  organizationSlug?: string;
  maxBodyBytes?: number;
}

export type BootstrapAdoptionErrorCode =
  | 'BOOTSTRAP_ADOPTION_CONFIG'
  | 'BOOTSTRAP_ADOPTION_UNAVAILABLE'
  | 'BOOTSTRAP_ADOPTION_UNAUTHORIZED'
  | 'BOOTSTRAP_ADOPTION_FORBIDDEN'
  | 'BOOTSTRAP_ADOPTION_INVALID_REQUEST'
  | 'BOOTSTRAP_ADOPTION_CONFLICT';

/** Safe, user-facing error used by the route and by the SQL adapter. */
export class BootstrapAdoptionError extends Error {
  constructor(
    readonly code: BootstrapAdoptionErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BootstrapAdoptionError';
  }
}

/**
 * Build the explicit adoption endpoint. The endpoint requires two
 * independent proofs: a live, verified Better Auth user session and a
 * separately configured legacy owner token. A social first login or an email
 * domain can therefore never claim the existing registry by itself.
 */
export function createBootstrapAdoptionHandler(
  options: BootstrapAdoptionHandlerOptions,
): (request: Request) => Promise<Response> {
  const defaultOrganizationId = boundedId(options.defaultOrganizationId, 'organization id');
  const canonicalOrigin = normalizeOrigin(options.canonicalOrigin);
  const maxBodyBytes = boundedBodyLimit(options.maxBodyBytes);
  const allowedProofIds = new Set(options.allowedBootstrapTokenIds.map((id) => boundedId(id, 'bootstrap token id')));
  const organizationName = options.organizationName === undefined
    ? undefined
    : boundedName(options.organizationName, 'organization name', MAX_NAME_BYTES);
  const organizationSlug = options.organizationSlug === undefined
    ? undefined
    : boundedName(options.organizationSlug, 'organization slug', MAX_SLUG_BYTES);

  return async (request: Request): Promise<Response> => {
    try {
      if (new URL(request.url).pathname !== BOOTSTRAP_ADOPTION_PATH) {
        return adoptionJson({ code: 'NOT_FOUND', message: 'Not Found' }, 404);
      }
      if (request.method.toUpperCase() !== 'POST') {
        return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      }
      if (!sameOrigin(request, canonicalOrigin)) {
        throw adoptionError('BOOTSTRAP_ADOPTION_FORBIDDEN', 'A matching Origin is required.', 403);
      }
      if (allowedProofIds.size === 0 || !options.identity || !options.store) {
        throw adoptionError('BOOTSTRAP_ADOPTION_UNAVAILABLE', 'Bootstrap adoption is not configured.', 503);
      }

      const session = await readIdentitySession(options.identity, request);
      if (!session) {
        throw adoptionError('BOOTSTRAP_ADOPTION_UNAUTHORIZED', 'A signed-in identity session is required.', 401);
      }
      if (!session.emailVerified) {
        throw adoptionError('BOOTSTRAP_ADOPTION_FORBIDDEN', 'A verified identity email is required.', 403);
      }

      const token = await readBootstrapToken(request, maxBodyBytes);
      const createSession = options.authenticator.createSession;
      if (!createSession) {
        throw adoptionError('BOOTSTRAP_ADOPTION_UNAVAILABLE', 'Bootstrap adoption is not configured.', 503);
      }
      let proof: Awaited<ReturnType<NonNullable<Authenticator['createSession']>>> | null = null;
      try {
        proof = await createSession.call(options.authenticator, token);
      } catch {
        // Token verification errors are deliberately indistinguishable from a
        // missing proof and never include token material in a response/log.
        proof = null;
      }
      const principal = proof?.principal as (Principal & {
        identity?: unknown;
        tokenId?: unknown;
      }) | undefined;
      if (!isOwnerBootstrapProof(principal, defaultOrganizationId, allowedProofIds)) {
        throw adoptionError('BOOTSTRAP_ADOPTION_FORBIDDEN', 'The explicit owner bootstrap proof is invalid.', 403);
      }
      const proofTokenId = boundedId(principal.tokenId, 'bootstrap token id');
      const proofSubject = boundedId(principal.subject, 'bootstrap proof subject');

      const binding = await options.store.bindOwner({
        organizationId: defaultOrganizationId,
        userId: session.userId,
        sessionId: session.sessionId,
        proofTokenId,
        proofSubject,
        ...(organizationName === undefined ? {} : { organizationName }),
        ...(organizationSlug === undefined ? {} : { organizationSlug }),
      });
      await appendAdoptionAudit(options.repository, {
        organizationId: defaultOrganizationId,
        userId: session.userId,
        sessionId: session.sessionId,
        proofTokenId,
        proofSubject,
      });

      return adoptionJson({
        ok: true,
        organizationId: defaultOrganizationId,
        userId: session.userId,
        replayed: binding.replayed,
      }, binding.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof BootstrapAdoptionError) {
        return adoptionJson({ code: error.code, message: error.message }, error.status);
      }
      // Database and identity failures are intentionally generic. In
      // particular, do not return provider, SQL, or token details to callers.
      return adoptionJson({
        code: 'BOOTSTRAP_ADOPTION_UNAVAILABLE',
        message: 'Bootstrap adoption is temporarily unavailable.',
      }, 503);
    }
  };
}

interface IdentitySessionSnapshot {
  userId: string;
  emailVerified: boolean;
  sessionId: string;
}

async function readIdentitySession(
  identity: BootstrapAdoptionIdentity,
  request: Request,
): Promise<IdentitySessionSnapshot | null> {
  let value: unknown;
  try {
    value = await identity.getSession(request);
  } catch {
    throw adoptionError('BOOTSTRAP_ADOPTION_UNAVAILABLE', 'Identity session is temporarily unavailable.', 503);
  }
  if (!isRecord(value) || !isRecord(value.user)) return null;
  const userId = value.user.id;
  const sessionId = value.sessionId;
  if (typeof userId !== 'string' || typeof sessionId !== 'string' || userId.trim() === '' || sessionId.trim() === '') {
    return null;
  }
  return {
    userId: boundedId(userId, 'identity user id'),
    sessionId: boundedId(sessionId, 'identity session id'),
    emailVerified: value.user.emailVerified === true,
  };
}

function isOwnerBootstrapProof(
  principal: (Principal & { identity?: unknown; tokenId?: unknown }) | undefined,
  organizationId: string,
  allowedProofIds: ReadonlySet<string>,
): principal is Principal & { identity: 'user'; tokenId: string } {
  if (!principal || principal.identity !== 'user' || !Array.isArray(principal.roles)) return false;
  const validRoles = new Set(['owner', 'admin', 'publisher', 'reader', 'worker']);
  if (principal.roles.some((role) => typeof role !== 'string' || !validRoles.has(role))) return false;
  if (principal.roles.includes('worker')) return false;
  if (principal.organizationId !== organizationId || !principal.roles.includes('owner')) return false;
  if (typeof principal.subject !== 'string' || principal.subject.trim() === '') return false;
  return typeof principal.tokenId === 'string' && allowedProofIds.has(principal.tokenId);
}

async function readBootstrapToken(request: Request, maxBodyBytes: number): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength.trim()) || Number(contentLength) > maxBodyBytes) {
      throw adoptionError('BOOTSTRAP_ADOPTION_INVALID_REQUEST', 'The adoption request is too large.', 413);
    }
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== undefined && contentType !== '' && contentType !== 'application/json' && !contentType.endsWith('+json')) {
    throw adoptionError('BOOTSTRAP_ADOPTION_INVALID_REQUEST', 'The adoption request must contain JSON.', 415);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedRequestBody(request, maxBodyBytes);
  } catch (error) {
    if (error instanceof BootstrapAdoptionError) throw error;
    throw adoptionError('BOOTSTRAP_ADOPTION_INVALID_REQUEST', 'The adoption request body is invalid.', 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw adoptionError('BOOTSTRAP_ADOPTION_INVALID_REQUEST', 'The adoption request body is invalid.', 400);
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.bootstrapToken !== 'string') {
    throw adoptionError('BOOTSTRAP_ADOPTION_INVALID_REQUEST', 'bootstrapToken is required.', 400);
  }
  const token = value.bootstrapToken;
  if (token.length === 0 || new TextEncoder().encode(token).byteLength > Math.min(MAX_TOKEN_BYTES, maxBodyBytes) || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw adoptionError('BOOTSTRAP_ADOPTION_INVALID_REQUEST', 'bootstrapToken is invalid.', 400);
  }
  return token;
}

async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw adoptionError('BOOTSTRAP_ADOPTION_INVALID_REQUEST', 'The adoption request is too large.', 413);
    return bytes;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw adoptionError('BOOTSTRAP_ADOPTION_INVALID_REQUEST', 'The adoption request is too large.', 413);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function appendAdoptionAudit(
  repository: StateRepository,
  input: Pick<BootstrapAdoptionBinding, 'organizationId' | 'userId' | 'sessionId' | 'proofTokenId' | 'proofSubject'>,
): Promise<void> {
  try {
    await repository.transaction(input.organizationId, (state) => {
      const existing = state.audit.filter((event) => event.action === BOOTSTRAP_ADOPTION_ACTION && event.organizationId === input.organizationId);
      for (const event of existing) {
        const eventUserId = isRecord(event.details) && typeof event.details.userId === 'string'
          ? event.details.userId
          : undefined;
        if (eventUserId !== input.userId) {
          throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization is already bound to another identity.', 409);
        }
      }
      // A prior successful binding is the replay marker. Do not append an
      // unbounded audit row for every retry of the same request. Check every
      // existing marker before returning so a corrupted duplicate cannot hide
      // a conflicting identity behind the first row.
      if (existing.length > 0) return;
      state.audit.push({
        id: adoptionAuditId(),
        organizationId: input.organizationId,
        subject: input.userId,
        action: BOOTSTRAP_ADOPTION_ACTION,
        createdAt: new Date().toISOString(),
        details: {
          userId: input.userId,
          sessionId: input.sessionId,
          proofTokenId: input.proofTokenId,
          proofSubject: input.proofSubject,
        },
      });
    });
  } catch (error) {
    if (error instanceof BootstrapAdoptionError) throw error;
    // The identity binding remains durable; a retry can safely append the
    // audit marker after the registry transport recovers.
    throw adoptionError('BOOTSTRAP_ADOPTION_UNAVAILABLE', 'Bootstrap adoption is temporarily unavailable.', 503);
  }
}

function adoptionAuditId(): string {
  const randomUUID = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (typeof randomUUID === 'function') return `audit_${randomUUID.call(globalThis.crypto)}`;
  return `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 18)}`;
}

/**
 * PostgreSQL adapter for the Better Auth organization/member/session tables.
 * It binds the configured default organization and Better Auth membership in
 * one transaction, while retaining existing metadata and members.
 */
export interface PostgresBootstrapAdoptionStoreOptions {
  organizationId?: string;
  schemaName?: string;
  organizationTableName?: string;
  memberTableName?: string;
  sessionTableName?: string;
  userTableName?: string;
  organizationName?: string;
  organizationSlug?: string;
  now?: () => Date;
  generateId?: () => string;
}

export function createPostgresBootstrapAdoptionStore(
  pool: PgPoolLike,
  options: PostgresBootstrapAdoptionStoreOptions = {},
): BootstrapAdoptionStore {
  return new PostgresBootstrapAdoptionStore(pool, options);
}

class PostgresBootstrapAdoptionStore implements BootstrapAdoptionStore {
  private readonly configuredOrganizationId?: string;
  private readonly organizationTable: string;
  private readonly memberTable: string;
  private readonly sessionTable: string;
  private readonly userTable: string;
  private readonly organizationName?: string;
  private readonly organizationSlug?: string;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(private readonly pool: PgPoolLike, options: PostgresBootstrapAdoptionStoreOptions) {
    this.configuredOrganizationId = options.organizationId === undefined
      ? undefined
      : boundedId(options.organizationId, 'organization id');
    const schemaName = options.schemaName === undefined || options.schemaName.trim() === ''
      ? undefined
      : quoteIdentifier(options.schemaName, 'schema name');
    this.organizationTable = qualifiedIdentifier(schemaName, options.organizationTableName ?? 'organization');
    this.memberTable = qualifiedIdentifier(schemaName, options.memberTableName ?? 'member');
    this.sessionTable = qualifiedIdentifier(schemaName, options.sessionTableName ?? 'session');
    this.userTable = qualifiedIdentifier(schemaName, options.userTableName ?? 'user');
    this.organizationName = options.organizationName === undefined
      ? undefined
      : boundedName(options.organizationName, 'organization name', MAX_NAME_BYTES);
    this.organizationSlug = options.organizationSlug === undefined
      ? undefined
      : boundedName(options.organizationSlug, 'organization slug', MAX_SLUG_BYTES);
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomIdentifier;
  }

  async bindOwner(input: BootstrapAdoptionBinding): Promise<BootstrapAdoptionBindingResult> {
    const organizationId = boundedId(input.organizationId, 'organization id');
    if (this.configuredOrganizationId !== undefined && organizationId !== this.configuredOrganizationId) {
      throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization binding is invalid.', 409);
    }
    const userId = boundedId(input.userId, 'identity user id');
    const sessionId = boundedId(input.sessionId, 'identity session id');
    const proofTokenId = boundedId(input.proofTokenId, 'bootstrap token id');
    const proofSubject = boundedId(input.proofSubject, 'bootstrap proof subject');
    const now = this.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw adoptionError('BOOTSTRAP_ADOPTION_CONFIG', 'Bootstrap adoption clock is invalid.', 500);
    }
    const nowIso = now.toISOString();
    const organizationName = this.organizationName ?? input.organizationName ?? organizationId;
    const organizationSlug = this.organizationSlug ?? input.organizationSlug ?? organizationId;
    const normalizedName = boundedName(organizationName, 'organization name', MAX_NAME_BYTES);
    const normalizedSlug = boundedName(organizationSlug, 'organization slug', MAX_SLUG_BYTES);

    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      // Better Auth currently serializes organization mutations with the
      // fixed key below. The tenant hash additionally prevents two distinct
      // adoption attempts from contending with unrelated organizations.
      await client.query(`SELECT pg_advisory_xact_lock(${BETTER_AUTH_ORGANIZATION_LOCK_KEY})`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [organizationId]);

      const userRows = await queryRows<{ id?: unknown; emailVerified?: unknown }>(client,
        `SELECT "id", "emailVerified" FROM ${this.userTable} WHERE "id" = $1 FOR UPDATE`, [userId]);
      const user = userRows[0];
      if (!user || user.id !== userId || user.emailVerified !== true) {
        throw adoptionError('BOOTSTRAP_ADOPTION_FORBIDDEN', 'The identity user is not verified.', 403);
      }

      const sessionRows = await queryRows<{
        id?: unknown;
        userId?: unknown;
        expiresAt?: unknown;
        activeOrganizationId?: unknown;
      }>(client,
        `SELECT "id", "userId", "expiresAt", "activeOrganizationId" FROM ${this.sessionTable}
         WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [sessionId, userId]);
      const session = sessionRows[0];
      if (!session || session.id !== sessionId || session.userId !== userId || !futureTimestamp(session.expiresAt, now.getTime())) {
        throw adoptionError('BOOTSTRAP_ADOPTION_UNAUTHORIZED', 'The identity session is no longer valid.', 401);
      }

      const organizationRows = await queryRows<{
        id?: unknown;
        name?: unknown;
        slug?: unknown;
        metadata?: unknown;
      }>(client,
        `SELECT "id", "name", "slug", "metadata" FROM ${this.organizationTable}
         WHERE "id" = $1 FOR UPDATE`, [organizationId]);
      const existingOrganization = organizationRows[0];
      let metadata: Record<string, unknown>;
      let marker: AdoptionMetadataMarker | undefined;
      // A marker created below for a brand-new organization is part of this
      // transaction and must not be mistaken for an interrupted prior bind.
      // Only a marker loaded from an existing row can establish that
      // inconsistency check.
      let markerWasPersisted = false;
      if (!existingOrganization) {
        marker = adoptionMetadataMarker({ userId, sessionId, proofTokenId, proofSubject, adoptedAt: nowIso });
        metadata = { [BOOTSTRAP_ADOPTION_METADATA_KEY]: marker };
        try {
          await client.query(
            `INSERT INTO ${this.organizationTable} ("id", "name", "slug", "createdAt", "metadata")
             VALUES ($1, $2, $3, $4, $5)`,
            [organizationId, normalizedName, normalizedSlug, nowIso, JSON.stringify(metadata)],
          );
        } catch (error) {
          throw normalizeStoreError(error);
        }
      } else {
        if (existingOrganization.id !== organizationId) {
          throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization identity is inconsistent.', 409);
        }
        metadata = parseMetadata(existingOrganization.metadata);
        marker = parseAdoptionMetadataMarker(metadata[BOOTSTRAP_ADOPTION_METADATA_KEY]);
        markerWasPersisted = marker !== undefined;
        if (marker && marker.userId !== userId) {
          throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization is already bound to another identity.', 409);
        }
      }

      const memberRows = await queryRows<{ id?: unknown; organizationId?: unknown; userId?: unknown; role?: unknown }>(client,
        `SELECT "id", "organizationId", "userId", "role" FROM ${this.memberTable}
         WHERE "organizationId" = $1 FOR UPDATE`, [organizationId]);
      const members = memberRows.map((row) => normalizeMemberRow(row, organizationId));
      const owners = members.filter((member) => member.role === 'owner');
      const otherOwner = owners.find((member) => member.userId !== userId);
      if (otherOwner) {
        throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization is already bound to another identity.', 409);
      }
      const owner = owners[0];
      if (owners.length > 1) {
        throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization has conflicting owner state.', 409);
      }
      if (markerWasPersisted && !owner) {
        // A marker without its owner membership means a previous deployment
        // was interrupted or the identity tables were edited manually.
        throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization binding is inconsistent.', 409);
      }

      let membershipId = owner?.id;
      const existingUserMembers = members.filter((member) => member.userId === userId);
      if (existingUserMembers.length > 1) {
        throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The identity membership state is inconsistent.', 409);
      }
      let replayed = owner !== undefined;
      if (!owner) {
        const existingUserMember = existingUserMembers[0];
        if (existingUserMember) {
          membershipId = existingUserMember.id;
          const updated = await client.query(
            `UPDATE ${this.memberTable} SET "role" = 'owner' WHERE "id" = $1 AND "organizationId" = $2`,
            [membershipId, organizationId],
          );
          if (updated.rowCount !== undefined && updated.rowCount !== 1) {
            throw adoptionError('BOOTSTRAP_ADOPTION_UNAVAILABLE', 'The identity membership could not be updated.', 503);
          }
        } else {
          membershipId = boundedId(this.generateId(), 'membership id');
          await client.query(
            `INSERT INTO ${this.memberTable} ("id", "organizationId", "userId", "role", "createdAt")
             VALUES ($1, $2, $3, 'owner', $4)`,
            [membershipId, organizationId, userId, nowIso],
          );
        }
        replayed = false;
      }

      if (!marker) {
        marker = adoptionMetadataMarker({ userId, sessionId, proofTokenId, proofSubject, adoptedAt: nowIso });
        metadata[BOOTSTRAP_ADOPTION_METADATA_KEY] = marker;
        await client.query(
          `UPDATE ${this.organizationTable} SET "metadata" = $2 WHERE "id" = $1`,
          [organizationId, JSON.stringify(metadata)],
        );
      }

      const activeOrganizationId = session.activeOrganizationId;
      if (activeOrganizationId !== organizationId) {
        const updated = await client.query(
          `UPDATE ${this.sessionTable} SET "activeOrganizationId" = $1 WHERE "id" = $2 AND "userId" = $3`,
          [organizationId, sessionId, userId],
        );
        if (updated.rowCount !== undefined && updated.rowCount !== 1) {
          throw adoptionError('BOOTSTRAP_ADOPTION_UNAVAILABLE', 'The identity session could not be updated.', 503);
        }
      }

      await client.query('COMMIT');
      began = false;
      return { replayed, ...(membershipId === undefined ? {} : { membershipId }) };
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      }
      throw normalizeStoreError(error);
    } finally {
      await client.release?.();
    }
  }
}

interface NormalizedMember {
  id: string;
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'publisher' | 'reader';
}

function normalizeMemberRow(row: { id?: unknown; organizationId?: unknown; userId?: unknown; role?: unknown }, organizationId: string): NormalizedMember {
  const id = boundedId(row.id, 'membership id');
  const memberOrganizationId = boundedId(row.organizationId, 'membership organization id');
  const userId = boundedId(row.userId, 'membership user id');
  if (memberOrganizationId !== organizationId) {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The identity membership state is inconsistent.', 409);
  }
  if (typeof row.role !== 'string') {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The identity membership state is inconsistent.', 409);
  }
  const role = row.role.trim().toLowerCase();
  if (role === 'member') return { id, organizationId, userId, role: 'reader' };
  if (role === 'owner' || role === 'admin' || role === 'publisher' || role === 'reader') {
    return { id, organizationId, userId, role };
  }
  throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The identity membership state is inconsistent.', 409);
}

interface AdoptionMetadataMarker {
  version: 1;
  userId: string;
  sessionId: string;
  proofTokenId: string;
  proofSubject: string;
  adoptedAt: string;
}

function adoptionMetadataMarker(input: Omit<AdoptionMetadataMarker, 'version'>): AdoptionMetadataMarker {
  return { version: 1, ...input };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined || value === '') return {};
  if (isRecord(value)) return { ...value };
  if (typeof value !== 'string') {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization metadata is invalid.', 409);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization metadata is invalid.', 409);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization metadata is invalid.', 409);
  }
  return { ...parsed };
}

function parseAdoptionMetadataMarker(value: unknown): AdoptionMetadataMarker | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1 || typeof value.userId !== 'string' || typeof value.sessionId !== 'string' ||
      typeof value.proofTokenId !== 'string' || typeof value.proofSubject !== 'string' || typeof value.adoptedAt !== 'string') {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization binding metadata is invalid.', 409);
  }
  const adoptedAt = boundedName(value.adoptedAt, 'adoption timestamp', 64);
  if (!Number.isFinite(Date.parse(adoptedAt))) {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization binding metadata is invalid.', 409);
  }
  return {
    version: 1,
    userId: boundedId(value.userId, 'adoption user id'),
    sessionId: boundedId(value.sessionId, 'adoption session id'),
    proofTokenId: boundedId(value.proofTokenId, 'adoption proof token id'),
    proofSubject: boundedId(value.proofSubject, 'adoption proof subject'),
    adoptedAt,
  };
}

function futureTimestamp(value: unknown, nowMs: number): boolean {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

async function queryRows<Row>(client: Pick<PgClientLike, 'query'>, sql: string, parameters: readonly unknown[]): Promise<Row[]> {
  const result = await client.query<Row>(sql, parameters);
  return result.rows ?? [];
}

function normalizeStoreError(error: unknown): BootstrapAdoptionError {
  if (error instanceof BootstrapAdoptionError) return error;
  if (isRecord(error) && error.code === '23505') {
    return adoptionError('BOOTSTRAP_ADOPTION_CONFLICT', 'The organization identity is already in use.', 409);
  }
  return adoptionError('BOOTSTRAP_ADOPTION_UNAVAILABLE', 'Bootstrap adoption is temporarily unavailable.', 503);
}

function boundedBodyLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(value) || value < 256 || value > 1024 * 1024) {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFIG', 'Bootstrap adoption body limit is invalid.', 500);
  }
  return value;
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFIG', `${field} is invalid.`, 500);
  }
  return value.trim();
}

function boundedName(value: string, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxBytes || new TextEncoder().encode(value).byteLength > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFIG', `${field} is invalid.`, 500);
  }
  return value.trim();
}

function quoteIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value)) {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFIG', `${field} is invalid.`, 500);
  }
  return `"${value}"`;
}

function qualifiedIdentifier(schema: string | undefined, name: string): string {
  const table = quoteIdentifier(name, 'table name');
  return schema === undefined ? table : `${schema}.${table}`;
}

function randomIdentifier(): string {
  const randomUUID = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  return `membership_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 18)}`;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFIG', 'Trusted identity origin is invalid.', 500);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin === 'null' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw adoptionError('BOOTSTRAP_ADOPTION_CONFIG', 'Trusted identity origin is invalid.', 500);
  }
  return parsed.origin;
}

function sameOrigin(request: Request, expected: string): boolean {
  const value = request.headers.get('origin');
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== expected || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    return true;
  } catch {
    return false;
  }
}

function adoptionError(code: BootstrapAdoptionErrorCode, message: string, status: number): BootstrapAdoptionError {
  return new BootstrapAdoptionError(code, message, status);
}

function adoptionJson(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
