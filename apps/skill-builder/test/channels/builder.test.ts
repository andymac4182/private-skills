import { describe, expect, it } from "vitest";
import { parseSessionRequest } from "../../agent/channels/builder.js";

const digest = `sha256:${"a".repeat(64)}`;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionKey: "builder-session-key",
    registrySessionId: "builder-registry-session",
    draftId: "draft-1",
    revision: 4,
    digest,
    message: "Please improve this section.\n\tKeep the code fence intact.\r\n",
    requestId: "request-01",
    requestDigest: digest,
    selectedPath: "SKILL.md",
    ...overrides,
  };
}

describe("skill-builder channel request contract", () => {
  it("preserves bounded multiline content and request metadata", () => {
    const parsed = parseSessionRequest(request());

    expect(parsed.message).toBe("Please improve this section.\n\tKeep the code fence intact.\r\n");
    expect(parsed.registrySessionId).toBe("builder-registry-session");
    expect(parsed.requestId).toBe("request-01");
    expect(parsed.requestDigest).toBe(digest);
    expect(parsed.selectedPath).toBe("SKILL.md");
  });

  it.each([
    ["missing registry session id", { registrySessionId: undefined }],
    ["unsafe registry session id", { registrySessionId: "builder/registry-session" }],
    ["missing request id", { requestId: undefined }],
    ["whitespace in request id", { requestId: "request 01" }],
    ["control character in request id", { requestId: "request-\u0001" }],
    ["malformed request digest", { requestDigest: "sha256:not-a-digest" }],
    ["NUL in message", { message: "line one\u0000line two" }],
    ["control character in selected path", { selectedPath: "SKILL\u0000.md" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseSessionRequest(request(overrides))).toThrow();
  });
});
