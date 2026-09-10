import { describe, expect, it, vi } from "vitest";
import {
  MAX_PATCH_CONTENT_BYTES,
  SkillBuilderRegistryClient,
  digestText,
  validateBuilderSessionAcceptance,
  validateBuilderSessionStartRequest,
  validatePatchOperations,
  validateDraftContext,
} from "../src/index.js";

const baseDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

describe("skill-builder contracts", () => {
  it("rejects unsafe paths and duplicate patch targets", () => {
    expect(() => validatePatchOperations([{ op: "add", path: "../SKILL.md", content: "x" }])).toThrow();
    expect(() => validatePatchOperations([
      { op: "edit", path: "SKILL.md", content: "x" },
      { op: "delete", path: "SKILL.md", },
    ])).toThrow();
    expect(() => validatePatchOperations([
      { op: "add", path: "SKILL.md", content: "x".repeat(MAX_PATCH_CONTENT_BYTES) + "x" },
    ])).toThrow();
  });

  it("bounds server-selected context and refuses binary content exposure", () => {
    expect(() => validateDraftContext({
      draftId: "draft-1",
      revision: 4,
      digest: baseDigest,
      files: [{
        path: "image.png",
        sizeBytes: 10,
        digest: baseDigest,
        kind: "binary",
        contentAvailable: true,
      }],
    })).toThrow();
  });

  it("requires the returned file bytes to match both server digests", async () => {
    const content = "# Skill\n";
    const digest = await digestText(content);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("builder-context")) {
        return new Response(JSON.stringify({
          draftId: "draft-1",
          revision: 4,
          digest: baseDigest,
          files: [{ path: "SKILL.md", sizeBytes: content.length, digest, kind: "text", contentAvailable: true }],
        }), { status: 200 });
      }
      expect(url).toContain("builder-file");
      return new Response(JSON.stringify({
        draftId: "draft-1",
        revision: 4,
        digest: baseDigest,
        path: "SKILL.md",
        contentDigest: digest,
        content,
      }), { status: 200 });
    });
    const client = new SkillBuilderRegistryClient({
      baseUrl: "https://registry.example.test",
      serviceToken: "registry-token",
      fetch: fetchMock,
    });
    const context = await client.loadContext({ draftId: "draft-1", revision: 4, digest: baseDigest });
    const files = await client.readFiles({ context, paths: ["SKILL.md"] });
    expect(files[0]?.content).toBe(content);
    const init = fetchMock.mock.calls[1]?.[1];
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer registry-token");
    expect(new Headers(init?.headers).get("x-pskills-tool-identity")).toBe("skill-builder");
  });

  it("rejects a context response for a different revision", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      draftId: "draft-1",
      revision: 5,
      digest: baseDigest,
      files: [],
    })));
    const client = new SkillBuilderRegistryClient({ baseUrl: "https://registry.example.test", serviceToken: "token", fetch: fetchMock });
    await expect(client.loadContext({ draftId: "draft-1", revision: 4, digest: baseDigest })).rejects.toMatchObject({ code: "UPSTREAM_CONFLICT" });
  });

  it("rejects a content digest mismatch before returning candidate text", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("builder-context")) {
        return new Response(JSON.stringify({
          draftId: "draft-1",
          revision: 4,
          digest: baseDigest,
          files: [{ path: "SKILL.md", sizeBytes: 1, digest: baseDigest, kind: "text", contentAvailable: true }],
        }));
      }
      return new Response(JSON.stringify({
        draftId: "draft-1",
        revision: 4,
        digest: baseDigest,
        path: "SKILL.md",
        contentDigest: baseDigest,
        content: "changed",
      }));
    });
    const client = new SkillBuilderRegistryClient({ baseUrl: "https://registry.example.test", serviceToken: "token", fetch: fetchMock });
    const context = await client.loadContext({ draftId: "draft-1", revision: 4, digest: baseDigest });
    await expect(client.readFiles({ context, paths: ["SKILL.md"] })).rejects.toMatchObject({ code: "UPSTREAM_SCHEMA_ERROR" });
  });

  it("does not accept a model-supplied proposed digest", async () => {
    const operations = [{ op: "add", path: "SKILL.md", content: "# Skill" }] as const;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(String(init?.body)).not.toContain("proposedDigest");
      return new Response(JSON.stringify({ proposal: {
        id: "proposal-1",
        draftId: "draft-1",
        baseRevision: 4,
        baseDigest: baseDigest,
        proposedDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        operations: [{ op: "add", path: "SKILL.md", contentBytes: 7 }],
        state: "pending",
        createdAt: "2026-09-10T00:00:00.000Z",
      }}));
    });
    const client = new SkillBuilderRegistryClient({ baseUrl: "https://registry.example.test", serviceToken: "token", fetch: fetchMock });
    const result = await client.persistProposal({
      context: { draftId: "draft-1", revision: 4, digest: baseDigest, files: [] },
      operations,
      sessionId: "eve-session-1",
      idempotencyKey: "skill-builder:eve-session-1:call-1",
    });
    expect(result.proposedDigest).toMatch(/^sha256:/u);
  });

  it("binds app acceptance to the registry session while keeping provider identity opaque", () => {
    const request = validateBuilderSessionStartRequest({
      sessionKey: "provider-key-1",
      registrySessionId: "builder-session-1",
      draftId: "draft-1",
      revision: 4,
      digest: baseDigest,
      message: "Keep this\nmultiline prompt intact.",
      requestId: "request-1",
      requestDigest: baseDigest,
      selectedPath: "SKILL.md",
    });
    const acceptance = validateBuilderSessionAcceptance({
      status: "accepted",
      sessionId: "eve-session-1",
      sessionKey: request.sessionKey,
      registrySessionId: request.registrySessionId,
      draftId: request.draftId,
      revision: request.revision,
      digest: request.digest,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      selectedPath: request.selectedPath,
    }, request);

    expect(acceptance.sessionId).toBe("eve-session-1");
    expect(acceptance.registrySessionId).toBe("builder-session-1");
    expect(() => validateBuilderSessionAcceptance({
      status: "accepted",
      sessionId: "eve-session-1",
      sessionKey: request.sessionKey,
      registrySessionId: "eve-session-1",
      draftId: request.draftId,
      revision: request.revision,
      digest: request.digest,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      selectedPath: request.selectedPath,
    }, request)).toThrow();
  });
});
