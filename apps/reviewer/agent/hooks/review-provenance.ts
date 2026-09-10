import { defineHook } from "eve/hooks";
import { createReviewInvocationAudit } from "../lib/provenance.js";
import { reviewState } from "../lib/review-state.js";

/**
 * Capture the trusted trigger before model work begins. The hook is
 * observe-only and stores no prompt, message, token, or provider payload.
 */
export default defineHook({
  events: {
    "session.started"(_event, ctx) {
      const invocation = createReviewInvocationAudit(ctx.session, {
        trigger: ctx.channel.kind === "schedule" ? "schedule" : "api",
      });
      reviewState.update((state) => state.invocation
        ? state
        : { ...state, invocation });
    },
  },
});
