import { randomUUID } from "node:crypto";
import type { SessionContext } from "eve/context";
import type { ReviewRunProvenance } from "../../../../packages/reviews/src/index.js";

/** Filesystem-derived Eve schedule name for agent/schedules/daily-review.ts. */
export const DAILY_REVIEW_SCHEDULE_ID = "daily-review";

export type ReviewInvocationStatus =
  | "pending"
  | "prepared"
  | "already_completed"
  | "no_candidates"
  | "not_claimed"
  | "completed"
  | "request_failed"
  | "submission_uncertain";

export interface ReviewInvocationAudit extends ReviewRunProvenance {
  /** Opaque durable Eve session identity, never model supplied. */
  eveSessionId: string;
  status: ReviewInvocationStatus;
  runId?: string;
}

interface ReviewInvocationOptions {
  invocationId?: string;
  observedAt?: string;
  createInvocationId?: () => string;
  /** Trusted framework channel classification, supplied by the session hook. */
  trigger?: "schedule" | "api";
}

/**
 * Eve's schedule dispatcher uses this exact trusted app principal. It is
 * deliberately checked from ctx.session rather than from prompt text or a
 * request body. `invocationId` remains app-generated and is never presented
 * as a Vercel/provider request identifier.
 */
export function createReviewInvocationAudit(
  session: Pick<SessionContext["session"], "id" | "auth">,
  options: ReviewInvocationOptions = {},
): ReviewInvocationAudit {
  const initiator = session.auth.initiator;
  const schedulePrincipal = initiator?.authenticator === "app"
    && initiator.principalId === "eve:app"
    && initiator.principalType === "runtime";
  // HookContext.channel.kind is framework-owned (`schedule` for an Eve
  // schedule). Keep the principal fallback for recovery/tool contexts where
  // only the public SessionContext is available.
  const scheduled = options.trigger === "schedule"
    || (options.trigger === undefined && schedulePrincipal);
  const invocationId = options.invocationId ?? `eve-review-invocation_${(options.createInvocationId ?? randomUUID)()}`;
  const observedAt = options.observedAt ?? new Date().toISOString();
  return {
    source: scheduled ? "eve-schedule" : "api",
    ...(scheduled ? { scheduleId: DAILY_REVIEW_SCHEDULE_ID } : {}),
    invocationId,
    observedAt,
    eveSessionId: session.id,
    status: "pending",
  };
}

export function classifyPrepareOutcome(input: {
  alreadyCompleted?: boolean;
  runId?: string;
  candidateCount: number;
}): "already_completed" | "no_candidates" | "not_claimed" | "prepared" {
  if (input.alreadyCompleted === true) return "already_completed";
  if (input.candidateCount === 0) {
    // The registry uses a run ID with an empty candidate list to signal that
    // another session owns the active lease. A truly empty snapshot has no ID.
    return input.runId === undefined ? "no_candidates" : "not_claimed";
  }
  return "prepared";
}

export function shouldRecordAlreadyCompleted(
  status: ReviewInvocationStatus | undefined,
): boolean {
  return status === undefined || status === "pending";
}

/** A cached prepare does not erase a terminal or uncertain prior outcome. */
export function shouldRecordCachedPrepare(
  status: ReviewInvocationStatus | undefined,
): boolean {
  return status === undefined || status === "pending" || status === "prepared";
}

/** Record the latest bounded phase without retaining error details. */
export function withReviewInvocationOutcome(
  audit: ReviewInvocationAudit,
  status: ReviewInvocationStatus,
  runId?: string,
): ReviewInvocationAudit {
  return {
    ...audit,
    status,
    ...(runId === undefined ? {} : { runId }),
  };
}

/** Replays keep one invocation identity for the life of the Eve session. */
export function resolveReviewInvocationAudit(
  existing: ReviewInvocationAudit | null | undefined,
  session: Pick<SessionContext["session"], "id" | "auth">,
  options: ReviewInvocationOptions = {},
): ReviewInvocationAudit {
  return existing ?? createReviewInvocationAudit(session, options);
}

export function toReviewRunProvenance(audit: ReviewInvocationAudit): ReviewRunProvenance {
  return {
    source: audit.source,
    ...(audit.scheduleId === undefined ? {} : { scheduleId: audit.scheduleId }),
    invocationId: audit.invocationId,
    observedAt: audit.observedAt,
  };
}
