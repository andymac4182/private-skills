import type { OpenClawTrustedFeedProfile } from '../../../packages/openclaw-adapter/src/index.ts';
import {
  OPENCLAW_CLAWHUB_SKILLS_API_URL,
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
} from '../../../packages/openclaw/src/index.ts';

export type OpenClawProfileEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the server-owned trusted OpenClaw metadata profile.  Compatibility
 * is opt-in and binds all three values together; a suffix feed id without the
 * explicit profile is rejected instead of being treated as an alias for the
 * strict published contract.
 */
export function createOpenClawTrustedFeedProfile(
  env: OpenClawProfileEnvironment,
): OpenClawTrustedFeedProfile | undefined {
  const raw = env.PSKILLS_OPENCLAW_TRUSTED_FEED_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    const expectedFeedId = env.PSKILLS_OPENCLAW_TRUSTED_FEED_ID?.trim() || 'clawhub-official';
    const compatibility = env.PSKILLS_OPENCLAW_TRUSTED_FEED_COMPATIBILITY?.trim();
    if (compatibility !== undefined && compatibility !== '') {
      if (
        compatibility !== OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE ||
        url.href !== OPENCLAW_CLAWHUB_SKILLS_API_URL ||
        expectedFeedId !== OPENCLAW_CLAWHUB_SKILLS_FEED_ID
      ) return undefined;
    } else if (expectedFeedId === OPENCLAW_CLAWHUB_SKILLS_FEED_ID) {
      return undefined;
    }
    return {
      url: url.href,
      expectedFeedId,
      allowedOrigins: [url.origin],
      ...(compatibility === OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE
        ? { compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE }
        : {}),
    };
  } catch {
    return undefined;
  }
}
