import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegistryState, SkillVersion } from '../../contracts/src/index.js';
import { FileStateRepository, MemoryStateRepository } from '../../database/src/index.js';
import {
  DefaultReviewPersistenceService,
  ReviewDecisionConflictError,
  ReviewLeaseError,
  ReviewServiceError,
  ReviewValidationError,
  createReviewPersistenceService,
  type ReviewSkillSnapshot,
  type ReviewSuggestionProposal,
} from '../src/index.js';

const baseTime = '2026-01-02T03:04:05.000Z';
type ReviewStateForTest = RegistryState & {
  reviewRuns?: unknown[];
  reviewSuggestions?: unknown[];
};

function digest(letter: string): `sha256:${string}` {
  return `sha256:${letter.repeat(64)}` as `sha256:${string}`;
}

function skill(
  organizationId: string,
  id: string,
  letter: string,
  version = '1.0.0',
): SkillVersion {
  return {
    id,
    organizationId,
    name: `skill-${id}`,
    skillName: `skill-${id}`,
    version,
    description: 'test skill',
    artifact: { key: `${id}.bundle`, digest: digest(letter), size: 10 },
    state: 'approved',
    policyRevision: 'policy-initial',
    createdAt: baseTime,
    approvedAt: baseTime,
    provenance: { kind: 'native' },
    fileCount: 1,
    scanIds: [],
  };
}

function snapshotOf(...items: SkillVersion[]): ReviewSkillSnapshot[] {
  return items.map((item) => ({
    resourceId: item.id,
    name: item.name,
    version: item.version,
    artifactDigest: item.artifact.digest,
  }));
}

function proposal(resourceIds: string[]): ReviewSuggestionProposal {
  return {
    resourceIds,
    title: 'Shared implementation',
    rationale: 'The candidates provide overlapping behavior.',
    overlap: 'Both expose the same public operation.',
    differences: 'The implementation details differ.',
    mergePlan: 'Keep the stricter validation and merge the documented behavior.',
    similarity: 0.74,
  };
}

async function fixture() {
  const repository = new MemoryStateRepository();
  const first = skill('org-a', 'skill-a', 'a');
  const second = skill('org-a', 'skill-b', 'b');
  const third = skill('org-a', 'skill-c', 'c');
  await repository.transaction('org-a', (state) => {
    state.skills.push(first, second, third);
  });
  return {
    repository,
    first,
    second,
    third,
    service: createReviewPersistenceService(repository),
  };
}

describe('review persistence service', () => {
  it('atomically deduplicates concurrent daily claims', async () => {
    const { service, first, second, repository } = await fixture();
    const input = {
      idempotencyKey: 'daily-2026-01-02',
      model: 'eve-reviewer',
      eveSessionId: 'eve-session-test-opaque',
      provenance: {
        source: 'eve-schedule' as const,
        invocationId: 'eve-review-invocation_first',
        scheduleId: 'daily-review',
        observedAt: baseTime,
      },
      snapshot: snapshotOf(first, second),
      now: baseTime,
    };
    const claims = await Promise.all([
      service.beginRun('org-a', input),
      service.beginRun('org-a', input),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims[0]?.run.id).toBe(claims[1]?.run.id);
    expect(claims[0]?.run.eveSessionId).toBe('eve-session-test-opaque');
    expect(claims[0]?.run.provenance).toEqual(input.provenance);
    expect((await service.listRuns('org-a')).map((run) => run.id)).toHaveLength(1);
    expect((await repository.read('org-a') as ReviewStateForTest).reviewRuns).toHaveLength(1);

    const winner = claims.find((claim) => claim.claimed)!;
    await service.completeRun('org-a', winner.run.id, winner.run.leaseToken!, [], baseTime);
    const completedRead = await service.beginRun('org-a', {
      idempotencyKey: input.idempotencyKey,
      model: input.model,
      snapshot: input.snapshot,
      now: baseTime,
    });
    expect(completedRead.claimed).toBe(false);
    expect(completedRead.run.eveSessionId).toBe('eve-session-test-opaque');
    expect(completedRead.run.provenance).toEqual(input.provenance);
  });

  it('fences stale leases and permits failed and expired retries', async () => {
    const { service, first, second } = await fixture();
    const firstClaim = await service.beginRun('org-a', {
      idempotencyKey: 'retryable',
      model: 'eve-reviewer',
      eveSessionId: 'eve-session-failed-old',
      snapshot: snapshotOf(first, second),
      now: baseTime,
    });
    const failed = await service.failRun(
      'org-a',
      firstClaim.run.id,
      firstClaim.run.leaseToken!,
      'Bearer top-secret token=abc',
      baseTime,
    );
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('[redacted]');
    expect(failed.error).not.toContain('top-secret');

    const retry = await service.beginRun('org-a', {
      idempotencyKey: 'retryable',
      model: 'eve-reviewer',
      snapshot: snapshotOf(first, second),
      now: baseTime,
    });
    expect(retry.claimed).toBe(true);
    expect(retry.run.id).toBe(firstClaim.run.id);
    expect(retry.run.leaseToken).not.toBe(firstClaim.run.leaseToken);
    expect(retry.run.eveSessionId).toBeUndefined();
    expect(retry.run.provenance).toBeUndefined();
    await expect(
      service.failRun('org-a', retry.run.id, firstClaim.run.leaseToken!, 'stale', baseTime),
    ).rejects.toMatchObject({ code: 'REVIEW_LEASE_FENCED' });

    const otherFixture = await fixture();
    const expiringService = createReviewPersistenceService(otherFixture.repository, { leaseSeconds: 1 });
    const expiringClaim = await expiringService.beginRun('org-a', {
      idempotencyKey: 'expired',
      model: 'eve-reviewer',
      eveSessionId: 'eve-session-expired-old',
      provenance: {
        source: 'eve-schedule',
        invocationId: 'eve-review-invocation_old',
        scheduleId: 'daily-review',
        observedAt: baseTime,
      },
      snapshot: snapshotOf(otherFixture.first, otherFixture.second),
      now: baseTime,
    });
    const reclaimed = await expiringService.beginRun('org-a', {
      idempotencyKey: 'expired',
      model: 'eve-reviewer',
      eveSessionId: 'eve-session-expired-new',
      provenance: {
        source: 'eve-schedule',
        invocationId: 'eve-review-invocation_new',
        scheduleId: 'daily-review',
        observedAt: new Date(Date.parse(baseTime) + 2_000).toISOString(),
      },
      snapshot: snapshotOf(otherFixture.first, otherFixture.second),
      now: Date.parse(baseTime) + 2_000,
    });
    expect(reclaimed.claimed).toBe(true);
    expect(reclaimed.run.eveSessionId).toBe('eve-session-expired-new');
    expect(reclaimed.run.provenance).toEqual({
      source: 'eve-schedule',
      invocationId: 'eve-review-invocation_new',
      scheduleId: 'daily-review',
      observedAt: new Date(Date.parse(baseTime) + 2_000).toISOString(),
    });
    await expect(
      expiringService.completeRun('org-a', expiringClaim.run.id, expiringClaim.run.leaseToken!, [], Date.parse(baseTime) + 2_000),
    ).rejects.toMatchObject({ code: 'REVIEW_LEASE_FENCED' });
  });

  it('rejects unsafe Eve session provenance before creating a run', async () => {
    const { service, first, second } = await fixture();
    const input = {
      idempotencyKey: 'invalid-eve-session',
      model: 'eve-reviewer',
      snapshot: snapshotOf(first, second),
      now: baseTime,
    };
    await expect(service.beginRun('org-a', { ...input, eveSessionId: 'eve\nsession' }))
      .rejects.toBeInstanceOf(ReviewValidationError);
    await expect(service.beginRun('org-a', { ...input, eveSessionId: 'x'.repeat(257) }))
      .rejects.toBeInstanceOf(ReviewValidationError);
    expect(await service.listRuns('org-a')).toEqual([]);
  });

  it('validates trigger provenance and does not retain private or provider fields', async () => {
    const { service, first, second } = await fixture();
    const input = {
      idempotencyKey: 'provenance-shape',
      model: 'eve-reviewer',
      eveSessionId: 'eve-session-provenance',
      snapshot: snapshotOf(first, second),
      now: baseTime,
    };
    const apiClaim = await service.beginRun('org-a', {
      ...input,
      provenance: {
        source: 'api',
        invocationId: 'eve-review-invocation-api',
        observedAt: baseTime,
      },
    });
    expect(apiClaim.run.provenance).toEqual({
      source: 'api',
      invocationId: 'eve-review-invocation-api',
      observedAt: baseTime,
    });
    expect(apiClaim.run.provenance).not.toHaveProperty('attributes');
    expect(apiClaim.run.provenance).not.toHaveProperty('requestId');

    for (const provenance of [
      { source: 'eve-schedule', invocationId: 'invocation', observedAt: baseTime },
      { source: 'api', invocationId: 'invocation', scheduleId: 'daily-review', observedAt: baseTime },
      { source: 'api', invocationId: 'invocation', observedAt: 'not-a-date' },
    ]) {
      await expect(service.beginRun('org-a', {
        ...input,
        idempotencyKey: `bad-${JSON.stringify(provenance)}`,
        provenance: provenance as never,
      })).rejects.toBeInstanceOf(ReviewValidationError);
    }
  });

  it('rejects invented candidates and malformed model output without committing', async () => {
    const { service, first, second, repository } = await fixture();
    await expect(
      service.beginRun('org-a', {
        idempotencyKey: 'bad-digest',
        model: 'eve-reviewer',
        snapshot: [{ ...snapshotOf(first)[0]!, artifactDigest: digest('f') }],
        now: baseTime,
      }),
    ).rejects.toBeInstanceOf(ReviewValidationError);

    const claim = await service.beginRun('org-a', {
      idempotencyKey: 'malformed',
      model: 'eve-reviewer',
      snapshot: snapshotOf(first, second),
      now: baseTime,
    });
    await expect(
      service.completeRun('org-a', claim.run.id, claim.run.leaseToken!, [proposal(['skill-a', 'invented'])], baseTime),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_INPUT' });
    await expect(
      service.completeRun('org-a', claim.run.id, claim.run.leaseToken!, [{ ...proposal(['skill-a']), similarity: Number.NaN }], baseTime),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_INPUT' });
    await expect(
      service.completeRun('org-a', claim.run.id, claim.run.leaseToken!, [{ ...proposal(['skill-a', 'skill-b']), title: 'x'.repeat(257) }], baseTime),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_INPUT' });

    const persisted = await repository.read('org-a');
    expect((persisted as ReviewStateForTest).reviewRuns).toHaveLength(1);
    expect((persisted as ReviewStateForTest).reviewRuns?.[0]).toMatchObject({ state: 'running' });
    expect((persisted as ReviewStateForTest).reviewSuggestions ?? []).toHaveLength(0);
  });

  it('stores server-owned snapshot identities and isolates decisions from artifacts', async () => {
    const { service, first, second, repository } = await fixture();
    const claim = await service.beginRun('org-a', {
      idempotencyKey: 'complete',
      model: 'eve-reviewer',
      snapshot: snapshotOf(first, second),
      now: baseTime,
    });
    const completed = await service.completeRun(
      'org-a',
      claim.run.id,
      claim.run.leaseToken!,
      [{ ...proposal(['skill-b', 'skill-a']), snapshot: snapshotOf(second, first) }],
      baseTime,
    );
    expect(completed.run.state).toBe('completed');
    expect(completed.suggestions[0]?.resourceIds).toEqual(['skill-a', 'skill-b']);
    expect(completed.suggestions[0]?.snapshot.map((entry) => entry.artifactDigest)).toEqual([digest('a'), digest('b')]);
    expect(completed.suggestions[0]?.state).toBe('open');
    const beforeSkills = (await repository.read('org-a')).skills;

    const accepted = await service.decideSuggestion('org-a', completed.suggestions[0]!.id, 'accepted', 'owner', baseTime);
    expect(accepted.state).toBe('accepted');
    expect(accepted.decidedBy).toBe('owner');
    await expect(
      service.decideSuggestion('org-a', accepted.id, 'dismissed', 'other', baseTime),
    ).rejects.toBeInstanceOf(ReviewDecisionConflictError);
    expect((await repository.read('org-a')).skills).toEqual(beforeSkills);
  });

  it('treats absent review collections as legacy-safe and enforces organization isolation', async () => {
    const { service, first, second, repository } = await fixture();
    const legacy = await repository.read('org-a');
    expect((legacy as ReviewStateForTest).reviewRuns).toBeUndefined();
    expect(await service.listRuns('org-a')).toEqual([]);
    expect(await service.listSuggestions('org-a')).toEqual([]);

    const orgB = skill('org-b', 'skill-b-only', 'd');
    const orgBSecond = skill('org-b', 'skill-b-second', 'e');
    await repository.transaction('org-b', (state) => { state.skills.push(orgB, orgBSecond); });
    const orgBClaim = await service.beginRun('org-b', {
      key: 'org-b-only',
      model: 'eve-reviewer',
      snapshot: snapshotOf(orgB, orgBSecond),
      now: baseTime,
    });
    await service.completeRun('org-b', orgBClaim.run.id, orgBClaim.run.leaseToken!, [proposal(['skill-b-only', 'skill-b-second'])], baseTime);
    expect(await service.listSuggestions('org-a')).toEqual([]);
    expect(await service.listSuggestions('org-b')).toHaveLength(1);

    const claim = await service.beginRun('org-a', {
      idempotencyKey: 'org-a-only',
      model: 'eve-reviewer',
      snapshot: snapshotOf(first, second),
      now: baseTime,
    });
    await service.completeRun('org-a', claim.run.id, claim.run.leaseToken!, [proposal(['skill-a', 'skill-b'])], baseTime);
    expect(await service.listSuggestions('org-a')).toHaveLength(1);
    expect(await service.listSuggestions('org-b')).toHaveLength(1);
  });

  it('reloads persisted runs and suggestions through the durable file repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), `private-skills-reviews-${crypto.randomUUID()}-`));
    try {
      const firstRepository = new FileStateRepository(directory);
      const first = skill('org-file', 'file-a', 'a');
      const second = skill('org-file', 'file-b', 'b');
      await firstRepository.transaction('org-file', (state) => { state.skills.push(first, second); });
      const firstService = createReviewPersistenceService(firstRepository);
      const claim = await firstService.beginRun('org-file', {
        key: 'durable',
        model: 'eve-reviewer',
        snapshot: snapshotOf(first, second),
        now: baseTime,
      });
      await firstService.completeRun('org-file', claim.run.id, claim.leaseToken!, [proposal(['file-a', 'file-b'])], baseTime);

      const reloadedService = createReviewPersistenceService(new FileStateRepository(directory));
      expect(await reloadedService.listRuns('org-file')).toHaveLength(1);
      expect(await reloadedService.listSuggestions('org-file')).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('caps candidate and proposal amplification', async () => {
    const { service, first, second } = await fixture();
    const tooManyCandidates = Array.from({ length: 61 }, (_, index) => ({
      resourceId: `resource-${index}`,
      name: 'candidate',
      version: '1.0.0',
      artifactDigest: digest('a'),
    }));
    await expect(
      service.beginRun('org-a', { idempotencyKey: 'too-many', model: 'eve', snapshot: tooManyCandidates, now: baseTime }),
    ).rejects.toBeInstanceOf(ReviewValidationError);

    const claim = await service.beginRun('org-a', {
      idempotencyKey: 'too-many-proposals',
      model: 'eve-reviewer',
      snapshot: snapshotOf(first, second),
      now: baseTime,
    });
    const proposals = Array.from({ length: 61 }, () => proposal(['skill-a', 'skill-b']));
    await expect(
      service.completeRun('org-a', claim.run.id, claim.run.leaseToken!, proposals, baseTime),
    ).rejects.toBeInstanceOf(ReviewValidationError);
  });

  it('exposes an explicit service implementation for runtime composition', () => {
    expect(DefaultReviewPersistenceService).toBeDefined();
    expect(ReviewLeaseError).toBeDefined();
    expect(ReviewServiceError).toBeDefined();
  });
});
