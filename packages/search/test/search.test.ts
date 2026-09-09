import { describe, expect, it } from 'vitest';
import type { RegistryState, StateRepository } from '../../contracts/src/index';
import { cloneRegistryState, defaultRegistryState } from '../../database/src/state';
import {
  PostgresSemanticIndex,
  StateSemanticIndex,
  SearchValidationError,
  type EmbeddingProfile,
  type PersistedSearchIndex,
  type SearchDocument,
  type SearchRegistryState,
} from '../src/index';

const profile: EmbeddingProfile = { id: 'test-v1', model: 'test-model', dimensions: 3 };
const timestamp = '2026-09-09T00:00:00.000Z';

class MemoryStateRepository implements StateRepository {
  readonly states = new Map<string, RegistryState>();

  constructor() {
    this.states.set('org-a', defaultRegistryState());
    this.states.set('org-b', defaultRegistryState());
  }

  async read(organizationId: string): Promise<RegistryState> {
    return cloneRegistryState(this.states.get(organizationId) ?? defaultRegistryState());
  }

  async transaction<T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T> {
    const state = cloneRegistryState(this.states.get(organizationId) ?? defaultRegistryState()) as SearchRegistryState;
    const value = updater(state);
    this.states.set(organizationId, cloneRegistryState(state));
    return value;
  }
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}

function document(
  organizationId: string,
  resourceId: string,
  vector: number[],
  artifact = 'a',
  content = 'b',
): SearchDocument {
  return {
    organizationId,
    resourceId,
    artifactDigest: digest(artifact),
    contentDigest: digest(content),
    text: `${resourceId} approved text`,
    vector,
    profileId: profile.id,
    indexedAt: timestamp,
  };
}

function query(organizationId: string, allowedResourceIds: string[], vector: number[], limit = 10) {
  return { organizationId, allowedResourceIds, profileId: profile.id, vector, limit };
}

describe('StateSemanticIndex', () => {
  it('ranks exact cosine distance and enforces tenant/resource scopes', async () => {
    const repository = new MemoryStateRepository();
    const index = new StateSemanticIndex({ repository, profile });
    await index.upsert([
      document('org-a', 'r1', [1, 0, 0]),
      document('org-a', 'r2', [0, 1, 0]),
      document('org-b', 'r1', [1, 0, 0]),
    ]);

    await expect(index.search(query('org-a', ['r1', 'r2'], [1, 0, 0], 2))).resolves.toEqual([
      expect.objectContaining({ resourceId: 'r1', score: 1 }),
      expect.objectContaining({ resourceId: 'r2', score: 0 }),
    ]);
    await expect(index.search(query('org-a', ['r2'], [1, 0, 0]))).resolves.toEqual([
      expect.objectContaining({ resourceId: 'r2' }),
    ]);
    await expect(index.search(query('org-a', [], [1, 0, 0]))).resolves.toEqual([]);
  });

  it('does not cross organization repository boundaries when resource ids overlap', async () => {
    const repository = new MemoryStateRepository();
    const index = new StateSemanticIndex({ repository, profile });
    await index.upsert([document('org-b', 'same-resource', [1, 0, 0])]);
    await expect(index.search(query('org-a', ['same-resource'], [1, 0, 0]))).resolves.toEqual([]);
  });

  it('requires the caller resource allowlist for namespaced resources', async () => {
    const repository = new MemoryStateRepository();
    const index = new StateSemanticIndex({ repository, profile });
    await index.upsert([
      document('org-a', '@team/approved', [1, 0, 0]),
      document('org-a', '@other/approved', [1, 0, 0]),
    ]);
    await expect(index.search(query('org-a', ['@team/approved'], [1, 0, 0]))).resolves.toEqual([
      expect.objectContaining({ resourceId: '@team/approved' }),
    ]);
  });

  it('replaces the current document and revocation removes every profile row for a resource', async () => {
    const repository = new MemoryStateRepository();
    const index = new StateSemanticIndex({ repository, profile });
    await index.upsert([document('org-a', 'r1', [1, 0, 0], 'a', 'b')]);
    await index.upsert([document('org-a', 'r1', [0, 1, 0], 'c', 'd')]);
    await expect(index.search(query('org-a', ['r1'], [0, 1, 0]))).resolves.toEqual([
      expect.objectContaining({ resourceId: 'r1', artifactDigest: digest('c'), contentDigest: digest('d'), score: 1 }),
    ]);
    await index.remove('org-a', ['r1']);
    await expect(index.search(query('org-a', ['r1'], [0, 1, 0]))).resolves.toEqual([]);
  });

  it('reads legacy state without a search extension as an empty index', async () => {
    const repository = new MemoryStateRepository();
    const index = new StateSemanticIndex({ repository, profile });
    await expect(index.search(query('org-a', ['missing'], [1, 0, 0]))).resolves.toEqual([]);
  });

  it('rejects unknown profiles, wrong dimensions, non-finite vectors, and zero vectors', async () => {
    const repository = new MemoryStateRepository();
    const index = new StateSemanticIndex({ repository, profile });
    await expect(index.upsert([document('org-a', 'bad', [1, 0] as number[])])).rejects.toMatchObject({ code: 'VECTOR_DIMENSIONS' });
    await expect(index.upsert([document('org-a', 'bad', [1, Number.NaN, 0])])).rejects.toBeInstanceOf(SearchValidationError);
    await expect(index.upsert([document('org-a', 'bad', [0, 0, 0])])).rejects.toMatchObject({ code: 'VECTOR_ZERO' });
    await expect(index.search({ ...query('org-a', ['bad'], [1, 0, 0]), profileId: 'other' })).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' });
  });

  it('enforces the profile dimension ceiling', () => {
    expect(() => new StateSemanticIndex({
      repository: new MemoryStateRepository(),
      profile: { id: 'too-large', model: 'oversized', dimensions: 2_001 },
    })).toThrowError(/between 1 and 2000/);
  });

  it('keeps model profiles immutable and dimension-specific', async () => {
    const repository = new MemoryStateRepository();
    const alternate: EmbeddingProfile = { id: 'other-v1', model: 'other-model', dimensions: 2 };
    const index = new StateSemanticIndex({ repository, profiles: [profile, alternate] });
    const other = { ...document('org-a', 'other', [1, 0, 0]), profileId: alternate.id, vector: [1, 0] };
    await index.upsert([other]);
    await expect(index.search({ ...query('org-a', ['other'], [1, 0, 0]), profileId: alternate.id })).rejects.toMatchObject({ code: 'VECTOR_DIMENSIONS' });
    await expect(index.search({ ...query('org-a', ['other'], [1, 0]), profileId: alternate.id })).resolves.toEqual([
      expect.objectContaining({ resourceId: 'other', score: 1 }),
    ]);
  });

  it('persists only the adapter-owned optional extension', async () => {
    const repository = new MemoryStateRepository();
    const index = new StateSemanticIndex({ repository, profile });
    await index.upsert([document('org-a', 'r1', [1, 0, 0])]);
    const state = repository.states.get('org-a') as SearchRegistryState;
    const extension = state.search as PersistedSearchIndex;
    expect(extension.version).toBe(1);
    expect(extension.documents).toHaveLength(1);
    expect(state.skills).toEqual([]);
  });
});

describe('PostgresSemanticIndex', () => {
  it('uses parameterized, tenant/resource-scoped exact cosine SQL', async () => {
    const calls: Array<{ text: string; parameters?: readonly unknown[] }> = [];
    const index = new PostgresSemanticIndex({
      profile,
      query: async <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) => {
        calls.push({ text, parameters });
        if (text.startsWith('SELECT resource_id')) {
          return {
            rows: [{ resource_id: 'r1', artifact_digest: digest('a'), content_digest: digest('b'), score: '0.75' } as Row],
          };
        }
        return { rows: [] as Row[] };
      },
    });
    await index.upsert([document('org-a', 'r1', [1, 0, 0])]);
    const hits = await index.search(query('org-a', ['r1'], [1, 0, 0]));
    expect(hits).toEqual([{ resourceId: 'r1', artifactDigest: digest('a'), contentDigest: digest('b'), score: 0.75 }]);
    const searchCall = calls.find((call) => call.text.startsWith('SELECT resource_id'))!;
    expect(searchCall.text.indexOf('WHERE')).toBeLessThan(searchCall.text.indexOf('ORDER BY'));
    expect(searchCall.text.indexOf('resource_id = ANY')).toBeGreaterThan(-1);
    expect(searchCall.text.indexOf('LIMIT')).toBeGreaterThan(searchCall.text.indexOf('ORDER BY'));
    expect(searchCall.parameters).toEqual(['[1,0,0]', 'org-a', 'test-v1', ['r1'], 10]);
    expect(searchCall.text).not.toContain('org-a');
  });

  it('does not issue a global query for an empty allowlist', async () => {
    let queryCount = 0;
    const index = new PostgresSemanticIndex({
      profile,
      query: async () => { queryCount += 1; return { rows: [] }; },
    });
    await expect(index.search(query('org-a', [], [1, 0, 0]))).resolves.toEqual([]);
    expect(queryCount).toBe(0);
  });
});
