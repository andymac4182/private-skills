import type { PgPoolLike } from '../../database/src/postgres.js';

/** The durable table owned by the identity operations projection. */
export const IDENTITY_OPERATIONS_EVENTS_TABLE = 'private_skills_identity_operations_events';
export const IDENTITY_OPERATIONS_RETENTION_DAYS = 30;
export const IDENTITY_OPERATIONS_CLEANUP_BATCH_SIZE = 1_000;
/** Maximum time a request without a platform waitUntil hook waits for telemetry. */
export const IDENTITY_OPERATIONS_CAPTURE_TIMEOUT_MS = 250;
/** Record-triggered cleanup is bounded to one database delete per interval. */
export const IDENTITY_OPERATIONS_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;

export type IdentityOperationsEventKind =
  | 'authentication_failure'
  | 'callback_failure'
  | 'membership_denial';

/**
 * Reason values are deliberately closed. The event table is an operations
 * counter, not an application log, so callers cannot persist exception text,
 * request data, provider responses, or user supplied labels.
 */
export type IdentityOperationsReasonCode =
  | 'unknown_failure'
  | 'session_unavailable'
  | 'authentication_rejected'
  | 'callback_rejected'
  | 'callback_unavailable'
  | 'membership_missing'
  | 'membership_role_denied'
  | 'tenant_mismatch';

export type IdentityOperationsRole = 'owner' | 'admin' | 'publisher' | 'reader';

export interface IdentityOperationsFailure {
  kind: IdentityOperationsEventKind;
  reasonCode: IdentityOperationsReasonCode;
  /** Provider ids are accepted only after the caller matches server config. */
  providerId?: string;
  occurredAt?: Date | string | number;
}

/** A context returned only after a live exact membership lookup. */
export interface IdentityOperationsTrustedTenant {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: IdentityOperationsRole;
}

export type IdentityOperationsTenantVerifier = (
  organizationId: string,
  userId: string,
) => Promise<{ organizationId: string; userId: string; role: IdentityOperationsRole } | null>;

export interface IdentityOperationsCounter {
  total: number;
  last24h: number;
  latestAt?: string;
}

export interface IdentityOperationsSummary {
  authenticationFailures: IdentityOperationsCounter;
  callbackFailures: IdentityOperationsCounter;
  membershipDenials: IdentityOperationsCounter;
}

export interface IdentityOperationsEventSink {
  /** Persist a global event with no tenant attribution. */
  recordGlobal(failure: IdentityOperationsFailure): Promise<void>;
  /**
   * Resolve a live tenant context. The input is untrusted until this method
   * returns a context, and the context is checked again before insertion.
   */
  trustedTenant(organizationId: string, userId: string): Promise<IdentityOperationsTrustedTenant | null>;
  /** Persist only a context issued by trustedTenant(). */
  recordTenant(context: IdentityOperationsTrustedTenant, failure: IdentityOperationsFailure): Promise<boolean>;
  /** Return bounded aggregate counters for one verified tenant. */
  summarize(organizationId: string, now?: number): Promise<IdentityOperationsSummary>;
  runMigrations(): Promise<void>;
  /** Delete at most cleanupBatchSize rows older than the retention boundary. */
  cleanup(now?: number): Promise<number>;
}

export interface IdentityOperationsWaitUntilRequest {
  /** Shared with Fetch Request so callers can pass either shape portably. */
  readonly headers?: unknown;
  waitUntil?: (task: Promise<unknown>) => void;
}

export interface IdentityOperationsEventStoreOptions {
  pool: PgPoolLike;
  tableName?: string;
  schemaName?: string;
  retentionDays?: number;
  cleanupBatchSize?: number;
  cleanupIntervalMs?: number;
  verifyTenant: IdentityOperationsTenantVerifier;
  now?: () => number;
}

export function identityOperationsEventsSchemaSql(
  tableName = IDENTITY_OPERATIONS_EVENTS_TABLE,
  schemaName?: string,
): string {
  const normalizedTableName = validateIdentifier(tableName, 'identity operations table');
  const normalizedSchemaName = schemaName === undefined || schemaName.trim() === ''
    ? undefined
    : validateIdentifier(schemaName, 'identity schema');
  const table = qualifiedTable(normalizedTableName, normalizedSchemaName);
  const organizationTimeIndex = quoteIdentifier(indexName(normalizedTableName, 'organization_time'));
  const kindTimeIndex = quoteIdentifier(indexName(normalizedTableName, 'kind_time'));
  const occurredTimeIndex = quoteIdentifier(indexName(normalizedTableName, 'occurred_time'));
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('authentication_failure', 'callback_failure', 'membership_denial')),
  reason_code text NOT NULL CHECK (reason_code IN ('unknown_failure', 'session_unavailable', 'authentication_rejected', 'callback_rejected', 'callback_unavailable', 'membership_missing', 'membership_role_denied', 'tenant_mismatch')),
  provider_id text,
  organization_id text,
  role text CHECK (role IS NULL OR role IN ('owner', 'admin', 'publisher', 'reader')),
  CHECK ((organization_id IS NULL AND role IS NULL) OR (organization_id IS NOT NULL AND role IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ${organizationTimeIndex} ON ${table} (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ${kindTimeIndex} ON ${table} (event_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ${occurredTimeIndex} ON ${table} (occurred_at ASC);
`;
}

export const IDENTITY_OPERATIONS_EVENTS_SCHEMA_SQL = identityOperationsEventsSchemaSql();

/**
 * Persisted identity events intentionally expose no free-form message field.
 * A deployment can use this class with Neon, a local PostgreSQL pool, or the
 * test pool adapter used by the existing Node runtime.
 */
export class PostgresIdentityOperationsEventStore implements IdentityOperationsEventSink {
  private readonly pool: PgPoolLike;
  private readonly table: string;
  private readonly tableName: string;
  private readonly schemaName?: string;
  private readonly retentionDays: number;
  private readonly cleanupBatchSize: number;
  private readonly cleanupIntervalMs: number;
  private readonly verifyTenant: IdentityOperationsTenantVerifier;
  private readonly now: () => number;
  private readonly trustedContexts = new WeakSet<object>();
  private migrationPromise?: Promise<void>;
  private cleanupPromise?: Promise<number>;
  private lastCleanupAt = Number.NEGATIVE_INFINITY;

  constructor(options: IdentityOperationsEventStoreOptions) {
    this.pool = options.pool;
    this.tableName = validateIdentifier(options.tableName ?? IDENTITY_OPERATIONS_EVENTS_TABLE, 'identity operations table');
    this.schemaName = options.schemaName === undefined || options.schemaName.trim() === ''
      ? undefined
      : validateIdentifier(options.schemaName, 'identity schema');
    this.table = qualifiedTable(this.tableName, this.schemaName);
    this.retentionDays = boundedInteger(options.retentionDays ?? IDENTITY_OPERATIONS_RETENTION_DAYS, 1, 365, 'identity operations retention days');
    this.cleanupBatchSize = boundedInteger(options.cleanupBatchSize ?? IDENTITY_OPERATIONS_CLEANUP_BATCH_SIZE, 1, 10_000, 'identity operations cleanup batch size');
    this.cleanupIntervalMs = boundedInteger(options.cleanupIntervalMs ?? IDENTITY_OPERATIONS_CLEANUP_INTERVAL_MS, 1_000, 24 * 60 * 60 * 1_000, 'identity operations cleanup interval');
    if (typeof options.verifyTenant !== 'function') throw new TypeError('identity operations tenant verifier is required');
    this.verifyTenant = options.verifyTenant;
    this.now = options.now ?? Date.now;
  }

  async runMigrations(): Promise<void> {
    this.migrationPromise ??= this.pool.query(identityOperationsEventsSchemaSql(this.tableName, this.schemaName)).then(() => undefined);
    await this.migrationPromise;
  }

  async cleanup(now = this.now()): Promise<number> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const cleanup = this.runCleanup(now);
    const pending = cleanup.finally(() => {
      if (this.cleanupPromise === pending) this.cleanupPromise = undefined;
    });
    this.cleanupPromise = pending;
    return pending;
  }

  private async runCleanup(now: number): Promise<number> {
    const boundary = retentionBoundary(now, this.retentionDays);
    const result = await this.pool.query(
      `DELETE FROM ${this.table}
       WHERE id IN (
         SELECT id FROM ${this.table}
         WHERE occurred_at < $1
         ORDER BY occurred_at ASC
         LIMIT $2
       )`,
      [boundary, this.cleanupBatchSize],
    );
    return boundedCount(result.rowCount);
  }

  async recordGlobal(failure: IdentityOperationsFailure): Promise<void> {
    await this.insert({ ...normalizeFailure(failure), organizationId: null, role: null });
    await this.recordTriggeredCleanup();
  }

  async trustedTenant(organizationId: string, userId: string): Promise<IdentityOperationsTrustedTenant | null> {
    const normalizedOrganizationId = boundedValue(organizationId, 'organization id');
    const normalizedUserId = boundedValue(userId, 'user id');
    if (!normalizedOrganizationId || !normalizedUserId) return null;
    let membership: Awaited<ReturnType<IdentityOperationsTenantVerifier>>;
    try {
      membership = await this.verifyTenant(normalizedOrganizationId, normalizedUserId);
    } catch {
      return null;
    }
    if (!membership || membership.organizationId !== normalizedOrganizationId || membership.userId !== normalizedUserId) return null;
    const role = normalizeRole(membership.role);
    if (!role) return null;
    const context: IdentityOperationsTrustedTenant = Object.freeze({
      organizationId: normalizedOrganizationId,
      userId: normalizedUserId,
      role,
    });
    this.trustedContexts.add(context);
    return context;
  }

  async recordTenant(context: IdentityOperationsTrustedTenant, failure: IdentityOperationsFailure): Promise<boolean> {
    if (!context || typeof context !== 'object' || !this.trustedContexts.has(context)) return false;
    const organizationId = boundedValue(context.organizationId, 'organization id');
    const userId = boundedValue(context.userId, 'user id');
    const role = normalizeRole(context.role);
    if (!organizationId || !userId || !role) return false;
    let membership: Awaited<ReturnType<IdentityOperationsTenantVerifier>>;
    try {
      membership = await this.verifyTenant(organizationId, userId);
    } catch {
      return false;
    }
    if (!membership || membership.organizationId !== organizationId || membership.userId !== userId || normalizeRole(membership.role) !== role) return false;
    await this.insert({ ...normalizeFailure(failure), organizationId, role });
    await this.recordTriggeredCleanup();
    return true;
  }

  async summarize(organizationId: string, now = this.now()): Promise<IdentityOperationsSummary> {
    const normalizedOrganizationId = boundedValue(organizationId, 'organization id');
    if (!normalizedOrganizationId) throw new TypeError('identity operations organization id is required');
    const current = Number.isFinite(now) ? now : this.now();
    const safeCurrent = Number.isFinite(current) ? current : Date.now();
    const retention = retentionBoundary(safeCurrent, this.retentionDays);
    const recentBoundary = new Date(safeCurrent - 24 * 60 * 60 * 1_000);
    const result = await this.pool.query<{
      event_kind?: unknown;
      total?: unknown;
      recent_count?: unknown;
      latest_at?: unknown;
    }>(
      `SELECT event_kind,
              COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE occurred_at >= $3)::bigint AS recent_count,
              MAX(occurred_at) AS latest_at
        FROM ${this.table}
       WHERE organization_id = $1
         AND occurred_at >= $2
          AND event_kind IN ('authentication_failure', 'callback_failure', 'membership_denial')
        GROUP BY event_kind
        LIMIT 3`,
      [normalizedOrganizationId, retention, recentBoundary],
    );
    const empty = (): IdentityOperationsCounter => ({ total: 0, last24h: 0 });
    const summary: IdentityOperationsSummary = {
      authenticationFailures: empty(),
      callbackFailures: empty(),
      membershipDenials: empty(),
    };
    for (const row of result.rows) {
      const counter = row.event_kind === 'authentication_failure'
        ? summary.authenticationFailures
        : row.event_kind === 'callback_failure'
          ? summary.callbackFailures
          : row.event_kind === 'membership_denial'
            ? summary.membershipDenials
            : undefined;
      if (!counter) continue;
      counter.total = boundedCount(row.total);
      counter.last24h = boundedCount(row.recent_count);
      const latestAt = dateString(row.latest_at);
      if (latestAt) counter.latestAt = latestAt;
    }
    return summary;
  }

  private async recordTriggeredCleanup(): Promise<void> {
    const current = this.now();
    const safeCurrent = Number.isFinite(current) ? current : Date.now();
    if (safeCurrent - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = safeCurrent;
    try {
      await this.cleanup(safeCurrent);
    } catch {
      // The event has already been persisted. Cleanup is best effort and will
      // be retried after the next interval or by an explicit scheduler.
    }
  }

  private async insert(input: NormalizedIdentityOperationsEvent & { organizationId: string | null; role: IdentityOperationsRole | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (id, occurred_at, event_kind, reason_code, provider_id, organization_id, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [createEventId(), input.occurredAt, input.kind, input.reasonCode, input.providerId ?? null, input.organizationId, input.role],
    );
  }
}

/** Keep event recording out of authentication control flow. */
export function recordIdentityOperationsEvent(
  sink: IdentityOperationsEventSink | undefined,
  failure: IdentityOperationsFailure,
  request?: IdentityOperationsWaitUntilRequest,
): Promise<void> {
  if (!sink) return Promise.resolve();
  return captureIdentityOperationsTask(request, () => sink.recordGlobal(failure));
}

/**
 * Keep operational writes alive on serverless hosts while still providing a
 * bounded awaited fallback for ordinary Fetch runtimes and tests.
 */
export function captureIdentityOperationsTask(
  request: IdentityOperationsWaitUntilRequest | undefined,
  task: PromiseLike<unknown> | (() => PromiseLike<unknown>),
  timeoutMs = IDENTITY_OPERATIONS_CAPTURE_TIMEOUT_MS,
): Promise<void> {
  let pending: Promise<void>;
  try {
    const result = typeof task === 'function' ? task() : task;
    pending = Promise.resolve(result).then(() => undefined, () => undefined);
  } catch {
    pending = Promise.resolve();
  }
  let waitUntil: IdentityOperationsWaitUntilRequest['waitUntil'];
  try {
    waitUntil = request?.waitUntil;
  } catch {
    waitUntil = undefined;
  }
  if (typeof waitUntil === 'function') {
    try {
      waitUntil.call(request, pending);
      return Promise.resolve();
    } catch {
      // Fall back to the bounded await when the host hook rejects the task.
    }
  }
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 10_000
    ? timeoutMs
    : IDENTITY_OPERATIONS_CAPTURE_TIMEOUT_MS;
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, boundedTimeout);
    void pending.then(() => {
      clearTimeout(timer);
      finish();
    }, () => {
      clearTimeout(timer);
      finish();
    });
  });
}

interface NormalizedIdentityOperationsEvent {
  kind: IdentityOperationsEventKind;
  reasonCode: IdentityOperationsReasonCode;
  providerId?: string;
  occurredAt: Date;
}

function normalizeFailure(failure: IdentityOperationsFailure): NormalizedIdentityOperationsEvent {
  const kind = normalizeKind(failure.kind);
  const reasonCode = normalizeReason(failure.reasonCode);
  const providerId = normalizeProviderId(failure.providerId);
  const occurredAt = normalizeDate(failure.occurredAt);
  return {
    kind,
    reasonCode,
    occurredAt,
    ...(providerId === undefined ? {} : { providerId }),
  };
}

function normalizeKind(value: unknown): IdentityOperationsEventKind {
  return value === 'authentication_failure' || value === 'callback_failure' || value === 'membership_denial'
    ? value
    : 'authentication_failure';
}

function normalizeReason(value: unknown): IdentityOperationsReasonCode {
  const values: readonly IdentityOperationsReasonCode[] = [
    'unknown_failure',
    'session_unavailable',
    'authentication_rejected',
    'callback_rejected',
    'callback_unavailable',
    'membership_missing',
    'membership_role_denied',
    'tenant_mismatch',
  ];
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? value as IdentityOperationsReasonCode
    : 'unknown_failure';
}

function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized) ? normalized : undefined;
}

function normalizeRole(value: unknown): IdentityOperationsRole | undefined {
  return value === 'owner' || value === 'admin' || value === 'publisher' || value === 'reader' ? value : undefined;
}

function normalizeDate(value: Date | string | number | undefined): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function dateString(value: unknown): string | undefined {
  const date = value instanceof Date ? value : new Date(typeof value === 'string' || typeof value === 'number' ? value : NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function retentionBoundary(now: number, retentionDays: number): Date {
  const candidate = Number.isFinite(now) ? now : Date.now();
  return new Date(candidate - retentionDays * 24 * 60 * 60 * 1_000);
}

function createEventId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function boundedCount(value: unknown): number {
  const numeric = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : 0;
}

function boundedValue(value: unknown, _field: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} is out of range`);
  return value;
}

function validateIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(normalized)) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string, schemaName?: string): string {
  return schemaName ? `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}` : quoteIdentifier(tableName);
}

function indexName(tableName: string, suffix: string): string {
  const full = `${tableName}_${suffix}`;
  if (full.length <= 63) return full;
  const hash = stableIdentifierHash(tableName);
  const prefixLength = Math.max(1, 63 - hash.length - suffix.length - 2);
  return `${tableName.slice(0, prefixLength)}_${hash}_${suffix}`;
}

function stableIdentifierHash(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
