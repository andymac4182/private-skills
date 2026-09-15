import type { StateRepository } from '../../../packages/contracts/src/index.js';
import { createReviewTrigger } from '../../../packages/intelligence/src/reviewer-client.js';
import type { TenantReviewTarget, TenantReviewDispatchResult } from './tenant-review-dispatch.js';
import {
  createTenantReviewCronHandler,
  dispatchTenantDailyReviews,
  StateRepositoryTenantReviewDispatchLedger,
} from './tenant-review-dispatch.js';
import {
  createBillingEveCostReservation,
  type EveBillingUsageAdmission,
} from './eve-cost-reservation.js';
import type { EveTenantCostReservation } from '../../../packages/intelligence/src/eve-cost-reservation.js';
import type { EveTenantHostRuntime } from './eve-tenant-runtime.js';
import { assertVercelRuntimeDuration } from './vercel-function-budget.js';

export interface TenantReviewRuntimeOptions {
  env: Record<string, string | undefined>;
  repository: StateRepository;
  billing: EveBillingUsageAdmission;
  eveTenant: EveTenantHostRuntime;
  /** Explicit Better Auth organization enumeration owned by the host. */
  listTenants: () => Promise<readonly TenantReviewTarget[]>;
  maxTenants?: number;
  leaseMs?: number;
  maxDurationMs?: number;
  now?: () => Date;
  /** Reuse the host adapter for interactive tenant review runs as well. */
  costReservation?: EveTenantCostReservation;
}

export interface TenantReviewOrganizationPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: readonly T[] }>;
}

export interface PostgresTenantReviewTargetListerOptions {
  schemaName?: string;
  maxTenants?: number;
  /** Optional server-side provisioning check; never receives request data. */
  isProvisioned?: (organizationId: string) => Promise<boolean> | boolean;
}

export interface PostgresTenantOrganizationCatalog {
  /** Return a keyset page from the server-owned Better Auth organization table. */
  listOrganizations(input: {
    after: string | null;
    limit: number;
    signal?: AbortSignal;
  }): Promise<readonly string[]>;
}

export type PostgresTenantReviewTargetLister = (() => Promise<readonly TenantReviewTarget[]>) & PostgresTenantOrganizationCatalog;

/**
 * Enumerate Better Auth organizations from the shared PostgreSQL pool. This
 * is intentionally an explicit host helper: it never infers a company from a
 * user's email/domain and never returns credentials or candidate content.
 */
export function createPostgresTenantReviewTargetLister(
  pool: TenantReviewOrganizationPool,
  options: PostgresTenantReviewTargetListerOptions = {},
): PostgresTenantReviewTargetLister {
  const table = qualifiedOrganizationTable(options.schemaName);
  const maxTenants = boundedTenantListLimit(options.maxTenants);
  const catalog: PostgresTenantOrganizationCatalog = {
    listOrganizations: async (input) => {
      if (input === undefined || input === null || typeof input !== 'object') throw new Error('Tenant organization page is invalid');
      const after = input.after;
      if (after !== null && typeof after !== 'string') throw new Error('Tenant organization cursor is invalid');
      if (after !== null && normalizeTenantOrganizationId(after) !== after) throw new Error('Tenant organization cursor is invalid');
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 256) throw new Error('Tenant organization page size is invalid');
      const result = await pool.query<{ id?: unknown }>(
        `SELECT "id" FROM ${table} WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" ASC LIMIT $2`,
        [after, input.limit],
      );
      const organizations: string[] = [];
      for (const row of result.rows) {
        if (!row || typeof row.id !== 'string') throw new Error('Better Auth organization identity is invalid');
        organizations.push(normalizeTenantOrganizationId(row.id));
      }
      return organizations;
    },
  };
  const listTenants = async () => {
    const result = await pool.query<{ id?: unknown }>(
      `SELECT "id" FROM ${table} ORDER BY "id" ASC LIMIT $1`,
      [maxTenants + 1],
    );
    if (result.rows.length > maxTenants) throw new Error('Tenant review target count exceeds the configured bound');
    const targets: TenantReviewTarget[] = [];
    for (const row of result.rows) {
      if (!row || typeof row.id !== 'string' || row.id.trim() === '' || row.id.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.id)) {
        throw new Error('Better Auth organization identity is invalid');
      }
      const organizationId = row.id.trim();
      const provisioned = options.isProvisioned === undefined
        ? true
        : await options.isProvisioned(organizationId);
      targets.push({ organizationId, provisioned: provisioned === true });
    }
    return targets;
  };
  return Object.assign(listTenants, catalog);
}

/**
 * Compose the internal cron route only when the host has tenant-bound Eve
 * credentials, an explicit tenant enumerator, and a CRON_SECRET. The legacy
 * static reviewer token is never used by this path.
 */
export function createTenantReviewRuntime(options: TenantReviewRuntimeOptions): ((request: Request) => Promise<Response | undefined>) | undefined {
  const cronSecret = options.env.CRON_SECRET?.trim();
  if (!cronSecret) return undefined;
  const configuredMaxDurationMs = options.maxDurationMs ?? parseOptionalDuration(options.env.PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS);
  const maxDurationMs = assertVercelRuntimeDuration(
    configuredMaxDurationMs,
    600_000,
    'Tenant review dispatch max duration',
  );
  const costReservation = options.costReservation ?? createTenantReviewCostReservation(options.env, options.billing);
  const ledger = new StateRepositoryTenantReviewDispatchLedger(options.repository);
  const dispatch = async (): Promise<TenantReviewDispatchResult> => dispatchTenantDailyReviews({
    listTenants: options.listTenants,
    triggerForTenant: (organizationId) => {
      const tenantService = options.eveTenant.providerFor(organizationId, 'consolidation-reviewer');
      return createReviewTrigger(
        { ...options.env, PSKILLS_EVE_API_TOKEN: undefined },
        {
          tenantService,
          costReservation,
          ...(options.now === undefined ? {} : { now: options.now }),
        },
      );
    },
    ledger,
    ...(options.maxTenants === undefined ? {} : { maxTenants: options.maxTenants }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return createTenantReviewCronHandler({ dispatch, cronSecret });
}

/** Construct the one host-owned Eve billing adapter shared by all review paths. */
export function createTenantReviewCostReservation(
  env: Record<string, string | undefined>,
  billing: EveBillingUsageAdmission,
): EveTenantCostReservation {
  return createBillingEveCostReservation(billing, {
    ...(env.PSKILLS_EVE_REVIEW_ESTIMATE_CENTS === undefined
      ? {}
      : { estimateCents: parseEstimate(env.PSKILLS_EVE_REVIEW_ESTIMATE_CENTS) }),
  });
}

function parseEstimate(value: string): number {
  if (!/^\d+$/u.test(value.trim())) throw new Error('PSKILLS_EVE_REVIEW_ESTIMATE_CENTS is invalid');
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 10_000) throw new Error('PSKILLS_EVE_REVIEW_ESTIMATE_CENTS is invalid');
  return parsed;
}

function parseOptionalDuration(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^\d+$/u.test(value.trim())) throw new Error('PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS is invalid');
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS is invalid');
  return parsed;
}

function qualifiedOrganizationTable(schemaName: string | undefined): string {
  if (schemaName === undefined || schemaName.trim() === '') return '"organization"';
  const schema = schemaName.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema)) throw new Error('Better Auth schema name is invalid');
  return `"${schema}"."organization"`;
}

function boundedTenantListLimit(value: number | undefined): number {
  if (value === undefined) return 4_096;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 4_096) throw new Error('Tenant review target limit is invalid');
  return value;
}

function normalizeTenantOrganizationId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error('Better Auth organization identity is invalid');
  return normalized;
}
