import { describe, expect, it } from 'vitest';
import { MemoryStateRepository } from '../../database/src/index.js';
import {
  UploadReviewConflictError,
  UploadReviewLeaseError,
  UploadReviewValidationError,
  createUploadReviewPersistenceService,
  createUploadReviewHttpHandler,
  type UploadReviewBinding,
  type UploadReviewSnapshot,
} from '../src/index.js';

const BASE_TIME = '2026-01-02T03:04:05.000Z';

function digest(letter: string): `sha256:${string}` {
  return `sha256:${letter.repeat(64)}` as `sha256:${string}`;
}

function binding(revision = 1, letter = 'a'): UploadReviewBinding {
  return {
    draftId: 'draft-1',
    draftRevision: revision,
    contentDigest: digest(letter),
    baseReleaseId: 'release-1',
    baseReleaseVersion: '1.2.3',
    baseDigest: digest('b'),
    policyRevision: 'policy-1',
  };
}

function snapshot(): UploadReviewSnapshot {
  return {
    files: [
      { path: 'SKILL.md', kind: 'text', size: 22, digest: digest('c'), text: '# Safe content\n' },
      { path: 'bin/tool', kind: 'binary', size: 8, digest: digest('d') },
    ],
  };
}

async function fixture() {
  const repository = new MemoryStateRepository();
  return {
    repository,
    service: createUploadReviewPersistenceService(repository, { leaseSeconds: 60 }),
  };
}

describe('upload/edit review persistence', () => {
  it('deduplicates the same exact draft revision and fences conflicting idempotency', async () => {
    const { service } = await fixture();
    const input = {
      idempotencyKey: 'draft-1:revision-1',
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.6-luna',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    };
    const [first, second] = await Promise.all([
      service.enqueue('org-a', input),
      service.enqueue('org-a', input),
    ]);
    expect(first.id).toBe(second.id);
    expect((await service.listJobs('org-a'))).toHaveLength(1);

    await expect(service.enqueue('org-a', { ...input, model: 'other/model' })).rejects.toBeInstanceOf(UploadReviewConflictError);
  });

  it('keeps tenants isolated and binds the completion to the leased snapshot', async () => {
    const { repository, service } = await fixture();
    const job = await service.enqueue('org-a', {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.6-luna',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });
    await expect(service.listJobs('org-b')).resolves.toEqual([]);
    await expect(service.claim('org-b', job.id)).rejects.toMatchObject({ code: 'UPLOAD_REVIEW_NOT_FOUND' });

    const claim = await service.claim('org-a', job.id, { eveSessionId: 'eve-session-1', now: BASE_TIME });
    expect(claim.claimed).toBe(true);
    expect(claim.leaseToken).toBeTruthy();
    expect(claim.job.eveSessionId).toBe('eve-session-1');

    const result = await service.complete('org-a', job.id, claim.leaseToken!, {
      findings: [{
        severity: 'high',
        category: 'unsafe-execution',
        title: 'Suspicious execution',
        summary: 'The draft contains a shell execution path.',
        evidence: 'path is metadata only',
        path: 'SKILL.md',
        line: 1,
      }],
      now: '2026-01-02T03:04:30.000Z',
    });
    expect(result.state).toBe('passed');
    expect(result.binding).toEqual(binding());
    expect(result.findings[0]?.path).toBe('SKILL.md');
    expect(result.findings[0]?.decision).toBe('open');
    const findingId = result.findings[0]!.id;
    const acknowledged = await service.updateFindingDecision(
      'org-a',
      result.id,
      findingId,
      'acknowledged',
      'publisher-1',
      '2026-01-02T03:05:05.000Z',
    );
    expect(acknowledged.findings[0]?.decision).toBe('acknowledged');
    expect((await repository.read('org-a')).audit.at(-1)).toMatchObject({
      action: 'upload-review.finding.decision',
      subject: 'publisher-1',
      resourceId: result.id,
      details: { findingId, decision: 'acknowledged' },
    });
    expect((await service.listJobs('org-a'))[0]?.eveSessionId).toBe('eve-session-1');
  });

  it('reclaims an expired lease with fresh Eve provenance and rejects the old lease', async () => {
    const { service } = await fixture();
    const job = await service.enqueue('org-a', {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.6-luna',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });
    const first = await service.claim('org-a', job.id, { eveSessionId: 'old-session', now: BASE_TIME });
    const second = await service.claim('org-a', job.id, {
      eveSessionId: 'new-session',
      now: '2026-01-02T03:06:06.000Z',
    });
    expect(second.claimed).toBe(true);
    expect(second.job.eveSessionId).toBe('new-session');
    await expect(service.complete('org-a', job.id, first.leaseToken!, { findings: [], now: BASE_TIME })).rejects.toBeInstanceOf(UploadReviewLeaseError);
  });

  it('binds one opaque Eve session to one job before the reviewer can claim it', async () => {
    const { service } = await fixture();
    const job = await service.enqueue('org-a', {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.6-luna',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });
    await expect(service.claimForEveSession('org-a', 'eve-session-1', { now: BASE_TIME })).rejects.toMatchObject({ code: 'UPLOAD_REVIEW_NOT_FOUND' });
    const bound = await service.bindEveSession('org-a', job.id, 'eve-session-1', BASE_TIME);
    expect(bound.eveSessionId).toBe('eve-session-1');
    const claim = await service.claimForEveSession('org-a', 'eve-session-1', { now: BASE_TIME });
    expect(claim.claimed).toBe(true);
    const retried = await service.claimForEveSession('org-a', 'eve-session-1', { now: BASE_TIME });
    expect(retried.claimed).toBe(false);
    expect(retried.leaseToken).toBe(claim.leaseToken);
  });

  it('marks old results stale when the draft binding changes and permits explicit requeue', async () => {
    const { service } = await fixture();
    const job = await service.enqueue('org-a', {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.6-luna',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });
    const claim = await service.claim('org-a', job.id, { now: BASE_TIME });
    await service.complete('org-a', job.id, claim.leaseToken!, { findings: [], now: BASE_TIME });
    const stale = await service.markStale('org-a', {
      draftId: 'draft-1',
      current: binding(2, 'e'),
      reason: 'draft revision changed',
      now: '2026-01-02T03:07:07.000Z',
    });
    expect(stale[0]?.state).toBe('stale');
    expect((await service.listResults('org-a'))[0]?.state).toBe('stale');
    const requeued = await service.requeue('org-a', job.id, '2026-01-02T03:08:08.000Z');
    expect(requeued.state).toBe('pending');
    expect(requeued.resultId).toBeUndefined();
  });

  it('rejects hostile paths, duplicate paths, invalid findings, and secret-bearing errors', async () => {
    const { service } = await fixture();
    const baseInput = {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.6-luna',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    };
    await expect(service.enqueue('org-a', {
      ...baseInput,
      snapshot: { files: [{ path: '../SKILL.md', kind: 'text', size: 1, digest: digest('a'), text: 'x' }] },
    })).rejects.toBeInstanceOf(UploadReviewValidationError);
    await expect(service.enqueue('org-a', {
      ...baseInput,
      snapshot: { files: [
        { path: 'SKILL.md', kind: 'text', size: 1, digest: digest('a'), text: 'x' },
        { path: 'skill.md', kind: 'text', size: 1, digest: digest('b'), text: 'y' },
      ] },
    })).rejects.toBeInstanceOf(UploadReviewValidationError);

    const job = await service.enqueue('org-a', baseInput);
    const claim = await service.claim('org-a', job.id, { now: BASE_TIME });
    const failed = await service.fail('org-a', job.id, claim.leaseToken!, 'Bearer super-secret token=abc', BASE_TIME);
    expect(failed.error).not.toContain('super-secret');
    expect(failed.error).toContain('[redacted]');
    await expect(service.complete('org-a', job.id, claim.leaseToken!, { findings: [], now: BASE_TIME })).rejects.toBeInstanceOf(UploadReviewLeaseError);
  });

  it('keeps the upload reviewer route separate and fences session/job mismatches', async () => {
    const { service } = await fixture();
    const job = await service.enqueue('org-a', {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.6-luna',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });
    await service.bindEveSession('org-a', job.id, 'eve-session-1', BASE_TIME);
    const handler = createUploadReviewHttpHandler({
      repository: new MemoryStateRepository(),
      organizationId: 'org-a',
      reviewerToken: 'upload-review-token',
      service,
    });
    const endpoint = (path: string, body: unknown, token = 'upload-review-token') => handler(new Request(`https://registry.test${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));

    const unauthorized = await endpoint('/internal/upload-review/prepare', { sessionId: 'eve-session-1' }, 'wrong-token');
    expect(unauthorized?.status).toBe(401);
    const prepared = await endpoint('/internal/upload-review/prepare', { sessionId: 'eve-session-1' });
    expect(prepared?.status).toBe(200);
    const preparedBody = await prepared!.json() as Record<string, unknown>;
    expect(preparedBody.status).toBe('prepared');
    expect(preparedBody.leaseToken).toEqual(expect.any(String));
    expect((preparedBody.files as unknown[]).length).toBe(2);

    const mismatched = await endpoint('/internal/upload-review/complete', {
      sessionId: 'other-session',
      jobId: preparedBody.jobId,
      leaseToken: preparedBody.leaseToken,
      findings: [],
    });
    expect(mismatched?.status).toBe(404);

    const complete = await endpoint('/internal/upload-review/complete', {
      sessionId: 'eve-session-1',
      jobId: preparedBody.jobId,
      leaseToken: preparedBody.leaseToken,
      findings: [],
    });
    expect(complete?.status).toBe(200);
    expect(await complete!.json()).toMatchObject({ status: 'passed', findingCount: 0 });
  });
});
