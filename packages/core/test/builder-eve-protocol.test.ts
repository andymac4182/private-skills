import { describe, expect, it } from 'vitest';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { createRegistryHandler } from '../src/index.js';
import { digestBytes } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  StateRepository,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const APP_ORIGIN = 'https://builder.example.test';
const ORGANIZATION = 'org-test';
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;

type JsonRecord = Record<string, unknown>;

interface EveCall {
  url: string;
  method: string;
  body?: JsonRecord;
}

interface EveHarness {
  readonly calls: EveCall[];
  events: JsonRecord[];
  cancelResponse: JsonRecord;
  mismatchAcceptance: boolean;
  mismatchRegistrySession: boolean;
  fetch: typeof fetch;
}

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
    if (!bytes) throw new Error('missing blob');
    return bytes.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function principal(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'publisher',
    roles: ['publisher'],
    namespaces: ['@team'],
    scopes: ['registry:read', 'skills:read', 'skills:write', 'skills:publish'],
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function parseBody(init: RequestInit | undefined): JsonRecord | undefined {
  if (typeof init?.body !== 'string') return undefined;
  const value: unknown = JSON.parse(init.body);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function createEveHarness(): EveHarness {
  const harness = {
    calls: [],
    events: [],
    cancelResponse: { ok: true, status: 'accepted' },
    mismatchAcceptance: false,
    mismatchRegistrySession: false,
  } as Omit<EveHarness, 'fetch'> & { fetch?: typeof fetch };

  harness.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = parseBody(init);
    harness.calls.push({ url: url.toString(), method, ...(body ? { body } : {}) });

    if (url.origin !== APP_ORIGIN) throw new Error('unexpected upstream origin');
    if (url.pathname === '/internal/builder/sessions' && method === 'POST') {
      if (!body) return responseJson({ error: 'body required' }, 400);
      const sessionId = 'eve-session-1';
      return responseJson({
        status: 'accepted',
        sessionId,
        sessionKey: body.sessionKey,
        draftId: body.draftId,
        revision: body.revision,
        digest: body.digest,
        requestId: harness.mismatchAcceptance ? 'wrong-request-id' : body.requestId,
        requestDigest: harness.mismatchAcceptance ? ZERO_DIGEST : body.requestDigest,
        registrySessionId: harness.mismatchRegistrySession ? 'wrong-registry-session' : body.registrySessionId,
      });
    }

    if (url.pathname.startsWith('/eve/v1/session/') && url.pathname.endsWith('/cancel') && method === 'POST') {
      return responseJson(harness.cancelResponse);
    }

    if (url.pathname.startsWith('/eve/v1/session/') && method === 'GET') {
      const text = harness.events.map((event) => JSON.stringify(event)).join('\n');
      return new Response(text.length > 0 ? `${text}\n` : '', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }

    throw new Error(`unexpected upstream request: ${method} ${url.pathname}`);
  };

  return harness as EveHarness;
}

interface Fixture {
  readonly handler: ReturnType<typeof createRegistryHandler>;
  readonly repository: StateRepository;
  readonly eve: EveHarness;
}

function fixture(): Fixture {
  const state: RegistryState = defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: 'protocol-test-policy',
  });
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  const blobs = new MemoryBlobs();
  const eve = createEveHarness();
  const auth: Authenticator = { authenticate: async () => principal() };
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
    builder: {
      appOrigin: APP_ORIGIN,
      serviceToken: 'builder-service-token',
      eveToken: 'eve-session-token',
      fetch: eve.fetch,
    },
  });
  return { handler, repository, eve };
}

function base64Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function json(response: Response): Promise<JsonRecord> {
  return await response.json() as JsonRecord;
}

async function createDraft(test: Fixture): Promise<{ id: string; revision: number; digest: string }> {
  const response = await test.handler(new Request(`${ORIGIN}/v1/drafts`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'idempotency-key': 'upload-protocol-test',
    },
    body: JSON.stringify({
      name: '@team/protocol-test',
      files: [{
        path: 'SKILL.md',
        content: base64Text('---\nname: protocol-test\ndescription: Protocol test\n---\n# Protocol test\n'),
      }],
    }),
  }));
  expect(response.status).toBe(201);
  const body = await json(response);
  return body.draft as { id: string; revision: number; digest: string };
}

async function createSession(test: Fixture, draft: { id: string; revision: number; digest: string }): Promise<string> {
  const response = await test.handler(new Request(
    `${ORIGIN}/v1/drafts/${encodeURIComponent(draft.id)}/builder/session?revision=${draft.revision}&digest=${encodeURIComponent(draft.digest)}`,
    {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: draft.id,
        revision: draft.revision,
        digest: draft.digest,
        requestId: 'session-create-1',
      }),
    },
  ));
  expect(response.status).toBe(200);
  const body = await json(response);
  const session = body.session as { id: string };
  expect(session.id).toEqual(expect.any(String));
  return session.id;
}

async function sendPrompt(
  test: Fixture,
  draft: { id: string; revision: number; digest: string },
  sessionId: string,
  requestId = 'prompt-1',
): Promise<Response> {
  return await test.handler(new Request(
    `${ORIGIN}/v1/drafts/${encodeURIComponent(draft.id)}/builder/session/${encodeURIComponent(sessionId)}/prompt?revision=${draft.revision}&digest=${encodeURIComponent(draft.digest)}`,
    {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: draft.id,
        revision: draft.revision,
        digest: draft.digest,
        prompt: 'Please improve this skill.',
        requestId,
      }),
    },
  ));
}

function event(type: string, id: string, data: JsonRecord): JsonRecord {
  return {
    type,
    data,
    meta: { id, at: '2026-09-10T00:00:00.000Z' },
  };
}

async function sessionState(test: Fixture, draft: { id: string; revision: number; digest: string }, sessionId: string): Promise<JsonRecord> {
  const response = await test.handler(new Request(
    `${ORIGIN}/v1/drafts/${encodeURIComponent(draft.id)}/builder/session/${encodeURIComponent(sessionId)}?revision=${draft.revision}&digest=${encodeURIComponent(draft.digest)}`,
  ));
  expect(response.status).toBe(200);
  const body = await json(response);
  return body.session as JsonRecord;
}

describe('core skill builder Eve protocol boundary', () => {
  it('correlates message deltas and completion by turn and step, despite distinct event ids', async () => {
    const test = fixture();
    test.eve.events = [
      event('turn.started', 'turn-start-event', { sequence: 1, turnId: 'turn-1' }),
      event('message.received', 'received-event', { message: 'Please improve this skill.', sequence: 2, turnId: 'turn-1' }),
      event('message.appended', 'append-event-1', { messageDelta: 'Hello ', sequence: 3, stepIndex: 0, turnId: 'turn-1' }),
      event('message.appended', 'append-event-2', { messageDelta: 'world', sequence: 4, stepIndex: 0, turnId: 'turn-1' }),
      event('message.completed', 'completed-event', { finishReason: 'stop', message: 'Hello world', sequence: 5, stepIndex: 0, turnId: 'turn-1' }),
      event('turn.completed', 'turn-completed-event', { sequence: 6, turnId: 'turn-1' }),
      event('session.waiting', 'session-waiting-event', {}),
    ];
    const draft = await createDraft(test);
    const sessionId = await createSession(test, draft);

    const response = await sendPrompt(test, draft, sessionId);
    expect(response.status).toBe(202);
    const body = await json(response);
    const session = body.session as { state: string; turns: Array<{ role: string; content: string }> };
    expect(session.state).toBe('ready');
    expect(session.turns.filter((turn) => turn.role === 'user')).toHaveLength(1);
    expect(session.turns.filter((turn) => turn.role === 'assistant')).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Hello world' }),
    ]);
  });

  it('maps provider turn failure and cancellation into terminal session state', async () => {
    const failed = fixture();
    failed.eve.events = [
      event('turn.started', 'failed-start', { sequence: 1, turnId: 'turn-failed' }),
      event('turn.failed', 'failed-end', { code: 'MODEL_FAILED', message: 'provider failed', sequence: 2, turnId: 'turn-failed' }),
    ];
    const failedDraft = await createDraft(failed);
    const failedSessionId = await createSession(failed, failedDraft);
    expect((await sendPrompt(failed, failedDraft, failedSessionId)).status).toBe(202);
    expect((await sessionState(failed, failedDraft, failedSessionId)).state).toBe('failed');

    const cancelled = fixture();
    cancelled.eve.events = [
      event('turn.started', 'cancelled-start', { sequence: 1, turnId: 'turn-cancelled' }),
      event('turn.cancelled', 'cancelled-end', { sequence: 2, turnId: 'turn-cancelled' }),
    ];
    const cancelledDraft = await createDraft(cancelled);
    const cancelledSessionId = await createSession(cancelled, cancelledDraft);
    expect((await sendPrompt(cancelled, cancelledDraft, cancelledSessionId)).status).toBe(202);
    expect((await sessionState(cancelled, cancelledDraft, cancelledSessionId)).state).toBe('stopped');
  });

  it('does not stop a running session when cancel returns an unrecognized successful response', async () => {
    const test = fixture();
    test.eve.events = [
      event('turn.started', 'running-start', { sequence: 1, turnId: 'turn-running' }),
    ];
    test.eve.cancelResponse = { ok: false, status: 'unexpected' };
    const draft = await createDraft(test);
    const sessionId = await createSession(test, draft);
    expect((await sendPrompt(test, draft, sessionId)).status).toBe(202);

    const response = await test.handler(new Request(
      `${ORIGIN}/v1/drafts/${encodeURIComponent(draft.id)}/builder/session/${encodeURIComponent(sessionId)}/stop?revision=${draft.revision}&digest=${encodeURIComponent(draft.digest)}`,
      {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'stop-1' }),
      },
    ));
    expect(response.status).toBe(502);
    expect((await sessionState(test, draft, sessionId)).state).toBe('running');
  });

  it('does not bind an Eve session when app acceptance echoes mismatched request metadata', async () => {
    const test = fixture();
    test.eve.mismatchAcceptance = true;
    const draft = await createDraft(test);
    const sessionId = await createSession(test, draft);

    const response = await sendPrompt(test, draft, sessionId);
    expect(response.status).toBe(502);
    const state = await test.repository.read(ORGANIZATION);
    const record = state.builderSessions?.find((candidate) => candidate.id === sessionId);
    expect(record).toBeDefined();
    expect(record?.eveSessionId).toBe('');
    expect(record?.requests).toEqual([
      expect.objectContaining({ id: 'prompt-1', state: 'uncertain' }),
    ]);
    expect(test.eve.calls.filter((call) => call.url.includes('/eve/v1/session/'))).toHaveLength(0);
  });

  it('does not bind an Eve session when app acceptance echoes a different registry session', async () => {
    const test = fixture();
    test.eve.mismatchRegistrySession = true;
    const draft = await createDraft(test);
    const sessionId = await createSession(test, draft);

    const response = await sendPrompt(test, draft, sessionId, 'prompt-registry-session');
    expect(response.status).toBe(502);
    const state = await test.repository.read(ORGANIZATION);
    const record = state.builderSessions?.find((candidate) => candidate.id === sessionId);
    expect(record?.eveSessionId).toBe('');
    expect(record?.requests).toEqual([
      expect.objectContaining({ id: 'prompt-registry-session', state: 'uncertain' }),
    ]);
    expect(test.eve.calls.filter((call) => call.url.includes('/eve/v1/session/'))).toHaveLength(0);
  });
});
