import { describe, expect, it, vi } from "vitest";
import { createMemoryStateRepository, defaultRegistryState } from "../../../../packages/database/src/index.js";
import { createRegistryHandler } from "../../../../packages/core/src/index.js";
import { digestBytes } from "../../../../packages/storage/src/index.js";
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  SkillBuilderSessionRecord,
  StateRepository,
  StoredBlob,
} from "../../../../packages/contracts/src/index.js";
import {
  SkillBuilderRegistryClient,
  type DraftBinding,
} from "../../../../packages/skill-builder/src/index.js";
import { resolveBuilderTools } from "../../agent/tools/draft.js";

const { registryClientMock } = vi.hoisted(() => ({ registryClientMock: vi.fn() }));

vi.mock("../../agent/lib/config.js", () => ({
  builderStatus: () => ({ enabled: true }),
  registryClient: registryClientMock,
}));

const ORIGIN = "https://registry.example.test";
const ORGANIZATION = "org-test";
const REGISTRY_TOKEN = "registry-builder-token";
const REGISTRY_SESSION_ID = "builder-registry-session-9";
const PROVIDER_SESSION_ID = "eve-provider-session-9";

class MemoryBlobs implements BlobStore {
  private readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const stored: StoredBlob = {
      key: `blob-${this.values.size}`,
      digest: await digestBytes(copy),
      size: copy.byteLength,
    };
    this.values.set(stored.key, copy);
    return stored;
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.values.get(key);
    if (!bytes) throw new Error("missing blob");
    return bytes.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function browserPrincipal(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: "author",
    roles: ["publisher"],
    namespaces: ["@team"],
    scopes: ["registry:read", "skills:read", "skills:write", "skills:publish"],
  };
}

function builderPrincipal(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: "author",
    roles: ["publisher"],
    namespaces: ["@team"],
    scopes: ["skills:builder"],
  };
}

function base64Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

interface Fixture {
  readonly handler: ReturnType<typeof createRegistryHandler>;
  readonly repository: StateRepository;
  readonly requests: Array<{ path: string; authorization: string | null; toolIdentity: string | null }>;
}

function fixture(): Fixture {
  const state: RegistryState = defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: "tool-integration-policy",
  });
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  const blobs = new MemoryBlobs();
  const requests: Fixture["requests"] = [];
  const auth: Authenticator = {
    authenticate: async (request) => request.headers.get("authorization") === `Bearer ${REGISTRY_TOKEN}`
      ? builderPrincipal()
      : browserPrincipal(),
  };
  const handler = createRegistryHandler({
    repository,
    blobs,
    auth,
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: 1024 * 1024,
      organizationId: ORGANIZATION,
      leaseSeconds: 30,
    },
  });
  return { handler, repository, requests };
}

async function createUploadDraft(test: Fixture): Promise<{ id: string; revision: number; digest: string }> {
  const response = await test.handler(new Request(`${ORIGIN}/v1/drafts`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "idempotency-key": "tool-integration-draft",
    },
    body: JSON.stringify({
      name: "@team/tool-integration",
      files: [{
        path: "SKILL.md",
        content: base64Text("---\nname: tool-integration\ndescription: Tool integration\n---\n# Tool integration\n"),
      }],
    }),
  }));
  expect(response.status).toBe(201);
  const body = await json(response);
  return body.draft as { id: string; revision: number; digest: string };
}

async function addRegistrySession(test: Fixture, binding: DraftBinding): Promise<void> {
  const now = "2026-09-10T00:00:00.000Z";
  const record: SkillBuilderSessionRecord = {
    id: REGISTRY_SESSION_ID,
    organizationId: ORGANIZATION,
    subject: "author",
    draftId: binding.draftId,
    draftRevision: binding.revision,
    draftDigest: binding.digest,
    sessionKey: "provider-channel-key-9",
    eveSessionId: PROVIDER_SESSION_ID,
    state: "running",
    requests: [],
    proposals: [],
    createdAt: now,
    updatedAt: now,
  };
  await test.repository.transaction(ORGANIZATION, (state) => {
    state.builderSessions ??= [];
    state.builderSessions.push(record);
  });
}

describe("skill-builder proposal tool integration", () => {
  it("loads, reads, and persists through core using registry identity distinct from Eve identity", async () => {
    const test = fixture();
    const draft = await createUploadDraft(test);
    const binding: DraftBinding = {
      draftId: draft.id,
      revision: draft.revision,
      digest: draft.digest as DraftBinding["digest"],
    };
    await addRegistrySession(test, binding);

    const client = new SkillBuilderRegistryClient({
      baseUrl: ORIGIN,
      serviceToken: REGISTRY_TOKEN,
      fetch: async (input, init) => {
        const request = new Request(String(input), init);
        test.requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          toolIdentity: request.headers.get("x-pskills-tool-identity"),
        });
        return await test.handler(request);
      },
    });
    registryClientMock.mockReturnValue(client);
    const tools = await resolveBuilderTools({
      channel: {
        kind: "skill-builder",
        metadata: { audience: "private", bound: true, ...binding, registrySessionId: REGISTRY_SESSION_ID },
      },
    }, { enabled: true });
    expect(registryClientMock).not.toHaveBeenCalled();
    expect(tools).not.toBeNull();
    if (!tools) throw new Error("builder tools were not resolved");

    const toolContext = {
      session: { id: PROVIDER_SESSION_ID },
      callId: "provider-call-9",
    } as never;
    const listed = await tools.list_draft_files.execute({}, toolContext);
    expect(listed).toMatchObject({ draftId: draft.id, revision: draft.revision, digest: draft.digest });
    const read = await tools.read_draft_files.execute({ paths: ["SKILL.md"] }, toolContext);
    expect(read).toMatchObject({ files: [{ path: "SKILL.md" }] });

    const result = await tools.propose_file_changes.execute({
      operations: [{ op: "edit", path: "SKILL.md", content: "---\nname: tool-integration\ndescription: Edited\n---\n# Edited\n" }],
    }, toolContext);
    expect(result).toMatchObject({ draftId: draft.id, state: "pending" });
    expect(result).not.toHaveProperty("reviewUrl");

    const finalState = await test.repository.read(ORGANIZATION);
    const session = finalState.builderSessions?.find((candidate) => candidate.id === REGISTRY_SESSION_ID);
    expect(session?.proposals).toHaveLength(1);
    expect(session?.proposals[0]).toMatchObject({
      sessionId: REGISTRY_SESSION_ID,
      idempotencyKey: `skill-builder:${PROVIDER_SESSION_ID}:provider-call-9`,
    });
    expect(session?.proposals[0]?.sessionId).not.toBe(PROVIDER_SESSION_ID);
    expect(test.requests.map((request) => request.path)).toEqual([
      `/v1/drafts/${draft.id}/builder-context`,
      `/v1/drafts/${draft.id}/builder-context`,
      `/v1/drafts/${draft.id}/builder-file`,
      `/v1/drafts/${draft.id}/builder-context`,
      `/v1/drafts/${draft.id}/proposals`,
    ]);
    expect(test.requests.every((request) => request.authorization === `Bearer ${REGISTRY_TOKEN}`)).toBe(true);
    expect(test.requests.every((request) => request.toolIdentity === "skill-builder")).toBe(true);
  });
});
