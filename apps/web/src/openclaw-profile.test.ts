import { describe, expect, it } from 'vitest';

import { createOpenClawTrustedFeedProfile } from '../server/openclaw-profile';
import {
  OPENCLAW_CLAWHUB_SKILLS_API_URL,
  OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
  OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
} from '../../../packages/openclaw/src/index.ts';

describe('server OpenClaw trusted-feed profile selection', () => {
  it('propagates the exact server-selected live compatibility profile', () => {
    expect(createOpenClawTrustedFeedProfile({
      PSKILLS_OPENCLAW_TRUSTED_FEED_URL: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      PSKILLS_OPENCLAW_TRUSTED_FEED_ID: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      PSKILLS_OPENCLAW_TRUSTED_FEED_COMPATIBILITY: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
    })).toMatchObject({
      url: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      expectedFeedId: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      allowedOrigins: ['https://clawhub.ai'],
      compatibilityProfile: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
    });
  });

  it.each([
    {
      PSKILLS_OPENCLAW_TRUSTED_FEED_URL: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      PSKILLS_OPENCLAW_TRUSTED_FEED_ID: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
    },
    {
      PSKILLS_OPENCLAW_TRUSTED_FEED_URL: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      PSKILLS_OPENCLAW_TRUSTED_FEED_COMPATIBILITY: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
    },
    {
      PSKILLS_OPENCLAW_TRUSTED_FEED_URL: 'https://clawhub.ai/v1/feeds/skills',
      PSKILLS_OPENCLAW_TRUSTED_FEED_ID: OPENCLAW_CLAWHUB_SKILLS_FEED_ID,
      PSKILLS_OPENCLAW_TRUSTED_FEED_COMPATIBILITY: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
    },
    {
      PSKILLS_OPENCLAW_TRUSTED_FEED_URL: OPENCLAW_CLAWHUB_SKILLS_API_URL,
      PSKILLS_OPENCLAW_TRUSTED_FEED_ID: 'clawhub-official',
      PSKILLS_OPENCLAW_TRUSTED_FEED_COMPATIBILITY: OPENCLAW_CLAWHUB_SKILLS_COMPATIBILITY_PROFILE,
    },
  ])('fails closed for an incomplete or mismatched compatibility tuple', (env) => {
    expect(createOpenClawTrustedFeedProfile(env)).toBeUndefined();
  });
});
