/**
 * Integration tests must never point at a shared or production database.
 * Keep the error independent of the URL so credentials are not echoed.
 */
export function loopbackDatabaseURL(
  ...entries: readonly (readonly [name: string, value: string | undefined])[]
): string | undefined {
  const configured = entries.find(([, value]) => typeof value === 'string' && value.trim() !== '');
  if (!configured) return undefined;
  const [name, rawValue] = configured;
  const value = rawValue!.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid loopback PostgreSQL URL for integration tests`);
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if ((parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    || !loopbackHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${name} must use a loopback PostgreSQL host for integration tests`);
  }
  return value;
}
