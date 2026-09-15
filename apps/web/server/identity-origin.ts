/**
 * Resolve the deployment origin used by server-side identity and delegation
 * checks. This module intentionally has no Node, database, or identity SDK
 * imports so the shared runtime can use it in an edge bundle.
 */
export interface IdentityOriginEnvironment {
  BETTER_AUTH_URL?: string;
  PSKILLS_PUBLIC_ORIGIN?: string;
  PSKILLS_API_URL?: string;
}

export function canonicalOriginFromEnv(env: IdentityOriginEnvironment): string {
  const value = env.BETTER_AUTH_URL?.trim() || env.PSKILLS_PUBLIC_ORIGIN?.trim() || env.PSKILLS_API_URL?.trim() || 'http://localhost:5173';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Trusted identity origin is invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin === 'null' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Trusted identity origin is invalid');
  }
  return parsed.origin;
}
