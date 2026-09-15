import type {
  RegistryState,
  StateRepository,
  TenantReviewDispatchCursor,
  TenantReviewDispatchRecord,
} from '../../../packages/contracts/src/index.js';
import {
  dailyReviewIdempotencyKey,
  isUncertainEveStartFailure,
} from '../../../packages/intelligence/src/eve-cost-reservation.js';
import type { ReviewTrigger, ReviewTriggerResult } from '../../../packages/intelligence/src/reviewer-client.js';

export const TENANT_REVIEW_DISPATCH_PATH = '/internal/reviewer/dispatch';
export const TENANT_REVIEW_DISPATCH_PROTOCOL_VERSION = 1 as const;
/**
 * The host route is a liveness trigger for the durable queue. Running it
 * throughout the UTC day lets the bounded cursor drain a large organization
 * list without making one invocation unbounded.
 */
export const TENANT_REVIEW_DISPATCH_CRON = '*/15 * * * *';
const DEFAULT_MAX_TENANTS = 64;
const MAX_MAX_TENANTS = 256;
const DEFAULT_LEASE_MS = 15 * 60 * 1_000;
const MAX_LEASE_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_INVOCATION_MS = 10 * 60 * 1_000;
const MAX_MAX_INVOCATION_MS = 14 * 60 * 1_000;
const MIN_LEASE_MARGIN_MS = 1_000;
const MAX_PERSIST_MARGIN_MS = 5_000;
const MIN_PROVIDER_BUDGET_MS = 100;
const MAX_RECORDS_PER_TENANT = 256;
const MAX_TRACKED_TENANTS = 4_096;
const DEFAULT_CURSOR_ORGANIZATION_ID = '__private_skills_tenant_review_dispatch__';
const MAX_TEXT_LENGTH = 256;

export interface TenantReviewTarget {
  /** A server-derived Better Auth organization identifier. */
  organizationId: string;
  /** Explicit provisioning proof; false or absent never selects a provider. */
  provisioned: boolean;
  /** Optional operator kill switch for this company's scheduled review. */
  enabled?: boolean;
}

export interface TenantReviewDispatchClaim {
  claimed: boolean;
  reason?: 'completed' | 'in-progress';
  claimToken?: string;
}

export interface TenantReviewDispatchLedger {
  claim(input: {
    organizationId: string;
    operationKey: string;
    now: Date;
    leaseMs: number;
  }): Promise<TenantReviewDispatchClaim>;
  complete(input: {
    organizationId: string;
    operationKey: string;
    claimToken: string;
    sessionId?: string;
    now: Date;
  }): Promise<boolean>;
  /** Commit the external-call boundary before reserving or opening a session. */
  markStarting(input: {
    organizationId: string;
    operationKey: string;
    claimToken: string;
    now: Date;
  }): Promise<boolean>;
  /** Fence a provider result whose outcome cannot be retried safely. */
  markUncertain(input: {
    organizationId: string;
    operationKey: string;
    claimToken: string;
    sessionId?: string;
    now: Date;
  }): Promise<boolean>;
  release(input: {
    organizationId: string;
    operationKey: string;
    claimToken: string;
  }): Promise<boolean>;
}

export interface TenantReviewDispatchCursorStore {
  read(input: { day: string }): Promise<TenantReviewDispatchCursor | undefined>;
  write(input: { cursor: TenantReviewDispatchCursor }): Promise<void>;
}

interface TenantReviewDispatchState extends RegistryState {
  tenantReviewDispatches?: TenantReviewDispatchRecord[];
  tenantReviewDispatchCursor?: TenantReviewDispatchCursor;
}

/**
 * Durable per-organization dispatch ledger. StateRepository transactions are
 * the single-flight fence, including PostgreSQL's row lock; this class keeps
 * the schedule independent of the registry review lease implementation.
 */
export class StateRepositoryTenantReviewDispatchLedger implements TenantReviewDispatchLedger {
  readonly cursorStore: TenantReviewDispatchCursorStore;

  constructor(
    private readonly repository: StateRepository,
    options: { maxRecords?: number; cursorOrganizationId?: string } | number = {},
  ) {
    const normalizedOptions = typeof options === 'number' ? { maxRecords: options } : options;
    const maxRecords = normalizedOptions.maxRecords ?? MAX_RECORDS_PER_TENANT;
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0 || maxRecords > MAX_RECORDS_PER_TENANT) {
      throw new Error('Tenant review dispatch record limit is invalid');
    }
    const cursorOrganizationId = normalizedOptions.cursorOrganizationId ?? DEFAULT_CURSOR_ORGANIZATION_ID;
    boundedText(cursorOrganizationId, 'cursorOrganizationId');
    this.cursorStore = new StateRepositoryTenantReviewDispatchCursorStore(repository, cursorOrganizationId);
    this.maxRecords = maxRecords;
  }

  private readonly maxRecords!: number;

  async claim(input: {
    organizationId: string;
    operationKey: string;
    now: Date;
    leaseMs: number;
  }): Promise<TenantReviewDispatchClaim> {
    const organizationId = boundedText(input.organizationId, 'organizationId');
    const operationKey = boundedText(input.operationKey, 'operationKey');
    const now = validDate(input.now);
    const leaseMs = boundedLease(input.leaseMs);
    return this.repository.transaction(organizationId, (state) => {
      const mutable = state as TenantReviewDispatchState;
      const records = recordsFor(mutable);
      const existing = records.find((record) => record.operationKey === operationKey);
      if (existing?.state === 'completed') return { claimed: false, reason: 'completed' as const };
      if (existing?.state === 'starting' || existing?.state === 'uncertain') return { claimed: false, reason: 'in-progress' as const };
      if (existing?.state === 'claimed' && leaseIsActive(existing, now)) {
        return { claimed: false, reason: 'in-progress' as const };
      }
      const claimToken = opaqueId();
      const record: TenantReviewDispatchRecord = {
        operationKey,
        state: 'claimed',
        claimToken,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        updatedAt: now.toISOString(),
      };
      const withoutExisting = records.filter((candidate) => candidate.operationKey !== operationKey);
      withoutExisting.push(record);
      mutable.tenantReviewDispatches = pruneRecords(withoutExisting, this.maxRecords);
      return { claimed: true, claimToken };
    });
  }

  async complete(input: {
    organizationId: string;
    operationKey: string;
    claimToken: string;
    sessionId?: string;
    now: Date;
  }): Promise<boolean> {
    const organizationId = boundedText(input.organizationId, 'organizationId');
    const operationKey = boundedText(input.operationKey, 'operationKey');
    const claimToken = boundedText(input.claimToken, 'claimToken');
    const now = validDate(input.now);
    const sessionId = input.sessionId === undefined ? undefined : boundedText(input.sessionId, 'sessionId');
    return this.repository.transaction(organizationId, (state) => {
      const mutable = state as TenantReviewDispatchState;
      const records = recordsFor(mutable);
      const record = records.find((candidate) => candidate.operationKey === operationKey);
      if (!record || (record.state !== 'claimed' && record.state !== 'starting') || record.claimToken !== claimToken || !leaseIsActive(record, now)) return false;
      record.state = 'completed';
      delete record.claimToken;
      delete record.startingAt;
      record.updatedAt = now.toISOString();
      record.completedAt = now.toISOString();
      if (sessionId !== undefined) record.sessionId = sessionId;
      mutable.tenantReviewDispatches = pruneRecords(records, this.maxRecords);
      return true;
    });
  }

  async markStarting(input: {
    organizationId: string;
    operationKey: string;
    claimToken: string;
    now: Date;
  }): Promise<boolean> {
    const organizationId = boundedText(input.organizationId, 'organizationId');
    const operationKey = boundedText(input.operationKey, 'operationKey');
    const claimToken = boundedText(input.claimToken, 'claimToken');
    const now = validDate(input.now);
    return this.repository.transaction(organizationId, (state) => {
      const mutable = state as TenantReviewDispatchState;
      const records = recordsFor(mutable);
      const record = records.find((candidate) => candidate.operationKey === operationKey);
      if (!record || record.state !== 'claimed' || record.claimToken !== claimToken || !leaseIsActive(record, now)) return false;
      record.state = 'starting';
      record.startingAt = now.toISOString();
      record.updatedAt = now.toISOString();
      mutable.tenantReviewDispatches = pruneRecords(records, this.maxRecords);
      return true;
    });
  }

  async markUncertain(input: {
    organizationId: string;
    operationKey: string;
    claimToken: string;
    sessionId?: string;
    now: Date;
  }): Promise<boolean> {
    const organizationId = boundedText(input.organizationId, 'organizationId');
    const operationKey = boundedText(input.operationKey, 'operationKey');
    const claimToken = boundedText(input.claimToken, 'claimToken');
    const now = validDate(input.now);
    const sessionId = input.sessionId === undefined ? undefined : boundedText(input.sessionId, 'sessionId');
    return this.repository.transaction(organizationId, (state) => {
      const mutable = state as TenantReviewDispatchState;
      const records = recordsFor(mutable);
      const record = records.find((candidate) => candidate.operationKey === operationKey);
      if (!record || (record.state !== 'claimed' && record.state !== 'starting') || record.claimToken !== claimToken) return false;
      record.state = 'uncertain';
      delete record.claimToken;
      delete record.startingAt;
      record.updatedAt = now.toISOString();
      record.uncertainAt = now.toISOString();
      if (sessionId !== undefined) record.sessionId = sessionId;
      mutable.tenantReviewDispatches = pruneRecords(records, this.maxRecords);
      return true;
    });
  }

  async release(input: {
    organizationId: string;
    operationKey: string;
    claimToken: string;
  }): Promise<boolean> {
    const organizationId = boundedText(input.organizationId, 'organizationId');
    const operationKey = boundedText(input.operationKey, 'operationKey');
    const claimToken = boundedText(input.claimToken, 'claimToken');
    return this.repository.transaction(organizationId, (state) => {
      const mutable = state as TenantReviewDispatchState;
      const records = recordsFor(mutable);
      const record = records.find((candidate) => candidate.operationKey === operationKey);
      if (!record || (record.state !== 'claimed' && record.state !== 'starting') || record.claimToken !== claimToken) return false;
      mutable.tenantReviewDispatches = records.filter((candidate) => candidate !== record);
      return true;
    });
  }
}

/** Persist the bounded fan-out cursor in a host-owned registry state row. */
export class StateRepositoryTenantReviewDispatchCursorStore implements TenantReviewDispatchCursorStore {
  constructor(
    private readonly repository: StateRepository,
    private readonly organizationId = DEFAULT_CURSOR_ORGANIZATION_ID,
  ) {
    boundedText(organizationId, 'cursorOrganizationId');
  }

  async read(input: { day: string }): Promise<TenantReviewDispatchCursor | undefined> {
    const day = boundedDay(input.day);
    const state = await this.repository.read(this.organizationId) as TenantReviewDispatchState;
    const cursor = state.tenantReviewDispatchCursor;
    if (cursor === undefined || cursor.day !== day) return undefined;
    return cloneCursor(cursor);
  }

  async write(input: { cursor: TenantReviewDispatchCursor }): Promise<void> {
    const cursor = normalizeCursor(input.cursor);
    await this.repository.transaction(this.organizationId, (state) => {
      (state as TenantReviewDispatchState).tenantReviewDispatchCursor = cursor;
    });
  }
}

export type TenantReviewDispatchFailureReason =
  | 'not-provisioned'
  | 'provider-unavailable'
  | 'provider-rejected'
  | 'uncertain'
  | 'lease-lost';

export interface TenantReviewDispatchOutcome {
  organizationId: string;
  operationKey: string;
  status: 'started' | 'already-completed' | 'in-progress' | 'unavailable' | 'failed';
  reason?: TenantReviewDispatchFailureReason;
  sessionId?: string;
}

export interface TenantReviewDispatchResult {
  protocolVersion: typeof TENANT_REVIEW_DISPATCH_PROTOCOL_VERSION;
  day: string;
  operationKey: string;
  attempted: number;
  started: number;
  truncated: number;
  outcomes: readonly TenantReviewDispatchOutcome[];
}

export interface TenantReviewDispatcherOptions {
  /** Explicit server-owned organization list; never derived from email/domain. */
  listTenants: () => Promise<readonly TenantReviewTarget[]>;
  /** Returns a credential-bound trigger for exactly this organization. */
  triggerForTenant: (organizationId: string) => Promise<ReviewTrigger | undefined> | ReviewTrigger | undefined;
  ledger: TenantReviewDispatchLedger;
  /** Required for a bounded page when the target list exceeds maxTenants. */
  cursorStore?: TenantReviewDispatchCursorStore;
  maxTenants?: number;
  leaseMs?: number;
  /** Stop starting new tenants before the lease/platform timeout. */
  maxDurationMs?: number;
  now?: () => Date;
}

export class TenantReviewDispatchError extends Error {
  readonly code: 'TENANTS_UNAVAILABLE' | 'DISPATCH_CONFIGURATION';
  readonly retryable: boolean;

  constructor(code: 'TENANTS_UNAVAILABLE' | 'DISPATCH_CONFIGURATION', message: string, retryable = true) {
    super(message);
    this.name = 'TenantReviewDispatchError';
    this.code = code;
    this.retryable = retryable;
  }
}

class TenantReviewDispatchBudgetError extends Error {
  constructor() {
    super('Tenant review dispatch invocation budget expired');
    this.name = 'TenantReviewDispatchBudgetError';
  }
}

/**
 * Dispatch one deterministic review operation per explicitly provisioned
 * tenant. Calls are sequential and bounded so a schedule cannot share a
 * snapshot, credential, or unreserved AI session across companies.
 */
export async function dispatchTenantDailyReviews(options: TenantReviewDispatcherOptions): Promise<TenantReviewDispatchResult> {
  const maxTenants = boundedMaxTenants(options.maxTenants);
  const leaseMs = boundedLease(options.leaseMs ?? DEFAULT_LEASE_MS);
  const clock = options.now ?? (() => new Date());
  const initialNow = validDate(clock());
  const maxDurationMs = boundedMaxDuration(options.maxDurationMs, leaseMs);
  const deadlineMs = initialNow.getTime() + maxDurationMs;
  const wallDeadlineMs = Date.now() + maxDurationMs;
  const persistMarginMs = Math.min(MAX_PERSIST_MARGIN_MS, Math.max(MIN_PROVIDER_BUDGET_MS, Math.floor(maxDurationMs / 5)));
  const currentNow = (): Date => validDate(clock());
  const remainingBudgetMs = (): number => Math.min(deadlineMs - currentNow().getTime(), wallDeadlineMs - Date.now());
  const operationKey = dailyReviewIdempotencyKey(initialNow);
  let rawTargets: readonly TenantReviewTarget[];
  try {
    rawTargets = await options.listTenants();
  } catch {
    throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review targets are temporarily unavailable');
  }
  if (!Array.isArray(rawTargets)) throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review targets are invalid');
  const targets = normalizeTargets(rawTargets);
  if (targets.length > MAX_TRACKED_TENANTS) {
    throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review target count exceeds the durable bound', false);
  }
  const cursorStore = options.cursorStore ?? (options.ledger as TenantReviewDispatchLedger & { cursorStore?: TenantReviewDispatchCursorStore }).cursorStore;
  let cursor: TenantReviewDispatchCursor | undefined;
  if (cursorStore) {
    try {
      cursor = await cursorStore.read({ day: operationKey.slice('common-skill-review:'.length) });
    } catch {
      throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch cursor is temporarily unavailable');
    }
  } else if (targets.length > maxTenants) {
    // Processing only the first page without durable continuation would
    // starve later companies forever. Refuse that unsafe configuration.
    throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'A durable tenant review cursor is required for bounded fan-out', false);
  }
  const targetMap = new Map(targets.map((target) => [target.organizationId, target]));
  const queue = buildQueue(cursor, targets);
  const pageIds = queue.pendingOrganizationIds.slice(0, maxTenants);
  const remainingIds = queue.pendingOrganizationIds.slice(pageIds.length);
  const done = new Set(queue.completedOrganizationIds);
  const blocked = new Set(queue.blockedOrganizationIds);
  const retry: string[] = [];
  const outcomes: TenantReviewDispatchOutcome[] = [];
  let attempted = 0;
  let started = 0;
  let unprocessedPageIds = pageIds;

  if (pageIds.length === 0) {
    // Keep the response useful for an idempotent replay while avoiding a
    // second provider call. The persisted completed set remains authoritative.
    for (const target of targets.slice(0, maxTenants)) {
      if (done.has(target.organizationId)) {
        outcomes.push({ organizationId: target.organizationId, operationKey, status: 'already-completed' });
      } else if (blocked.has(target.organizationId)) {
        outcomes.push({ organizationId: target.organizationId, operationKey, status: 'in-progress' });
      }
    }
  }

  for (let index = 0; index < pageIds.length; index += 1) {
    const organizationId = pageIds[index]!;
    const claimNow = currentNow();
    if (remainingBudgetMs() <= persistMarginMs || claimNow.getTime() >= deadlineMs) {
      unprocessedPageIds = pageIds.slice(index);
      break;
    }
    unprocessedPageIds = pageIds.slice(index + 1);
    const target = targetMap.get(organizationId);
    if (!target) {
      done.add(organizationId);
      continue;
    }
    const base = { organizationId: target.organizationId, operationKey };
    if (target.provisioned !== true || target.enabled === false) {
      outcomes.push({ ...base, status: 'unavailable', reason: 'not-provisioned' });
      done.add(organizationId);
      continue;
    }
    let claim: TenantReviewDispatchClaim;
    try {
      claim = await options.ledger.claim({
        organizationId: target.organizationId,
        operationKey,
        now: claimNow,
        leaseMs,
      });
    } catch {
      outcomes.push({ ...base, status: 'failed', reason: 'provider-unavailable' });
      retry.push(organizationId);
      continue;
    }
    if (!claim.claimed) {
      outcomes.push({
        ...base,
        status: claim.reason === 'completed' ? 'already-completed' : 'in-progress',
      });
      if (claim.reason === 'completed') done.add(organizationId);
      else retry.push(organizationId);
      continue;
    }
    attempted += 1;
    const claimToken = claim.claimToken;
    if (!claimToken) {
      outcomes.push({ ...base, status: 'failed', reason: 'lease-lost' });
      retry.push(organizationId);
      continue;
    }
    if (remainingBudgetMs() <= persistMarginMs) {
      const released = await releaseAfterFailure(options.ledger, target.organizationId, operationKey, claimToken);
      if (!released) throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch could not save its continuation');
      retry.push(organizationId);
      continue;
    }
    let trigger: ReviewTrigger | undefined;
    try {
      trigger = await options.triggerForTenant(target.organizationId);
    } catch {
      await releaseAfterFailure(options.ledger, target.organizationId, operationKey, claimToken);
      outcomes.push({ ...base, status: 'unavailable', reason: 'provider-unavailable' });
      retry.push(organizationId);
      continue;
    }
    if (!trigger) {
      await releaseAfterFailure(options.ledger, target.organizationId, operationKey, claimToken);
      outcomes.push({ ...base, status: 'unavailable', reason: 'provider-unavailable' });
      retry.push(organizationId);
      continue;
    }
    if (remainingBudgetMs() <= persistMarginMs || currentNow().getTime() >= deadlineMs) {
      const released = await releaseAfterFailure(options.ledger, target.organizationId, operationKey, claimToken);
      if (!released) throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch could not save its continuation');
      retry.push(organizationId);
      continue;
    }
    // Persist the external-call boundary before reserving cost or asking Eve
    // to create a session. A host crash after the provider accepts the call
    // can otherwise leave only an expired lease, allowing the next invocation
    // to start a duplicate session. `starting` is intentionally fenced until
    // an operator or reconciliation process resolves the outcome.
    let starting: boolean;
    try {
      starting = await options.ledger.markStarting({
        organizationId: target.organizationId,
        operationKey,
        claimToken,
        now: currentNow(),
      });
    } catch {
      throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch could not persist its starting state');
    }
    if (!starting) {
      outcomes.push({ ...base, status: 'failed', reason: 'lease-lost' });
      retry.push(organizationId);
      continue;
    }
    let result: ReviewTriggerResult;
    try {
      const providerBudgetMs = Math.floor(remainingBudgetMs() - persistMarginMs);
      if (providerBudgetMs < MIN_PROVIDER_BUDGET_MS) {
        const released = await releaseAfterFailure(options.ledger, target.organizationId, operationKey, claimToken);
        if (!released) throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch could not save its continuation');
        retry.push(organizationId);
        continue;
      }
      result = await runWithDispatchBudget(() => trigger(target.organizationId), providerBudgetMs);
    } catch (error) {
      const uncertain = isUncertainEveStartFailure(error);
      if (!uncertain) {
        const released = await releaseAfterFailure(options.ledger, target.organizationId, operationKey, claimToken);
        outcomes.push({ ...base, status: released ? 'failed' : 'failed', reason: released ? 'provider-rejected' : 'uncertain' });
      } else {
        const held = await markUncertainAfterFailure(
          options.ledger,
          target.organizationId,
          operationKey,
          claimToken,
          currentNow(),
        );
        if (!held) throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch could not persist an uncertain provider result');
        outcomes.push({ ...base, status: 'failed', reason: 'uncertain' });
      }
      if (uncertain) blocked.add(organizationId);
      else retry.push(organizationId);
      continue;
    }
    const sessionId = safeSessionId(result?.sessionId);
    try {
      const completed = await options.ledger.complete({
        organizationId: target.organizationId,
        operationKey,
        claimToken,
        ...(sessionId === undefined ? {} : { sessionId }),
        now: currentNow(),
      });
      if (!completed) {
        outcomes.push({ ...base, status: 'failed', reason: 'lease-lost', ...(sessionId === undefined ? {} : { sessionId }) });
        const held = await markUncertainAfterFailure(
          options.ledger,
          target.organizationId,
          operationKey,
          claimToken,
          currentNow(),
          sessionId,
        );
        if (!held) throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch could not persist a late provider result');
        blocked.add(organizationId);
      } else {
        started += 1;
        done.add(organizationId);
        outcomes.push({ ...base, status: 'started', ...(sessionId === undefined ? {} : { sessionId }) });
      }
    } catch {
      // The provider has already accepted the session. Fence the durable
      // starting record for retry/reconciliation rather than releasing it.
      const held = await markUncertainAfterFailure(
        options.ledger,
        target.organizationId,
        operationKey,
        claimToken,
        currentNow(),
        sessionId,
      );
      if (!held) throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch could not persist a provider result');
      blocked.add(organizationId);
      outcomes.push({ ...base, status: 'failed', reason: 'uncertain', ...(sessionId === undefined ? {} : { sessionId }) });
    }
  }

  const pendingOrganizationIds = uniqueIds([
    ...remainingIds.filter((organizationId) => !done.has(organizationId)),
    ...unprocessedPageIds.filter((organizationId) => !done.has(organizationId)),
    ...retry.filter((organizationId) => !done.has(organizationId)),
  ]).filter((organizationId) => !blocked.has(organizationId));
  const updatedAt = currentNow().toISOString();
  const nextCursor = normalizeCursor({
    day: operationKey.slice('common-skill-review:'.length),
    pendingOrganizationIds,
    completedOrganizationIds: [...done].filter((organizationId) => targetMap.has(organizationId)).sort(),
    blockedOrganizationIds: [...blocked].filter((organizationId) => targetMap.has(organizationId)).sort(),
    updatedAt,
  });
  if (cursorStore) {
    try {
      await cursorStore.write({ cursor: nextCursor });
    } catch {
      throw new TenantReviewDispatchError('TENANTS_UNAVAILABLE', 'Tenant review dispatch cursor could not be saved');
    }
  }

  return {
    protocolVersion: TENANT_REVIEW_DISPATCH_PROTOCOL_VERSION,
    day: operationKey.slice('common-skill-review:'.length),
    operationKey,
    attempted,
    started,
    truncated: pendingOrganizationIds.length,
    outcomes,
  };
}

export interface TenantReviewDispatchHandlerOptions {
  dispatch: () => Promise<TenantReviewDispatchResult>;
  authorize: (request: Request) => Promise<boolean> | boolean;
}

/** Mountable internal handler; the runtime decides which secret authorizes it. */
export function createTenantReviewDispatchHandler(options: TenantReviewDispatchHandlerOptions): (request: Request) => Promise<Response | undefined> {
  return async (request: Request): Promise<Response | undefined> => {
    const path = safePath(request);
    if (path !== TENANT_REVIEW_DISPATCH_PATH) return undefined;
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    let allowed = false;
    try { allowed = await options.authorize(request); } catch { allowed = false; }
    if (!allowed) return Response.json({ code: 'UNAUTHORIZED', message: 'Authentication is required.' }, { status: 401, headers: { 'cache-control': 'no-store' } });
    try {
      const result = await options.dispatch();
      return Response.json(result, { status: 200, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (error instanceof TenantReviewDispatchError) {
        return Response.json({ code: error.code, message: error.message, retryable: error.retryable }, { status: 503, headers: { 'cache-control': 'no-store' } });
      }
      return Response.json({ code: 'DISPATCH_UNAVAILABLE', message: 'Tenant review dispatch is temporarily unavailable.', retryable: true }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  };
}

/** Constant-time CRON_SECRET adapter for the internal scheduled route. */
export function createTenantReviewCronHandler(options: {
  dispatch: () => Promise<TenantReviewDispatchResult>;
  cronSecret: string;
}): (request: Request) => Promise<Response | undefined> {
  const secret = boundedText(options.cronSecret, 'cronSecret');
  return createTenantReviewDispatchHandler({
    dispatch: options.dispatch,
    authorize: (request) => {
      const supplied = request.headers.get('authorization')?.match(/^Bearer[ \t]+([^ \t]+)$/iu)?.[1];
      return supplied !== undefined && constantTimeEqual(supplied, secret);
    },
  });
}

function recordsFor(state: TenantReviewDispatchState): TenantReviewDispatchRecord[] {
  if (state.tenantReviewDispatches === undefined) {
    state.tenantReviewDispatches = [];
    return state.tenantReviewDispatches;
  }
  if (!Array.isArray(state.tenantReviewDispatches)) throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review dispatch state is invalid', false);
  for (const record of state.tenantReviewDispatches) {
    if (!record || typeof record !== 'object' || typeof record.operationKey !== 'string' || (record.state !== 'claimed' && record.state !== 'starting' && record.state !== 'completed' && record.state !== 'uncertain') || typeof record.leaseExpiresAt !== 'string' || typeof record.updatedAt !== 'string') {
      throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review dispatch state is invalid', false);
    }
  }
  return state.tenantReviewDispatches;
}

function pruneRecords(records: readonly TenantReviewDispatchRecord[], max: number): TenantReviewDispatchRecord[] {
  const completed = records
    .filter((record) => record.state === 'completed')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const remove = Math.max(0, records.length - max);
  const removeKeys = new Set(completed.slice(0, remove).map((record) => record.operationKey));
  const retained = records.filter((record) => !removeKeys.has(record.operationKey));
  if (retained.length > max) {
    // Never evict an unresolved provider outcome merely to stay within the
    // state bound: doing so would make a later retry capable of opening a
    // duplicate session. Operators must reconcile the oldest uncertain row
    // before this tenant can accumulate more history.
    throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review dispatch has too many unresolved outcomes', false);
  }
  return retained;
}

function leaseIsActive(record: TenantReviewDispatchRecord, now: Date): boolean {
  const expiry = Date.parse(record.leaseExpiresAt);
  return Number.isFinite(expiry) && expiry > now.getTime();
}

function normalizeTargets(targets: readonly TenantReviewTarget[]): TenantReviewTarget[] {
  const byOrganization = new Map<string, TenantReviewTarget>();
  for (const raw of targets) {
    if (!raw || typeof raw !== 'object') continue;
    const organizationId = typeof raw.organizationId === 'string' ? raw.organizationId.trim() : '';
    if (!organizationId || organizationId.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(organizationId)) continue;
    const candidate: TenantReviewTarget = {
      organizationId,
      provisioned: raw.provisioned === true,
      ...(raw.enabled === undefined ? {} : { enabled: raw.enabled === true }),
    };
    const existing = byOrganization.get(organizationId);
    if (!existing) {
      byOrganization.set(organizationId, candidate);
    } else if (existing.provisioned !== candidate.provisioned || existing.enabled !== candidate.enabled) {
      // Contradictory server configuration must fail closed for that tenant.
      byOrganization.set(organizationId, { organizationId, provisioned: false, enabled: false });
    }
  }
  return [...byOrganization.values()].sort((left, right) => left.organizationId.localeCompare(right.organizationId));
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function boundedMaxTenants(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_TENANTS;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review dispatch limit is invalid', false);
  return Math.min(value, MAX_MAX_TENANTS);
}

function boundedLease(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LEASE_MS) throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review lease is invalid', false);
  return value;
}

function boundedMaxDuration(value: number | undefined, leaseMs: number): number {
  const available = leaseMs - MIN_LEASE_MARGIN_MS;
  if (available <= 0) throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review lease is too short for a bounded invocation', false);
  const candidate = value ?? Math.min(DEFAULT_MAX_INVOCATION_MS, available);
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > MAX_MAX_INVOCATION_MS || candidate >= leaseMs) {
    throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review invocation budget is invalid', false);
  }
  return candidate;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review clock is invalid', false);
  return new Date(value.getTime());
}

function safeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value.trim();
}

function buildQueue(
  cursor: TenantReviewDispatchCursor | undefined,
  targets: readonly TenantReviewTarget[],
): TenantReviewDispatchCursor {
  const ids = targets.map((target) => target.organizationId);
  const available = new Set(ids);
  const completed = new Set((cursor?.completedOrganizationIds ?? []).filter((id) => available.has(id)));
  const blocked = new Set((cursor?.blockedOrganizationIds ?? []).filter((id) => available.has(id) && !completed.has(id)));
  const pending = new Set<string>();
  for (const id of cursor?.pendingOrganizationIds ?? []) {
    if (available.has(id) && !completed.has(id) && !blocked.has(id)) pending.add(id);
  }
  // New companies are appended in stable order. Existing queue order remains
  // intact, so a large company list advances one bounded page at a time.
  for (const id of ids) {
    if (!completed.has(id) && !blocked.has(id) && !pending.has(id)) pending.add(id);
  }
  return {
    day: cursor?.day ?? '',
    pendingOrganizationIds: [...pending],
    completedOrganizationIds: [...completed].sort(),
    blockedOrganizationIds: [...blocked].sort(),
    updatedAt: cursor?.updatedAt ?? new Date(0).toISOString(),
  };
}

function normalizeCursor(cursor: TenantReviewDispatchCursor): TenantReviewDispatchCursor {
  if (!cursor || typeof cursor !== 'object') throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review cursor is invalid', false);
  const day = boundedDay(cursor.day);
  if (!Array.isArray(cursor.pendingOrganizationIds) || !Array.isArray(cursor.completedOrganizationIds)) {
    throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review cursor is invalid', false);
  }
  const pending = cursor.pendingOrganizationIds.map((id) => boundedText(id, 'pending organization')).filter(Boolean);
  const completed = cursor.completedOrganizationIds.map((id) => boundedText(id, 'completed organization')).filter(Boolean);
  const blocked = (cursor.blockedOrganizationIds ?? []).map((id) => boundedText(id, 'blocked organization')).filter(Boolean);
  if (pending.length > MAX_TRACKED_TENANTS || completed.length > MAX_TRACKED_TENANTS || blocked.length > MAX_TRACKED_TENANTS || new Set([...pending, ...completed, ...blocked]).size !== pending.length + completed.length + blocked.length) {
    throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review cursor exceeds its durable bound', false);
  }
  return {
    day,
    pendingOrganizationIds: pending,
    completedOrganizationIds: completed,
    blockedOrganizationIds: blocked,
    updatedAt: validDate(new Date(cursor.updatedAt)).toISOString(),
  };
}

function cloneCursor(cursor: TenantReviewDispatchCursor): TenantReviewDispatchCursor {
  return {
    day: cursor.day,
    pendingOrganizationIds: [...cursor.pendingOrganizationIds],
    completedOrganizationIds: [...cursor.completedOrganizationIds],
    ...(cursor.blockedOrganizationIds === undefined ? {} : { blockedOrganizationIds: [...cursor.blockedOrganizationIds] }),
    updatedAt: cursor.updatedAt,
  };
}

function boundedDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TenantReviewDispatchError('DISPATCH_CONFIGURATION', 'Tenant review day is invalid', false);
  return value;
}

function opaqueId(): string {
  if (globalThis.crypto?.randomUUID) return `dispatch_${globalThis.crypto.randomUUID()}`;
  if (!globalThis.crypto?.getRandomValues) throw new Error('A secure random source is required');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `dispatch_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function releaseAfterFailure(
  ledger: TenantReviewDispatchLedger,
  organizationId: string,
  operationKey: string,
  claimToken: string,
): Promise<boolean> {
  try {
    return await ledger.release({ organizationId, operationKey, claimToken });
  } catch {
    return false;
  }
}

async function markUncertainAfterFailure(
  ledger: TenantReviewDispatchLedger,
  organizationId: string,
  operationKey: string,
  claimToken: string,
  now: Date,
  sessionId?: string,
): Promise<boolean> {
  return ledger.markUncertain({
    organizationId,
    operationKey,
    claimToken,
    ...(sessionId === undefined ? {} : { sessionId }),
    now,
  });
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

async function runWithDispatchBudget<T>(action: () => Promise<T>, budgetMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new TenantReviewDispatchBudgetError()), budgetMs);
  });
  try {
    // A late provider promise remains attached to the race, so a response
    // arriving after the host budget cannot become an unhandled rejection.
    return await Promise.race([action(), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function safePath(request: Request): string {
  try { return new URL(request.url).pathname.replace(/\/+$/u, '') || '/'; } catch { return ''; }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return mismatch === 0;
}
