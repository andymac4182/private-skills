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

vi.mock("eve/hooks", () => ({
  defineHook: (definition: unknown) => definition,
}));

vi.mock("../apps/reviewer/agent/lib/api.js", () => ({
  postReviewerJson: fakes.postReviewerJson,
}));

type ReviewerTool = {
  execute: (input: unknown, context: unknown) => Promise<unknown>;
};

type ReviewState = {
  status: string;
  runId: string | null;
  leaseToken: string | null;
  candidates: unknown[];
  prepareCalls: number;
  submitCalls: number;
  invocation: {
    status: string;
    source: string;
    scheduleId?: string;
    eveSessionId: string;
    [key: string]: unknown;
  } | null;
};

const context = {
  session: {
    id: "eve-session-tool-test",
    auth: { current: null, initiator: null },
  },
  abortSignal: new AbortController().signal,
};

const candidate = {
  resourceId: "skill-a",
  name: "skill-a",
  version: "1.0.0",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  description: "candidate",
  text: "# candidate",
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

function state(): ReviewState {
  const value = fakes.getState();
  if (!value) throw new Error("state was not initialized");
  return value as unknown as ReviewState;
}

async function reviewerTools(): Promise<{ prepare: ReviewerTool; submit: ReviewerTool }> {
  const [{ default: prepare }, { default: submit }] = await Promise.all([
    import("../apps/reviewer/agent/tools/prepare_review.js"),
    import("../apps/reviewer/agent/tools/submit_review.js"),
  ]);
  return { prepare: prepare as ReviewerTool, submit: submit as ReviewerTool };
}

function respondWith(value: unknown): void {
  fakes.postReviewerJson.mockImplementationOnce(async (
    _path: string,
    _body: Record<string, unknown>,
    parse: (response: unknown) => unknown,
  ) => parse(value));
}

describe("review provenance tool executor state", () => {
  beforeEach(resetState);

  it("distinguishes an active duplicate from a true empty result and preserves both outcomes on replay", async () => {
    const { prepare } = await reviewerTools();

    respondWith({ runId: "review-run-active", candidates: [] });
    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "no_candidates",
      candidates: [],
    });
    expect(state().invocation?.status).toBe("not_claimed");
    expect(state().status).toBe("completed");

    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "already_completed",
      candidates: [],
    });
    expect(state().invocation?.status).toBe("not_claimed");
    expect(fakes.postReviewerJson).toHaveBeenCalledTimes(1);

    resetState();
    respondWith({ candidates: [] });
    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "no_candidates",
      candidates: [],
    });
    expect(state().invocation?.status).toBe("no_candidates");

    await expect(prepare.execute({}, context)).resolves.toEqual({
      status: "already_completed",
      candidates: [],
    });
    expect(state().invocation?.status).toBe("no_candidates");
    expect(fakes.postReviewerJson).toHaveBeenCalledTimes(1);
  });

  it("keeps an uncertain completion marker across cached prepare and does not repost", async () => {
    const { prepare, submit } = await reviewerTools();
    respondWith({
      runId: "review-run-submit",
      leaseToken: "review-lease-submit",
      candidates: [candidate],
    });
    await expect(prepare.execute({}, context)).resolves.toMatchObject({ status: "prepared" });

    fakes.postReviewerJson.mockRejectedValueOnce(new Error("response unavailable"));
    await expect(submit.execute({ summary: "summary", suggestions: [] }, context))
      .rejects.toThrow("response unavailable");
    expect(state().invocation?.status).toBe("submission_uncertain");
    expect(state().status).toBe("prepared");

    await expect(prepare.execute({}, context)).resolves.toMatchObject({ status: "prepared" });
    expect(state().invocation?.status).toBe("submission_uncertain");
    await expect(submit.execute({ summary: "summary", suggestions: [] }, context))
      .rejects.toThrow("submit_review call budget exhausted");
    expect(fakes.postReviewerJson).toHaveBeenCalledTimes(2);
  });

  it("marks a known successful completion as completed and clears the lease", async () => {
    const { prepare, submit } = await reviewerTools();
    respondWith({
      runId: "review-run-success",
      leaseToken: "review-lease-success",
      candidates: [candidate],
    });
    await prepare.execute({}, context);
    respondWith({});

    await expect(submit.execute({ summary: "summary", suggestions: [] }, context)).resolves.toEqual({
      status: "completed",
      suggestionsRecorded: 0,
    });
    expect(state()).toMatchObject({
      status: "completed",
      runId: "review-run-success",
      leaseToken: null,
      candidates: [],
      invocation: { status: "completed", runId: "review-run-success" },
    });
  });

  it("captures schedule cause before tools run without persisting channel or auth fields", async () => {
    const { default: hook } = await import("../apps/reviewer/agent/hooks/review-provenance.js") as unknown as {
      default: { events: { "session.started": (event: unknown, context: unknown) => void } };
    };
    const session = {
      id: "eve-session-schedule-hook",
      auth: {
        current: null,
        initiator: {
          authenticator: "app",
          principalId: "eve:app",
          principalType: "runtime",
          attributes: { secret: "must-not-persist" },
        },
      },
    };
    hook.events["session.started"]({}, { session, channel: { kind: "schedule", private: "omit" } });

    expect(state().invocation).toMatchObject({
      source: "eve-schedule",
      scheduleId: "daily-review",
      eveSessionId: "eve-session-schedule-hook",
      status: "pending",
    });
    expect(state().invocation).not.toHaveProperty("attributes");
    expect(state().invocation).not.toHaveProperty("private");
    expect(JSON.stringify(state().invocation)).not.toContain("must-not-persist");
  });
});
