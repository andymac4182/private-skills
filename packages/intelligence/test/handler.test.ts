import { describe, expect, it } from 'vitest';

import type {
  BlobStore,
  Digest,
  Principal,
  RegistryState,
  SkillVersion,
  StateRepository,
  StoredBlob,
} from '../../contracts/src/index.js';
import { MemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { DefaultReviewPersistenceService } from '../../reviews/src/index.js';
import type { SearchDocument, SearchHealth, SearchHit, SemanticIndex } from '../../search/src/types.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type { EmbeddingProvider } from '../src/embeddings.js';
import { createIntelligenceHandler } from '../src/handler.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-test';

type AuthenticatedPrincipal = Principal & { scopes?: string[]; identity?: 'user' | 'worker' };

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function skillText(skillName: string, body: string): string {
  return `---\nname: ${skillName}\ndescription: A bounded test skill.\n---\n\n${body}`;
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const digest = await digestBytes(copy);
    const key = `artifact/${digest}`;
    this.values.set(key, copy);
    return { key, digest, size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error('blob not found');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FakeIndex implements SemanticIndex {
  hits: readonly SearchHit[] = [];
  queries: Array<{ allowedResourceIds: string[]; profileId: string; limit: number }> = [];
  upserts: SearchDocument[][] = [];
  removals: Array<{ organizationId: string; resourceIds: string[] }> = [];

  async upsert(documents: readonly SearchDocument[]): Promise<void> {
    this.upserts.push([...documents]);
  }

  async search(query: { allowedResourceIds: string[]; profileId: string; limit: number }): Promise<readonly SearchHit[]> {
    this.queries.push({
      allowedResourceIds: [...query.allowedResourceIds],
      profileId: query.profileId,
      limit: query.limit,
    });
    return this.hits;
  }

  async remove(organizationId: string, resourceIds: readonly string[]): Promise<void> {
    this.removals.push({ organizationId, resourceIds: [...resourceIds] });
  }

  async health(): Promise<SearchHealth> {
    return { status: 'ok', provider: 'fake-index' };
  }
}

const provider: EmbeddingProvider = {
  profile: { id: 'test-v1', model: 'test-model', dimensions: 3 },
  async embedQuery() {
    return [1, 0, 0];
  },
  async embedMany(texts) {
    return texts.map(() => [1, 0, 0]);
  },
};

async function addSkill(
  repository: StateRepository,
  blobs: MemoryBlobs,
  options: { id: string; name: string; skillName: string; body: string },
): Promise<{ skill: SkillVersion; text: string; contentDigest: Digest }> {
  const text = skillText(options.skillName, options.body);
  const skillBytes = new TextEncoder().encode(text);
  const contentDigest = await digestBytes(skillBytes);
  const bundleBytes = encodeBundle({
    format: 'pskills-bundle-v1',
    files: [{ path: 'SKILL.md', content: base64(text) }],
  });
  const artifact = await blobs.put(bundleBytes);
  const skill: SkillVersion = {
    id: options.id,
    organizationId: ORGANIZATION,
    name: options.name,
    skillName: options.skillName,
    version: '1.0.0',
    description: 'A bounded test skill.',
    artifact,
    state: 'approved',
    policyRevision: 'policy-initial',
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedAt: '2026-01-01T00:00:00.000Z',
    provenance: { kind: 'native' },
    fileCount: 1,
    scanIds: [],
  };
  await repository.transaction(ORGANIZATION, (state) => {
    state.skills.push(skill);
  });
  return { skill, text, contentDigest };
}

function request(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function bearer(token = 'user-token'): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function readerPrincipal(): AuthenticatedPrincipal {
  return {
    organizationId: ORGANIZATION,
    subject: 'reader',
    roles: ['reader'],
    namespaces: ['@team'],
    scopes: ['search:read', 'skills:read', 'registry:read', 'reviews:read'],
  };
}

function ownerPrincipal(): AuthenticatedPrincipal {
  return {
    organizationId: ORGANIZATION,
    subject: 'owner',
    roles: ['owner'],
    scopes: ['*'],
  };
}

async function fixture() {
  const repository = new MemoryStateRepository({
    stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }),
  });
  const blobs = new MemoryBlobs();
  const team = await addSkill(repository, blobs, {
    id: 'skill-team',
    name: '@team/alpha',
    skillName: 'alpha',
    body: 'Use this approved team skill for bounded search behavior.',
  });
  const other = await addSkill(repository, blobs, {
    id: 'skill-other',
    name: '@other/beta',
    skillName: 'beta',
    body: 'This skill must remain outside the reader namespace.',
  });
  const index = new FakeIndex();
  let principal: AuthenticatedPrincipal = readerPrincipal();
  const handler = createIntelligenceHandler({
    repository,
    blobs,
    authenticate: async () => principal,
    organizationId: ORGANIZATION,
    publicOrigin: ORIGIN,
    reviewerToken: 'reviewer-secret',
    index,
    embeddingProvider: provider,
    reviewService: new DefaultReviewPersistenceService(repository),
    triggerReview: async () => ({ sessionId: 'review-session', status: 'started' }),
  });
  return {
    repository,
    blobs,
    index,
    handler,
    team,
    other,
    setPrincipal(value: AuthenticatedPrincipal) {
      principal = value;
    },
  };
}

describe('intelligence HTTP handler', () => {
  it('prefilters semantic search by current visibility and rehydrates digest-verified text', async () => {
    const harness = await fixture();
    harness.index.hits = [
      {
        resourceId: harness.team.skill.id,
        artifactDigest: harness.team.skill.artifact.digest,
        contentDigest: harness.team.contentDigest,
        score: 0.98,
      },
      {
        resourceId: harness.other.skill.id,
        artifactDigest: harness.other.skill.artifact.digest,
        contentDigest: harness.other.contentDigest,
        score: 0.97,
      },
      {
        resourceId: harness.team.skill.id,
        artifactDigest: harness.team.skill.artifact.digest,
        contentDigest: `sha256:${'f'.repeat(64)}` as Digest,
        score: 0.96,
      },
    ];

    const response = await harness.handler(request('/v1/search?q=approved%20skill&limit=5', { headers: bearer() }));
    expect(response?.status).toBe(200);
    const body = await json<{ results: Array<Record<string, unknown>> }>(response!);
    expect(harness.index.queries).toEqual([{ allowedResourceIds: ['skill-team'], profileId: 'test-v1', limit: 5 }]);
    expect(body.results).toEqual([expect.objectContaining({
      resourceId: harness.team.skill.id,
      artifactDigest: harness.team.skill.artifact.digest,
      contentDigest: harness.team.contentDigest,
      text: harness.team.text,
    })]);
  });

  it('reindexes only verified approved documents and removes hidden resources', async () => {
    const harness = await fixture();
    harness.setPrincipal(ownerPrincipal());
    const response = await harness.handler(request('/v1/search/reindex', {
      method: 'POST',
      headers: bearer(),
    }));
    expect(response?.status).toBe(200);
    await expect(json<{ indexed: number; profileId: string }>(response!)).resolves.toEqual({
      indexed: 2,
      profileId: 'test-v1',
      truncated: false,
    });
    expect(harness.index.upserts).toHaveLength(1);
    expect(harness.index.upserts[0]?.map((document) => document.resourceId)).toEqual(['skill-other', 'skill-team']);
  });

  it('paginates reindex work at embedding limits and accepts only returned cursors', async () => {
    const harness = await fixture();
    for (let index = 0; index < 61; index += 1) {
      await addSkill(harness.repository, harness.blobs, {
        id: `skill-batch-${index}`,
        name: `@team/batch-${index}`,
        skillName: `batch-${index}`,
        body: 'A small bounded document for reindex pagination.',
      });
    }
    harness.setPrincipal(ownerPrincipal());

    const first = await harness.handler(request('/v1/search/reindex', {
      method: 'POST',
      headers: bearer(),
      body: {},
    }));
    const firstBody = await json<{ indexed: number; truncated: boolean; nextCursor?: string }>(first!);
    expect(first?.status).toBe(200);
    expect(firstBody).toMatchObject({ indexed: 60, truncated: true });
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await harness.handler(request('/v1/search/reindex', {
      method: 'POST',
      headers: bearer(),
      body: { cursor: firstBody.nextCursor },
    }));
    const secondBody = await json<{ indexed: number; truncated: boolean; nextCursor?: string }>(second!);
    expect(second?.status).toBe(200);
    expect(secondBody).toEqual({ indexed: 3, profileId: 'test-v1', truncated: false });
    expect(harness.index.upserts.map((batch) => batch.length)).toEqual([60, 3]);

    const invalid = await harness.handler(request('/v1/search/reindex', {
      method: 'POST',
      headers: bearer(),
      body: { cursor: 'v1.invalid!' },
    }));
    expect(invalid?.status).toBe(400);
    await expect(json<{ error: { code: string } }>(invalid!)).resolves.toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  });

  it('returns sanitized review runs and implements the frozen reviewer prepare/complete contract', async () => {
    const harness = await fixture();
    harness.setPrincipal(ownerPrincipal());
    const prepare = await harness.handler(request('/internal/reviewer/prepare', {
      method: 'POST',
      headers: { authorization: 'Bearer reviewer-secret' },
      body: { model: 'test-reviewer' },
    }));
    expect(prepare?.status).toBe(200);
    const prepared = await json<{
      runId?: string;
      leaseToken?: string;
      candidates: Array<Record<string, unknown>>;
      alreadyCompleted?: boolean;
    }>(prepare!);
    expect(prepared).toMatchObject({ candidates: expect.any(Array) });
    expect(prepared.runId).toEqual(expect.any(String));
    expect(prepared.leaseToken).toEqual(expect.any(String));
    expect(prepared.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: 'skill-team', description: 'A bounded test skill.' }),
      expect.objectContaining({ resourceId: 'skill-other', description: 'A bounded test skill.' }),
    ]));
    expect(prepared.candidates[0]).not.toHaveProperty('contentDigest');

    const reviewsWhileRunning = await harness.handler(request('/v1/reviews', { headers: bearer() }));
    expect(reviewsWhileRunning?.status).toBe(200);
    const runningBody = await json<{ runs: Array<Record<string, unknown>> }>(reviewsWhileRunning!);
    expect(runningBody.runs[0]).not.toHaveProperty('leaseToken');
    expect(runningBody.runs[0]).not.toHaveProperty('leaseExpiresAt');

    const complete = await harness.handler(request('/internal/reviewer/complete', {
      method: 'POST',
      headers: { authorization: 'Bearer reviewer-secret' },
      body: {
        runId: prepared.runId,
        leaseToken: prepared.leaseToken,
        summary: 'The candidates overlap in bounded registry behavior.',
        suggestions: [{
          skillIds: ['skill-team', 'skill-other'],
          title: 'Shared registry behavior',
          rationale: 'The candidates expose related bounded behavior.',
          overlap: ['Both describe registry behavior.'],
          differences: ['They target different namespaces.'],
          mergePlan: ['Retain namespace boundaries and combine only shared guidance.'],
          similarity: 0.8,
        }],
      },
    }));
    expect(complete?.status).toBe(200);
    const completed = await json<{ suggestions: Array<Record<string, unknown>> }>(complete!);
    expect(completed.suggestions[0]).toMatchObject({
      resourceIds: ['skill-other', 'skill-team'],
      overlap: '- Both describe registry behavior.',
      differences: '- They target different namespaces.',
      mergePlan: '- Retain namespace boundaries and combine only shared guidance.',
    });

    harness.setPrincipal(readerPrincipal());
    const filteredReviews = await harness.handler(request('/v1/reviews', { headers: bearer() }));
    const filteredBody = await json<{
      runs: Array<{ snapshot: Array<{ resourceId: string }>; snapshotValid: boolean }>;
      suggestions: unknown[];
    }>(filteredReviews!);
    expect(filteredBody.runs[0]?.snapshot).toEqual([{ resourceId: 'skill-team', name: '@team/alpha', version: '1.0.0', artifactDigest: harness.team.skill.artifact.digest }]);
    expect(filteredBody.runs[0]?.snapshotValid).toBe(false);
    expect(filteredBody.suggestions).toEqual([]);

    harness.setPrincipal(ownerPrincipal());

    const alreadyCompleted = await harness.handler(request('/internal/reviewer/prepare', {
      method: 'POST',
      headers: { authorization: 'Bearer reviewer-secret' },
      body: { model: 'test-reviewer' },
    }));
    await expect(json(alreadyCompleted!)).resolves.toMatchObject({ alreadyCompleted: true, candidates: [] });
  });

  it('accepts the reviewer bearer token, rejects mismatches, and does not leak it', async () => {
    const harness = await fixture();
    harness.setPrincipal({ ...ownerPrincipal(), roles: ['owner', 'worker'], identity: 'worker' });
    const mixedWorker = await harness.handler(request('/v1/search?q=bounded', { headers: bearer() }));
    expect(mixedWorker?.status).toBe(403);

    harness.setPrincipal(ownerPrincipal());
    const rejected = await harness.handler(request('/internal/reviewer/prepare', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: {},
    }));
    expect(rejected?.status).toBe(401);
    const rejectedBody = await json<{ error: { message: string } }>(rejected!);
    expect(JSON.stringify(rejectedBody)).not.toContain('reviewer-secret');

    const accepted = await harness.handler(request('/internal/reviewer/prepare', {
      method: 'POST',
      headers: { 'x-pskills-reviewer-token': 'reviewer-secret' },
      body: {},
    }));
    expect(accepted?.status).toBe(200);
  });

  it('does not return an active review lease to a duplicate prepare caller', async () => {
    const harness = await fixture();
    const prepare = () => harness.handler(request('/internal/reviewer/prepare', {
      method: 'POST',
      headers: { authorization: 'Bearer reviewer-secret' },
      body: { model: 'test-reviewer' },
    }));
    const responses = await Promise.all([prepare(), prepare()]);
    const bodies = await Promise.all(responses.map((response) => json<{
      runId?: string;
      leaseToken?: string;
      candidates: unknown[];
    }>(response!)));
    expect(bodies.filter((body) => body.leaseToken !== undefined)).toHaveLength(1);
    const duplicate = bodies.find((body) => body.leaseToken === undefined)!;
    expect(duplicate).toMatchObject({ runId: expect.any(String), candidates: [] });
    expect(duplicate).not.toHaveProperty('leaseToken');
  });
});
