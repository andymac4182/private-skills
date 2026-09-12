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

  it("emits bounded provider metadata for schedule sessions without state or payload content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const { default: hook } = await import("../apps/reviewer/agent/hooks/review-provenance.js") as unknown as {
        default: {
          events: {
            "session.started": (event: unknown, context: unknown) => void;
            "session.completed": (event: unknown, context: unknown) => void;
          };
        };
      };
      const context = {
        session: {
          id: "eve-session-observability",
          auth: {
            current: null,
            initiator: {
              authenticator: "app",
              principalId: "eve:app",
              principalType: "runtime",
              attributes: { secret: "must-not-log" },
            },
          },
        },
        channel: { kind: "schedule", private: "must-not-log" },
      };

      hook.events["session.started"]({ meta: { id: "event-start" } }, context);
      expect(info).toHaveBeenCalledTimes(1);
      expect(JSON.parse(info.mock.calls[0]?.[0] as string)).toMatchObject({
        kind: "private-skills.reviewer.invocation",
        phase: "started",
        sessionId: "eve-session-observability",
        source: "eve-schedule",
        scheduleId: "daily-review",
        status: "pending",
        streamEventId: "event-start",
      });

      fakes.resetState({
        status: "completed",
        runId: null,
        leaseToken: null,
        candidates: [],
        prepareCalls: 1,
        submitCalls: 0,
        invocation: {
          source: "eve-schedule",
          scheduleId: "daily-review",
          invocationId: "eve-review-invocation-observability",
          observedAt: "2026-01-02T03:04:05.000Z",
          eveSessionId: "eve-session-observability",
          status: "no_candidates",
        },
      });
      hook.events["session.completed"]({ meta: { id: "event-complete" } }, context);

      expect(JSON.parse(info.mock.calls[1]?.[0] as string)).toMatchObject({
        phase: "completed",
        status: "no_candidates",
        streamEventId: "event-complete",
      });
      expect(JSON.stringify(info.mock.calls)).not.toContain("must-not-log");
    } finally {
      info.mockRestore();
    }
  });

  it("keeps API sessions out of the log and replaces arbitrary failure codes", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const { default: hook } = await import("../apps/reviewer/agent/hooks/review-provenance.js") as unknown as {
        default: {
          events: {
            "session.started": (event: unknown, context: unknown) => void;
            "session.failed": (event: unknown, context: unknown) => void;
          };
        };
      };
      const apiContext = {
        session: {
          id: "eve-session-api-observability",
          auth: { current: null, initiator: null },
        },
        channel: { kind: "channel" },
      };
      hook.events["session.started"]({ meta: { id: "api-event" } }, apiContext);
      expect(info).not.toHaveBeenCalled();

      fakes.resetState({
        status: "completed",
        runId: null,
        leaseToken: null,
        candidates: [],
        prepareCalls: 1,
        submitCalls: 0,
        invocation: {
          source: "eve-schedule",
          scheduleId: "daily-review",
          invocationId: "eve-review-invocation-failed",
          observedAt: "2026-01-02T03:04:05.000Z",
          eveSessionId: "eve-session-failed-observability",
          status: "pending",
        },
      });
      const scheduleContext = {
        session: {
          id: "eve-session-failed-observability",
          auth: { current: null, initiator: null },
        },
        channel: { kind: "schedule" },
      };
      const arbitraryFailureCode = "ProviderError: secret model output must not be logged";
      hook.events["session.failed"](
        { meta: { id: "failure-event" }, data: { code: arbitraryFailureCode } },
        scheduleContext,
      );

      expect(info).toHaveBeenCalledTimes(1);
      const record = JSON.parse(info.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(record).toMatchObject({
        phase: "failed",
        status: "pending",
        failureCode: "session_failed",
      });
      expect(JSON.stringify(record)).not.toContain(arbitraryFailureCode);
    } finally {
      info.mockRestore();
    }
  });
});
