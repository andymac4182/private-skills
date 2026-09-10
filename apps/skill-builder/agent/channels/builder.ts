import { createHash, timingSafeEqual } from "node:crypto";
import { defineChannel, GET, POST } from "eve/channels";
import {
  assertBuilderDigest,
  MAX_DRAFT_ID_LENGTH,
  MAX_SESSION_ID_LENGTH,
  type BuilderDigest,
} from "../../../../packages/skill-builder/src/index.js";
import { builderServiceToken, builderStatus } from "../lib/config.js";

const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_SELECTED_PATH_LENGTH = 4096;
const UNSUPPORTED_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface BuilderChannelState {
  readonly sessionKey: string | null;
  readonly draftId: string | null;
  readonly revision: number | null;
  readonly digest: BuilderDigest | null;
}

const initialState: BuilderChannelState = {
  sessionKey: null,
  draftId: null,
  revision: null,
  digest: null,
};

const servicePrincipal = {
  attributes: { service: "private-skills-registry-bff" },
  authenticator: "pskills-builder-service-token",
  principalId: "private-skills-registry-bff",
  principalType: "service",
} as const;

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": 'Bearer realm="private-skills-skill-builder"',
    },
  });
}

function isAuthorized(request: Request): boolean {
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/iu)?.[1];
  if (!supplied || supplied.length > 512 || /\s/u.test(supplied)) return false;
  let expected: string;
  try {
    expected = builderServiceToken();
  } catch {
    return false;
  }
  return constantTimeEqual(expected, supplied);
}

function invalid(message: string, status = 400): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

function safeString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value.trim();
}

function safeSessionKey(value: unknown): string {
  const key = safeString(value, "sessionKey", MAX_SESSION_ID_LENGTH);
  if (/\s/u.test(key)) throw new Error("sessionKey is invalid");
  return key;
}

function boundedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new Error("revision is invalid");
  }
  return value as number;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > MAX_REQUEST_BYTES) {
    throw new Error("request is too large");
  }
  if (!request.body) throw new Error("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("request is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

export interface BuilderSessionRequest {
  sessionKey: string;
  draftId: string;
  revision: number;
  digest: BuilderDigest;
  message: string;
  requestId: string;
  requestDigest: BuilderDigest;
  selectedPath?: string;
}

export function parseSessionRequest(value: Record<string, unknown>): BuilderSessionRequest {
  const sessionKey = safeSessionKey(value.sessionKey);
  const draftId = safeString(value.draftId, "draftId", MAX_DRAFT_ID_LENGTH);
  const revision = boundedRevision(value.revision);
  assertBuilderDigest(value.digest);
  if (typeof value.message !== "string" || value.message.trim().length === 0 || new TextEncoder().encode(value.message).byteLength > MAX_MESSAGE_BYTES || UNSUPPORTED_CONTROL_CHARACTER.test(value.message)) {
    throw new Error("message must be bounded non-empty text");
  }
  const requestId = safeRequestId(value.requestId);
  assertBuilderDigest(value.requestDigest, "requestDigest");
  const requestDigest = value.requestDigest;
  const selectedPath = value.selectedPath === undefined ? undefined : safeSelectedPath(value.selectedPath);
  return {
    sessionKey,
    draftId,
    revision,
    digest: value.digest,
    message: value.message,
    requestId,
    requestDigest,
    ...(selectedPath === undefined ? {} : { selectedPath }),
  };
}

function safeRequestId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_REQUEST_ID_LENGTH || /\s/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("requestId is invalid");
  }
  return value;
}

function safeSelectedPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SELECTED_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("selectedPath is invalid");
  }
  return value;
}

export function channelMetadata(state: BuilderChannelState): Record<string, unknown> {
  if (!state.draftId || state.revision === null || !state.digest) {
    return { audience: "private", bound: false };
  }
  return {
    audience: "private",
    bound: true,
    draftId: state.draftId,
    revision: state.revision,
    digest: state.digest,
  };
}

export default defineChannel<BuilderChannelState>({
  state: initialState,
  kindHint: "skill-builder",
  turnPolicy: "steer",
  metadata: channelMetadata,
  routes: [
    GET("/internal/builder/status", async (request) => {
      if (!isAuthorized(request)) return unauthorized();
      return Response.json(builderStatus(), {
        headers: { "cache-control": "no-store" },
      });
    }),
    POST("/internal/builder/sessions", async (request, { from }) => {
      if (!isAuthorized(request)) return unauthorized();
      let body: Record<string, unknown>;
      try {
        body = await readJson(request);
      } catch (error) {
        return invalid(error instanceof Error ? error.message : "invalid request");
      }
      let input: ReturnType<typeof parseSessionRequest>;
      try {
        input = parseSessionRequest(body);
      } catch (error) {
        return invalid(error instanceof Error ? error.message : "invalid request");
      }
      const status = builderStatus();
      if (!status.enabled) return invalid("skill builder is disabled", 503);
      try {
        const session = await from(input.sessionKey).send(input.message, {
          auth: servicePrincipal,
          state: {
            sessionKey: input.sessionKey,
            draftId: input.draftId,
            revision: input.revision,
            digest: input.digest,
          },
        });
        return Response.json({
          status: "accepted",
          sessionId: session.id,
          sessionKey: input.sessionKey,
          draftId: input.draftId,
          revision: input.revision,
          digest: input.digest,
          requestId: input.requestId,
          requestDigest: input.requestDigest,
          ...(input.selectedPath === undefined ? {} : { selectedPath: input.selectedPath }),
        }, {
          status: 202,
          headers: { "cache-control": "no-store" },
        });
      } catch {
        return invalid("skill builder session could not be started", 502);
      }
    }),
  ],
});
