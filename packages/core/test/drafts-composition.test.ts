import { describe, expect, it } from 'vitest';
import {
  createRegistryHandler,
  resolveCurrentUploadReviewBinding,
  type RegistryHandlerDependencies,
} from '../src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes } from '../../storage/src/index.js';
import { createUploadReviewHttpHandler } from '../../upload-reviews/src/http.js';
import { createUploadReviewPersistenceService } from '../../upload-reviews/src/index.js';
import type {
  Authenticator,
  BlobStore,
  BundleFile,
  Digest,
  Principal,
  RegistryState,
  SkillDraft,
  SkillVersion,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-test';
const REVIEW_TOKEN = 'upload-review-http-test-token';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class MemoryBlobs implements BlobStore {
  private readonly values = new Map<string, Uint8Array>();
  private nextKey = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const key = `draft-${this.nextKey++}`;
    this.values.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.values.get(key);
    if (!bytes) throw new Error('missing blob');
    return bytes.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function publisher(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'publisher-1',
    roles: ['publisher'],
    namespaces: ['@team'],
    scopes: ['skills:write', 'skills:publish', 'skills:read'],
  };
}

function nativeFiles(revision: number): BundleFile[] {
  return [{
    path: 'SKILL.md',
    content: base64(`---\nname: native-review\ndescription: Revision ${revision}\n---\n# Native review ${revision}\n`),
  }];
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

function request(
  path: string,
  options: { method?: string; body?: unknown; authorization?: string; idempotency?: string } = {},
): Request {
  const headers = new Headers();
  if (options.authorization !== undefined) headers.set('authorization', options.authorization);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.idempotency !== undefined) headers.set('idempotency-key', options.idempotency);
  return new Request(`${ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

interface CompositionFixture {
  state: RegistryState;
  handler: (request: Request) => Promise<Response>;
  repository: ReturnType<typeof createMemoryStateRepository>;
  sessions: string[];
  setPrincipal(principal: Principal | null): void;
}

function fixture(): CompositionFixture {
  const state = defaultRegistryState({ production: false, allowUnscanned: true });
  state.policy.revision = 'policy-test';
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  const blobs = new MemoryBlobs();
  let sessionCounter = 0;
  const sessions: string[] = [];
  const service = createUploadReviewPersistenceService(repository, {
    resolveCurrentBinding: resolveCurrentUploadReviewBinding,
  });
  const integration: NonNullable<RegistryHandlerDependencies['uploadReview']> = {
    service,
    model: 'openai/gpt-5.5',
    reviewerRevision: 'upload-review-test-v1',
    configured: true,
    trigger: async (organizationId, jobId, reviewService) => {
      const sessionId = `eve-upload-${++sessionCounter}`;
      sessions.push(sessionId);
      await reviewService.bindEveSession(organizationId, jobId, sessionId);
      return { sessionId, status: 'started' };
    },
  };
  let currentPrincipal: Principal | null = publisher();
  const auth: Authenticator = {
    authenticate: async (request) => request.headers.get('authorization') === 'Bearer publisher-token'
      ? currentPrincipal
      : null,
  };
  const deps: RegistryHandlerDependencies = {
    repository,
    blobs,
    auth,
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: 2 * 1024 * 1024,
      organizationId: ORGANIZATION,
      leaseSeconds: 30,
    },
    uploadReview: integration,
  };
  const registry = createRegistryHandler(deps);
  const internal = createUploadReviewHttpHandler({
    repository,
    organizationId: ORGANIZATION,
    reviewerToken: REVIEW_TOKEN,
    resolveCurrentBinding: resolveCurrentUploadReviewBinding,
    service,
  });
  return {
    state,
    repository,
    sessions,
    setPrincipal(value) {
      currentPrincipal = value;
    },
    handler: async (incoming) => (await internal(incoming)) ?? registry(incoming),
  };
}

describe('M6 registry/runtime composition', () => {
  it('mounts native upload drafts and fences HTTP review completion and decisions to current revisions', async () => {
    const test = fixture();
    const auth = 'Bearer publisher-token';
    const createdResponse = await test.handler(request('/v1/drafts', {
      method: 'POST',
      authorization: auth,
      idempotency: 'native-create-1',
      body: { name: '@team/native-review', files: nativeFiles(1) },
    }));
    expect(createdResponse.status).toBe(201);
    const created = await json(createdResponse);
    const draft = created.draft;
    expect(draft.origin).toBe('upload');
    expect(test.sessions).toEqual(['eve-upload-1']);

    const afterCreate = await test.repository.read(ORGANIZATION) as RegistryState & {
      uploadReviewJobs?: Array<Record<string, any>>;
    };
    const firstJob = afterCreate.uploadReviewJobs?.[0];
    expect(firstJob).toMatchObject({
      state: 'pending',
      eveSessionId: 'eve-upload-1',
      binding: { draftId: draft.id, draftRevision: 1, contentDigest: draft.digest },
    });

    const prepared = await test.handler(request('/internal/upload-review/prepare', {
      method: 'POST',
      authorization: `Bearer ${REVIEW_TOKEN}`,
      body: { sessionId: 'eve-upload-1' },
    }));
    expect(prepared.status).toBe(200);
    const preparedBody = await json(prepared);
    expect(preparedBody).toMatchObject({ status: 'prepared', jobId: firstJob!.id, draftRevision: 1 });
    expect(typeof preparedBody.leaseToken).toBe('string');

    const completed = await test.handler(request('/internal/upload-review/complete', {
      method: 'POST',
      authorization: `Bearer ${REVIEW_TOKEN}`,
      body: {
        sessionId: 'eve-upload-1',
        jobId: firstJob!.id,
        leaseToken: preparedBody.leaseToken,
        findings: [{
          severity: 'low',
          category: 'style',
          title: 'Native draft note',
          summary: 'The draft has a bounded advisory note.',
          path: 'SKILL.md',
          line: 1,
        }],
      },
    }));
    expect(completed.status).toBe(200);
    const completedBody = await json(completed);
    expect(completedBody.status).toBe('passed');
    const firstResultId = completedBody.resultId as string;

    const updatedResponse = await test.handler(request(`/v1/drafts/${encodeURIComponent(draft.id)}`, {
      method: 'PUT',
      authorization: auth,
      idempotency: 'native-update-2',
      body: { expectedRevision: 1, files: nativeFiles(2) },
    }));
    expect(updatedResponse.status).toBe(200);
    const updated = await json(updatedResponse);
    expect(updated.draft.revision).toBe(2);
    expect(test.sessions).toEqual(['eve-upload-1', 'eve-upload-2']);

    const afterUpdate = await test.repository.read(ORGANIZATION) as RegistryState & {
      uploadReviewJobs?: Array<Record<string, any>>;
      uploadReviewResults?: Array<Record<string, any>>;
    };
    const secondJob = afterUpdate.uploadReviewJobs?.find((job) => job.binding.draftRevision === 2);
    expect(afterUpdate.uploadReviewJobs?.find((job) => job.id === firstJob!.id)).toMatchObject({ state: 'stale' });
    expect(afterUpdate.uploadReviewResults?.find((result) => result.id === firstResultId)).toMatchObject({ state: 'stale' });

    const secondPrepared = await test.handler(request('/internal/upload-review/prepare', {
      method: 'POST',
      authorization: `Bearer ${REVIEW_TOKEN}`,
      body: { sessionId: 'eve-upload-2' },
    }));
    expect(secondPrepared.status).toBe(200);
    const secondPreparedBody = await json(secondPrepared);

    const updatedAgainResponse = await test.handler(request(`/v1/drafts/${encodeURIComponent(draft.id)}`, {
      method: 'PUT',
      authorization: auth,
      idempotency: 'native-update-3',
      body: { expectedRevision: 2, files: nativeFiles(3) },
    }));
    expect(updatedAgainResponse.status).toBe(200);

    const staleCompletion = await test.handler(request('/internal/upload-review/complete', {
      method: 'POST',
      authorization: `Bearer ${REVIEW_TOKEN}`,
      body: {
        sessionId: 'eve-upload-2',
        jobId: secondJob!.id,
        leaseToken: secondPreparedBody.leaseToken,
        findings: [],
      },
    }));
    expect(staleCompletion.status).toBe(200);
    expect((await json(staleCompletion)).status).toBe('stale');

    // The public result contains the finding id; read it from the persisted
    // state so the assertion exercises the stale-result decision gate.
    const finalState = await test.repository.read(ORGANIZATION) as RegistryState & {
      uploadReviewResults?: Array<{ id: string; findings: Array<{ id: string }> }>;
    };
    const findingId = finalState.uploadReviewResults?.find((result) => result.id === firstResultId)?.findings[0]?.id;
    expect(findingId).toBeDefined();
    const decision = await test.handler(request(`/v1/drafts/${encodeURIComponent(draft.id)}/reviews/${encodeURIComponent(firstResultId)}/decisions`, {
      method: 'POST',
      authorization: auth,
      body: { findingId, decision: 'acknowledged' },
    }));
    expect(decision.status).toBe(409);
    expect((await json(decision)).error.code).toBe('REVIEW_CONFLICT');
  });

  it('applies the existing auth and scope boundary to draft routes', async () => {
    const test = fixture();
    const unauthenticated = await test.handler(request('/v1/drafts', {
      method: 'POST',
      idempotency: 'unauthenticated',
      body: { name: '@team/native-review', files: nativeFiles(1) },
    }));
    expect(unauthenticated.status).toBe(401);

    test.setPrincipal({ ...publisher(), scopes: [] });
    const missingScope = await test.handler(request('/v1/drafts', {
      method: 'POST',
      authorization: 'Bearer publisher-token',
      idempotency: 'missing-scope',
      body: { name: '@team/native-review', files: nativeFiles(1) },
    }));
    expect(missingScope.status).toBe(403);
  });

  it('rejects a fork review binding when the approved base artifact digest changed', () => {
    const state = defaultRegistryState({ production: false, allowUnscanned: true });
    state.policy.revision = 'policy-test';
    const baseDigest = `sha256:${'a'.repeat(64)}` as Digest;
    const draftDigest = `sha256:${'b'.repeat(64)}` as Digest;
    const now = new Date().toISOString();
    const base: SkillVersion = {
      id: 'base-release',
      organizationId: ORGANIZATION,
      name: '@team/base-release',
      skillName: 'base-release',
      version: '1.0.0',
      description: 'base release',
      artifact: { key: 'base-artifact', digest: baseDigest, size: 1 },
      state: 'approved',
      policyRevision: 'policy-test',
      createdAt: now,
      approvedAt: now,
      provenance: { kind: 'native' },
      fileCount: 1,
      scanIds: [],
    };
    const draft: SkillDraft = {
      id: 'fork-draft',
      organizationId: ORGANIZATION,
      origin: 'release',
      name: '@team/fork-draft',
      skillName: 'fork-draft',
      description: 'fork draft',
      baseResourceId: base.id,
      baseDigest: draftDigest,
      revision: 1,
      digest: draftDigest,
      artifact: { key: 'draft-artifact', digest: draftDigest, size: 1 },
      files: [],
      status: 'open',
      actor: 'publisher-1',
      createdAt: now,
      updatedAt: now,
    };
    state.skills.push(base);
    state.drafts = [draft];

    expect(resolveCurrentUploadReviewBinding(state, draft.id)).toBeUndefined();
    draft.baseDigest = baseDigest;
    expect(resolveCurrentUploadReviewBinding(state, draft.id)).toMatchObject({
      baseReleaseId: base.id,
      baseDigest,
    });
  });
});
