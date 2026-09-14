import { describe, expect, it, vi } from 'vitest';

import {
  SourceCatalogClient,
  type SourceCatalogAdapter,
  type SourceResolution,
  type SourceSearchResult,
} from '../src/index.js';

function row(sourceId: string, overrides: Partial<SourceSearchResult> = {}): SourceSearchResult {
  return {
    sourceId,
    externalId: `${sourceId}:fixture`,
    title: 'Fixture source',
    installable: true,
    ...overrides,
  };
}

function resolution(sourceId: string, externalId = `${sourceId}:fixture`): SourceResolution {
  return {
    sourceId,
    externalId,
    row: row(sourceId, { externalId }),
    reference: '@github/acme/fixture',
    title: 'Fixture source',
    version: '1.0.0',
    acquisition: {
      kind: 'github',
      repository: 'acme/fixture',
      path: '',
      ref: 'a'.repeat(40),
    },
    configRevision: 'revision-1',
    resolvedAt: new Date(0).toISOString(),
  };
}

function adapter(input: {
  id: string;
  availability?: SourceCatalogAdapter['availability'];
  search?: SourceCatalogAdapter['search'];
  resolve?: SourceCatalogAdapter['resolve'];
  configRevision?: string;
}): SourceCatalogAdapter {
  return {
    id: input.id,
    label: input.id,
    capabilities: ['search', 'resolve'],
    configRevision: input.configRevision ?? 'revision-1',
    availability: input.availability ?? (() => ({ state: 'available' as const })),
    search: input.search ?? (async ({ query: _query, limit: _limit }) => []),
    resolve: input.resolve ?? (async ({ sourceId, externalId }) => resolution(sourceId, externalId)),
  };
}

describe('SourceCatalogClient boundaries', () => {
  it('does not call an adapter after the request signal was already aborted', async () => {
    const availability = vi.fn(() => ({ state: 'available' as const }));
    const client = new SourceCatalogClient({ adapters: [adapter({ id: 'preabort', availability })] });
    const controller = new AbortController();
    controller.abort();

    const listed = await client.list({ organizationId: 'org', signal: controller.signal });

    expect(availability).not.toHaveBeenCalled();
    expect(listed.sources[0]?.availability).toMatchObject({ state: 'unavailable', code: 'SOURCE_TIMEOUT' });
  });

  it('aborts a timed-out adapter and removes its parent abort listener', async () => {
    const resolve = vi.fn(({ signal }: Parameters<SourceCatalogAdapter['resolve']>[0]) => new Promise<SourceResolution>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('provider stopped')), { once: true });
    }));
    const client = new SourceCatalogClient({
      adapters: [adapter({ id: 'timeout', resolve })],
      configuration: { requestTimeoutMs: 5 },
    });
    const parent = new AbortController();
    const addListener = vi.spyOn(parent.signal, 'addEventListener');
    const removeListener = vi.spyOn(parent.signal, 'removeEventListener');

    await expect(client.resolve({ sourceId: 'timeout', externalId: 'timeout:fixture', organizationId: 'org', signal: parent.signal }))
      .rejects.toMatchObject({ code: 'SOURCE_TIMEOUT' });

    expect(resolve).toHaveBeenCalledOnce();
    expect(addListener.mock.calls.length).toBe(removeListener.mock.calls.length);
    parent.abort();
    expect(addListener.mock.calls.length).toBe(removeListener.mock.calls.length);
  });

  it('keeps successful search rows when one adapter fails without exposing provider error text', async () => {
    const client = new SourceCatalogClient({
      adapters: [
        adapter({
          id: 'good',
          search: async () => [row('good', { path: '', description: 'first line\nsecond line' })],
        }),
        adapter({
          id: 'bad',
          search: async () => { throw new Error('provider secret token and response body'); },
        }),
      ],
    });

    const searched = await client.search({ query: 'fixture', limit: 10, organizationId: 'org' });

    expect(searched.data).toEqual([expect.objectContaining({ sourceId: 'good', path: '', description: 'first line\nsecond line' })]);
    const failed = searched.sources.find((source) => source.id === 'bad');
    expect(failed?.availability.state).toBe('unavailable');
    expect(failed?.error?.message).toBe('Source adapter failed');
    expect(JSON.stringify(searched)).not.toContain('provider secret');
  });

  it('honors disabled source configuration before invoking provider code', async () => {
    const availability = vi.fn(() => ({ state: 'available' as const }));
    const search = vi.fn(async () => [row('disabled')]);
    const client = new SourceCatalogClient({
      adapters: [adapter({ id: 'disabled', availability, search })],
      configuration: { sources: { disabled: { enabled: false } } },
    });

    const searched = await client.search({ query: 'fixture', source: 'disabled', organizationId: 'org' });

    expect(availability).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(searched.data).toEqual([]);
    expect(searched.sources[0]?.availability).toMatchObject({ state: 'disabled' });
  });
});
