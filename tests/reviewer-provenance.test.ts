import { describe, expect, it } from 'vitest';
import {
  classifyPrepareOutcome,
  createReviewInvocationAudit,
  resolveReviewInvocationAudit,
  shouldRecordAlreadyCompleted,
  shouldRecordCachedPrepare,
  toReviewRunProvenance,
  withReviewInvocationOutcome,
} from '../apps/reviewer/agent/lib/provenance.js';

function session(
  id: string,
  initiator: Record<string, unknown> | null = null,
): Parameters<typeof createReviewInvocationAudit>[0] {
  return {
    id,
    auth: {
      current: null,
      initiator: initiator as Parameters<typeof createReviewInvocationAudit>[0]['auth']['initiator'],
    },
  };
}

describe('review scheduler provenance', () => {
  it('classifies Eve schedule sessions from the trusted app principal', () => {
    const audit = createReviewInvocationAudit(
      session('eve-session-scheduled', {
        attributes: { private: 'must-not-persist' },
        authenticator: 'app',
        principalId: 'eve:app',
        principalType: 'runtime',
      }),
      { invocationId: 'eve-review-invocation-scheduled', observedAt: '2026-01-02T03:04:05.000Z' },
    );

    expect(audit).toEqual({
      source: 'eve-schedule',
      scheduleId: 'daily-review',
      invocationId: 'eve-review-invocation-scheduled',
      observedAt: '2026-01-02T03:04:05.000Z',
      eveSessionId: 'eve-session-scheduled',
      status: 'pending',
    });
    expect(audit).not.toHaveProperty('attributes');
    expect(toReviewRunProvenance(audit)).not.toHaveProperty('eveSessionId');
  });

  it('classifies omitted or non-schedule auth as API without private fields', () => {
    const audit = createReviewInvocationAudit(
      session('eve-session-api'),
      {
        invocationId: 'eve-review-invocation-api',
        observedAt: '2026-01-02T03:04:05.000Z',
      },
    );

    expect(audit).toEqual({
      source: 'api',
      invocationId: 'eve-review-invocation-api',
      observedAt: '2026-01-02T03:04:05.000Z',
      eveSessionId: 'eve-session-api',
      status: 'pending',
    });
    expect(JSON.stringify(audit)).not.toContain('private');
    expect(audit).not.toHaveProperty('scheduleId');
  });

  it('replays the existing audit identity instead of minting a second invocation', () => {
    const existing = createReviewInvocationAudit(
      session('eve-session-replay'),
      { invocationId: 'eve-review-invocation-original', observedAt: '2026-01-02T03:04:05.000Z' },
    );
    const replay = resolveReviewInvocationAudit(
      existing,
      session('eve-session-replay'),
      { createInvocationId: () => { throw new Error('must not mint a replay ID'); } },
    );
    expect(replay).toBe(existing);
  });

  it('does not treat a lookalike principal as a schedule trigger', () => {
    const audit = createReviewInvocationAudit(
      session('eve-session-lookalike', {
        attributes: {},
        authenticator: 'app',
        principalId: 'eve:app',
        principalType: 'service',
      }),
      { invocationId: 'eve-review-invocation-lookalike', observedAt: '2026-01-02T03:04:05.000Z' },
    );
    expect(audit.source).toBe('api');
    expect(audit).not.toHaveProperty('scheduleId');
  });

  it('honors the framework schedule channel classification without copying channel metadata', () => {
    const audit = createReviewInvocationAudit(
      session('eve-session-channel-schedule'),
      {
        trigger: 'schedule',
        invocationId: 'eve-review-invocation-channel-schedule',
        observedAt: '2026-01-02T03:04:05.000Z',
      },
    );
    expect(audit.source).toBe('eve-schedule');
    expect(audit.scheduleId).toBe('daily-review');
    expect(audit).not.toHaveProperty('channel');
  });

  it('distinguishes a genuinely empty snapshot from an active lease duplicate', () => {
    expect(classifyPrepareOutcome({ candidateCount: 0 })).toBe('no_candidates');
    expect(classifyPrepareOutcome({ candidateCount: 0, runId: 'review-run-existing' })).toBe('not_claimed');
    expect(classifyPrepareOutcome({ alreadyCompleted: true, candidateCount: 0, runId: 'review-run-completed' }))
      .toBe('already_completed');
  });

  it('preserves terminal outcomes on repeated prepare and marks uncertainty until completion succeeds', () => {
    const audit = createReviewInvocationAudit(
      session('eve-session-outcomes'),
      { invocationId: 'eve-review-invocation-outcomes', observedAt: '2026-01-02T03:04:05.000Z' },
    );
    const notClaimed = withReviewInvocationOutcome(audit, 'not_claimed', 'review-run-existing');
    const noCandidates = withReviewInvocationOutcome(audit, 'no_candidates');
    expect(shouldRecordAlreadyCompleted(notClaimed.status)).toBe(false);
    expect(shouldRecordAlreadyCompleted(noCandidates.status)).toBe(false);
    expect(shouldRecordCachedPrepare(notClaimed.status)).toBe(false);
    expect(shouldRecordCachedPrepare(noCandidates.status)).toBe(false);

    const submissionUncertain = withReviewInvocationOutcome(audit, 'submission_uncertain', 'review-run-existing');
    expect(shouldRecordCachedPrepare(submissionUncertain.status)).toBe(false);
    expect(withReviewInvocationOutcome(submissionUncertain, 'completed', 'review-run-existing').status)
      .toBe('completed');
  });
});
