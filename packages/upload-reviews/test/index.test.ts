import { describe, expect, it } from 'vitest';
import { MemoryStateRepository } from '../../database/src/index.js';
import {
  UploadReviewBindingStaleError,
  UploadReviewConflictError,
  UploadReviewLeaseError,
  UploadReviewValidationError,
  createUploadReviewPersistenceService,
  createUploadReviewSnapshot,
  type UploadReviewBinding,
  type UploadReviewSnapshot,
} from '../src/index.js';
import { createUploadReviewHttpHandler } from '../src/http.js';

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

  it('includes the configured model in generated idempotency keys', async () => {
    const { service } = await fixture();
    const first = await service.enqueue('org-a', {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.5',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });
    const second = await service.enqueue('org-a', {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('rejects stale enqueue/requeue and fences active claims through the transaction binding resolver', async () => {
    const repository = new MemoryStateRepository();
    let current = binding();
    const service = createUploadReviewPersistenceService(repository, {
      resolveCurrentBinding: (_state, draftId) => draftId === current.draftId ? current : undefined,
    });
    const job = await service.enqueue('org-a', {
      binding: current,
      snapshot: snapshot(),
      model: 'openai/gpt-5.5',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });

    current = binding(2, 'e');
    await expect(service.enqueue('org-a', {
      binding: binding(),
      snapshot: snapshot(),
      model: 'openai/gpt-5.5',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    })).rejects.toBeInstanceOf(UploadReviewBindingStaleError);

    const claim = await service.claim('org-a', job.id, { eveSessionId: 'eve-session-1', now: BASE_TIME });
    expect(claim.claimed).toBe(false);
    expect(claim.job.state).toBe('stale');
    expect((await service.listResults('org-a'))[0]?.state).toBe('stale');
    await expect(service.requeue('org-a', job.id, BASE_TIME)).rejects.toBeInstanceOf(UploadReviewBindingStaleError);
  });

  it('rejects completion and finding decisions after the current binding changes', async () => {
    const repository = new MemoryStateRepository();
    let current = binding();
    const service = createUploadReviewPersistenceService(repository, {
      resolveCurrentBinding: (_state, draftId) => draftId === current.draftId ? current : undefined,
    });
    const job = await service.enqueue('org-a', {
      binding: current,
      snapshot: snapshot(),
      model: 'openai/gpt-5.5',
      reviewerRevision: 'upload-reviewer-v1',
      now: BASE_TIME,
    });
    const claim = await service.claim('org-a', job.id, { eveSessionId: 'eve-session-1', now: BASE_TIME });
    current = binding(2, 'e');

    const stale = await service.complete('org-a', job.id, claim.leaseToken!, { findings: [], now: BASE_TIME });
    expect(stale.state).toBe('stale');
    await expect(service.updateFindingDecision(
      'org-a',
      stale.id,
      'missing-finding',
      'acknowledged',
      'publisher-1',
      BASE_TIME,
    )).rejects.toBeInstanceOf(UploadReviewBindingStaleError);
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
        summary: 'The draft contains a shell execution path.\nThe path is reviewed as quoted data.',
        evidence: 'path is metadata only\n\tno file was executed',
        recommendation: 'Keep the path inert.\r\nRequire explicit human review.',
        path: 'SKILL.md',
        line: 1,
      }],
      now: '2026-01-02T03:04:30.000Z',
    });
    expect(result.state).toBe('passed');
    expect(result.binding).toEqual(binding());
    expect(result.findings[0]?.path).toBe('SKILL.md');
    expect(result.findings[0]?.summary).toBe('The draft contains a shell execution path.\nThe path is reviewed as quoted data.');
    expect(result.findings[0]?.evidence).toBe('path is metadata only\n\tno file was executed');
    expect(result.findings[0]?.recommendation).toBe('Keep the path inert.\r\nRequire explicit human review.');
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
    await expect(service.updateFindingDecision(
      'org-a',
      result.id,
      findingId,
      'dismissed',
      'publisher-1',
      '2026-01-02T03:05:06.000Z',
    )).rejects.toMatchObject({ code: 'INVALID_UPLOAD_REVIEW_INPUT' });
    const dismissed = await service.updateFindingDecision(
      'org-a',
      result.id,
      findingId,
      'dismissed',
      'publisher-1',
      { reason: 'Reviewed and accepted as an intentional design choice.', now: '2026-01-02T03:05:07.000Z' },
    );
    expect(dismissed.findings[0]).toMatchObject({ decision: 'dismissed', decisionReason: 'Reviewed and accepted as an intentional design choice.' });
    expect((await repository.read('org-a')).audit.at(-1)).toMatchObject({
      action: 'upload-review.finding.decision',
      subject: 'publisher-1',
      resourceId: result.id,
      details: { findingId, decision: 'dismissed', reason: 'Reviewed and accepted as an intentional design choice.' },
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

  it('marks old results stale when the reviewer contract changes', async () => {
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
      current: binding(),
      reviewerRevision: 'upload-reviewer-v2',
      model: 'openai/gpt-5.6-luna',
      reason: 'reviewer contract changed',
      now: '2026-01-02T03:09:09.000Z',
    });
    expect(stale[0]?.state).toBe('stale');
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
    await expect(service.enqueue('org-a', {
      ...baseInput,
      snapshot: { files: [{ path: 'SKILL.md', kind: 'text', size: 3, digest: digest('a'), text: 'a\u0000b' }] },
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

  it('creates a metadata-only snapshot for binary and oversized files', async () => {
    const text = new TextEncoder().encode('# Safe\n');
    const binary = Uint8Array.from([0, 255, 1]);
    const oversized = new TextEncoder().encode('x'.repeat(16_001));
    const encode = (bytes: Uint8Array) => {
      let value = '';
      for (const byte of bytes) value += String.fromCharCode(byte);
      return btoa(value);
    };
    const snapshot = await createUploadReviewSnapshot([
      { path: 'SKILL.md', content: encode(text) },
      { path: 'tool.bin', content: encode(binary) },
      { path: 'notes.txt', content: encode(oversized) },
    ]);
    expect(snapshot.files.find((file) => file.path === 'SKILL.md')).toMatchObject({ kind: 'text', text: '# Safe\n' });
    expect(snapshot.files.find((file) => file.path === 'tool.bin')).toMatchObject({ kind: 'binary', size: 3 });
    expect(snapshot.files.find((file) => file.path === 'notes.txt')).toMatchObject({ kind: 'oversize', size: 16_001 });
    expect(snapshot.files.find((file) => file.path === 'tool.bin')).not.toHaveProperty('text');
  });

  it('preserves multiline text and falls back to whole-file metadata at the aggregate limit', async () => {
    const encode = (value: string) => {
      const bytes = new TextEncoder().encode(value);
      let encoded = '';
      for (const byte of bytes) encoded += String.fromCharCode(byte);
      return btoa(encoded);
    };
    const files = Array.from({ length: 11 }, (_, index) => ({
      path: `docs/file-${String(index + 1).padStart(2, '0')}.md`,
      content: encode('line one\r\n\tline two\n' + 'x'.repeat(15_976)),
    }));
    const result = await createUploadReviewSnapshot(files);
    expect(result.files.slice(0, 10).every((file) => file.kind === 'text')).toBe(true);
    expect(result.files[0]?.text?.startsWith('line one\r\n\tline two\n')).toBe(true);
    expect(result.files[10]).toMatchObject({ path: 'docs/file-11.md', kind: 'oversize' });
    expect(result.files[10]).not.toHaveProperty('text');
  });

  it('classifies valid UTF-8 with unsupported controls as metadata-only', async () => {
    const bytes = new TextEncoder().encode('safe\u0000content');
    let encoded = '';
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    const result = await createUploadReviewSnapshot([{ path: 'notes.md', content: btoa(encoded) }]);
    expect(result.files[0]).toMatchObject({ path: 'notes.md', kind: 'binary', size: bytes.byteLength });
    expect(result.files[0]).not.toHaveProperty('text');
  });
});
