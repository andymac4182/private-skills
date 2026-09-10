import type { SkillsTokenProvider } from './types.js';

/**
 * The stable error used when a directory credential is not available.  Keep
 * this message free of endpoint and credential values because it can cross a
 * request boundary through a sanitized directory error.
 */
export const SKILLS_DIRECTORY_AUTH_UNAVAILABLE = 'skills.sh directory authentication is not configured';

/** The only origin that may use the Vercel OIDC provider. */
export const SKILLS_DIRECTORY_OFFICIAL_BASE_URL = 'https://skills.sh' as const;

export const SKILLS_DIRECTORY_GATEWAY_URL_ENV = 'PSKILLS_DIRECTORY_GATEWAY_URL' as const;
export const SKILLS_DIRECTORY_GATEWAY_TOKEN_ENV = 'PSKILLS_DIRECTORY_GATEWAY_TOKEN' as const;
export const SKILLS_DIRECTORY_GATEWAYS_JSON_ENV = 'PSKILLS_DIRECTORY_GATEWAYS_JSON' as const;
export const SKILLS_DIRECTORY_ENABLED_ENV = 'PSKILLS_DIRECTORY_ENABLED' as const;

const MAX_GATEWAY_TOKEN_BYTES = 4_096;
export const MAX_SKILLS_DIRECTORY_GATEWAYS = 16 as const;
export const MAX_SKILLS_DIRECTORY_GATEWAYS_JSON_BYTES = 32_768 as const;

export type SkillsDirectoryRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * A credential-bound gateway seam shared by Node runtimes and hosted workers.
 * The token is intentionally available only through a request callback; it
 * is never part of the public record or a serialized configuration value.
 */
export interface SkillsShGatewayCredential {
  readonly baseUrl: string;
  readonly getToken: (signal?: AbortSignal) => Promise<string>;
}

export interface SkillsShGatewayCredentialConfig {
  readonly baseUrl: string;
  readonly token: string;
}

/** One operator-owned environment binding in PSKILLS_DIRECTORY_GATEWAYS_JSON. */
export interface SkillsDirectoryGatewayProfile {
  readonly baseUrl: string;
  readonly tokenEnv: string;
}

export type SkillsDirectoryGatewayUnavailableReason =
  | 'invalid_gateway_profiles'
  | 'gateway_profiles_too_large'
  | 'gateway_profile_limit'
  | 'duplicate_gateway_base'
  | 'invalid_gateway_url'
  | 'gateway_url_requires_explicit_config'
  | 'missing_gateway_token'
  | 'invalid_gateway_token';

export type SkillsDirectoryGatewayResolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'ready'; readonly gateways: readonly SkillsShGatewayCredential[] }
  | { readonly kind: 'unavailable'; readonly reason: SkillsDirectoryGatewayUnavailableReason };

export type SkillsDirectoryUnavailableReason =
  SkillsDirectoryGatewayUnavailableReason;

export type SkillsDirectoryConnection =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'official'; readonly baseURL: string }
  | { readonly kind: 'gateway'; readonly gateway: SkillsShGatewayCredential }
  | { readonly kind: 'unavailable'; readonly reason: SkillsDirectoryUnavailableReason };

/**
 * Build the portable credential record consumed by acquisition adapters.
 * Callers should pass a configuration obtained from
 * `resolveSkillsDirectoryConnection`; this function repeats validation so a
 * manually constructed adapter cannot accidentally bind an unsafe value.
 */
export function createSkillsShGatewayCredential(
  config: SkillsShGatewayCredentialConfig,
): SkillsShGatewayCredential {
  const baseUrl = normalizeGatewayBaseURL(config.baseUrl);
  if (baseUrl === undefined || isReservedSkillsDirectoryHost(new URL(baseUrl))) {
    throw new Error('invalid skills.sh gateway URL');
  }
  if (!isValidSkillsShGatewayToken(config.token)) throw new Error('invalid skills.sh gateway credential');

  const token = config.token;
  return {
    baseUrl,
    getToken: async (signal?: AbortSignal): Promise<string> => {
      throwIfAborted(signal);
      return token;
    },
  };
}

/**
 * Resolve all explicitly configured nonofficial directory gateways.
 *
 * The JSON setting contains only base URLs and names of operator-owned
 * environment variables. Tokens are read once while constructing the
 * request-scoped callback and are never returned as configuration data.
 * A malformed profile invalidates the complete set so callers cannot silently
 * fall back to an unintended catalog.
 */
export function resolveSkillsDirectoryGateways(
  env: SkillsDirectoryRuntimeEnvironment,
): SkillsDirectoryGatewayResolution {
  if (env[SKILLS_DIRECTORY_ENABLED_ENV] !== 'true') return { kind: 'disabled' };

  const profiles: Array<{ baseUrl: string; token: string }> = [];
  const seenBases = new Set<string>();
  const addProfile = (profile: SkillsDirectoryGatewayProfile, legacy = false): SkillsDirectoryGatewayGatewayResult => {
    const baseUrl = normalizeDirectoryBaseURL(profile.baseUrl);
    if (baseUrl === undefined) return { kind: 'unavailable', reason: 'invalid_gateway_url' };
    const parsed = new URL(baseUrl);
    if (isOfficialSkillsDirectoryURL(parsed)) {
      return legacy ? { kind: 'skip' } : { kind: 'unavailable', reason: 'invalid_gateway_url' };
    }
    if (isReservedSkillsDirectoryHost(parsed)) return { kind: 'unavailable', reason: 'invalid_gateway_url' };
    if (seenBases.has(baseUrl)) return { kind: 'unavailable', reason: 'duplicate_gateway_base' };
    const token = env[profile.tokenEnv];
    if (token === undefined) return { kind: 'unavailable', reason: 'missing_gateway_token' };
    if (!isValidSkillsShGatewayToken(token)) return { kind: 'unavailable', reason: 'invalid_gateway_token' };
    seenBases.add(baseUrl);
    profiles.push({ baseUrl, token });
    return { kind: 'added' };
  };

  const legacyURL = env[SKILLS_DIRECTORY_GATEWAY_URL_ENV];
  if (legacyURL !== undefined) {
    const result = addProfile({ baseUrl: legacyURL, tokenEnv: SKILLS_DIRECTORY_GATEWAY_TOKEN_ENV }, true);
    if (result.kind === 'unavailable') return result;
  }

  const encodedProfiles = env[SKILLS_DIRECTORY_GATEWAYS_JSON_ENV];
  if (encodedProfiles !== undefined) {
    if (!isWellFormedString(encodedProfiles) || new TextEncoder().encode(encodedProfiles).byteLength > MAX_SKILLS_DIRECTORY_GATEWAYS_JSON_BYTES) {
      return { kind: 'unavailable', reason: 'gateway_profiles_too_large' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(encodedProfiles);
    } catch {
      return { kind: 'unavailable', reason: 'invalid_gateway_profiles' };
    }
    if (!Array.isArray(parsed)) return { kind: 'unavailable', reason: 'invalid_gateway_profiles' };
    if (parsed.length > MAX_SKILLS_DIRECTORY_GATEWAYS) return { kind: 'unavailable', reason: 'gateway_profile_limit' };
    for (const value of parsed) {
      if (!isStrictGatewayProfile(value)) return { kind: 'unavailable', reason: 'invalid_gateway_profiles' };
      const result = addProfile(value);
      if (result.kind === 'unavailable') return result;
    }
  }

  if (profiles.length > MAX_SKILLS_DIRECTORY_GATEWAYS) {
    return { kind: 'unavailable', reason: 'gateway_profile_limit' };
  }
  const gateways = profiles.map(({ baseUrl, token }) => createSkillsShGatewayCredential({ baseUrl, token }));
  return { kind: 'ready', gateways: Object.freeze(gateways) };
}

/**
 * Select the directory authentication profile for one server runtime.
 *
 * `PSKILLS_SKILLS_SH_BASE_URL` remains an official-origin override for
 * compatibility.  A nonofficial destination is accepted only when the
 * explicit gateway URL and gateway token are both present.  The historical
 * `PSKILLS_DIRECTORY_TOKEN` setting is deliberately ignored.
 */
export function resolveSkillsDirectoryConnection(
  env: SkillsDirectoryRuntimeEnvironment,
): SkillsDirectoryConnection {
  if (env[SKILLS_DIRECTORY_ENABLED_ENV] !== 'true') return { kind: 'disabled' };

  const gatewayResolution = resolveSkillsDirectoryGateways(env);
  if (gatewayResolution.kind === 'unavailable') return gatewayResolution;

  const configuredGatewayURL = env[SKILLS_DIRECTORY_GATEWAY_URL_ENV];
  const requestedBaseURL = configuredGatewayURL
    ?? env.PSKILLS_SKILLS_SH_BASE_URL
    ?? SKILLS_DIRECTORY_OFFICIAL_BASE_URL;
  const normalizedBaseURL = normalizeDirectoryBaseURL(requestedBaseURL);
  if (normalizedBaseURL === undefined) return { kind: 'unavailable', reason: 'invalid_gateway_url' };

  const parsedURL = new URL(normalizedBaseURL);
  if (isOfficialSkillsDirectoryURL(parsedURL)) return { kind: 'official', baseURL: normalizedBaseURL };

  // Keep obvious official aliases out of the credential-bearing gateway
  // branch, including www and trailing-dot DNS spellings.
  if (isReservedSkillsDirectoryHost(parsedURL)) {
    return { kind: 'unavailable', reason: 'invalid_gateway_url' };
  }
  if (configuredGatewayURL === undefined) {
    if (gatewayResolution.kind === 'ready') {
      const configuredGateway = gatewayResolution.gateways.find((gateway) => gateway.baseUrl === normalizedBaseURL);
      if (configuredGateway !== undefined) return { kind: 'gateway', gateway: configuredGateway };
    }
    return { kind: 'unavailable', reason: 'gateway_url_requires_explicit_config' };
  }

  const token = env[SKILLS_DIRECTORY_GATEWAY_TOKEN_ENV];
  if (token === undefined) return { kind: 'unavailable', reason: 'missing_gateway_token' };
  if (!isValidSkillsShGatewayToken(token)) return { kind: 'unavailable', reason: 'invalid_gateway_token' };

  // Validation above is repeated inside the constructor as a defense against
  // future changes to the resolver and to keep the worker-facing seam small.
  return {
    kind: 'gateway',
    gateway: createSkillsShGatewayCredential({ baseUrl: normalizedBaseURL, token }),
  };
}

type SkillsDirectoryGatewayGatewayResult =
  | { readonly kind: 'added' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'unavailable'; readonly reason: SkillsDirectoryGatewayUnavailableReason };

function isStrictGatewayProfile(value: unknown): value is SkillsDirectoryGatewayProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('baseUrl') || !keys.includes('tokenEnv')) return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.baseUrl === 'string'
    && typeof profile.tokenEnv === 'string'
    && /^[A-Z][A-Z0-9_]{0,127}$/u.test(profile.tokenEnv);
}

/** Construct a stable provider for an already validated gateway credential. */
export function createSkillsDirectoryGatewayTokenProvider(
  gateway: SkillsShGatewayCredential,
): SkillsTokenProvider {
  return gateway.getToken;
}

/** True only for the canonical skills.sh origin (a path may be configured). */
export function isOfficialSkillsDirectoryURL(value: URL | string): boolean {
  const url = toURL(value);
  return url !== undefined
    && url.protocol === 'https:'
    && url.hostname === 'skills.sh'
    && url.port.length === 0
    && url.username.length === 0
    && url.password.length === 0
    && url.search.length === 0
    && url.hash.length === 0;
}

/**
 * Recognize official skills.sh host spellings that must never receive a
 * nonofficial gateway credential, including www and DNS trailing-dot forms.
 */
export function isReservedSkillsDirectoryHost(value: URL | string): boolean {
  const url = toURL(value);
  if (url === undefined) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.+$/u, '');
  return hostname === 'skills.sh' || hostname === 'www.skills.sh';
}

/** Provider used by runtimes that do not have a usable directory credential. */
export function createUnavailableSkillsDirectoryTokenProvider(): SkillsTokenProvider {
  return async (signal?: AbortSignal): Promise<never> => {
    throwIfAborted(signal);
    throw new Error(SKILLS_DIRECTORY_AUTH_UNAVAILABLE);
  };
}

/** Return a normalized HTTPS base URL without credentials, query, or fragment. */
export function normalizeDirectoryBaseURL(value: string): string | undefined {
  if (!isWellFormedString(value) || value.length === 0 || value !== value.trim()) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) || value.includes('\\')) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname.length === 0
      || url.username.length > 0 || url.password.length > 0
      || url.search.length > 0 || url.hash.length > 0) return undefined;

  // URL parsing canonicalizes dot segments and encoding.  Preserve the full
  // configured path while removing only redundant trailing separators.
  url.pathname = url.pathname.replace(/\/{2,}/gu, '/').replace(/\/$/u, '');
  const normalized = url.toString();
  return url.pathname === '/' ? normalized.slice(0, -1) : normalized;
}

function normalizeGatewayBaseURL(value: string): string | undefined {
  return normalizeDirectoryBaseURL(value);
}

/** Validate a gateway bearer without returning or logging its value. */
export function isValidSkillsShGatewayToken(value: unknown): value is string {
  if (typeof value !== 'string' || !isWellFormedString(value) || value.length === 0 || value.trim().length === 0 || value !== value.trim()) {
    return false;
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return false;
  return new TextEncoder().encode(value).byteLength <= MAX_GATEWAY_TOKEN_BYTES;
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
}

function toURL(value: URL | string): URL | undefined {
  try {
    return typeof value === 'string' ? new URL(value) : value;
  } catch {
    return undefined;
  }
}
