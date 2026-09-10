import { describe, expect, it } from 'vitest';

import {
  enumerateSkills,
  type SkillsEnumerationClient,
} from '../src/enumerate.js';
import type { SkillListResponse, V1Skill } from '../src/types.js';

function skill(overrides: Partial<V1Skill> = {}): V1Skill {
  return {
    id: 'owner/repository/first-skill',
    slug: 'first-skill',
    name: 'First skill',
    source: 'owner/repository',
    installs: 10,
    sourceType: 'github',
    installUrl: 'https://github.com/owner/repository',
    url: 'https://skills.sh/owner/repository/first-skill',
    ...overrides,
  };
}

function page(pageNumber: number, data: V1Skill[], total: number, hasMore: boolean, perPage = 2): SkillListResponse {
  return {
    data,
    pagination: { page: pageNumber, perPage, total, hasMore },
  };
}

function fixtureClient(pages: Map<number, SkillListResponse>): SkillsEnumerationClient & { calls: Array<{ page?: number; perPage?: number }> } {
  const calls: Array<{ page?: number; perPage?: number }> = [];
  return {
    calls,
    async list(options) {
      calls.push({ page: options?.page, perPage: options?.perPage });
      const result = pages.get(options?.page ?? 0);
      if (!result) throw new Error(`missing fixture page ${options?.page ?? 0}`);
      return result;
    },
  };
}

describe('enumerateSkills', () => {
  it('walks three pages, keeps complete IDs unique, and reconciles duplicate rows', async () => {
    const duplicate = skill({
      id: 'catalog-owner/skills/facebook/meta-ads',
      slug: 'facebook/meta-ads',
      name: 'meta-ads',
      source: 'catalog-owner/skills',
      url: 'https://skills.sh/catalog-owner/skills/facebook/meta-ads',
      provider: 'skills.sh',
      fetchedAt: '2026-04-20T12:00:00.000Z',
      sourceStatus: 'metadata-only',
      sourceReason: 'page zero metadata',
      feedName: null,
    });
    const duplicateWithNewContext = {
      ...duplicate,
      fetchedAt: '2026-04-20T12:00:01.000Z',
      sourceStatus: 'snapshot-available' as const,
      sourceReason: 'page one metadata',
    };
    const wellKnown = skill({
      id: 'open.feishu.cn/lark-doc',
      slug: 'lark-doc',
      name: 'lark-doc',
      source: 'open.feishu.cn',
      sourceType: 'well-known',
      installUrl: null,
      url: 'https://www.skills.sh/site/open.feishu.cn/lark-doc',
      // Unknown listing fields such as files:null are intentionally ignored by the client.
      files: null,
    } as Partial<V1Skill> & { files: null });
    const finalSkill = skill({
      id: 'another-owner/repository/third-skill',
      slug: 'third-skill',
      name: 'Third skill',
      source: 'another-owner/repository',
      url: 'https://skills.sh/another-owner/repository/third-skill',
    });
    const client = fixtureClient(new Map([
      [0, page(0, [duplicate], 4, true)],
      [1, page(1, [wellKnown, duplicateWithNewContext], 4, true)],
      [2, page(2, [finalSkill], 4, false)],
    ]));

    const result = await enumerateSkills(client, { perPage: 2 });

    expect(result.status).toBe('complete');
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.drifted).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.uniqueIds).toEqual([duplicate.id, wellKnown.id, finalSkill.id]);
    expect(result.rows.map((row) => row.id)).toEqual(result.uniqueIds);
    expect(result.rows[1]).toMatchObject({ sourceType: 'well-known', installUrl: null });
    expect(result.rows[0]).toMatchObject({ sourceStatus: 'metadata-only', fetchedAt: '2026-04-20T12:00:00.000Z' });
    expect(result.observedRows).toBe(4);
    expect(result.receivedRows).toBe(4);
    expect(result.reportedTotal).toBe(4);
    expect(result.duplicateRows).toBe(1);
    expect(result.duplicateIds).toEqual([duplicate.id]);
    expect(result.duplicateCounts).toEqual({ [duplicate.id]: 2 });
    expect(result.conflicts).toEqual([]);
    expect(result.conflictIds).toEqual([]);
    expect(result.conflictingRows).toBe(0);
    expect(result.duplicates).toEqual([{
      id: duplicate.id,
      count: 2,
      duplicateRows: 1,
      pages: [0, 1],
    }]);
    expect(result.reconciliation).toMatchObject({
      reportedTotal: 4,
      observedRows: 4,
      uniqueRows: 3,
      duplicateRows: 1,
      conflicts: 0,
      rowsOmitted: 0,
      complete: true,
      matchesReportedTotal: true,
    });
    expect(result.sourceTypeCounts).toEqual({ github: 2, 'well-known': 1 });
    expect(result.pagesFetched).toBe(3);
    expect(result.pages.map((entry) => entry.requestedPage)).toEqual([0, 1, 2]);
    expect(client.calls).toEqual([
      { page: 0, perPage: 2 },
      { page: 1, perPage: 2 },
      { page: 2, perPage: 2 },
    ]);
    expect(result.metadataOnly).toBe(true);
    expect(result.detailRequests).toBe(0);
    expect(result.artifactRequests).toBe(0);
  });

  it('marks conflicting duplicate metadata as drift and retains bounded evidence', async () => {
    const first = skill({
      id: 'catalog-owner/skills/facebook/meta-ads',
      slug: 'facebook/meta-ads',
      name: 'meta-ads',
      source: 'catalog-owner/skills',
      isDuplicate: false,
      installs: 320,
      url: 'https://skills.sh/catalog-owner/skills/facebook/meta-ads',
    });
    const conflicting = {
      ...first,
      installs: 321,
      isDuplicate: true,
    };
    const client = fixtureClient(new Map([
      [0, page(0, [first], 2, true)],
      [1, page(1, [conflicting], 2, false)],
    ]));

    const result = await enumerateSkills(client, {
      perPage: 2,
      limits: { maxPages: 2, maxRows: 2 },
    });

    expect(result.status).toBe('drifted');
    expect(result.drifted).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('conflicting_duplicate');
    expect(result.rows).toEqual([first]);
    expect(result.uniqueIds).toEqual([first.id]);
    expect(result.duplicateIds).toEqual([first.id]);
    expect(result.duplicateCounts).toEqual({ [first.id]: 2 });
    expect(result.duplicateRows).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      id: first.id,
      firstPage: 0,
      conflictingPage: 1,
      fields: ['installs', 'isDuplicate'],
      firstRow: first,
      conflictingRow: conflicting,
    });
    expect(result.conflictIds).toEqual([first.id]);
    expect(result.conflictingRows).toBe(1);
    expect(result.observedRows).toBe(2);
    expect(result.rowsOmitted).toBe(0);
    expect(result.pagesFetched).toBe(2);
    expect(client.calls.map((call) => call.page)).toEqual([0, 1]);
    expect(result.reconciliation).toMatchObject({
      observedRows: 2,
      uniqueRows: 1,
      duplicateRows: 1,
      conflicts: 1,
      rowsOmitted: 0,
      complete: false,
      matchesReportedTotal: true,
    });
  });

  it('stops at the page bound and marks the snapshot incomplete', async () => {
    const row = skill();
    const client = fixtureClient(new Map([
      [0, page(0, [row], 3, true)],
      [1, page(1, [skill({ id: 'owner/repository/second-skill', slug: 'second-skill' })], 3, true)],
      [2, page(2, [skill({ id: 'owner/repository/third-skill', slug: 'third-skill' })], 3, false)],
    ]));

    const result = await enumerateSkills(client, { perPage: 2, limits: { maxPages: 2 } });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('page_limit');
    expect(result.complete).toBe(false);
    expect(result.pagesFetched).toBe(2);
    expect(client.calls.map((call) => call.page)).toEqual([0, 1]);
  });

  it('bounds retained rows and records rows omitted from the reconciliation', async () => {
    const duplicate = skill();
    const client = fixtureClient(new Map([
      [0, page(0, [duplicate], 3, true)],
      [1, page(1, [duplicate, skill({ id: 'owner/repository/second-skill', slug: 'second-skill' })], 3, false)],
    ]));

    const result = await enumerateSkills(client, { perPage: 2, limits: { maxRows: 2 } });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('row_limit');
    expect(result.complete).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.uniqueIds).toEqual([duplicate.id]);
    expect(result.observedRows).toBe(3);
    expect(result.rowsOmitted).toBe(1);
    expect(result.reconciliation.complete).toBe(false);
    expect(result.reconciliation.matchesReportedTotal).toBe(true);
  });

  it('stops before retaining a page that would exceed the byte bound', async () => {
    const row = skill();
    const first = page(0, [row], 2, true);
    const firstBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
    const client = fixtureClient(new Map([
      [0, first],
      [1, page(1, [skill({ id: 'owner/repository/second-skill', slug: 'second-skill' })], 2, false)],
    ]));

    const result = await enumerateSkills(client, { perPage: 2, limits: { maxBytes: firstBytes - 1 } });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('byte_limit');
    expect(result.rows).toEqual([]);
    expect(result.rowsOmitted).toBe(1);
    expect(result.pagesFetched).toBe(1);
  });

  it('returns a bounded timeout and aborts a never-resolving list request', async () => {
    let requestSignal: AbortSignal | undefined;
    const client: SkillsEnumerationClient = {
      list(options) {
        requestSignal = options?.signal;
        return new Promise<SkillListResponse>(() => undefined);
      },
    };

    const result = await enumerateSkills(client, { limits: { timeoutMs: 10 } });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('timeout');
    expect(result.pagesFetched).toBe(0);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('returns cancellation separately from a timeout', async () => {
    const controller = new AbortController();
    const client: SkillsEnumerationClient = {
      list() {
        return new Promise<SkillListResponse>(() => undefined);
      },
    };
    const pending = enumerateSkills(client, { signal: controller.signal, limits: { timeoutMs: 1_000 } });
    controller.abort();

    const result = await pending;

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('cancelled');
  });

  it('marks repeated, mismatched, and changing pages as drift rather than completing', async () => {
    const row = skill();
    const repeatedClient = fixtureClient(new Map([
      [0, page(0, [row], 2, true)],
      [1, page(0, [row], 2, false)],
    ]));
    const repeated = await enumerateSkills(repeatedClient, { perPage: 2 });
    expect(repeated.status).toBe('drifted');
    expect(repeated.reason).toBe('repeated_page');

    const mismatchedClient = fixtureClient(new Map([
      [0, page(1, [row], 1, false)],
    ]));
    const mismatched = await enumerateSkills(mismatchedClient, { perPage: 2 });
    expect(mismatched.status).toBe('drifted');
    expect(mismatched.reason).toBe('page_mismatch');
    expect(mismatched.complete).toBe(false);

    const changingClient = fixtureClient(new Map([
      [0, page(0, [row], 2, true)],
      [1, page(1, [skill({ id: 'owner/repository/second-skill', slug: 'second-skill' })], 3, false)],
    ]));
    const changing = await enumerateSkills(changingClient, { perPage: 2 });
    expect(changing.status).toBe('drifted');
    expect(changing.reason).toBe('total_changed');
  });

  it('surfaces upstream errors as unavailable metadata runs', async () => {
    const client: SkillsEnumerationClient = {
      list: async () => {
        throw new Error('network failure');
      },
    };

    const result = await enumerateSkills(client);

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('upstream_error');
    expect(result.errorCode).toBe('unavailable');
    expect(result.complete).toBe(false);
  });

  it('rejects invalid bounds before calling the list client', async () => {
    let calls = 0;
    const client: SkillsEnumerationClient = {
      list: async () => {
        calls += 1;
        return page(0, [], 0, false);
      },
    };

    await expect(enumerateSkills(client, { limits: { maxPages: 0 } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(enumerateSkills(client, { limits: { maxBytes: Number.POSITIVE_INFINITY } })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toBe(0);
  });
});
