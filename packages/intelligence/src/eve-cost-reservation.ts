import type { EveTenantService } from '../../eve-tenant/src/index.js';

/**
 * The host-owned accounting boundary for a tenant-scoped Eve invocation.
 * Reservation identifiers are server bookkeeping and must never be sent to
 * Eve as prompt or delegation data.
 */
export interface EveTenantCostReservation {
  reserve(input: {
    tenantId: string;
    service: EveTenantService;
    operation: string;
    idempotencyKey: string;
  }): Promise<{ reservationId: string }>;
  settle(input: {
    reservationId: string;
    /** Optional measured cost; an adapter may use its bounded estimate. */
    actualCostCents?: number;
  }): Promise<void>;
  release(input: { reservationId: string }): Promise<void>;
  /**
   * Reconcile a completed invocation after the provider reports its measured
   * token cost. This is optional so a host can begin with estimate-only
   * accounting and add a durable usage callback later.
   */
  reconcile?(input: {
    reservationId: string;
    actualCostCents: number;
    operationKey?: string;
  }): Promise<void>;
}

/** A bounded failure category safe to use in runtime status responses. */
export type EveCostFailureCode =
  | 'BILLING_DISABLED'
  | 'BILLING_UNAVAILABLE'
  | 'COST_RESERVATION_FAILED'
  | 'COST_RECONCILIATION_REQUIRED'
  | 'COST_RESERVATION_UNKNOWN';

/**
 * Errors from the cost boundary intentionally carry no billing provider
 * payload. `uncertain` means a provider session may already exist and the
 * reservation must remain held for reconciliation/retry.
 */
export class EveCostReservationError extends Error {
  readonly code: EveCostFailureCode;
  readonly uncertain: boolean;
  readonly retryable: boolean;
  readonly reservationId?: string;

  constructor(
    code: EveCostFailureCode,
    message: string,
    options: { uncertain?: boolean; retryable?: boolean; reservationId?: string } = {},
  ) {
    super(message);
    this.name = 'EveCostReservationError';
    this.code = code;
    this.uncertain = options.uncertain ?? false;
    this.retryable = options.retryable ?? this.uncertain;
    this.reservationId = options.reservationId;
  }
}

/**
 * Return the UTC key shared by the reviewer schedule, registry review claim,
 * and billing reservation. The clock is injectable for deterministic tests.
 */
export function dailyReviewIdempotencyKey(now: Date = new Date()): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Review clock is invalid');
  }
  return `common-skill-review:${now.toISOString().slice(0, 10)}`;
}

/** A safe classification for an Eve start failure. */
export function isUncertainEveStartFailure(error: unknown): boolean {
  if (error instanceof EveCostReservationError) return error.uncertain;
  if (!error || typeof error !== 'object') return true;
  const status = (error as { status?: unknown }).status;
  // A response status means the server definitely rejected the create call
  // for normal client errors. Network/5xx/timeout failures leave the outcome
  // unknown because the remote session may have been committed first.
  if (typeof status === 'number' && Number.isInteger(status)) {
    return status >= 500 || status === 408 || status === 409 || status === 425 || status === 429;
  }
  return true;
}

/**
 * Run one host action under a pre-reserved Eve budget. The helper centralizes
 * the failure rule so every caller reserves before opening a provider
 * session, releases known failures, and retains uncertain reservations.
 */
export async function runWithEveCostReservation<T>(input: {
  reservation: EveTenantCostReservation;
  tenantId: string;
  service: EveTenantService;
  operation: string;
  idempotencyKey: string;
  action: () => Promise<T>;
  /** Measured provider cost, when the action has one. */
  actualCostCents?: (result: T) => number | undefined;
}): Promise<T> {
  const held = await input.reservation.reserve({
    tenantId: input.tenantId,
    service: input.service,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
  });
  const reservationId = held.reservationId;
  if (typeof reservationId !== 'string' || reservationId.trim() === '') {
    throw new EveCostReservationError('COST_RESERVATION_FAILED', 'Eve cost reservation is invalid');
  }
  let started = false;
  try {
    const result = await input.action();
    started = true;
    const actual = input.actualCostCents?.(result);
    await input.reservation.settle({
      reservationId,
      ...(actual === undefined ? {} : { actualCostCents: actual }),
    });
    return result;
  } catch (error) {
    // Once the provider call has returned, a session exists even if billing
    // settlement failed. Keep the reservation held for a later reconciliation.
    if (started || isUncertainEveStartFailure(error)) {
      if (error instanceof EveCostReservationError && error.uncertain) throw error;
      throw new EveCostReservationError(
        'COST_RECONCILIATION_REQUIRED',
        'Eve cost settlement requires reconciliation',
        { uncertain: true, reservationId },
      );
    }
    try {
      await input.reservation.release({ reservationId });
    } catch {
      // A failed release is itself uncertain: the reservation may still be
      // counted and must not be silently retried as free work.
      throw new EveCostReservationError(
        'COST_RECONCILIATION_REQUIRED',
        'Eve cost release requires reconciliation',
        { uncertain: true, reservationId },
      );
    }
    throw error;
  }
}
