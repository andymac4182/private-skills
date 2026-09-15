import { hasScope } from '../../../packages/auth/src/index.js';
import { getCurrentSkillAdmission } from '../../../packages/core/src/index.js';
import type {
  Authenticator,
  Job,
  RegistryState,
  StateRepository,
} from '../../../packages/contracts/src/index.js';
import type {
  BillingMode,
  BillingProviderId,
  BillingService,
  BillingStatus,
  UsageSnapshot,
} from '../../../packages/billing/src/index.js';
// Keep the shared route's telemetry seam dependency-free. Importing the
// identity barrel here also pulls Better Auth and its PostgreSQL driver into
// the edge bundle, even though edge infrastructure never supplies an
// operations-event sink.
import { captureIdentityOperationsTask } from '../../../packages/identity/src/operations-events.js';
import type {
  IdentityOperationsCounter,
  IdentityOperationsEventSink,
  IdentityOperationsFailure,
} from '../../../packages/identity/src/operations-events.js';
import type { ReviewRun } from '../../../packages/reviews/src/index.js';
import type { UploadReviewJob } from '../../../packages/upload-reviews/src/index.js';

/** The route is mounted before the shared `/v1/operations` handler. */
export const OPERATIONS_STATUS_ROUTE_PATH = '/v1/operations/status';
export const OPERATIONS_STATUS_PROTOCOL_VERSION = 1 as const;

export type OperationsStatusHandler = (request: Request) => Promise<Response | undefined>;
export type OperationsAvailability = 'available' | 'empty' | 'unavailable';

export interface OperationsQueueStatus {
  state: 'clear' | 'active' | 'attention' | 'empty';
  queued: number;
  running: number;
  failed: number;
  oldestActiveAt?: string;
  oldestActiveAgeSeconds?: number;
}

export interface OperationsScanStatus {
  state: 'current' | 'attention' | 'empty';
  skills: {
    total: number;
    current: number;
    stale: number;
    failed: number;
    blocked: number;
    unavailable: number;
  };
  enabledScannerCount: number;
  requiredScannerCount: number;
  evidenceMaxAgeSeconds: number;
  latestCompletedAt?: string;
}

export interface OperationsAuthStatus {
  /** Aggregate identity events are available only after the existing admin boundary passes. */
  state: 'available' | 'empty' | 'unavailable';
  authenticationFailures: IdentityOperationsCounter | null;
  callbackFailures: IdentityOperationsCounter | null;
  membershipDenials: IdentityOperationsCounter | null;
  reason?: string;
}

export interface OperationsBillingUsage {
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
  seats: number;
  storageBytes: number;
  scans: number;
  eveCostCents: number;
  limits: {
    seats: number;
    storageBytes: number;
    scansPerMonth: number;
    eveCostCentsPerMonth: number;
  };
}

export interface OperationsBillingStatus {
  state: 'available' | 'unconfigured' | 'disabled' | 'unavailable';
  provider: BillingProviderId | null;
  mode: BillingMode;
  webhookVerification: boolean;
  checkout: boolean;
  portal: boolean;
  usageState: OperationsAvailability;
  usage: OperationsBillingUsage | null;
  failureCount: null;
  failureState: 'unavailable';
  reason: string;
}

export interface OperationsEveStatus {
  state: 'current' | 'attention' | 'empty' | 'unavailable';
  consolidationRuns: {
    total: number;
    running: number;
    completed: number;
    failed: number;
  };
  uploadReviews: {
    total: number;
    pending: number;
    running: number;
    passed: number;
    failed: number;
    stale: number;
  };
  latestFailureAt?: string;
  reason?: string;
}

export interface OperationsStatusResponse {
  protocolVersion: typeof OPERATIONS_STATUS_PROTOCOL_VERSION;
  organizationId: string;
  generatedAt: string;
  queue: OperationsQueueStatus;
  scans: OperationsScanStatus;
  auth: OperationsAuthStatus;
  billing: OperationsBillingStatus;
  eve: OperationsEveStatus;
}

export interface OperationsStatusBilling {
  status(): BillingStatus;
  usageSnapshot(organizationId: string): Promise<UsageSnapshot>;
}

export interface OperationsStatusOptions {
  repository: StateRepository;
  billing: OperationsStatusBilling | BillingService;
  authenticate: Authenticator['authenticate'];
  organizationId: string;
  /** Whether an Eve reviewer is configured for the selected tenant. */
  eveConfigured?: boolean;
  /** Optional durable identity event store; absent on legacy/edge profiles. */
  operationsEvents?: IdentityOperationsEventSink;
  now?: () => number;
}

const ADMIN_ROLES = new Set(['owner', 'admin']);

function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname.replace(/\/+$/u, '') || '/';
  } catch {
    return '';
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function isoAt(milliseconds: number): string {
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizedNow(now: (() => number) | undefined): number {
  const candidate = now?.() ?? Date.now();
  return Number.isFinite(candidate) ? candidate : Date.now();
}

function countableDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queueStatus(state: RegistryState, organizationId: string, nowMilliseconds: number): OperationsQueueStatus {
  const jobs = state.jobs.filter((job) => job.organizationId === organizationId);
  // Registry states are read through the fixed tenant repository, but keep a
  // second organization check at the projection boundary when an adapter
  // returns a malformed row.
  const queued = jobs.filter((job) => job.state === 'queued').length;
  const running = jobs.filter((job) => job.state === 'running').length;
  const failed = jobs.filter((job) => job.state === 'failed').length;
  const activeJobs = jobs
    .filter((job) => job.state === 'queued' || job.state === 'running');
  const active = activeJobs
    .map((job) => ({ job, createdAt: countableDate(job.createdAt) }))
    .filter((entry): entry is { job: Job; createdAt: number } => entry.createdAt !== undefined)
    .sort((left, right) => left.createdAt - right.createdAt);
  const oldest = active[0]?.createdAt;
  const stateValue: OperationsQueueStatus['state'] = failed > 0
    ? 'attention'
    : activeJobs.length > 0
      ? 'active'
      : jobs.length === 0
        ? 'empty'
        : 'clear';
  return {
    state: stateValue,
    queued,
    running,
    failed,
    ...(oldest === undefined ? {} : {
      oldestActiveAt: new Date(oldest).toISOString(),
      oldestActiveAgeSeconds: Math.max(0, Math.floor((nowMilliseconds - oldest) / 1_000)),
    }),
  };
}

function scanStatus(state: RegistryState, organizationId: string, nowMilliseconds: number): OperationsScanStatus {
  const skills = state.skills.filter((skill) => skill.organizationId === organizationId);
  const admissions = skills.map((skill) => getCurrentSkillAdmission(state, skill, nowMilliseconds));
  const current = admissions.filter((admission) => admission.allowed).length;
  const stale = admissions.filter((admission) => admission.reason === 'evidence-stale' || admission.reason === 'policy-changed').length;
  const blocked = admissions.filter((admission) => admission.reason === 'blocking-finding' || admission.reason === 'quarantined').length;
  const failed = admissions.filter((admission) =>
    admission.reason === 'scan-error' ||
    admission.reason === 'scan-failed' ||
    admission.reason === 'evidence-incomplete' ||
    admission.reason === 'evidence-missing',
  ).length;
  const unavailable = Math.max(0, skills.length - current - stale - failed - blocked);
  const completed = state.scans
    .filter((scan) => scan.organizationId === organizationId && scan.status === 'completed')
    .map((scan) => {
      // The persisted scan contract records when evidence was created. When
      // its durable job is retained, use the job's terminal update as the
      // completion timestamp; otherwise leave the completion metric absent.
      const job = state.jobs.find((candidate) => candidate.organizationId === organizationId && candidate.id === scan.jobId && candidate.state === 'completed');
      return countableDate(job?.updatedAt);
    })
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
  const attention = stale + failed + blocked + unavailable;
  return {
    state: skills.length === 0 ? 'empty' : attention === 0 ? 'current' : 'attention',
    skills: { total: skills.length, current, stale, failed, blocked, unavailable },
    enabledScannerCount: state.policy.scanners.filter((scanner) => scanner.mode !== 'disabled').length,
    requiredScannerCount: state.policy.scanners.filter((scanner) => scanner.mode === 'required').length,
    evidenceMaxAgeSeconds: state.policy.evidenceMaxAgeSeconds,
    ...(completed === undefined ? {} : { latestCompletedAt: new Date(completed).toISOString() }),
  };
}

type ReviewRunStatusRow = Pick<ReviewRun, 'organizationId' | 'state' | 'finishedAt' | 'createdAt'>;
type UploadReviewStatusRow = Pick<UploadReviewJob, 'organizationId' | 'state' | 'finishedAt' | 'updatedAt' | 'createdAt'>;

function eveStatus(state: RegistryState, organizationId: string, configured: boolean): OperationsEveStatus {
  const extension = state as RegistryState & {
    reviewRuns?: ReviewRunStatusRow[];
    uploadReviewJobs?: UploadReviewStatusRow[];
  };
  const runs = Array.isArray(extension.reviewRuns)
    ? extension.reviewRuns.filter((run) => run.organizationId === organizationId)
    : [];
  const uploadJobs = Array.isArray(extension.uploadReviewJobs)
    ? extension.uploadReviewJobs.filter((job) => job.organizationId === organizationId)
    : [];
  const consolidationRuns = {
    total: runs.length,
    running: runs.filter((run) => run.state === 'running').length,
    completed: runs.filter((run) => run.state === 'completed').length,
    failed: runs.filter((run) => run.state === 'failed').length,
  };
  const uploadReviews = {
    total: uploadJobs.length,
    pending: uploadJobs.filter((job) => job.state === 'pending').length,
    running: uploadJobs.filter((job) => job.state === 'running').length,
    passed: uploadJobs.filter((job) => job.state === 'passed').length,
    failed: uploadJobs.filter((job) => job.state === 'failed').length,
    stale: uploadJobs.filter((job) => job.state === 'stale').length,
  };
  const failureTimes = [
    ...runs.filter((run) => run.state === 'failed').map((run) => countableDate(run.finishedAt) ?? countableDate(run.createdAt)),
    ...uploadJobs.filter((job) => job.state === 'failed' || job.state === 'stale').map((job) => countableDate(job.finishedAt) ?? countableDate(job.updatedAt) ?? countableDate(job.createdAt)),
  ].filter((value): value is number => value !== undefined).sort((left, right) => right - left);
  const failures = consolidationRuns.failed + uploadReviews.failed + uploadReviews.stale;
  const total = consolidationRuns.total + uploadReviews.total;
  const base = { consolidationRuns, uploadReviews, ...(failureTimes[0] === undefined ? {} : { latestFailureAt: new Date(failureTimes[0]).toISOString() }) };
  if (!configured) {
    return {
      state: 'unavailable',
      ...base,
      reason: 'Eve review is not configured for this company.',
    };
  }
  return {
    state: total === 0 ? 'empty' : failures > 0 ? 'attention' : 'current',
    ...base,
  };
}

function billingState(status: BillingStatus): OperationsBillingStatus['state'] {
  if (!status.enabled || status.mode === 'disabled') return 'disabled';
  if (!status.webhookVerification || (!status.checkout && !status.portal)) return 'unconfigured';
  return 'available';
}

function projectUsage(snapshot: UsageSnapshot): OperationsBillingUsage {
  return {
    periodStart: snapshot.usage.periodStart,
    periodEnd: snapshot.usage.periodEnd,
    updatedAt: snapshot.usage.updatedAt,
    seats: snapshot.usage.seats,
    storageBytes: snapshot.usage.storageBytes,
    scans: snapshot.usage.scans,
    eveCostCents: snapshot.usage.eveCostCents,
    limits: { ...snapshot.limits },
  };
}

async function billingStatus(
  options: Pick<OperationsStatusOptions, 'billing'>,
  organizationId: string,
): Promise<OperationsBillingStatus> {
  let status: BillingStatus;
  try {
    status = options.billing.status();
  } catch {
    return {
      state: 'unavailable',
      provider: null,
      mode: 'disabled',
      webhookVerification: false,
      checkout: false,
      portal: false,
      usageState: 'unavailable',
      usage: null,
      failureCount: null,
      failureState: 'unavailable',
      reason: 'Billing status is temporarily unavailable.',
    };
  }
  let usage: OperationsBillingUsage | null = null;
  let usageState: OperationsAvailability = 'unavailable';
  try {
    usage = projectUsage(await options.billing.usageSnapshot(organizationId));
    usageState = 'available';
  } catch {
    // A provider or billing repository failure must not prevent queue, scan,
    // and Eve status from being displayed. Keep this metric unavailable.
  }
  return {
    state: billingState(status),
    provider: status.provider,
    mode: status.mode,
    webhookVerification: status.webhookVerification,
    checkout: status.checkout,
    portal: status.portal,
    usageState,
    usage,
    failureCount: null,
    failureState: 'unavailable',
    reason: 'Billing failure history is not persisted by the current billing service.',
  };
}

async function authStatus(
  options: Pick<OperationsStatusOptions, 'operationsEvents'>,
  organizationId: string,
  nowMilliseconds: number,
): Promise<OperationsAuthStatus> {
  if (!options.operationsEvents) {
    return {
      state: 'unavailable',
      authenticationFailures: null,
      callbackFailures: null,
      membershipDenials: null,
      reason: 'Identity failure history is not configured on this deployment.',
    };
  }
  try {
    const summary = await options.operationsEvents.summarize(organizationId, nowMilliseconds);
    const hasFailures = summary.authenticationFailures.total > 0
      || summary.callbackFailures.total > 0
      || summary.membershipDenials.total > 0;
    return {
      state: hasFailures ? 'available' : 'empty',
      authenticationFailures: summary.authenticationFailures,
      callbackFailures: summary.callbackFailures,
      membershipDenials: summary.membershipDenials,
    };
  } catch {
    return {
      state: 'unavailable',
      authenticationFailures: null,
      callbackFailures: null,
      membershipDenials: null,
      reason: 'Identity failure history is temporarily unavailable.',
    };
  }
}

async function recordMembershipDenial(
  sink: IdentityOperationsEventSink,
  principal: NonNullable<Awaited<ReturnType<Authenticator['authenticate']>>>,
  organizationId: string,
): Promise<void> {
  const reasonCode: IdentityOperationsFailure['reasonCode'] = principal.organizationId === organizationId
    ? 'membership_role_denied'
    : 'tenant_mismatch';
  let context: Awaited<ReturnType<IdentityOperationsEventSink['trustedTenant']>> = null;
  try {
    context = await sink.trustedTenant(principal.organizationId, principal.subject);
  } catch {
    // A telemetry lookup failure must never change the authorization response.
  }
  if (context) {
    try {
      if (await sink.recordTenant(context, { kind: 'membership_denial', reasonCode })) return;
    } catch {
      // Fall through to an unattributed operator event. The membership was
      // not proven at the point the event could be persisted.
    }
  }
  // A principal without a live Better Auth membership cannot be attributed to
  // a company. Keep the denial global for operator diagnostics. This also
  // covers a stale context revoked between the two exact membership checks.
  try {
    await sink.recordGlobal({ kind: 'membership_denial', reasonCode: 'membership_missing' });
  } catch {
    // Operational visibility is best effort and remains outside auth control.
  }
}

function recordAuthenticationFailure(
  sink: IdentityOperationsEventSink | undefined,
  request: Request,
): Promise<void> {
  if (!sink) return Promise.resolve();
  return captureIdentityOperationsTask(request, () => sink.recordGlobal({
    kind: 'authentication_failure',
    reasonCode: 'authentication_rejected',
  }));
}

export async function buildOperationsStatus(
  options: Pick<OperationsStatusOptions, 'repository' | 'billing' | 'organizationId' | 'eveConfigured' | 'operationsEvents' | 'now'>,
): Promise<OperationsStatusResponse> {
  const organizationId = options.organizationId.trim();
  if (!organizationId) throw new Error('operations status organization is required');
  const nowMilliseconds = normalizedNow(options.now);
  const state = await options.repository.read(organizationId);
  const billing = await billingStatus(options, organizationId);
  const auth = await authStatus(options, organizationId, nowMilliseconds);
  return {
    protocolVersion: OPERATIONS_STATUS_PROTOCOL_VERSION,
    organizationId,
    generatedAt: isoAt(nowMilliseconds),
    queue: queueStatus(state, organizationId, nowMilliseconds),
    scans: scanStatus(state, organizationId, nowMilliseconds),
    auth,
    billing,
    eve: eveStatus(state, organizationId, options.eveConfigured === true),
  };
}

function forbidden(principal: NonNullable<Awaited<ReturnType<Authenticator['authenticate']>>>, organizationId: string): string | undefined {
  if (principal.organizationId !== organizationId) return 'The authenticated company cannot access this status.';
  if (!Array.isArray(principal.roles) || !principal.roles.some((role) => ADMIN_ROLES.has(role)) || principal.roles.includes('worker')) return 'Owner or admin access is required for company operations status.';
  // Legacy adapter principals without a scopes array predate scoped auth and
  // retain their role boundary. An explicit array opts into strict matching.
  if (principal.scopes !== undefined && (!Array.isArray(principal.scopes) || principal.scopes.some((scope) => typeof scope !== 'string'))) {
    return 'The principal scopes are invalid.';
  }
  if (principal.scopes !== undefined && !hasScope(principal, 'operations:read') && !hasScope(principal, 'registry:admin')) {
    return 'The principal lacks the required operations:read scope.';
  }
  const identity = (principal as { identity?: unknown }).identity;
  if (identity === 'worker') return 'Worker identity cannot access company operations status.';
  return undefined;
}

/**
 * Build the company-admin status endpoint without modifying the shared core
 * router. Return undefined for unrelated paths so existing routing continues.
 */
export function createOperationsStatusHandler(options: OperationsStatusOptions): OperationsStatusHandler {
  const organizationId = options.organizationId.trim();
  if (!organizationId) throw new Error('operations status organization is required');
  if (!options.repository || typeof options.repository.read !== 'function') throw new Error('operations status repository is required');
  if (!options.billing || typeof options.billing.status !== 'function' || typeof options.billing.usageSnapshot !== 'function') throw new Error('operations status billing service is required');
  if (typeof options.authenticate !== 'function') throw new Error('operations status authenticator is required');
  return async (request: Request): Promise<Response | undefined> => {
    if (safePath(request) !== OPERATIONS_STATUS_ROUTE_PATH) return undefined;
    if (request.method.toUpperCase() !== 'GET') return json({ code: 'METHOD_NOT_ALLOWED', message: 'Operations status only accepts GET.' }, 405);
    let principal: Awaited<ReturnType<Authenticator['authenticate']>>;
    try {
      principal = await options.authenticate(request);
    } catch {
      await recordAuthenticationFailure(options.operationsEvents, request);
      return json({ code: 'OPERATIONS_AUTH_UNAVAILABLE', message: 'Operations status authorization is temporarily unavailable.', retryable: true }, 503);
    }
    if (!principal) {
      await recordAuthenticationFailure(options.operationsEvents, request);
      return json({ code: 'UNAUTHENTICATED', message: 'Authentication is required.' }, 401);
    }
    const denial = forbidden(principal, organizationId);
    if (denial) {
      if (options.operationsEvents) {
        await captureIdentityOperationsTask(request, () => recordMembershipDenial(options.operationsEvents!, principal, organizationId));
      }
      return json({ code: 'OPERATIONS_FORBIDDEN', message: denial }, 403);
    }
    try {
      return json(await buildOperationsStatus(options));
    } catch {
      return json({ code: 'OPERATIONS_UNAVAILABLE', message: 'Company operations status is temporarily unavailable.', retryable: true }, 503);
    }
  };
}
