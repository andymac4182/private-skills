import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  let stateValue: Record<string, unknown> | undefined;
  const postReviewerJson = vi.fn();
  return {
    postReviewerJson,
    getState: () => stateValue,
    resetState: (value: Record<string, unknown>) => {
      stateValue = value;
    },
    updateState: (update: (value: Record<string, unknown>) => Record<string, unknown>) => {
      if (!stateValue) throw new Error("state was not initialized");
      stateValue = update(stateValue);
    },
  };
});

vi.mock("eve/context", () => ({
  defineState: (_name: string, initial: () => Record<string, unknown>) => {
    if (!fakes.getState()) fakes.resetState(initial());
    return {
      get: fakes.getState,
      update: fakes.updateState,
    };
  },
}));

vi.mock("eve/tools", () => ({
  defineTool: (definition: unknown) => definition,
}));

vi.mock("../apps/reviewer/agent/lib/api.js", () => ({
  postReviewerJson: fakes.postReviewerJson,
}));

type ReviewerTool = {
  execute: (input: unknown, context: unknown) => Promise<unknown>;
};

const context = {
  session: {
    id: "eve-session-executor",
    auth: { current: null, initiator: null },
  },
  abortSignal: new AbortController().signal,
};

function resetState(): void {
  fakes.resetState({
    status: "idle",
    runId: null,
    leaseToken: null,
    candidates: [],
    prepareCalls: 0,
    submitCalls: 0,
    invocation: null,
  });
  fakes.postReviewerJson.mockReset();
}

async function reviewerTools(): Promise<{ prepare: ReviewerTool; submit: ReviewerTool }> {
  const [{ default: prepare }, { default: submit }] = await Promise.all([
    import("../apps/reviewer/agent/tools/prepare_review.js"),
    import("../apps/reviewer/agent/tools/submit_review.js"),
  ]);
  return { prepare: prepare as ReviewerTool, submit: submit as ReviewerTool };
}

function state(): Record<string, unknown> {
  const value = fakes.getState();
  if (!value) throw new Error("state was not initialized");
  return value;
}

describe("review provenance executor state", () => {
  beforeEach(resetState);

  it("records not_claimed for an active duplicate and preserves it on repeated prepare", async () => {
    const { prepare } = await reviewerTools();
    fakes.postReviewerJson.mockResolvedValueOnce({
      runId: "review-run-active",
      candidates: [],
    });

    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "no_candidates",
      candidates: [],
    });
    expect((state().invocation as { status: string }).status).toBe("not_claimed");

    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "already_completed",
      candidates: [],
    });
    expect((state().invocation as { status: string }).status).toBe("not_claimed");
    expect(fakes.postReviewerJson).toHaveBeenCalledTimes(1);
  });

  it("records no_candidates when the registry returns no run and preserves it on repeated prepare", async () => {
    const { prepare } = await reviewerTools();
    fakes.postReviewerJson.mockResolvedValueOnce({ candidates: [] });

    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "no_candidates",
      candidates: [],
    });
    expect((state().invocation as { status: string }).status).toBe("no_candidates");

    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "already_completed",
      candidates: [],
    });
    expect((state().invocation as { status: string }).status).toBe("no_candidates");
    expect(fakes.postReviewerJson).toHaveBeenCalledTimes(1);
  });

  it("keeps submission uncertainty when cached prepare is replayed", async () => {
    const { prepare, submit } = await reviewerTools();
    fakes.postReviewerJson.mockResolvedValueOnce({
      runId: "review-run-submit",
      leaseToken: "review-lease-submit",
      candidates: [{
        resourceId: "skill-a",
        name: "skill-a",
        version: "1.0.0",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        description: "candidate",
        text: "# candidate",
      }],
    });
    await prepare.execute({}, context);
    expect((state().invocation as { status: string }).status).toBe("prepared");

    fakes.postReviewerJson.mockRejectedValueOnce(new Error("response unavailable"));
    await expect(submit.execute({ summary: "summary", suggestions: [] }, context)).rejects.toThrow("response unavailable");
    expect((state().invocation as { status: string }).status).toBe("submission_uncertain");

    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "prepared",
      candidates: expect.any(Array),
    });
    expect((state().invocation as { status: string }).status).toBe("submission_uncertain");
    expect(fakes.postReviewerJson).toHaveBeenCalledTimes(2);
  });
});
