import { defineTool } from "eve/tools";
import { postReviewerJson } from "../lib/api.js";
import { submitInputSchema, submitOutputSchema } from "../lib/schemas.js";
import { reviewState } from "../lib/review-state.js";

const completionResponse = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("reviewer API returned an invalid completion response");
  }
  return value as Record<string, unknown>;
};

export default defineTool({
  description: [
    "Record bounded common-skill merge suggestions for the prepared review.",
    "This records proposals only; it cannot publish, merge, edit source, or authorize an install.",
    "Use only resourceId values returned by prepare_review as skillIds.",
    "Submit an empty suggestions array when comparison found no safe proposal.",
  ].join(" "),
  inputSchema: submitInputSchema,
  outputSchema: submitOutputSchema,
  async execute(input, ctx) {
    const current = reviewState.get();
    if (current.status === "completed") {
      return { status: "already_completed" as const, suggestionsRecorded: 0 };
    }
    if (!current.runId || !current.leaseToken || current.status !== "prepared") {
      return { status: "not_prepared" as const, suggestionsRecorded: 0 };
    }
    if (current.submitCalls >= 1) {
      throw new Error("submit_review call budget exhausted");
    }

    const allowed = new Set(current.candidates.map((candidate) => candidate.resourceId));
    const groups = new Set<string>();
    for (const suggestion of input.suggestions) {
      const ids = new Set(suggestion.skillIds);
      if (ids.size !== suggestion.skillIds.length) {
        throw new Error("a merge suggestion cannot repeat a skillId");
      }
      for (const skillId of ids) {
        if (!allowed.has(skillId)) {
          throw new Error("a merge suggestion referenced a skill outside the prepared snapshot");
        }
      }
      const group = [...ids].sort().join("\u0000");
      if (groups.has(group)) {
        throw new Error("a review cannot submit duplicate skill groups");
      }
      groups.add(group);
    }

    reviewState.update((state) => ({ ...state, submitCalls: state.submitCalls + 1 }));
    try {
      await postReviewerJson(
        "/internal/reviewer/complete",
        {
          runId: current.runId,
          leaseToken: current.leaseToken,
          summary: input.summary,
          suggestions: input.suggestions,
        },
        completionResponse,
        ctx.abortSignal,
      );
    } catch (error) {
      reviewState.update((state) => state.invocation ? {
        ...state,
        invocation: { ...state.invocation, status: "failed" },
      } : state);
      throw error;
    }
    reviewState.update((state) => ({
      ...state,
      status: "completed",
      leaseToken: null,
      candidates: [],
      invocation: state.invocation ? {
        ...state.invocation,
        status: "completed",
        runId: current.runId!,
      } : state.invocation,
    }));
    return {
      status: "completed" as const,
      suggestionsRecorded: input.suggestions.length,
    };
  },
});
