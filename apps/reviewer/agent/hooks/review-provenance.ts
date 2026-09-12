import { defineHook, type HookContext } from "eve/hooks";
import { createReviewInvocationAudit } from "../lib/provenance.js";
import { reviewState } from "../lib/review-state.js";

type ReviewAuditPhase = "started" | "status" | "completed" | "failed";

const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.~:-]{0,255}$/u;
const SAFE_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVIEW_INVOCATION_STATUSES = new Set([
  "pending",
  "prepared",
  "already_completed",
  "no_candidates",
  "not_claimed",
  "completed",
  "request_failed",
  "submission_uncertain",
]);

function safeOpaqueId(value: string): string | undefined {
  return SAFE_OPAQUE_ID.test(value) ? value : undefined;
}

function safeTimestamp(value: string): string | undefined {
  return SAFE_ISO_TIMESTAMP.test(value) ? value : undefined;
}

function emitReviewInvocationAudit(
  phase: ReviewAuditPhase,
  eventId: string | undefined,
  ctx: HookContext,
  failureCode?: string,
): void {
  const audit = reviewState.get().invocation;
  // API sessions are intentionally excluded. The provider-visible record is
  // only for the scheduled reviewer path that needs an external session
  // handle when no registry ReviewRun is created.
  if (!audit || audit.source !== "eve-schedule") return;

  const sessionId = safeOpaqueId(ctx.session.id);
  const invocationId = safeOpaqueId(audit.invocationId);
  const observedAt = safeTimestamp(audit.observedAt);
  const status = REVIEW_INVOCATION_STATUSES.has(audit.status) ? audit.status : undefined;
  if (!sessionId || !invocationId || !observedAt || !status) return;

  const record: Record<string, string> = {
    kind: "private-skills.reviewer.invocation",
    phase,
    sessionId,
    source: audit.source,
    scheduleId: "daily-review",
    invocationId,
    observedAt,
    status,
    loggedAt: new Date().toISOString(),
  };
  const safeEventId = eventId === undefined ? undefined : safeOpaqueId(eventId);
  const safeRunId = audit.runId === undefined ? undefined : safeOpaqueId(audit.runId);
  const safeFailureCode = failureCode === undefined ? undefined : safeOpaqueId(failureCode);
  if (safeEventId) record.streamEventId = safeEventId;
  if (safeRunId) record.runId = safeRunId;
  if (safeFailureCode) record.failureCode = safeFailureCode;

  // Keep this as one JSON line containing only opaque identifiers, bounded
  // phase/status values, and timestamps. Never log state, prompts, or tool
  // payloads here; Vercel runtime logs are the external discovery surface.
  console.info(JSON.stringify(record));
}

/**
 * Capture the trusted trigger before model work begins. The hook is
 * observe-only and stores no prompt, message, token, or provider payload.
 */
export default defineHook({
  events: {
    "session.started"(event, ctx) {
      const invocation = createReviewInvocationAudit(ctx.session, {
        trigger: ctx.channel.kind === "schedule" ? "schedule" : "api",
      });
      reviewState.update((state) => state.invocation
        ? state
        : { ...state, invocation });
      emitReviewInvocationAudit("started", event.meta?.id, ctx);
    },
    "action.result"(event, ctx) {
      const status = reviewState.get().invocation?.status;
      if (status === undefined || status === "pending") return;
      emitReviewInvocationAudit("status", event.meta?.id, ctx);
    },
    "session.completed"(event, ctx) {
      emitReviewInvocationAudit("completed", event.meta?.id, ctx);
    },
    "session.failed"(event, ctx) {
      emitReviewInvocationAudit("failed", event.meta?.id, ctx, event.data.code);
    },
  },
});
