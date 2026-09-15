import { describe, expect, it, vi } from 'vitest';
import type { Principal, RegistryState, ScanResult, SkillVersion } from '../../../packages/contracts/src/index.js';
import { defaultRegistryState } from '../../../packages/database/src/state.js';
import { MemoryStateRepository } from '../../../packages/database/src/memory.js';
import { BillingService, createMemoryBillingRepository } from '../../../packages/billing/src/index.js';
import type { ReviewRun } from '../../../packages/reviews/src/index.js';
import type { UploadReviewJob } from '../../../packages/upload-reviews/src/index.js';
import {
  OPERATIONS_STATUS_ROUTE_PATH,
  createOperationsStatusHandler,
  type OperationsStatusResponse,
} from '../server/operations-status.js';

const NOW = Date.parse('2026-09-16T00:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;

function skill(organizationId: string): SkillVersion {
  return {
    id: `${organizationId}-skill`,
    organizationId,
    name: '@acme/review',
    skillName: '@acme/review',
    version: '1.0.0',
    description: 'A test release',
    artifact: { key: `${organizationId}-artifact`, digest: DIGEST, size: 12 },
    state: 'approved',
    policyRevision: 'policy-a',
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    approvedAt: new Date(NOW - 3_500_000).toISOString(),
    provenance: { kind: 'native' },
    fileCount: 1,
    scanIds: [`${organizationId}-scan`],
  };
}

function scan(organizationId: string): ScanResult {
  return {
    id: `${organizationId}-scan`,
    organizationId,
    jobId: `${organizationId}-scan-job`,
    artifactDigest: DIGEST,
    policyRevision: 'policy-a',
    scannerId: 'cisco-skill-scanner',
    engineVersion: '1.0.0',
    rulesRevision: 'rules-a',
    configurationHash: 'config-a',
    status: 'completed',
    findings: [],
    coverage: {
      filesEnumerated: 1,
      filesAnalyzed: 1,
      filesSkipped: 0,
      filesUnsupported: 0,
      limitations: [],
      externalDestinations: [],
    },
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    durationMs: 10,
  };
}

function stateFor(organizationId: string): RegistryState {
  const state = defaultRegistryState({ production: true, policyRevision: 'policy-a', evidenceMaxAgeSeconds: 60 });
  state.skills = [skill(organizationId)];
  state.scans = [scan(organizationId)];
  state.jobs = [
    {
      id: `${organizationId}-queued`,
      organizationId,
      kind: 'import',
      state: 'queued',
      policyRevision: 'policy-a',
      policy: state.policy,
      createdAt: new Date(NOW - 125_000).toISOString(),
      updatedAt: new Date(NOW - 120_000).toISOString(),
      attempts: 1,
      error: 'queue secret must never be returned',
    },
    {
      id: `${organizationId}-failed`,
      organizationId,
      kind: 'scan',
      state: 'failed',
      policyRevision: 'policy-a',
      policy: state.policy,
      createdAt: new Date(NOW - 300_000).toISOString(),
      updatedAt: new Date(NOW - 200_000).toISOString(),
      attempts: 2,
      error: 'provider token and report excerpt must never be returned',
    },
    {
      id: `${organizationId}-scan-job`,
      organizationId,
      kind: 'scan',
      state: 'completed',
      policyRevision: 'policy-a',
      policy: state.policy,
      createdAt: new Date(NOW - 3_700_000).toISOString(),
      updatedAt: new Date(NOW - 2_000).toISOString(),
      attempts: 1,
    },
  ];
  const extension = state as RegistryState & {
    reviewRuns: Array<Pick<ReviewRun, 'id' | 'organizationId' | 'state' | 'finishedAt' | 'createdAt' | 'error'>>;
    uploadReviewJobs: Array<Pick<UploadReviewJob, 'id' | 'organizationId' | 'state' | 'finishedAt' | 'updatedAt' | 'createdAt' | 'error' | 'staleReason'>>;
  };
  extension.reviewRuns = [{
    id: 'run-a', organizationId, state: 'failed', createdAt: new Date(NOW - 90_000).toISOString(),
    finishedAt: new Date(NOW - 60_000).toISOString(), error: 'eve secret and report prose',
  }];
  extension.uploadReviewJobs = [
    { id: 'upload-failed', organizationId, state: 'failed', createdAt: new Date(NOW - 80_000).toISOString(), updatedAt: new Date(NOW - 70_000).toISOString(), error: 'provider secret' },
    { id: 'upload-stale', organizationId, state: 'stale', createdAt: new Date(NOW - 70_000).toISOString(), updatedAt: new Date(NOW - 50_000).toISOString(), staleReason: 'report excerpt' },
  ];
  return state;
}

function principal(organizationId: string, roles: Principal['roles'], scopes?: string[]): Principal {
  return { organizationId, subject: `${organizationId}-subject`, roles, ...(scopes === undefined ? {} : { scopes }) };
}

function request(token: string, path = OPERATIONS_STATUS_ROUTE_PATH, method = 'GET'): Request {
  return new Request(`https://registry.example${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('company operations status route', () => {
  const repository = new MemoryStateRepository({
    initial: { 'org-a': stateFor('org-a'), 'org-b': defaultRegistryState() },
  });
  const billing = new BillingService({
    repository: createMemoryBillingRepository({ now: () => NOW }),
    enabled: false,
  });
  const principals: Record<string, Principal> = {
    'owner-a': principal('org-a', ['owner']),
    'owner-a-scoped': principal('org-a', ['owner'], ['operations:read']),
    'reader-a': principal('org-a', ['reader'], ['operations:read']),
    'wrong-org-admin': principal('org-b', ['admin'], ['operations:read']),
    'worker-a': principal('org-a', ['worker'], ['jobs:claim']),
    'owner-a-wrong-scope': principal('org-a', ['owner'], ['registry:read']),
  };
  const authenticate = vi.fn(async (incoming: Request) => {
    const token = incoming.headers.get('authorization')?.replace(/^Bearer\s+/u, '');
    return token ? principals[token] ?? null : null;
  });
  const handler = createOperationsStatusHandler({
    repository,
    billing,
    authenticate,
    organizationId: 'org-a',
    eveConfigured: true,
    now: () => NOW,
  });

  it('projects queue age, scan freshness, Eve failures, and billing state without sensitive text', async () => {
    const response = await handler(request('owner-a'));
    expect(response?.status).toBe(200);
    const body = await response?.json() as OperationsStatusResponse;
    expect(body.organizationId).toBe('org-a');
    expect(body.queue).toMatchObject({ state: 'attention', queued: 1, running: 0, failed: 1, oldestActiveAgeSeconds: 125 });
    expect(body.scans).toMatchObject({ state: 'attention', enabledScannerCount: 3, requiredScannerCount: 1, evidenceMaxAgeSeconds: 60, latestCompletedAt: new Date(NOW - 2_000).toISOString() });
    expect(body.scans.skills).toEqual({ total: 1, current: 0, stale: 1, failed: 0, blocked: 0, unavailable: 0 });
    expect(body.eve).toMatchObject({ state: 'attention', latestFailureAt: new Date(NOW - 50_000).toISOString() });
    expect(body.eve.consolidationRuns).toEqual({ total: 1, running: 0, completed: 0, failed: 1 });
    expect(body.eve.uploadReviews).toEqual({ total: 2, pending: 0, running: 0, passed: 0, failed: 1, stale: 1 });
    expect(body.billing.state).toBe('disabled');
    expect(body.billing.usageState).toBe('available');
    expect(body.auth).toMatchObject({ state: 'unavailable', authenticationFailures: null, callbackFailures: null });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('report');
  });

  it('keeps organization and owner/admin scope boundaries at the route', async () => {
    expect((await handler(request('wrong-org-admin')))?.status).toBe(403);
    expect((await handler(request('reader-a')))?.status).toBe(403);
    expect((await handler(request('worker-a')))?.status).toBe(403);
    expect((await handler(request('owner-a-wrong-scope')))?.status).toBe(403);
    expect((await handler(request('owner-a-scoped')))?.status).toBe(200);
  });

  it('returns explicit auth, method, and Eve-unavailable states', async () => {
    expect((await handler(request('unknown')))?.status).toBe(401);
    expect((await handler(request('owner-a', OPERATIONS_STATUS_ROUTE_PATH, 'POST')))?.status).toBe(405);
    expect(await handler(request('owner-a', '/v1/operations'))).toBeUndefined();
    const unavailable = createOperationsStatusHandler({
      repository,
      billing,
      authenticate,
      organizationId: 'org-a',
      now: () => NOW,
    });
    const body = await (await unavailable(request('owner-a')))?.json() as OperationsStatusResponse;
    expect(body.eve.state).toBe('unavailable');
    expect(body.eve.reason).toContain('not configured');
  });
});
