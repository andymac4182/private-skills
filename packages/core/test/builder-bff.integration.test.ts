import { describe, expect, it } from 'vitest';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  SkillBundle,
  SkillVersion,
  StoredBlob,
} from '../../contracts/src/index.js';
import { createRegistryHandler } from '../src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-builder';
const SERVICE_ORIGIN = 'https://builder.example.test';
const SERVICE_TOKEN = 'service-secret';
const EVE_TOKEN = 'eve-secret';

function base64Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();

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
    if (!bytes) throw new Error(`missing blob ${key}`);
    return bytes.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function principal(
  subject: string,
  namespaces: string[],
  roles: Principal['roles'] = ['publisher', 'reader'],
  scopes: string[] = ['skills:read', 'registry:read', 'skills:write', 'skills:publish'],
): Principal {
  return {
    organizationId: ORGANIZATION,
    subject,
    roles,
    namespaces,
    scopes,
  };
}

const PUBLISHER = principal('publisher', ['@team']);
const OTHER_PUBLISHER = principal('other-publisher', ['@other']);
const READER = principal('reader', ['@team'], ['reader'], ['registry:read', 'skills:read']);

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
}

interface Fixture {
  state: RegistryState;
  repository: ReturnType<typeof createMemoryStateRepository>;
  blobs: MemoryBlobs;
  release: SkillVersion;
  bundle: SkillBundle;
  handler: ReturnType<typeof createRegistryHandler>;
  calls: RecordedCall[];
  modelCalls: number;
  streamCalls: number;
  cancellations: RecordedCall[];
  firstModelEntered?: Promise<void>;
  releaseFirstModel?: () => void;
}

interface FixtureOptions {
  holdFirstModel?: boolean;
  providerSessionId?: unknown;
  streamBody?: string;
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const state = defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: 'builder-policy',
  });
  const bundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [
      {
        path: 'SKILL.md',
        content: base64Text('---\nname: demo\ndescription: Base demo\n---\n# Demo\n'),
      },
      {
        path: 'docs/guide.md',
        content: base64Text('# Guide\n'),
      },
    ],
  };
  const blobs = new MemoryBlobs();
  const artifact = await blobs.put(encodeBundle(bundle));
  const release: SkillVersion = {
    id: 'release-1',
    organizationId: ORGANIZATION,
    name: '@team/demo',
    skillName: 'demo',
    version: '1.0.0',
    description: 'Base demo',
    artifact,
    state: 'approved',
    policyRevision: state.policy.revision,
    createdAt: '2026-09-10T00:00:00.000Z',
    approvedAt: '2026-09-10T00:00:01.000Z',
    provenance: { kind: 'native' },
    fileCount: bundle.files.length,
    scanIds: [],
  };
  state.skills.push(release);

  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  const calls: RecordedCall[] = [];
  const cancellations: RecordedCall[] = [];
  let modelCalls = 0;
  let streamCalls = 0;
  let firstModelEnteredResolve: (() => void) | undefined;
  let releaseFirstModelResolve: (() => void) | undefined;
  const firstModelEntered = options.holdFirstModel
    ? new Promise<void>((resolve) => { firstModelEnteredResolve = resolve; })
    : undefined;
  const firstModelRelease = options.holdFirstModel
    ? new Promise<void>((resolve) => { releaseFirstModelResolve = resolve; })
    : undefined;
  let registryHandler: ReturnType<typeof createRegistryHandler>;

  const tokens = new Map<string, Principal>([
    ['publisher-token', PUBLISHER],
    ['other-token', OTHER_PUBLISHER],
    ['reader-token', READER],
  ]);
  const auth: Authenticator = {
    authenticate: async (request) => {
      const header = request.headers.get('authorization');
      if (header?.startsWith('Bearer ')) return tokens.get(header.slice('Bearer '.length)) ?? null;
      return request.headers.get('cookie') === 'pskills-session=publisher-cookie' ? PUBLISHER : null;
    },
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const request = new Request(url, init);
    const body = init?.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : await new Response(init.body).text();
    const call: RecordedCall = {
      url,
      method: request.method,
      authorization: request.headers.get('authorization'),
      body,
    };
    calls.push(call);

    if (url === `${SERVICE_ORIGIN}/internal/builder/status`) {
      return Response.json({ enabled: true });
    }

    if (url === `${SERVICE_ORIGIN}/internal/builder/sessions`) {
      modelCalls += 1;
      if (options.holdFirstModel && modelCalls === 1) {
        firstModelEnteredResolve?.();
        await firstModelRelease;
      }
      const payload = JSON.parse(body ?? '{}') as {
        sessionKey?: string;
        draftId?: string;
        revision?: number;
        digest?: string;
        message?: string;
      };
      const current = await repository.read(ORGANIZATION);
      const session = current.builderSessions?.find((candidate) => candidate.sessionKey === payload.sessionKey);
      if (!session || session.draftId !== payload.draftId || session.draftRevision !== payload.revision || session.draftDigest !== payload.digest) {
        return Response.json({ error: 'invalid-session-binding' }, { status: 409 });
      }
      const proposalResponse = await registryHandler(new Request(`${ORIGIN}/v1/drafts/${session.draftId}/proposals`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer publisher-token',
          'content-type': 'application/json',
          'idempotency-key': `proposal-${session.id}`,
          'x-pskills-tool-identity': 'skill-builder',
        },
        body: JSON.stringify({
          draftId: session.draftId,
          revision: session.draftRevision,
          digest: session.draftDigest,
          sessionId: session.id,
          operations: [{
            op: 'edit',
            path: 'SKILL.md',
            content: '---\nname: demo\ndescription: Builder proposal\n---\n# Builder proposal\n',
          }],
        }),
      }));
      if (proposalResponse.status !== 201 && proposalResponse.status !== 200) {
        return Response.json({ error: 'proposal-create-failed' }, { status: 502 });
      }
      return Response.json({ sessionId: options.providerSessionId ?? 'eve-session-1' });
    }

    const providerSessionIdValue = options.providerSessionId ?? 'eve-session-1';
    const providerSessionId = encodeURIComponent(typeof providerSessionIdValue === 'string' ? providerSessionIdValue : 'invalid-provider-session');
    if (url.startsWith(`${SERVICE_ORIGIN}/eve/v1/session/${providerSessionId}/stream`)) {
      streamCalls += 1;
      const stream = options.streamBody ?? [
        JSON.stringify({
          type: 'message.received',
          meta: { id: 'turn-user', at: '2026-09-10T00:01:00.000Z' },
          data: { message: 'Suggest a bounded edit', turnId: 'turn-1' },
        }),
        JSON.stringify({
          type: 'message.completed',
          meta: { id: 'turn-assistant', at: '2026-09-10T00:01:01.000Z' },
          data: { message: 'I prepared a proposal.' },
        }),
      ].join('\n') + '\n';
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }

    if (url === `${SERVICE_ORIGIN}/eve/v1/session/${providerSessionId}/cancel`) {
      cancellations.push(call);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'unexpected-upstream-request' }, { status: 404 });
  };

  registryHandler = createRegistryHandler({
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
      appOrigin: SERVICE_ORIGIN,
      serviceToken: SERVICE_TOKEN,
      eveToken: EVE_TOKEN,
      fetch: fakeFetch,
    },
  });

  return {
    state,
    repository,
    blobs,
    release,
    bundle,
    handler: registryHandler,
    calls,
    get modelCalls() { return modelCalls; },
    get streamCalls() { return streamCalls; },
    cancellations,
    firstModelEntered,
    releaseFirstModel: options.holdFirstModel ? () => releaseFirstModelResolve?.() : undefined,
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function request(
  fixture: Fixture,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return await fixture.handler(new Request(`${ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

async function createReleaseDraft(fixture: Fixture, key = 'draft-create-1'): Promise<Record<string, any>> {
  const response = await request(fixture, '/v1/skills/release-1/drafts', {
    method: 'POST',
    token: 'publisher-token',
    headers: { 'idempotency-key': key },
    body: { baseDigest: fixture.release.artifact.digest },
  });
  expect(response.status).toBe(201);
  const body = await json(response);
  return body.draft;
}

function bindingQuery(draft: Record<string, any>): string {
  return `revision=${encodeURIComponent(String(draft.revision))}&digest=${encodeURIComponent(String(draft.digest))}`;
}

async function createSession(fixture: Fixture, draft: Record<string, any>, requestId = 'session-1'): Promise<Record<string, any>> {
  const response = await request(fixture, `/v1/drafts/${draft.id}/builder/session?${bindingQuery(draft)}`, {
    method: 'POST',
    token: 'publisher-token',
    body: { revision: draft.revision, digest: draft.digest, requestId },
  });
  expect(response.status).toBe(200);
  return (await json(response)).session;
}

async function prompt(fixture: Fixture, draft: Record<string, any>, sessionId: string, requestId = 'prompt-1'): Promise<Response> {
  return await request(fixture, `/v1/drafts/${draft.id}/builder/session/${sessionId}/prompt?${bindingQuery(draft)}`, {
    method: 'POST',
    token: 'publisher-token',
    body: { prompt: 'Suggest a bounded edit', requestId, selectedPath: 'SKILL.md' },
  });
}

async function internalProposal(
  fixture: Fixture,
  draft: Record<string, any>,
  sessionId: string,
  idempotencyKey: string,
  content: string,
): Promise<Response> {
  return await fixture.handler(new Request(`${ORIGIN}/v1/drafts/${draft.id}/proposals`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer publisher-token',
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-pskills-tool-identity': 'skill-builder',
    },
    body: JSON.stringify({
      draftId: draft.id,
      revision: draft.revision,
      digest: draft.digest,
      sessionId,
      operations: [{ op: 'edit', path: 'SKILL.md', content }],
    }),
  }));
}

describe('builder BFF draft contract', () => {
  it('creates a local release draft session without AI, proposes through the real authoring CAS, and applies only after human approval', async () => {
    const fixture = await makeFixture();
    const draft = await createReleaseDraft(fixture);
    expect(draft).toMatchObject({ origin: 'release', revision: 1, digest: fixture.release.artifact.digest, status: 'open' });

    const availability = await request(fixture, `/v1/drafts/${draft.id}/builder/availability`, { token: 'publisher-token' });
    expect(availability.status).toBe(200);
    expect(await json(availability)).toEqual({ enabled: true });
    expect(fixture.calls.filter((call) => call.url.endsWith('/internal/builder/sessions'))).toHaveLength(0);

    const session = await createSession(fixture, draft);
    expect(session).toMatchObject({
      binding: { draftId: draft.id, revision: 1, digest: draft.digest },
      state: 'ready',
      turns: [],
      proposal: null,
    });
    expect(fixture.modelCalls).toBe(0);

    const loaded = await request(fixture, `/v1/drafts/${draft.id}/builder/session/${session.id}?${bindingQuery(draft)}`, { token: 'publisher-token' });
    expect(loaded.status).toBe(200);
    expect((await json(loaded)).session).toMatchObject({ id: session.id, state: 'ready', binding: session.binding });
    expect(fixture.modelCalls).toBe(0);

    const firstPrompt = await prompt(fixture, draft, session.id);
    expect(firstPrompt.status).toBe(202);
    const prompted = (await json(firstPrompt)).session;
    expect(prompted).toMatchObject({
      id: session.id,
      state: 'running',
      binding: session.binding,
      proposal: { state: 'pending', baseRevision: 1, baseDigest: draft.digest, operations: [{ op: 'edit', path: 'SKILL.md' }] },
    });
    const proposal = prompted.proposal as Record<string, any>;
    expect(proposal.id).toEqual(expect.any(String));
    expect(proposal.proposedDigest).not.toBe(draft.digest);
    expect(fixture.modelCalls).toBe(1);
    expect(fixture.streamCalls).toBe(1);

    const retryPrompt = await prompt(fixture, draft, session.id);
    expect(retryPrompt.status).toBe(200);
    expect(fixture.modelCalls).toBe(1);
    expect(fixture.streamCalls).toBe(2);

    const idempotencyConflict = await internalProposal(
      fixture,
      draft,
      session.id,
      `proposal-${session.id}`,
      '---\nname: demo\ndescription: A different proposal\n---\n# Different\n',
    );
    expect(idempotencyConflict.status).toBe(409);
    const idempotencyConflictBody = await json(idempotencyConflict);
    expect(idempotencyConflictBody.error?.code ?? idempotencyConflictBody.code).toBe('IDEMPOTENCY_CONFLICT');

    const apply = await request(fixture, `/v1/drafts/${draft.id}/proposals/${proposal.id}/apply`, {
      method: 'POST',
      token: 'publisher-token',
      headers: { 'idempotency-key': 'builder-apply-1' },
      body: { revision: draft.revision, digest: draft.digest, sessionId: session.id },
    });
    expect(apply.status).toBe(200);
    const applied = await json(apply);
    expect(applied.proposal).toMatchObject({ id: proposal.id, state: 'applied', baseRevision: 1 });
    expect(applied.draft).toMatchObject({ id: draft.id, revision: 2, status: 'open' });
    expect(applied.draft.digest).toBe(proposal.proposedDigest);
    expect(applied.draft.digest).not.toBe(draft.digest);

    const loadedDraft = await request(fixture, `/v1/drafts/${draft.id}`, { token: 'publisher-token' });
    expect(loadedDraft.status).toBe(200);
    expect((await json(loadedDraft)).draft).toMatchObject({ id: draft.id, revision: 2, digest: proposal.proposedDigest, status: 'open' });
    const afterApply = await fixture.repository.read(ORGANIZATION);
    expect(afterApply.skills).toHaveLength(1);
    expect(afterApply.jobs).toHaveLength(0);
    expect(afterApply.drafts).toHaveLength(1);
    expect(afterApply.drafts?.[0]).toMatchObject({ revision: 2, status: 'open', digest: proposal.proposedDigest });
    expect(afterApply.skills[0]?.artifact).toEqual(fixture.release.artifact);

    const replay = await request(fixture, `/v1/drafts/${draft.id}/proposals/${proposal.id}/apply`, {
      method: 'POST',
      token: 'publisher-token',
      headers: { 'idempotency-key': 'builder-apply-1' },
      body: { revision: draft.revision, digest: draft.digest, sessionId: session.id },
    });
    expect(replay.status).toBe(200);
    expect((await json(replay)).draft).toMatchObject({ revision: 2, digest: proposal.proposedDigest });
    expect((await fixture.repository.read(ORGANIZATION)).drafts?.[0]?.revision).toBe(2);

    const serviceCalls = fixture.calls.filter((call) => call.url.startsWith(SERVICE_ORIGIN));
    expect(serviceCalls.filter((call) => call.url.includes('/internal/')).every((call) => call.authorization === `Bearer ${SERVICE_TOKEN}`)).toBe(true);
    expect(serviceCalls.filter((call) => call.url.includes('/eve/')).every((call) => call.authorization === `Bearer ${EVE_TOKEN}`)).toBe(true);
    expect(JSON.stringify(applied)).not.toContain(SERVICE_TOKEN);
    expect(JSON.stringify(applied)).not.toContain(EVE_TOKEN);
  });

  it('enforces authentication, publisher namespace, stale bindings, and exact Eve cancellation targets', async () => {
    const fixture = await makeFixture();
    const draft = await createReleaseDraft(fixture);

    const unauthenticated = await request(fixture, `/v1/drafts/${draft.id}/builder/availability`);
    expect(unauthenticated.status).toBe(401);
    const reader = await request(fixture, `/v1/drafts/${draft.id}/builder/availability`, { token: 'reader-token' });
    expect(reader.status).toBe(403);
    const otherNamespace = await request(fixture, `/v1/drafts/${draft.id}/builder/availability`, { token: 'other-token' });
    expect(otherNamespace.status).toBe(404);

    const stale = await request(fixture, `/v1/drafts/${draft.id}/builder/session?revision=99&digest=${encodeURIComponent(draft.digest)}`, {
      method: 'POST',
      token: 'publisher-token',
      body: { revision: 99, digest: draft.digest, requestId: 'stale-session' },
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe('STALE_BINDING');

    const session = await createSession(fixture, draft, 'stop-session');
    const accepted = await prompt(fixture, draft, session.id, 'stop-prompt');
    expect(accepted.status).toBe(202);
    const stopped = await request(fixture, `/v1/drafts/${draft.id}/builder/session/${session.id}/stop?${bindingQuery(draft)}`, {
      method: 'POST',
      token: 'publisher-token',
      body: { requestId: 'stop-request' },
    });
    expect(stopped.status).toBe(204);
    expect(fixture.cancellations).toHaveLength(1);
    expect(fixture.cancellations[0]).toMatchObject({
      url: `${SERVICE_ORIGIN}/eve/v1/session/eve-session-1/cancel`,
      method: 'POST',
      authorization: `Bearer ${EVE_TOKEN}`,
      body: JSON.stringify({ turnId: 'turn-1' }),
    });
    const stoppedState = await fixture.repository.read(ORGANIZATION);
    const stoppedSession = stoppedState.builderSessions?.find((candidate) => candidate.id === session.id);
    expect(stoppedSession).toMatchObject({ state: 'stopped' });
    expect(stoppedSession).not.toHaveProperty('activeTurnId');
  });

  it('denies cookie-authenticated mutations without same-origin evidence and rejects cross-origin mutations', async () => {
    const fixture = await makeFixture();
    const draft = await createReleaseDraft(fixture, 'csrf-draft');
    const missingOrigin = await request(fixture, `/v1/drafts/${draft.id}/builder/session?${bindingQuery(draft)}`, {
      method: 'POST',
      headers: { cookie: 'pskills-session=publisher-cookie' },
      body: { revision: draft.revision, digest: draft.digest, requestId: 'cookie-no-origin' },
    });
    expect(missingOrigin.status).toBe(403);
    expect((await json(missingOrigin)).code).toBe('CSRF_DENIED');

    const crossOrigin = await request(fixture, `/v1/drafts/${draft.id}/builder/session?${bindingQuery(draft)}`, {
      method: 'POST',
      token: 'publisher-token',
      headers: {
        origin: 'https://attacker.example.test',
        'sec-fetch-site': 'cross-site',
      },
      body: { revision: draft.revision, digest: draft.digest, requestId: 'cross-origin' },
    });
    expect(crossOrigin.status).toBe(403);
    expect((await json(crossOrigin)).code).toBe('CSRF_DENIED');
    expect((await fixture.repository.read(ORGANIZATION)).builderSessions ?? []).toHaveLength(0);
  });

  it('fails closed on malformed or oversized provider session identifiers before opening Eve streams', async () => {
    const malformed = await makeFixture({ providerSessionId: 123 });
    const malformedDraft = await createReleaseDraft(malformed, 'malformed-provider-draft');
    const malformedSession = await createSession(malformed, malformedDraft, 'malformed-provider-session');
    const malformedResponse = await prompt(malformed, malformedDraft, malformedSession.id, 'malformed-provider-prompt');
    expect(malformedResponse.status).toBe(502);
    expect((await json(malformedResponse)).code).toBe('BUILDER_UPSTREAM');
    expect(malformed.streamCalls).toBe(0);

    const oversized = await makeFixture({ providerSessionId: 's'.repeat(257) });
    const oversizedDraft = await createReleaseDraft(oversized, 'oversized-provider-draft');
    const oversizedSession = await createSession(oversized, oversizedDraft, 'oversized-provider-session');
    const oversizedResponse = await prompt(oversized, oversizedDraft, oversizedSession.id, 'oversized-provider-prompt');
    expect(oversizedResponse.status).toBe(400);
    expect((await json(oversizedResponse)).code).toBe('INVALID_REQUEST');
    expect(oversized.streamCalls).toBe(0);
  });

  it('does not expose raw Eve stream secrets and bounds oversized stream payloads', async () => {
    const unsafeStream = [
      JSON.stringify({
        type: 'message.received',
        meta: { id: 'unsafe-user', at: '2026-09-10T00:02:00.000Z' },
        data: { message: 'safe prompt', turnId: 'turn-1', accessToken: EVE_TOKEN, serviceToken: SERVICE_TOKEN },
      }),
      JSON.stringify({
        type: 'message.completed',
        meta: { id: 'unsafe-assistant', at: '2026-09-10T00:02:01.000Z' },
        data: { message: 'safe answer', credential: EVE_TOKEN },
      }),
    ].join('\n') + '\n';
    const fixture = await makeFixture({ streamBody: unsafeStream });
    const draft = await createReleaseDraft(fixture, 'stream-safety-draft');
    const session = await createSession(fixture, draft, 'stream-safety-session');
    const prompted = await prompt(fixture, draft, session.id, 'stream-safety-prompt');
    expect(prompted.status).toBe(202);
    const promptedBody = await json(prompted);
    expect(JSON.stringify(promptedBody)).not.toContain(EVE_TOKEN);
    expect(JSON.stringify(promptedBody)).not.toContain(SERVICE_TOKEN);

    const stream = await request(fixture, `/v1/drafts/${draft.id}/builder/session/${session.id}/stream?${bindingQuery(draft)}`, { token: 'publisher-token' });
    expect([404, 405, 200]).toContain(stream.status);
    if (stream.status === 200) {
      const body = await stream.text();
      expect(body).not.toContain(EVE_TOKEN);
      expect(body).not.toContain(SERVICE_TOKEN);
    }

    const oversized = await makeFixture({ streamBody: 'x'.repeat(2 * 1024 * 1024 + 1) });
    const oversizedDraft = await createReleaseDraft(oversized, 'stream-size-draft');
    const oversizedSession = await createSession(oversized, oversizedDraft, 'stream-size-session');
    const oversizedPrompt = await prompt(oversized, oversizedDraft, oversizedSession.id, 'stream-size-prompt');
    expect(oversizedPrompt.status).toBe(502);
    expect((await json(oversizedPrompt)).code).toBe('BUILDER_UPSTREAM');
  });

  it('serializes concurrent proposal apply and reject so one terminal state owns the draft CAS', async () => {
    const fixture = await makeFixture();
    const draft = await createReleaseDraft(fixture, 'concurrent-draft');
    const session = await createSession(fixture, draft, 'concurrent-session');
    const prompted = await prompt(fixture, draft, session.id, 'concurrent-prompt');
    expect(prompted.status).toBe(202);
    const proposal = ((await json(prompted)).session.proposal) as Record<string, any>;

    const [apply, reject] = await Promise.all([
      request(fixture, `/v1/drafts/${draft.id}/proposals/${proposal.id}/apply`, {
        method: 'POST',
        token: 'publisher-token',
        headers: { 'idempotency-key': 'concurrent-apply' },
        body: { revision: draft.revision, digest: draft.digest, sessionId: session.id },
      }),
      request(fixture, `/v1/drafts/${draft.id}/proposals/${proposal.id}/reject`, {
        method: 'POST',
        token: 'publisher-token',
        headers: { 'idempotency-key': 'concurrent-reject' },
        body: { revision: draft.revision, digest: draft.digest, sessionId: session.id },
      }),
    ]);
    expect([200, 404, 409]).toContain(apply.status);
    expect([200, 404, 409]).toContain(reject.status);

    const finalState = await fixture.repository.read(ORGANIZATION);
    const finalSession = finalState.builderSessions?.find((candidate) => candidate.id === session.id);
    const finalProposal = finalSession?.proposals.find((candidate) => candidate.id === proposal.id);
    expect(finalProposal?.state).toMatch(/^(applied|rejected)$/u);
    expect(finalState.drafts?.[0]?.revision).toBe(finalProposal?.state === 'applied' ? 2 : 1);
    if (finalProposal?.state === 'applied') {
      expect(finalState.drafts?.[0]?.digest).toBe(finalProposal.proposedDigest);
      expect(finalState.jobs).toHaveLength(0);
    } else {
      expect(finalState.drafts?.[0]?.digest).toBe(draft.digest);
    }
  });

  it('allows only one active prompt per local session while the external model call is unresolved', async () => {
    const fixture = await makeFixture({ holdFirstModel: true });
    const draft = await createReleaseDraft(fixture, 'prompt-fence-draft');
    const session = await createSession(fixture, draft, 'prompt-fence-session');
    const firstPrompt = prompt(fixture, draft, session.id, 'prompt-fence-first');
    await fixture.firstModelEntered;

    const secondPrompt = await prompt(fixture, draft, session.id, 'prompt-fence-second');
    fixture.releaseFirstModel?.();
    const firstResponse = await firstPrompt;

    expect(secondPrompt.status).toBe(409);
    expect((await json(secondPrompt)).code).toBe('BUILDER_BUSY');
    expect(firstResponse.status).toBe(202);
    expect(fixture.modelCalls).toBe(1);
  });

  it('supports native upload-origin drafts through the same local-session HTTP contract', async () => {
    const fixture = await makeFixture();
    const response = await request(fixture, '/v1/drafts', {
      method: 'POST',
      token: 'publisher-token',
      headers: { 'idempotency-key': 'upload-draft-1' },
      body: { name: '@team/uploaded', files: fixture.bundle.files },
    });
    expect(response.status).toBe(201);
    const draft = (await json(response)).draft;
    expect(draft).toMatchObject({ origin: 'upload', name: '@team/uploaded', revision: 1, status: 'open' });
    const session = await createSession(fixture, draft, 'upload-session');
    expect(session).toMatchObject({ binding: { draftId: draft.id, revision: 1, digest: draft.digest }, state: 'ready', turns: [], proposal: null });
    expect(fixture.modelCalls).toBe(0);
  });
});
