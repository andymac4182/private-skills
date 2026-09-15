import type { BuilderBffRuntime } from '../../../packages/core/src/builder.js';
import type { BoundEveTenantService } from '../../../packages/eve-tenant/src/index.js';

/** The only production origin permitted for the separately deployed builder. */
export const BUILDER_APP_ORIGIN = 'https://private-skills-builder.vercel.app';

const MAX_BUILDER_TOKEN_LENGTH = 16 * 1024;
export type BuilderRuntimeEnvironment = Record<string, string | undefined>;

export interface BuilderRuntimeOptions {
  /** Tenant-bound credential for a non-default company. */
  readonly tenantService?: BoundEveTenantService;
}

/**
 * Resolve the registry's server-only connection to the builder app.
 *
 * The bridge is deliberately absent until all three values are valid.  The
 * core handler turns an absent bridge into its honest disabled availability
 * response, so a partial deployment cannot accidentally send a credential to
 * an arbitrary URL or claim that the builder is ready.
 */
export function createBuilderBffRuntime(
  env: BuilderRuntimeEnvironment,
  options: BuilderRuntimeOptions = {},
): BuilderBffRuntime | undefined {
  const appOrigin = validBuilderAppOrigin(env.PSKILLS_BUILDER_APP_ORIGIN, env);
  const serviceToken = boundedSecret(env.PSKILLS_BUILDER_SERVICE_TOKEN);
  const eveToken = boundedSecret(env.PSKILLS_BUILDER_EVE_API_TOKEN);
  if (appOrigin === undefined) return undefined;
  if (options.tenantService) return { appOrigin, tenantService: options.tenantService };
  if (serviceToken === undefined || eveToken === undefined) {
    return undefined;
  }
  return { appOrigin, serviceToken, eveToken };
}

function boundedSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized.length > MAX_BUILDER_TOKEN_LENGTH ||
    /\s/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function validBuilderAppOrigin(
  value: string | undefined,
  env: BuilderRuntimeEnvironment,
): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0 || /\s/u.test(normalized)) return undefined;
  // Reject even an empty query or fragment (`?`/`#`), which URL normalisation
  // would otherwise erase. Credentials and path components are rejected below.
  if (/[?#]/u.test(normalized)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return undefined;
  }

  if (isProduction(env)) {
    return parsed.origin === BUILDER_APP_ORIGIN ? BUILDER_APP_ORIGIN : undefined;
  }
  // Local development/test may point at an explicitly deployed HTTPS fixture,
  // while loopback HTTP remains intentionally unavailable to this bridge.
  return parsed.origin;
}

function isProduction(env: BuilderRuntimeEnvironment): boolean {
  return env.PSKILLS_ENVIRONMENT === 'production' ||
    env.NODE_ENV === 'production' ||
    env.VERCEL_ENV === 'production';
}
