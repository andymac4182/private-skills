import { describe, expect, it, vi } from 'vitest';

import { SkillsDirectoryClient } from '../src/client.js';
import { SkillsDirectoryError } from '../src/types.js';

const skillId = 'vercel-labs/skills/find-skills';
const identity = {
  id: skillId,
  source: 'vercel-labs/skills',
  slug: 'find-skills',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function auditPayload(audits: unknown[]): unknown {
  return { ...identity, audits };
}

describe('skills.sh audit response shapes', () => {
  it('retains unknown providers, optional partial fields, and stale audit timestamps', async () => {
    const fetch = vi.fn(async () => jsonResponse(auditPayload([
      {
        provider: 'Future Scanner Partner',
        slug: 'future-scanner',
        status: 'warn',
        summary: 'Review recommended by an external partner',
        auditedAt: '2001-01-01T00:00:00.000Z',
      },
      {
        provider: 'Socket',
        slug: 'socket',
        status: 'pass',
        summary: 'No alerts',
        auditedAt: '2020-02-03T04:05:06.000Z',
        riskLevel: null,
        categories: null,
      },
      {
        provider: 'Partial Partner',
        slug: 'partial-partner',
        status: 'fail',
        summary: 'External evidence requires review',
        auditedAt: '2024-04-05T06:07:08.000Z',
        riskLevel: 'HIGH',
      },
    ])));
    const client = new SkillsDirectoryClient({ fetch, maxAttempts: 1 });

    const result = await client.audit(skillId);

    expect(result.id).toBe(skillId);
    expect(result.audits).toHaveLength(3);
    expect(result.audits[0]).toEqual({
      provider: 'Future Scanner Partner',
      slug: 'future-scanner',
      status: 'warn',
      summary: 'Review recommended by an external partner',
      auditedAt: '2001-01-01T00:00:00.000Z',
    });
    expect(result.audits[1]).toMatchObject({
      provider: 'Socket',
      riskLevel: null,
      categories: null,
    });
    expect(result.audits[2]).toMatchObject({
      provider: 'Partial Partner',
      status: 'fail',
      riskLevel: 'HIGH',
    });
    expect(result.audits[2]).not.toHaveProperty('categories');
  });

  it('fails closed for malformed audit entries and never invents statuses', async () => {
    const baseEntry = {
      provider: 'Socket',
      slug: 'socket',
      status: 'pass',
      summary: 'No alerts',
      auditedAt: '2024-04-05T06:07:08.000Z',
    };
    const malformedEntries: unknown[] = [
      { ...baseEntry, status: 'safe' },
      { ...baseEntry, riskLevel: 'UNKNOWN' },
      { ...baseEntry, auditedAt: 'not-a-timestamp' },
      { ...baseEntry, categories: ['NO_CODE', 7] },
      { ...baseEntry, provider: 42 },
      null,
    ];

    for (const malformed of malformedEntries) {
      const fetch = vi.fn(async () => jsonResponse(auditPayload([malformed])));
      const client = new SkillsDirectoryClient({ fetch, maxAttempts: 1 });
      const error = await client.audit(skillId).catch((value: unknown) => value);

      expect(error).toBeInstanceOf(SkillsDirectoryError);
      expect(error).toMatchObject({ code: 'invalid_response' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});
