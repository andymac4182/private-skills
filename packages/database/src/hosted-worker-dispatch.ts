import type { RegistryState } from '../../contracts/src/index';
import type { PgClientLike, PgPoolLike, PgQueryResult } from './postgres';

/**
 * The catalog is deliberately injected.  A dispatcher may only receive
 * organization ids from a server-owned catalog, never from the cron request.
 * The callback is also useful for deployments whose identity service already
 * has a bounded, durable organization listing implementation.
 */
export interface HostedWorkerDispatchCatalog {
  listOrganizations(input: {
    after: string | null;
    limit: number;
    signal?: AbortSignal;
    deadline?: number;
    timeoutMs?: number;
  }): Promise<readonly string[]>;
  /** Optional fast path used to avoid invoking an idle tenant worker. */
  hasPendingJobs?(organizationId: string, input: {
    now: number;
    signal?: AbortSignal;
    deadline?: number;
    timeoutMs?: number;
  }): Promise<boolean>;
}

export interface HostedWorkerDispatchOperationContext {
  now: number;
  deadline: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface HostedWorkerDispatchLease {
  /** Opaque server-side fencing token. Never include this in a route response. */
  token: string;
  cursor: string | null;
  expiresAt: number;
}

export interface HostedWorkerDispatchStore {
  acquireLease(now: number, leaseDurationMs: number, context?: HostedWorkerDispatchOperationContext): Promise<HostedWorkerDispatchLease | null>;
  advance(lease: HostedWorkerDispatchLease, cursor: string | null, now: number, context?: HostedWorkerDispatchOperationContext): Promise<void>;
  recordSuccess(lease: HostedWorkerDispatchLease, organizationId: string, cursor: string | null, now: number, context?: HostedWorkerDispatchOperationContext): Promise<void>;
  recordFailure(lease: HostedWorkerDispatchLease, organizationId: string, cursor: string | null, reason: string, now: number, context?: HostedWorkerDispatchOperationContext): Promise<void>;
  /** Releasing an already-taken-over lease is a no-op fenced by its token. */
  release(lease: HostedWorkerDispatchLease, cursor: string | null, context?: HostedWorkerDispatchOperationContext): Promise<void>;
  /** A retry row suppresses a tenant until its durable backoff expires. */
  isRetryReady(organizationId: string, now: number, context?: HostedWorkerDispatchOperationContext): Promise<boolean>;
}

export class HostedWorkerDispatchLeaseError extends Error {
  constructor(message = 'Hosted worker dispatcher lease is no longer owned') {
    super(message);
    this.name = 'HostedWorkerDispatchLeaseError';
  }
}

class HostedWorkerDispatchTimeBudgetError extends Error {
  constructor() {
    super('Hosted worker dispatcher time budget expired');
    this.name = 'HostedWorkerDispatchTimeBudgetError';
  }
}

export interface HostedWorkerDispatcherOptions {
  cronSecret: string;
  catalog: HostedWorkerDispatchCatalog;
  store: HostedWorkerDispatchStore;
  /** Server-constructed tenant worker factory. The request never chooses its argument. */
  workerForOrganization: (organizationId: string) => ((request: Request) => Promise<Response>) | undefined;
  maxOrganizations?: number;
  pageSize?: number;
  maxJobsPerOrganization?: number;
  maxDurationMs?: number;
  leaseDurationMs?: number;
  now?: () => number;
}

export interface HostedWorkerDispatchSummary {
  ok: true;
  claimed: boolean;
  organizationsVisited: number;
  failures: number;
  truncated: boolean;
}

interface OrganizationOutcome {
  claimed: number;
  failure?: string;
}

type DispatchOptions = Required<Pick<HostedWorkerDispatcherOptions,
  'maxOrganizations' | 'pageSize' | 'maxJobsPerOrganization' | 'maxDurationMs' | 'leaseDurationMs'>>
  & Omit<HostedWorkerDispatcherOptions, 'maxOrganizations' | 'pageSize' | 'maxJobsPerOrganization' | 'maxDurationMs' | 'leaseDurationMs'>;

const DEFAULT_MAX_ORGANIZATIONS = 32;
const DEFAULT_PAGE_SIZE = 32;
const DEFAULT_MAX_JOBS_PER_ORGANIZATION = 2;
const DEFAULT_MAX_DURATION_MS = 240_000;
const DEFAULT_LEASE_DURATION_MS = 300_000;
const MAX_ORGANIZATIONS = 1_024;
const MAX_PAGE_SIZE = 256;
const MAX_JOBS_PER_ORGANIZATION = 16;
const MAX_DURATION_MS = 15 * 60_000;
const MAX_LEASE_DURATION_MS = 30 * 60_000;
const MAX_ORGANIZATION_ID_BYTES = 256;

/**
 * Cross-company hosted-worker cron dispatcher.
 *
 * The dispatcher owns scheduling fairness and retry metadata; the worker
 * handler remains responsible for claiming and fencing individual jobs. A
 * successful worker response with `claimed: false` is a successful no-op.
 */
export class HostedWorkerDispatcher {
  private readonly options: DispatchOptions;
  private readonly now: () => number;

  constructor(options: HostedWorkerDispatcherOptions) {
    validateDispatcherOptions(options);
    this.options = {
      ...options,
      maxOrganizations: options.maxOrganizations ?? DEFAULT_MAX_ORGANIZATIONS,
      pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
      maxJobsPerOrganization: options.maxJobsPerOrganization ?? DEFAULT_MAX_JOBS_PER_ORGANIZATION,
      maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      leaseDurationMs: options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    };
    this.now = options.now ?? Date.now;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== 'GET') {
      return dispatchJson({ ok: false, claimed: false, error: 'dispatcher route failed' }, 405, { Allow: 'GET' });
    }
    if (!authorizedCronRequest(request, this.options.cronSecret)) {
      return dispatchJson({ ok: false, claimed: false, error: 'dispatcher route failed' }, 401);
    }

    let lease: HostedWorkerDispatchLease | null = null;
    let released = false;
    let cursorForRelease: string | null = null;
    let cursor: string | null = null;
    let visited = 0;
    let claimed = 0;
    let failures = 0;
    let truncated = false;
    try {
      const startedAt = this.now();
      const initialContext = this.operationContext(request, startedAt + this.options.maxDurationMs);
      lease = await this.runBounded(
        (context) => this.options.store.acquireLease(startedAt, this.options.leaseDurationMs, context),
        initialContext,
      );
      if (lease === null) {
        // Another invocation owns the durable lease. This is an expected cron
        // overlap and must not cause the platform to retry the whole request.
        return dispatchJson({ ok: true, claimed: false, organizationsVisited: 0, failures: 0, truncated: false, skipped: 'lease-active' }, 200);
      }

      // Never let a worker call or a cursor mutation run past the durable
      // lease, even if a clock jump or a misconfigured store gives us a
      // shorter lease than the configured wall-clock budget.
      const deadline = Math.min(startedAt + this.options.maxDurationMs, lease.expiresAt);
      cursor = lease.cursor;
      cursorForRelease = cursor;
      let wrapped = false;
      const seen = new Set<string>();

      while (visited < this.options.maxOrganizations) {
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          truncated = true;
          break;
        }

        const requestedLimit = Math.min(this.options.pageSize, this.options.maxOrganizations - visited);
        const pageContext = this.operationContext(request, deadline);
        const page = await this.runBounded(
          (context) => this.options.catalog.listOrganizations({
            after: cursor,
            limit: requestedLimit,
            signal: context.signal,
            deadline: context.deadline,
            timeoutMs: context.timeoutMs,
          }),
          pageContext,
        );
        const organizations = page.map((organizationId) => normalizeOrganizationId(organizationId));
        if (organizations.length === 0) {
          if (wrapped) break;
          // The persisted cursor is a keyset cursor. Reaching the end wraps
          // exactly once; `seen` prevents a same-run duplicate dispatch.
          wrapped = true;
          cursor = null;
          continue;
        }

        let added = 0;
        for (const organizationId of organizations) {
          if (seen.has(organizationId)) continue;
          seen.add(organizationId);
          added += 1;
          visited += 1;
          cursor = organizationId;
          cursorForRelease = cursor;
          const advanceContext = this.operationContext(request, deadline);
          await this.runBounded(
            (context) => this.options.store.advance(lease!, cursor, advanceContext.now, context),
            advanceContext,
          );

          const outcome = await this.dispatchOrganization(lease, organizationId, request, deadline);
          claimed += outcome.claimed;
          if (outcome.failure === 'dispatcher_time_budget') {
            truncated = true;
            break;
          }
          if (outcome.failure !== undefined) failures += 1;
          if (visited >= this.options.maxOrganizations || deadline - this.now() <= 0) {
            if (visited < this.options.maxOrganizations) truncated = true;
            break;
          }
        }

        if (truncated) break;
        // A short page proves the current catalog tail. Persisted cursor
        // remains at its last visited organization; the next invocation wraps.
        if (organizations.length < requestedLimit || added === 0) break;
      }

      await this.releaseBounded(lease, cursor, request, deadline);
      released = true;
      const summary: HostedWorkerDispatchSummary = {
        ok: true,
        claimed: claimed > 0,
        organizationsVisited: visited,
        failures,
        truncated,
      };
      return dispatchJson(summary, 200);
    } catch (error) {
      // Never return tenant ids, lease tokens, response bodies, or provider
      // errors from this operator route. A failed invocation leaves durable
      // queued jobs and retry/cursor state available to the next run.
      if (lease !== null && !released) {
        await this.releaseBounded(lease, cursorForRelease, request, this.now() + 1);
      }
      if (error instanceof HostedWorkerDispatchTimeBudgetError) {
        return dispatchJson({ ok: true, claimed: claimed > 0, organizationsVisited: visited, failures, truncated: true }, 200);
      }
      return dispatchJson({ ok: false, claimed: false, error: 'dispatcher route failed' }, 503);
    }
  }

  private async dispatchOrganization(
    lease: HostedWorkerDispatchLease,
    organizationId: string,
    request: Request,
    deadline: number,
  ): Promise<OrganizationOutcome> {
    let ready: boolean;
    try {
      const context = this.operationContext(request, deadline);
      ready = await this.runBounded(
        (operation) => this.options.store.isRetryReady(organizationId, operation.now, operation),
        context,
      );
    } catch (error) {
      if (error instanceof HostedWorkerDispatchTimeBudgetError) return { claimed: 0, failure: 'dispatcher_time_budget' };
      try {
        await this.recordFailureBounded(lease, organizationId, 'retry_probe_failed', request, deadline);
      } catch (failureError) {
        if (failureError instanceof HostedWorkerDispatchTimeBudgetError) return { claimed: 0, failure: 'dispatcher_time_budget' };
      }
      return { claimed: 0, failure: 'retry_probe_failed' };
    }
    if (!ready) return { claimed: 0 };

    if (this.options.catalog.hasPendingJobs) {
      let pending: boolean;
      try {
        const context = this.operationContext(request, deadline);
        pending = await this.runBounded(
          (operation) => this.options.catalog.hasPendingJobs!(organizationId, {
            now: operation.now,
            signal: operation.signal,
            deadline: operation.deadline,
            timeoutMs: operation.timeoutMs,
          }),
          context,
        );
      } catch (error) {
        if (error instanceof HostedWorkerDispatchTimeBudgetError) return { claimed: 0, failure: 'dispatcher_time_budget' };
        try {
          await this.recordFailureBounded(lease, organizationId, 'queue_probe_failed', request, deadline);
        } catch (failureError) {
          if (failureError instanceof HostedWorkerDispatchTimeBudgetError) return { claimed: 0, failure: 'dispatcher_time_budget' };
        }
        return { claimed: 0, failure: 'queue_probe_failed' };
      }
      if (!pending) {
        try {
          const context = this.operationContext(request, deadline);
          await this.runBounded(
            (operation) => this.options.store.recordSuccess(lease, organizationId, organizationId, operation.now, operation),
            context,
          );
        } catch (error) {
          if (error instanceof HostedWorkerDispatchTimeBudgetError) return { claimed: 0, failure: 'dispatcher_time_budget' };
          throw error;
        }
        return { claimed: 0 };
      }
    }

    let worker: ((request: Request) => Promise<Response>) | undefined;
    try {
      worker = this.options.workerForOrganization(organizationId);
    } catch {
      // A tenant credential/provider failure must remain isolated to this
      // organization. Persist a generic retry marker and let the next page
      // continue instead of aborting the whole company sweep.
      try {
        await this.recordFailureBounded(lease, organizationId, 'tenant_worker_unavailable', request, deadline);
      } catch (error) {
        if (error instanceof HostedWorkerDispatchTimeBudgetError) return { claimed: 0, failure: 'dispatcher_time_budget' };
        throw error;
      }
      return { claimed: 0, failure: 'tenant_worker_unavailable' };
    }
    if (worker === undefined) {
      try {
        await this.recordFailureBounded(lease, organizationId, 'tenant_worker_unavailable', request, deadline);
      } catch (error) {
        if (error instanceof HostedWorkerDispatchTimeBudgetError) return { claimed: 0, failure: 'dispatcher_time_budget' };
        throw error;
      }
      return { claimed: 0, failure: 'tenant_worker_unavailable' };
    }

    let claimed = 0;
    for (let attempt = 0; attempt < this.options.maxJobsPerOrganization; attempt += 1) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return { claimed, failure: 'dispatcher_time_budget' };
      }
      const outcome = await invokeWorker(worker, request, remaining);
      if (outcome.failure !== undefined) {
        try {
          await this.recordFailureBounded(lease, organizationId, outcome.failure, request, deadline);
        } catch (error) {
          if (error instanceof HostedWorkerDispatchTimeBudgetError) return { claimed, failure: 'dispatcher_time_budget' };
          throw error;
        }
        return { claimed, failure: outcome.failure };
      }
      if (!outcome.claimed) break;
      claimed += 1;
    }
    try {
      const context = this.operationContext(request, deadline);
      await this.runBounded(
        (operation) => this.options.store.recordSuccess(lease, organizationId, organizationId, operation.now, operation),
        context,
      );
    } catch (error) {
      if (error instanceof HostedWorkerDispatchTimeBudgetError) return { claimed, failure: 'dispatcher_time_budget' };
      throw error;
    }
    return { claimed };
  }

  private async recordFailureBounded(
    lease: HostedWorkerDispatchLease,
    organizationId: string,
    reason: string,
    request: Request,
    deadline: number,
  ): Promise<void> {
    const context = this.operationContext(request, deadline);
    await this.runBounded(
      (operation) => this.options.store.recordFailure(lease, organizationId, organizationId, reason, operation.now, operation),
      context,
    );
  }

  private operationContext(request: Request, deadline: number): HostedWorkerDispatchOperationContext {
    const now = this.now();
    const timeoutMs = Math.max(1, Math.floor(deadline - now));
    if (deadline <= now || request.signal.aborted) throw new HostedWorkerDispatchTimeBudgetError();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;
    return { now, deadline, timeoutMs, signal };
  }

  private async runBounded<T>(
    operation: (context: HostedWorkerDispatchOperationContext) => Promise<T>,
    context: HostedWorkerDispatchOperationContext,
  ): Promise<T> {
    if (context.signal.aborted) throw new HostedWorkerDispatchTimeBudgetError();
    const operationPromise = operation(context);
    // The underlying adapter may not support AbortSignal cancellation. Attach
    // a rejection sink because the lease fence, rather than a late promise,
    // protects durable cursor/retry writes after this invocation returns.
    void operationPromise.catch(() => undefined);
    const abortPromise = new Promise<never>((_, reject) => {
      context.signal.addEventListener('abort', () => reject(new HostedWorkerDispatchTimeBudgetError()), { once: true });
    });
    return Promise.race([operationPromise, abortPromise]);
  }

  private async releaseBounded(
    lease: HostedWorkerDispatchLease,
    cursor: string | null,
    request: Request,
    deadline: number,
  ): Promise<void> {
    try {
      // Releasing a lease after the dispatch budget is a tiny, bounded
      // cleanup operation. If no budget remains, give the fenced update one
      // millisecond rather than leaving a live lease until its expiry.
      const context = this.operationContext(request, Math.max(deadline, this.now() + 1));
      await this.runBounded((operation) => this.options.store.release(lease, cursor, operation), context);
    } catch {
      // An expired lease is safe to leave for the next invocation. The store
      // fences a late release by the lease token, so it cannot clear a newer
      // owner's cursor.
    }
  }
}

/** Create a route-compatible dispatcher handler for Nitro/runtime wiring. */
export function createHostedWorkerDispatcher(options: HostedWorkerDispatcherOptions): (request: Request) => Promise<Response> {
  const dispatcher = new HostedWorkerDispatcher(options);
  return dispatcher.handle.bind(dispatcher);
}

/** Alias used by runtime adapters that call the cron boundary a scheduler. */
export const createHostedWorkerScheduler = createHostedWorkerDispatcher;

export interface PostgresHostedWorkerDispatchStoreOptions {
  pool: PgPoolLike;
  tableName?: string;
  retryTableName?: string;
  autoMigrate?: boolean;
  retryRetentionMs?: number;
  leaseTokenFactory?: () => string;
}

const DEFAULT_DISPATCH_TABLE = 'private_skills_hosted_worker_dispatch';
const DEFAULT_RETRY_TABLE = 'private_skills_hosted_worker_dispatch_retry';
const MAX_TABLE_NAME_LENGTH = 63;
const DEFAULT_RETRY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MIN_RETRY_RETENTION_MS = 60 * 60_000;
const MAX_RETRY_RETENTION_MS = 365 * 24 * 60 * 60_000;
const MAX_RETRY_ATTEMPTS = 16;
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 60 * 60_000;
const MAX_RETRY_REASON_BYTES = 512;

export function hostedWorkerDispatchSchemaSql(
  tableName = DEFAULT_DISPATCH_TABLE,
  retryTableName = DEFAULT_RETRY_TABLE,
): string {
  const table = quoteIdentifier(tableName);
  const retryTable = quoteIdentifier(retryTableName);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  singleton_id text PRIMARY KEY,
  cursor_org_id text,
  lease_token text,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (singleton_id = 'default'),
  CHECK (cursor_org_id IS NULL OR char_length(cursor_org_id) BETWEEN 1 AND ${MAX_ORGANIZATION_ID_BYTES}),
  CHECK ((lease_token IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ${retryTable} (
  organization_id text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(organization_id) BETWEEN 1 AND ${MAX_ORGANIZATION_ID_BYTES}),
  CHECK (attempts BETWEEN 0 AND ${MAX_RETRY_ATTEMPTS}),
  CHECK (char_length(last_error) BETWEEN 1 AND ${MAX_RETRY_REASON_BYTES})
);
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(retryReadyIndexName(retryTableName))}
  ON ${retryTable} (next_attempt_at, organization_id);
`;
}

export const HOSTED_WORKER_DISPATCH_SCHEMA_SQL = hostedWorkerDispatchSchemaSql();

interface DispatchRow {
  cursor_org_id?: unknown;
  lease_token?: unknown;
  lease_expires_at?: unknown;
}

export class PostgresHostedWorkerDispatchStore implements HostedWorkerDispatchStore {
  private readonly pool: PgPoolLike;
  private readonly table: string;
  private readonly retryTable: string;
  private readonly tableName: string;
  private readonly retryTableName: string;
  private readonly autoMigrate: boolean;
  private readonly retryRetentionMs: number;
  private readonly leaseTokenFactory: () => string;
  private migrationPromise?: Promise<void>;

  constructor(options: PostgresHostedWorkerDispatchStoreOptions);
  constructor(pool: PgPoolLike, options?: Omit<PostgresHostedWorkerDispatchStoreOptions, 'pool'>);
  constructor(
    optionsOrPool: PostgresHostedWorkerDispatchStoreOptions | PgPoolLike,
    options: Omit<PostgresHostedWorkerDispatchStoreOptions, 'pool'> = {},
  ) {
    const isPool = isPgPool(optionsOrPool);
    const supplied = isPool ? { ...options, pool: optionsOrPool } : optionsOrPool;
    this.pool = supplied.pool;
    this.tableName = supplied.tableName ?? DEFAULT_DISPATCH_TABLE;
    this.retryTableName = supplied.retryTableName ?? DEFAULT_RETRY_TABLE;
    this.table = quoteIdentifier(this.tableName);
    this.retryTable = quoteIdentifier(this.retryTableName);
    this.autoMigrate = supplied.autoMigrate ?? false;
    this.retryRetentionMs = supplied.retryRetentionMs ?? DEFAULT_RETRY_RETENTION_MS;
    if (!Number.isSafeInteger(this.retryRetentionMs) || this.retryRetentionMs < MIN_RETRY_RETENTION_MS || this.retryRetentionMs > MAX_RETRY_RETENTION_MS) {
      throw new Error('Hosted worker retry retention is invalid');
    }
    this.leaseTokenFactory = supplied.leaseTokenFactory ?? defaultLeaseToken;
  }

  async acquireLease(now: number, leaseDurationMs: number, context?: HostedWorkerDispatchOperationContext): Promise<HostedWorkerDispatchLease | null> {
    validateTimestamp(now);
    validateLeaseDuration(leaseDurationMs);
    await this.ensureSchema(context);
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await setStatementTimeout(client, context);
      await ensureDispatchRow(client, this.table);
      const result = await client.query<DispatchRow>(
        `SELECT cursor_org_id, lease_token, lease_expires_at FROM ${this.table} WHERE singleton_id = 'default' FOR UPDATE`,
      );
      const row = result.rows[0];
      if (!row) throw new Error('Hosted worker dispatch row is unavailable');
      const currentToken = optionalText(row.lease_token, 'dispatch lease token');
      const currentExpiry = optionalTimestamp(row.lease_expires_at, 'dispatch lease expiry');
      if (currentToken !== undefined && currentExpiry !== undefined && currentExpiry > now) {
        await client.query('COMMIT');
        began = false;
        return null;
      }
      const cursor = optionalOrganizationId(row.cursor_org_id);
      const token = boundedLeaseToken(this.leaseTokenFactory());
      const expiresAt = now + leaseDurationMs;
      const update = await client.query(
        `UPDATE ${this.table}
            SET lease_token = $1, lease_expires_at = $2::timestamptz, updated_at = now()
          WHERE singleton_id = 'default'
          RETURNING singleton_id`,
        [token, new Date(expiresAt).toISOString()],
      );
      if (!hasRows(update)) throw new Error('Hosted worker dispatch lease was not acquired');
      const cutoff = new Date(now - this.retryRetentionMs).toISOString();
      await client.query(`DELETE FROM ${this.retryTable} WHERE updated_at < $1::timestamptz`, [cutoff]);
      await client.query('COMMIT');
      began = false;
      return { token, cursor, expiresAt };
    } catch (error) {
      if (began) { try { await client.query('ROLLBACK'); } catch { /* preserve error */ } }
      throw error;
    } finally {
      await client.release?.();
    }
  }

  async advance(lease: HostedWorkerDispatchLease, cursor: string | null, now: number, context?: HostedWorkerDispatchOperationContext): Promise<void> {
    await this.mutateWithLease(lease, cursor, now, async () => undefined, context);
  }

  async recordSuccess(lease: HostedWorkerDispatchLease, organizationId: string, cursor: string | null, now: number, context?: HostedWorkerDispatchOperationContext): Promise<void> {
    const organization = normalizeOrganizationId(organizationId);
    await this.mutateWithLease(lease, cursor, now, async (client) => {
      await client.query(`DELETE FROM ${this.retryTable} WHERE organization_id = $1`, [organization]);
    }, context);
  }

  async recordFailure(lease: HostedWorkerDispatchLease, organizationId: string, cursor: string | null, reason: string, now: number, context?: HostedWorkerDispatchOperationContext): Promise<void> {
    const organization = normalizeOrganizationId(organizationId);
    const safeReason = boundedRetryReason(reason);
    await this.mutateWithLease(lease, cursor, now, async (client) => {
      const previous = await client.query<{ attempts?: unknown }>(
        `SELECT attempts FROM ${this.retryTable} WHERE organization_id = $1 FOR UPDATE`, [organization],
      );
      const previousAttempts = previous.rows[0] === undefined ? 0 : boundedRetryAttempts(previous.rows[0].attempts);
      const attempts = Math.min(MAX_RETRY_ATTEMPTS, previousAttempts + 1);
      const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempts - 1)));
      await client.query(
        `INSERT INTO ${this.retryTable} (organization_id, attempts, next_attempt_at, last_error, updated_at)
         VALUES ($1, $2, $3::timestamptz, $4, now())
         ON CONFLICT (organization_id) DO UPDATE SET
           attempts = EXCLUDED.attempts,
           next_attempt_at = EXCLUDED.next_attempt_at,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
        [organization, attempts, new Date(now + delay).toISOString(), safeReason],
      );
    }, context);
  }

  async release(lease: HostedWorkerDispatchLease, cursor: string | null, context?: HostedWorkerDispatchOperationContext): Promise<void> {
    validateCursor(cursor);
    await this.ensureSchema(context);
    if (context === undefined) {
      await this.pool.query(
        `UPDATE ${this.table}
            SET cursor_org_id = $2, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE singleton_id = 'default' AND lease_token = $1`,
        [boundedLeaseToken(lease.token), cursor],
      );
      return;
    }
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await setStatementTimeout(client, context);
      await client.query(
        `UPDATE ${this.table}
            SET cursor_org_id = $2, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE singleton_id = 'default' AND lease_token = $1`,
        [boundedLeaseToken(lease.token), cursor],
      );
      await client.query('COMMIT');
      began = false;
    } catch (error) {
      if (began) { try { await client.query('ROLLBACK'); } catch { /* preserve error */ } }
      throw error;
    } finally {
      await client.release?.();
    }
  }

  async isRetryReady(organizationId: string, now: number, context?: HostedWorkerDispatchOperationContext): Promise<boolean> {
    const organization = normalizeOrganizationId(organizationId);
    validateTimestamp(now);
    await this.ensureSchema(context);
    if (context === undefined) {
      const result = await this.pool.query<{ next_attempt_at?: unknown }>(
        `SELECT next_attempt_at FROM ${this.retryTable} WHERE organization_id = $1`, [organization],
      );
      return retryReadyFromResult(result, now);
    }
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await setStatementTimeout(client, context);
      const result = await client.query<{ next_attempt_at?: unknown }>(
        `SELECT next_attempt_at FROM ${this.retryTable} WHERE organization_id = $1`, [organization],
      );
      const ready = retryReadyFromResult(result, now);
      await client.query('COMMIT');
      began = false;
      return ready;
    } catch (error) {
      if (began) { try { await client.query('ROLLBACK'); } catch { /* preserve error */ } }
      throw error;
    } finally {
      await client.release?.();
    }
  }

  private async mutateWithLease(
    lease: HostedWorkerDispatchLease,
    cursor: string | null,
    now: number,
    mutation: (client: Pick<PgClientLike, 'query'>) => Promise<void>,
    context?: HostedWorkerDispatchOperationContext,
  ): Promise<void> {
    validateCursor(cursor);
    validateTimestamp(now);
    const token = boundedLeaseToken(lease.token);
    await this.ensureSchema(context);
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await setStatementTimeout(client, context);
      const updated = await client.query(
        `UPDATE ${this.table}
            SET cursor_org_id = $2, updated_at = now()
          WHERE singleton_id = 'default'
            AND lease_token = $1
            AND lease_expires_at > $3::timestamptz
          RETURNING singleton_id`,
        [token, cursor, new Date(now).toISOString()],
      );
      if (!hasRows(updated)) throw new HostedWorkerDispatchLeaseError();
      await mutation(client);
      await client.query('COMMIT');
      began = false;
    } catch (error) {
      if (began) { try { await client.query('ROLLBACK'); } catch { /* preserve error */ } }
      throw error;
    } finally {
      await client.release?.();
    }
  }

  private async ensureSchema(context?: HostedWorkerDispatchOperationContext): Promise<void> {
    if (!this.autoMigrate) return;
    if (this.migrationPromise === undefined) {
      this.migrationPromise = this.migrate(context);
      // A timed out or failed migration must not poison this long-lived store
      // instance forever. The next invocation gets a fresh bounded attempt;
      // concurrent callers still share the in-flight promise above.
      this.migrationPromise.catch(() => {
        this.migrationPromise = undefined;
      });
    }
    await this.migrationPromise;
  }

  private async migrate(context?: HostedWorkerDispatchOperationContext): Promise<void> {
    if (context === undefined) {
      await this.pool.query(hostedWorkerDispatchSchemaSql(this.tableName, this.retryTableName));
      return;
    }
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await setStatementTimeout(client, context);
      await client.query(hostedWorkerDispatchSchemaSql(this.tableName, this.retryTableName));
      await client.query('COMMIT');
      began = false;
    } catch (error) {
      if (began) { try { await client.query('ROLLBACK'); } catch { /* preserve error */ } }
      throw error;
    } finally {
      await client.release?.();
    }
  }
}

function validateDispatcherOptions(options: HostedWorkerDispatcherOptions): void {
  if (!options || typeof options !== 'object') throw new Error('Hosted worker dispatcher options are required');
  if (typeof options.cronSecret !== 'string' || options.cronSecret.length < 16 || options.cronSecret.length > 4096 || /[\u0000\r\n]/u.test(options.cronSecret)) {
    throw new Error('CRON_SECRET must be 16-4096 characters without control characters');
  }
  if (!options.catalog || typeof options.catalog.listOrganizations !== 'function') throw new Error('Hosted worker dispatcher catalog is invalid');
  if (!options.store || typeof options.store.acquireLease !== 'function') throw new Error('Hosted worker dispatcher store is invalid');
  if (typeof options.workerForOrganization !== 'function') throw new Error('Hosted worker dispatcher worker factory is invalid');
  boundedOption(options.maxOrganizations ?? DEFAULT_MAX_ORGANIZATIONS, 1, MAX_ORGANIZATIONS, 'maxOrganizations');
  boundedOption(options.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, 'pageSize');
  boundedOption(options.maxJobsPerOrganization ?? DEFAULT_MAX_JOBS_PER_ORGANIZATION, 1, MAX_JOBS_PER_ORGANIZATION, 'maxJobsPerOrganization');
  boundedOption(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS, 1_000, MAX_DURATION_MS, 'maxDurationMs');
  boundedOption(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS, 1_000, MAX_LEASE_DURATION_MS, 'leaseDurationMs');
  if ((options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS) < (options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)) {
    throw new Error('Hosted worker dispatcher lease must outlive its time budget');
  }
  if (options.now !== undefined && typeof options.now !== 'function') throw new Error('Hosted worker dispatcher clock is invalid');
}

function boundedOption(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Hosted worker dispatcher ${name} is invalid`);
}

function authorizedCronRequest(request: Request, expected: string): boolean {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer[ \t]+(.+)$/iu.exec(authorization);
  return match !== null && constantTimeEqual(match[1]!.trim(), expected);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

function dispatchJson(payload: object, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

async function invokeWorker(
  worker: (request: Request) => Promise<Response>,
  sourceRequest: Request,
  remainingMs: number,
): Promise<{ claimed: boolean; failure?: string }> {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)));
  const signal = typeof AbortSignal.any === 'function'
    ? AbortSignal.any([sourceRequest.signal, timeoutSignal])
    : timeoutSignal;
  const authorization = sourceRequest.headers.get('authorization');
  if (authorization === null) return { claimed: false, failure: 'cron_authorization_missing' };
  const request = new Request(sourceRequest.url, {
    method: 'GET',
    headers: { authorization },
    signal,
  });
  let response: Response;
  try {
    response = await worker(request);
  } catch {
    return { claimed: false, failure: signal.aborted ? 'worker_timeout' : 'worker_invocation_failed' };
  }
  if (!response.ok) return { claimed: false, failure: `worker_http_${response.status}` };
  let body: unknown;
  try { body = await response.json(); } catch { return { claimed: false, failure: 'worker_response_invalid' }; }
  if (!isRecord(body) || typeof body.ok !== 'boolean' || typeof body.claimed !== 'boolean' || body.ok !== true) {
    return { claimed: false, failure: 'worker_response_invalid' };
  }
  return { claimed: body.claimed };
}

function normalizeOrganizationId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Organization id is invalid');
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ORGANIZATION_ID_BYTES || new TextEncoder().encode(normalized).byteLength > MAX_ORGANIZATION_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('Organization id is invalid');
  }
  return normalized;
}

function validateCursor(cursor: string | null): void {
  if (cursor !== null) normalizeOrganizationId(cursor);
}

function optionalOrganizationId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return normalizeOrganizationId(value);
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Timestamp is invalid');
}

function validateLeaseDuration(value: number): void {
  boundedOption(value, 1_000, MAX_LEASE_DURATION_MS, 'leaseDurationMs');
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 4_096 || /[\u0000\r\n]/u.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredTimestamp(value, field);
}

function requiredTimestamp(value: unknown, field: string): number {
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${field} is invalid`);
  return parsed;
}

function boundedLeaseToken(value: string): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256 || /[\u0000\r\n]/u.test(value)) throw new Error('Hosted worker dispatch lease token is invalid');
  return value;
}

function defaultLeaseToken(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('Hosted worker dispatch lease randomness is unavailable');
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function boundedRetryReason(value: unknown): string {
  const text = typeof value === 'string' ? value : 'worker_failed';
  const sanitized = text.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, MAX_RETRY_REASON_BYTES);
  return sanitized || 'worker_failed';
}

function boundedRetryAttempts(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0 || (parsed as number) > MAX_RETRY_ATTEMPTS) throw new Error('Retry attempts are invalid');
  return parsed as number;
}

function hasRows(result: PgQueryResult): boolean {
  return typeof result.rowCount === 'number' ? result.rowCount > 0 : result.rows.length > 0;
}

function retryReadyFromResult(result: PgQueryResult<{ next_attempt_at?: unknown }>, now: number): boolean {
  if (result.rows.length === 0) return true;
  const value = result.rows[0]?.next_attempt_at;
  if (value === undefined) throw new Error('Retry timestamp is unavailable');
  const retryAt = requiredTimestamp(value, 'retry timestamp');
  return retryAt <= now;
}

/**
 * PostgreSQL clients do not share the Web AbortSignal contract.  Keep the
 * signal for callback cancellation and also set a transaction-local database
 * timeout so a stalled query cannot outlive the dispatch lease indefinitely.
 */
async function setStatementTimeout(
  executor: Pick<PgClientLike, 'query'>,
  context: HostedWorkerDispatchOperationContext | undefined,
): Promise<void> {
  if (context === undefined) return;
  const timeoutMs = Math.max(1, Math.min(MAX_DURATION_MS, Math.floor(context.timeoutMs)));
  await executor.query(`SELECT set_config('statement_timeout', $1, true)`, [`${timeoutMs}ms`]);
}

function isPgPool(value: PostgresHostedWorkerDispatchStoreOptions | PgPoolLike): value is PgPoolLike {
  return typeof (value as PgPoolLike).query === 'function' && typeof (value as PgPoolLike).connect === 'function';
}

async function ensureDispatchRow(executor: Pick<PgPoolLike, 'query'>, table: string): Promise<void> {
  await executor.query(`INSERT INTO ${table} (singleton_id) VALUES ('default') ON CONFLICT (singleton_id) DO NOTHING`);
}

function quoteIdentifier(identifier: string): string {
  if (typeof identifier !== 'string' || identifier.length === 0 || identifier.length > MAX_TABLE_NAME_LENGTH || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error('Hosted worker dispatch table name is invalid');
  }
  return `"${identifier}"`;
}

function retryReadyIndexName(tableName: string): string {
  const suffix = '_ready_idx';
  const candidate = `${tableName}${suffix}`;
  if (candidate.length <= MAX_TABLE_NAME_LENGTH) return candidate;
  const hash = shortIdentifierHash(tableName);
  return `${tableName.slice(0, MAX_TABLE_NAME_LENGTH - suffix.length - hash.length - 1)}_${hash}${suffix}`;
}

function shortIdentifierHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Kept as a type-only reference so consumers can pair a catalog with state. */
export type HostedWorkerDispatchStateReader = (organizationId: string) => Promise<RegistryState>;
