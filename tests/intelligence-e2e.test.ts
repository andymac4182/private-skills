import { afterEach, describe, expect, it } from 'vitest';

import {
  TokenAuthenticator,
  type BootstrapTokenConfig,
} from '../packages/auth/src/index.js';
import { createReviewPersistenceService } from '../packages/reviews/src/index.js';
import { StateSemanticIndex } from '../packages/search/src/state.js';
import type { EmbeddingProvider } from '../packages/intelligence/src/embeddings.js';
import { createIntelligenceHandler } from '../packages/intelligence/src/handler.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import { WorkerRunner } from '../workers/runner/src/index.js';
import type {
  InstallAuthorization,
  Job,
  Principal,
  Resolution,
  SkillVersion,
} from '../packages/contracts/src/index.js';
import {
  bearer,
  bundleFor,
  createLocalRegistryHarness,
  jsonResponse,
  request,
  type LocalRegistryHarness,
} from './e2e/harness.js';

const REVIEWER_TOKEN = 'e2e-reviewer-token';
const PROFILE = { id: 'e2e-test-v1', model: 'e2e-test-model', dimensions: 3 } as const;

type JsonObject = Record<string, unknown>;

function vectorFor(value: string): number[] {
  return /\b(?:alpha|first)\b/iu.test(value) ? [1, 0, 0] : [0, 1, 0];
}

function testEmbeddingProvider(): EmbeddingProvider {
  return {
    profile: PROFILE,
    embedMany: async (texts) => texts.map(vectorFor),
    embedQuery: async (text) => vectorFor(text),
  };
}

async function publishAndApprove(
  handler: (request: Request) => Promise<Response>,
  harness: LocalRegistryHarness,
  name: string,
  description: string,
): Promise<{ skill: SkillVersion; bundle: ReturnType<typeof bundleFor> }> {
  const userHeaders = bearer(harness.token);
  const bundle = bundleFor(name.slice(name.indexOf('/') + 1), description);
  const publish = await request(handler, harness.origin, '/v1/publish', {
    method: 'POST',
    headers: userHeaders,
    json: { name, version: '1.0.0', description, bundle },
  });
  expect(publish.status).toBe(202);
  const queued = (await jsonResponse<{ operation: Job }>(publish)).operation;

  const worker = await request(handler, harness.origin, '/internal/jobs/claim', {
    method: 'POST',
    headers: bearer(harness.workerToken),
  });
  expect(worker.status).toBe(200);
  const claimed = (await jsonResponse<{ job: Job }>(worker)).job;
  expect(claimed.id).toBe(queued.id);

  const complete = await request(handler, harness.origin, `/internal/jobs/${encodeURIComponent(queued.id)}/complete`, {
    method: 'POST',
    headers: bearer(harness.workerToken),
    json: { leaseToken: claimed.leaseToken },
  });
  expect(complete.status).toBe(200);

  const skillResponse = await request(handler, harness.origin, `/v1/skills/${encodeURIComponent(queued.resourceId!)}`, {
    headers: userHeaders,
  });
  expect(skillResponse.status).toBe(200);
  const skill = (await jsonResponse<{ skill: SkillVersion }>(skillResponse)).skill;
  expect(skill.state).toBe('approved');
  return { skill, bundle };
}

async function makeComposedHandler(
  harness: LocalRegistryHarness,
  authenticateOverride?: (request: Request) => Promise<Principal | null>,
) {
  const authConfig: BootstrapTokenConfig = {
    id: 'e2e-user',
    token: harness.token,
    organizationId: 'org-e2e',
    subject: 'e2e-user',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: ['@acme'],
    scopes: ['registry:*'],
  };
  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: [authConfig],
    sessionSecret: 'e2e-session-secret-that-is-long-enough',
    publicOrigin: harness.origin,
    allowedOrigins: [harness.origin],
  });
  await auth.ready();
  const blobs = await createNodeFilesSdkBlobStore({
    provider: 'fs',
    root: harness.root,
    prefix: 'private-registry',
  });
  const index = new StateSemanticIndex({ repository: harness.repository, profile: PROFILE });
  const reviewService = createReviewPersistenceService(harness.repository);
  const intelligence = createIntelligenceHandler({
    repository: harness.repository,
    blobs,
    authenticate: authenticateOverride ?? ((request: Request) => auth.authenticate(request)),
    config: {
      organizationId: 'org-e2e',
      publicOrigin: harness.origin,
      reviewerToken: REVIEWER_TOKEN,
    },
    embeddingProvider: testEmbeddingProvider(),
    index,
    reviewService,
    triggerReview: async () => ({ sessionId: 'e2e-review-session', status: 'started' }),
  });
  return async (request: Request): Promise<Response> => await intelligence(request) ?? harness.handler(request);
}

describe('intelligence HTTP integration', () => {
  let harness: LocalRegistryHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('indexes approved releases, serves authorized semantic search, and revokes stale results', async () => {
    harness = await createLocalRegistryHarness();
    const handler = await makeComposedHandler(harness);
    const first = await publishAndApprove(handler, harness, '@acme/alpha-skill', 'alpha first search candidate');
    const second = await publishAndApprove(handler, harness, '@acme/beta-skill', 'beta second search candidate');
    const hidden = await publishAndApprove(handler, harness, '@other/hidden-skill', 'beta hidden namespace candidate');

    const reindex = await request(handler, harness.origin, '/v1/search/reindex', {
      method: 'POST',
      headers: bearer(harness.token),
    });
    expect(reindex.status).toBe(200);
    await expect(jsonResponse<JsonObject>(reindex)).resolves.toMatchObject({
      indexed: 3,
      profileId: PROFILE.id,
      truncated: false,
    });

    const status = await request(handler, harness.origin, '/v1/search/status', {
      headers: bearer(harness.token),
    });
    expect(status.status).toBe(200);
    await expect(jsonResponse<JsonObject>(status)).resolves.toMatchObject({
      status: 'ok',
      profileId: PROFILE.id,
    });

    const search = await request(handler, harness.origin, '/v1/search?q=alpha%20first', {
      headers: bearer(harness.token),
    });
    expect(search.status).toBe(200);
    const searchBody = await jsonResponse<{ results: Array<JsonObject> }>(search);
    expect(searchBody.results).toHaveLength(3);
    expect(searchBody.results[0]).toMatchObject({
      resourceId: first.skill.id,
      name: first.skill.name,
      version: first.skill.version,
      artifactDigest: first.skill.artifact.digest,
      score: 1,
    });
    expect(searchBody.results[0]?.text).toEqual(expect.stringContaining('alpha'));
    expect(searchBody.results.find((result) => result.resourceId === second.skill.id)).toMatchObject({ score: 0 });
    expect(searchBody.results.find((result) => result.resourceId === hidden.skill.id)).toMatchObject({ score: 0 });

    const limitedPrincipal: Principal = {
      organizationId: 'org-e2e',
      subject: 'namespace-reader',
      roles: ['reader'],
      namespaces: ['@acme'],
      scopes: ['search:read'],
    } as Principal & { scopes: string[] };
    const limitedHandler = await makeComposedHandler(harness, async () => limitedPrincipal);
    const limitedSearch = await request(limitedHandler, harness.origin, '/v1/search?q=alpha%20first', {});
    expect(limitedSearch.status).toBe(200);
    const limitedBody = await jsonResponse<{ results: JsonObject[] }>(limitedSearch);
    expect(limitedBody.results.some((result) => result.resourceId === hidden.skill.id)).toBe(false);
    expect(limitedBody.results.some((result) => result.resourceId === first.skill.id)).toBe(true);

    const unauthorized = await request(handler, harness.origin, '/v1/search?q=alpha', {});
    expect(unauthorized.status).toBe(401);

    const resolved = await request(handler, harness.origin, '/v1/resolve', {
      method: 'POST',
      headers: bearer(harness.token),
      json: { kind: 'skill', ref: first.skill.name, version: first.skill.version },
    });
    expect(resolved.status).toBe(200);
    const resolution = (await jsonResponse<{ resolution: Resolution }>(resolved)).resolution;
    const authorization = await request(handler, harness.origin, '/v1/install-authorizations', {
      method: 'POST',
      headers: bearer(harness.token),
      json: { resolution },
    });
    expect(authorization.status).toBe(201);
    const authorizationBody = await jsonResponse<{ authorization: InstallAuthorization }>(authorization);
    const grant = await request(handler, harness.origin, `/v1/artifacts/${encodeURIComponent(first.skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: bearer(harness.token),
      json: { resourceId: first.skill.id, authorizationId: authorizationBody.authorization.id },
    });
    expect(grant.status).toBe(200);
    const descriptor = await jsonResponse<{ url: string }>(grant);

    const revoke = await request(handler, harness.origin, `/v1/skills/${encodeURIComponent(first.skill.id)}/revoke`, {
      method: 'POST',
      headers: bearer(harness.token),
    });
    expect(revoke.status).toBe(200);

    const transferAfterRevoke = await request(handler, harness.origin, new URL(descriptor.url).pathname, {
      headers: bearer(harness.token),
    });
    expect(transferAfterRevoke.status).toBe(409);

    const immediatePostRevokeSearch = await request(handler, harness.origin, '/v1/search?q=alpha%20first', {
      headers: bearer(harness.token),
    });
    expect(immediatePostRevokeSearch.status).toBe(200);
    const immediatePostRevokeBody = await jsonResponse<{ results: JsonObject[] }>(immediatePostRevokeSearch);
    expect(immediatePostRevokeBody.results.some((result) => result.resourceId === first.skill.id)).toBe(false);

    const postRevokeReindex = await request(handler, harness.origin, '/v1/search/reindex', {
      method: 'POST',
      headers: bearer(harness.token),
    });
    expect(postRevokeReindex.status).toBe(200);
    const postRevokeSearch = await request(handler, harness.origin, '/v1/search?q=alpha%20first', {
      headers: bearer(harness.token),
    });
    expect(postRevokeSearch.status).toBe(200);
    const postRevokeBody = await jsonResponse<{ results: Array<JsonObject> }>(postRevokeSearch);
    expect(postRevokeBody.results.some((result) => result.resourceId === first.skill.id)).toBe(false);
  });

  it('runs the reviewer prepare/complete flow, records a decision, and reports a real install receipt', async () => {
    harness = await createLocalRegistryHarness();
    const handler = await makeComposedHandler(harness);
    const first = await publishAndApprove(handler, harness, '@acme/review-alpha', 'alpha review candidate');
    const second = await publishAndApprove(handler, harness, '@acme/review-beta', 'beta review candidate');

    const trigger = await request(handler, harness.origin, '/v1/reviews/run', {
      method: 'POST',
      headers: bearer(harness.token),
    });
    expect(trigger.status).toBe(202);
    await expect(jsonResponse<JsonObject>(trigger)).resolves.toEqual({
      sessionId: 'e2e-review-session',
      status: 'started',
    });

    const prepare = await request(handler, harness.origin, '/internal/reviewer/prepare', {
      method: 'POST',
      headers: { authorization: `Bearer ${REVIEWER_TOKEN}` },
      json: { idempotencyKey: 'e2e-review-2026-09-09', model: 'e2e-reviewer' },
    });
    expect(prepare.status).toBe(200);
    const prepared = await jsonResponse<JsonObject>(prepare);
    expect(prepared.runId).toEqual(expect.any(String));
    expect(prepared.leaseToken).toEqual(expect.any(String));
    expect(prepared.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: first.skill.id, name: first.skill.name, description: first.skill.description }),
      expect.objectContaining({ resourceId: second.skill.id, name: second.skill.name, description: second.skill.description }),
    ]));

    const complete = await request(handler, harness.origin, '/internal/reviewer/complete', {
      method: 'POST',
      headers: { authorization: `Bearer ${REVIEWER_TOKEN}` },
      json: {
        runId: prepared.runId,
        leaseToken: prepared.leaseToken,
        summary: 'Two approved candidates share a review surface.',
        suggestions: [{
          skillIds: [first.skill.id, second.skill.id],
          title: 'Shared search behavior',
          rationale: 'Both candidates expose a bounded search operation.',
          overlap: ['Both expose search behavior.'],
          differences: ['The descriptions differ.'],
          mergePlan: ['Keep the stricter validation.'],
          similarity: 0.8,
        }],
      },
    });
    expect(complete.status).toBe(200);
    const completed = await jsonResponse<JsonObject>(complete);
    expect(completed.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'open', resourceIds: expect.arrayContaining([first.skill.id, second.skill.id]) }),
    ]));
    const suggestion = (completed.suggestions as Array<JsonObject>)[0]!;

    const reviews = await request(handler, harness.origin, '/v1/reviews', {
      headers: bearer(harness.token),
    });
    expect(reviews.status).toBe(200);
    await expect(jsonResponse<JsonObject>(reviews)).resolves.toMatchObject({
      suggestions: expect.arrayContaining([expect.objectContaining({ id: suggestion.id, snapshotValid: true })]),
    });

    const decision = await request(handler, harness.origin, `/v1/reviews/${encodeURIComponent(String(suggestion.id))}/decision`, {
      method: 'POST',
      headers: bearer(harness.token),
      json: { decision: 'accepted' },
    });
    expect(decision.status).toBe(200);
    await expect(jsonResponse<JsonObject>(decision)).resolves.toMatchObject({
      suggestion: { id: suggestion.id, state: 'accepted' },
    });

    const resolved = await request(handler, harness.origin, '/v1/resolve', {
      method: 'POST',
      headers: bearer(harness.token),
      json: { kind: 'skill', ref: first.skill.name, version: first.skill.version },
    });
    expect(resolved.status).toBe(200);
    const resolution = (await jsonResponse<{ resolution: Resolution }>(resolved)).resolution;
    const authorization = await request(handler, harness.origin, '/v1/install-authorizations', {
      method: 'POST',
      headers: bearer(harness.token),
      json: { resolution },
    });
    expect(authorization.status).toBe(201);
    const authorizationBody = await jsonResponse<{ authorization: InstallAuthorization }>(authorization);
    const receipt = await request(handler, harness.origin, '/v1/install-receipts', {
      method: 'POST',
      headers: bearer(harness.token),
      json: {
        authorizationId: authorizationBody.authorization.id,
        changed: true,
        agent: 'codex',
        platform: 'linux',
        clientVersion: 'e2e',
      },
    });
    expect(receipt.status).toBe(201);
    await expect(jsonResponse<JsonObject>(receipt)).resolves.toMatchObject({
      receipt: { resolution: { resourceId: first.skill.id, digest: first.skill.artifact.digest } },
    });

    const analytics = await request(handler, harness.origin, '/v1/analytics?days=1', {
      headers: bearer(harness.token),
    });
    expect(analytics.status).toBe(200);
    await expect(jsonResponse<JsonObject>(analytics)).resolves.toMatchObject({
      totals: { installOperations: 1, skillInstalls: 1 },
    });
  });
});
