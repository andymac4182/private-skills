import {
  BILLING_PROTOCOL_VERSION,
  type PlanCatalog,
  type PlanDefinition,
  type PlanId,
  type PlanLimits,
  type PublicPlanMetadata,
} from './types.js';

const GIB = 1024 ** 3;

/**
 * Provisional finite defaults used by the local/test contract.  Product and
 * marketing may replace these through explicit configuration before launch.
 */
export const DEFAULT_PLAN_DEFINITIONS: readonly PlanDefinition[] = Object.freeze([
  {
    id: 'free' as PlanId,
    label: 'Free',
    description: 'A bounded evaluation workspace for trying the registry.',
    limits: { seats: 3, storageBytes: GIB, scansPerMonth: 50, eveCostCentsPerMonth: 50 },
    public: true,
  },
  {
    id: 'team' as PlanId,
    label: 'Team',
    description: 'Shared private skill management for a small team (provisional).',
    limits: { seats: 10, storageBytes: 10 * GIB, scansPerMonth: 750, eveCostCentsPerMonth: 500 },
    public: true,
  },
  {
    id: 'business' as PlanId,
    label: 'Business',
    description: 'Higher bounded capacity for governed organization use (provisional Team Plus anchor).',
    limits: { seats: 25, storageBytes: 50 * GIB, scansPerMonth: 4_000, eveCostCentsPerMonth: 2_500 },
    public: true,
  },
].map((plan) => Object.freeze({ ...plan, limits: Object.freeze({ ...plan.limits }) })));

const MAX_LIMIT = Number.MAX_SAFE_INTEGER;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/u;

export interface PlanCatalogOptions {
  plans?: readonly PlanDefinition[];
  priceIds?: Readonly<Record<string, string | undefined>>;
  env?: Readonly<Record<string, string | undefined>>;
}

function boundedText(value: unknown, field: string, max = 4_000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value.trim();
}

export function validatePlanLimits(limits: PlanLimits): PlanLimits {
  if (!limits || typeof limits !== 'object') throw new Error('plan limits are required');
  for (const [field, value] of Object.entries(limits)) {
    if (!['seats', 'storageBytes', 'scansPerMonth', 'eveCostCentsPerMonth'].includes(field)) throw new Error(`plan limit ${field} is unsupported`);
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIMIT) throw new Error(`plan limit ${field} must be a finite positive integer`);
  }
  const required = ['seats', 'storageBytes', 'scansPerMonth', 'eveCostCentsPerMonth'] as const;
  for (const field of required) {
    if (!(field in limits)) throw new Error(`plan limit ${field} is required`);
  }
  return { ...limits };
}

export function validatePlanDefinition(definition: PlanDefinition): PlanDefinition {
  if (!definition || typeof definition !== 'object') throw new Error('plan definition is required');
  const id = boundedText(definition.id, 'plan id', 64);
  if (!PLAN_ID.test(id)) throw new Error('plan id must use lowercase letters, digits, underscores, or hyphens');
  const label = boundedText(definition.label, 'plan label', 128);
  const description = boundedText(definition.description, 'plan description', 4_000);
  const priceId = definition.priceId === undefined ? undefined : boundedText(definition.priceId, 'plan priceId', 256);
  if (typeof definition.public !== 'boolean') throw new Error('plan public flag is invalid');
  return {
    id: id as PlanId,
    label,
    description,
    limits: validatePlanLimits(definition.limits),
    ...(priceId === undefined ? {} : { priceId }),
    public: definition.public,
  };
}

function firstEnv(env: Readonly<Record<string, string | undefined>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** Read only public, non-secret Stripe Price identifiers from deployment configuration. */
export function priceIdsFromEnv(env: Readonly<Record<string, string | undefined>> = {}): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (const definition of DEFAULT_PLAN_DEFINITIONS) {
    if (definition.id === 'free') continue;
    const upper = definition.id.toUpperCase().replaceAll('-', '_');
    result[definition.id] = firstEnv(env, [
      `PSKILLS_BILLING_PRICE_${upper}`,
      `PSKILLS_BILLING_PRICE_${upper}_MONTHLY`,
      `PSKILLS_STRIPE_PRICE_${upper}`,
      `PSKILLS_STRIPE_PRICE_${upper}_MONTHLY`,
      `STRIPE_PRICE_${upper}`,
      `STRIPE_PRICE_${upper}_MONTHLY`,
    ]);
  }
  return result;
}

function cloneDefinition(definition: PlanDefinition): PlanDefinition {
  return { ...definition, limits: { ...definition.limits } };
}

export function createPlanCatalog(options: PlanCatalogOptions = {}): PlanCatalog {
  const supplied = options.plans ?? DEFAULT_PLAN_DEFINITIONS;
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.length > 32) throw new Error('at least one bounded plan is required');
  const priceIds = { ...priceIdsFromEnv(options.env ?? {}), ...(options.priceIds ?? {}) };
  const plans = supplied.map((definition) => {
    const normalized = validatePlanDefinition(definition);
    const configuredPrice = priceIds[normalized.id];
    if (normalized.priceId !== undefined && configuredPrice !== undefined && normalized.priceId !== configuredPrice) {
      throw new Error(`plan ${normalized.id} has conflicting price mappings`);
    }
    const priceId = normalized.priceId ?? (configuredPrice === undefined ? undefined : boundedText(configuredPrice, `price id for ${normalized.id}`, 256));
    return { ...normalized, ...(priceId === undefined ? {} : { priceId }) };
  });
  const planIds = new Set(plans.map((plan) => plan.id));
  for (const key of Object.keys(options.priceIds ?? {})) {
    if (!planIds.has(key as PlanId)) throw new Error(`price mapping ${key} does not reference a configured plan`);
  }
  const ids = new Set<string>();
  for (const plan of plans) {
    if (ids.has(plan.id)) throw new Error(`plan ${plan.id} is duplicated`);
    ids.add(plan.id);
  }
  const configuredPrices = new Set<string>();
  for (const plan of plans) {
    if (plan.priceId === undefined) continue;
    if (configuredPrices.has(plan.priceId)) throw new Error(`plan price ${plan.priceId} is duplicated`);
    configuredPrices.add(plan.priceId);
  }
  const frozen = plans.map((plan) => Object.freeze({ ...plan, limits: Object.freeze({ ...plan.limits }) }));
  return {
    get(id: PlanId): PlanDefinition | undefined {
      const plan = frozen.find((candidate) => candidate.id === id);
      return plan ? cloneDefinition(plan) : undefined;
    },
    byPriceId(priceId: string): PlanDefinition | undefined {
      const plan = frozen.find((candidate) => candidate.priceId === priceId);
      return plan ? cloneDefinition(plan) : undefined;
    },
    all(): readonly PlanDefinition[] {
      return frozen.map(cloneDefinition);
    },
    publicMetadata(): readonly PublicPlanMetadata[] {
      return frozen.filter((plan) => plan.public).map((plan) => ({
        protocolVersion: BILLING_PROTOCOL_VERSION,
        id: plan.id,
        label: plan.label,
        description: plan.description,
        limits: { ...plan.limits },
        priceConfigured: plan.priceId !== undefined,
        checkoutAvailable: plan.id !== 'free' && plan.priceId !== undefined,
      }));
    },
  };
}

export function planForPriceId(catalog: PlanCatalog, priceId: string): PlanDefinition | undefined {
  if (typeof priceId !== 'string' || priceId.trim() === '') return undefined;
  return catalog.byPriceId(priceId.trim());
}
