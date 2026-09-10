import { createSkillsDirectoryClient, type SkillsDirectoryClient } from './client.js';
import {
  MAX_SKILLS_DIRECTORY_GATEWAYS,
  normalizeDirectoryBaseURL,
  SKILLS_DIRECTORY_OFFICIAL_BASE_URL,
  type SkillsDirectoryGatewayResolution,
  type SkillsShGatewayCredential,
} from './gateway.js';
import type { SkillsFetch, SkillsTokenProvider } from './types.js';

export interface SkillsDirectoryClientResolverOptions {
  readonly gateways: SkillsDirectoryGatewayResolution;
  readonly officialAvailable: boolean;
  readonly officialTokenProvider?: SkillsTokenProvider;
  readonly fetch?: SkillsFetch;
}

/**
 * Resolve one exact feed base to a bounded, lazily constructed directory
 * client. The canonical root is intentionally separate from custom gateway
 * profiles so a UI default cannot redirect the official OIDC credential.
 */
export function createSkillsDirectoryClientResolver(
  options: SkillsDirectoryClientResolverOptions,
): (baseUrl: string) => SkillsDirectoryClient | undefined {
  const gateways = new Map<string, SkillsShGatewayCredential>();
  if (options.gateways.kind === 'ready') {
    for (const gateway of options.gateways.gateways) gateways.set(gateway.baseUrl, gateway);
  }
  const clients = new Map<string, SkillsDirectoryClient>();
  const maxClients = MAX_SKILLS_DIRECTORY_GATEWAYS + 1;

  return (baseUrl: string): SkillsDirectoryClient | undefined => {
    const normalized = normalizeDirectoryBaseURL(baseUrl);
    if (normalized === undefined) return undefined;
    const existing = clients.get(normalized);
    if (existing !== undefined) return existing;

    const isCanonicalRoot = normalized === SKILLS_DIRECTORY_OFFICIAL_BASE_URL;
    const gateway = gateways.get(normalized);
    if (!isCanonicalRoot && gateway === undefined) return undefined;
    if (clients.size >= maxClients) return undefined;
    if (isCanonicalRoot && (options.gateways.kind !== 'ready' || !options.officialAvailable || options.officialTokenProvider === undefined)) return undefined;

    const client = createSkillsDirectoryClient({
      baseURL: normalized,
      fetch: options.fetch,
      getToken: isCanonicalRoot ? options.officialTokenProvider : gateway!.getToken,
    });
    clients.set(normalized, client);
    return client;
  };
}
