import type { EveTenantService } from '../../../packages/eve-tenant/src/index.js';
import {
  EveCostReservationError,
  type EveTenantCostReservation,
} from '../../../packages/intelligence/src/eve-cost-reservation.js';

/** The review agent's documented per-session upper bound in integer cents. */
export const DEFAULT_EVE_REVIEW_ESTIMATE_CENTS = 50;
const MAX_EVE_COST_CENTS = 10_000;
const MAX_OPERATION_LENGTH = 256;
const MAX_RESERVATIONS = 4_096;
const EVE_SERVICES = new Set<EveTenantService>([
  'upload-reviewer',
  'skill-builder',
  'consolidation-reviewer',
]);

/**
 * Minimal billing shape accepted by the host adapter. Keeping this
 * structural lets the billing package and the portable contracts evolve
 * independently while preserving the reserve/reconcile transaction.
 */
export interface EveBillingUsageAdmission {
  status(): { enabled: boolean };
  reserveUsage(
    organizationId: string,
    delta: { eveCostCents: number },
    operationKey: string,
  ): Promise<unknown>;
  reconcileUsage(
    organizationId: string,
    reservationKey: string,
    actual: { eveCostCents: number },
    operationKey: string,
    reservationGeneration?: number,
  ): Promise<unknown>;
  /** Resolve a retained usage operation after an adapter restart or eviction. */
  findUsageOperation(operationKey: string): Promise<{
    organizationId: unknown;
    operationKey: unknown;
    delta: unknown;
    reservationGeneration?: unknown;
  } | undefined>;
}

export interface BillingEveCostReservationOptions {
  /** Bounded estimate held before a provider session is opened. */
  estimateCents?: number;
  /** Maximum number of reservation records retained in this process. */
  maxInMemoryReservations?: number;
}

interface ReservationInput {
  tenantId: string;
  service: EveTenantService;
  operation: string;
  idempotencyKey: string;
}

interface ReservationRecord {
  tenantId: string;
  reservationId: string;
  reservationGeneration: number;
  estimateCents: number;
}

/**
 * Bind Eve accounting to the server-owned billing service. The returned
 * adapter never accepts a browser-supplied amount or tenant; callers provide
 * both from the verified tenant context and the fixed operation.
 */
export function createBillingEveCostReservation(
  billing: EveBillingUsageAdmission,
  options: BillingEveCostReservationOptions = {},
): EveTenantCostReservation {
  const estimateCents = boundedCost(options.estimateCents ?? DEFAULT_EVE_REVIEW_ESTIMATE_CENTS, 'Eve cost estimate');
  const maxReservations = boundedReservationLimit(options.maxInMemoryReservations);
  const reservations = new Map<string, ReservationRecord>();

  const remember = (record: ReservationRecord): void => {
    const existing = reservations.get(record.reservationId);
    // Concurrent retries can resolve out of order. Never let an older
    // reserve response replace the newer lifecycle in the local handoff map.
    if (existing && existing.reservationGeneration > record.reservationGeneration) return;
    reservations.delete(record.reservationId);
    reservations.set(record.reservationId, record);
    while (reservations.size > maxReservations) {
      const oldest = reservations.keys().next().value;
      if (oldest === undefined) break;
      reservations.delete(oldest);
    }
  };

  const lookup = async (reservationId: string): Promise<ReservationRecord> => {
    const normalized = boundedOperation(reservationId, 'reservationId');
    const record = reservations.get(normalized);
    if (!record) {
      let durable: Awaited<ReturnType<EveBillingUsageAdmission['findUsageOperation']>>;
      try {
        durable = await billing.findUsageOperation(normalized);
      } catch {
        throw new EveCostReservationError(
          'BILLING_UNAVAILABLE',
          'Billing reservation lookup is temporarily unavailable',
          { uncertain: true, retryable: true, reservationId: normalized },
        );
      }
      if (!durable || durable.operationKey !== normalized) {
        throw new EveCostReservationError(
          'COST_RESERVATION_UNKNOWN',
          'Eve cost reservation is unavailable for reconciliation',
          { retryable: false, reservationId: normalized },
        );
      }
      const tenantId = normalizedOperation(durable.organizationId);
      const durableEstimate = eveReservationEstimate(durable.delta);
      if (tenantId === undefined || durableEstimate === undefined) {
        throw new EveCostReservationError(
          'COST_RESERVATION_UNKNOWN',
          'Eve cost reservation record is invalid for reconciliation',
          { retryable: false, reservationId: normalized },
        );
      }
      const recovered: ReservationRecord = {
        tenantId,
        reservationId: normalized,
        // Rows written before lifecycle fencing are generation 1. Keep the
        // caller's generation separate below: a delayed callback may carry
        // G1 while the durable row has already been reopened as G2.
        reservationGeneration: eveReservationGeneration(durable.reservationGeneration),
        estimateCents: durableEstimate,
      };
      remember(recovered);
      return recovered;
    }
    // Touch the record so frequently reconciled rows remain available within
    // the bounded in-process handoff window.
    remember(record);
    return record;
  };

  const reserve: EveTenantCostReservation['reserve'] = async (input) => {
    const normalized = normalizeInput(input);
    let status: { enabled: boolean };
    try {
      status = billing.status();
    } catch {
      throw new EveCostReservationError(
        'BILLING_UNAVAILABLE',
        'Billing is temporarily unavailable for Eve work',
        { retryable: true },
      );
    }
    if (!status || status.enabled !== true) {
      throw new EveCostReservationError(
        'BILLING_DISABLED',
        'Billing must be enabled before Eve work can start',
        { retryable: false },
      );
    }

    const operationKey = await usageOperationKey(normalized, 'reserve');
    let result: unknown;
    try {
      result = await billing.reserveUsage(
        normalized.tenantId,
        { eveCostCents: estimateCents },
        operationKey,
      );
    } catch (error) {
      throw billingFailure(error, 'Eve cost reservation failed');
    }
    const reservationId = reservationIdFromResult(result, operationKey);
    const reservationGeneration = reservationGenerationFromResult(result);
    remember({ tenantId: normalized.tenantId, reservationId, reservationGeneration, estimateCents });
    return { reservationId, reservationGeneration };
  };

  const settle: EveTenantCostReservation['settle'] = async ({ reservationId, reservationGeneration, actualCostCents }) => {
    const generation = boundedReservationGeneration(reservationGeneration);
    const record = await lookup(reservationId);
    const actual = boundedCost(actualCostCents ?? record.estimateCents, 'Eve actual cost');
    await reconcileRecord(record, actual, 'settle', generation);
  };

  const release: EveTenantCostReservation['release'] = async ({ reservationId, reservationGeneration }) => {
    const generation = boundedReservationGeneration(reservationGeneration);
    const record = await lookup(reservationId);
    await reconcileRecord(record, 0, 'release', generation);
  };

  const reconcile: NonNullable<EveTenantCostReservation['reconcile']> = async ({
    reservationId,
    actualCostCents,
    operationKey,
    reservationGeneration,
  }) => {
    const generation = boundedReservationGeneration(reservationGeneration);
    const record = await lookup(reservationId);
    const actual = boundedCost(actualCostCents, 'Eve actual cost');
    await reconcileRecord(record, actual, operationKey === undefined ? 'reconcile' : boundedOperation(operationKey, 'operationKey'), generation);
  };

  async function reconcileRecord(record: ReservationRecord, actual: number, phase: string, reservationGeneration: number): Promise<void> {
    const operationKey = await reconciliationOperationKey(record.reservationId, reservationGeneration, phase);
    try {
      await billing.reconcileUsage(
        record.tenantId,
        record.reservationId,
        { eveCostCents: actual },
        operationKey,
        reservationGeneration,
      );
    } catch {
      // A reconciliation response can be lost after the correction commits;
      // retaining this as uncertain prevents a caller from silently starting
      // an unaccounted session. The deterministic operation key makes a retry
      // idempotent in the billing repository.
      throw new EveCostReservationError(
        'COST_RECONCILIATION_REQUIRED',
        'Eve cost reconciliation requires retry',
        { uncertain: true, reservationId: record.reservationId, reservationGeneration },
      );
    }
  }

  return { reserve, settle, release, reconcile };
}

function normalizeInput(input: {
  tenantId: string;
  service: EveTenantService;
  operation: string;
  idempotencyKey: string;
}): ReservationInput {
  if (!input || typeof input !== 'object') throw new EveCostReservationError('COST_RESERVATION_FAILED', 'Eve cost input is invalid');
  const tenantId = boundedOperation(input.tenantId, 'tenantId');
  if (!EVE_SERVICES.has(input.service)) throw new EveCostReservationError('COST_RESERVATION_FAILED', 'Eve service is invalid');
  return {
    tenantId,
    service: input.service,
    operation: boundedOperation(input.operation, 'operation'),
    idempotencyKey: boundedOperation(input.idempotencyKey, 'idempotencyKey'),
  };
}

function boundedOperation(value: unknown, field: string): string {
  const normalized = normalizedOperation(value);
  if (normalized === undefined) {
    throw new EveCostReservationError('COST_RESERVATION_FAILED', `Eve ${field} is invalid`);
  }
  return normalized;
}

function normalizedOperation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_OPERATION_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  return normalized;
}

function boundedCost(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_EVE_COST_CENTS) {
    throw new EveCostReservationError('COST_RESERVATION_FAILED', `${field} is invalid`);
  }
  return value as number;
}

function boundedReservationLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RESERVATIONS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RESERVATIONS) {
    throw new EveCostReservationError('COST_RESERVATION_FAILED', 'Eve reservation memory limit is invalid');
  }
  return value;
}

function eveReservationEstimate(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const delta = value as Record<string, unknown>;
  for (const [metric, amount] of Object.entries(delta)) {
    if (metric !== 'eveCostCents' || !Number.isSafeInteger(amount) || (amount as number) <= 0 || (amount as number) > MAX_EVE_COST_CENTS) return undefined;
  }
  const estimate = delta.eveCostCents;
  return Number.isSafeInteger(estimate) && (estimate as number) > 0 && (estimate as number) <= MAX_EVE_COST_CENTS
    ? estimate as number
    : undefined;
}

function eveReservationGeneration(value: unknown): number {
  // The billing repository treats pre-fencing rows as generation 1. Preserve
  // that compatibility while rejecting malformed generation values.
  return value === undefined ? 1 : boundedReservationGeneration(value);
}

function boundedReservationGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new EveCostReservationError('COST_RESERVATION_UNKNOWN', 'Eve cost reservation generation is invalid', { retryable: false });
  }
  return value as number;
}

function reservationGenerationFromResult(result: unknown): number {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return eveReservationGeneration((result as { reservationGeneration?: unknown }).reservationGeneration);
  }
  // Older billing adapters returned only the operation key; their durable
  // rows are generation 1 and remain safe to reconcile with that identity.
  return 1;
}

function reservationIdFromResult(result: unknown, fallback: string): string {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const candidate = (result as { operationKey?: unknown; reservationId?: unknown }).operationKey
      ?? (result as { reservationId?: unknown }).reservationId;
    if (candidate !== undefined) return boundedOperation(candidate, 'reservationId');
  }
  return fallback;
}

async function usageOperationKey(record: {
  tenantId: string;
  service: EveTenantService;
  operation: string;
  idempotencyKey: string;
}, phase: string): Promise<string> {
  const normalizedPhase = boundedOperation(phase, 'phase');
  const material = JSON.stringify([
    'private-skills-eve-usage-v1',
    record.tenantId,
    record.service,
    record.operation,
    record.idempotencyKey,
    normalizedPhase,
  ]);
  const digest = await sha256Hex(material);
  // Keep a short tenant hint for operations inspection while hashing the
  // complete identity to stay within Billing's 256-byte key limit.
  const tenantHint = record.tenantId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 48) || 'tenant';
  return `private-skills:eve:${tenantHint}:${digest}:${normalizedPhase.slice(0, 24)}`.slice(0, MAX_OPERATION_LENGTH);
}

/**
 * Reconciliation keys depend on the durable reservation identity, exact
 * lifecycle generation, and a bounded phase. This lets a fresh process settle
 * or release a reservation without retaining the original request payload,
 * while ensuring a reopened key receives a distinct correction operation.
 */
async function reconciliationOperationKey(reservationId: string, reservationGeneration: number, phase: string): Promise<string> {
  const normalizedReservationId = boundedOperation(reservationId, 'reservationId');
  const normalizedGeneration = boundedReservationGeneration(reservationGeneration);
  const normalizedPhase = boundedOperation(phase, 'phase');
  const material = JSON.stringify([
    'private-skills-eve-reconcile-v1',
    normalizedReservationId,
    normalizedGeneration,
    normalizedPhase,
  ]);
  const digest = await sha256Hex(material);
  return `private-skills:eve-reconcile:${digest}:${normalizedPhase.slice(0, 24)}`.slice(0, MAX_OPERATION_LENGTH);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function billingFailure(error: unknown, message: string): EveCostReservationError {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  const retryable = typeof status === 'number' ? status >= 500 || status === 408 || status === 429 : true;
  return new EveCostReservationError(
    retryable ? 'BILLING_UNAVAILABLE' : 'COST_RESERVATION_FAILED',
    message,
    { retryable, uncertain: retryable },
  );
}
