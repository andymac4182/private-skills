import type {
  Authenticator,
  BlobStore,
  Digest,
  Principal,
  RegistryState,
  SkillBuilderProposalRecord,
  SkillBuilderSessionRecord,
  StateRepository,
} from '../../contracts/src/index.js';
import {
  assertPublisher,
  canReadNamespace,
  type AuthoringHandlerDependencies,
} from '../../authoring/src/index.js';
import { writeDraftRevision } from '../../authoring/src/drafts.js';
import { digestBytes } from '../../storage/src/index.js';
import { validateDraftBinding, type DraftBinding } from '../../skill-builder/src/index.js';

const MAX_BODY_BYTES = 96 * 1024;
const MAX_TURNS = 200;
const MAX_TURN_TEXT_BYTES = 64 * 1024;
const MAX_REQUESTS = 64;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_PROMPT_BYTES = 8_000;
const MAX_REQUEST_ID_BYTES = 256;
const MAX_EVE_STREAM_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

export interface BuilderBffRuntime {
  /** Origin of the separate Eve service, without credentials or path. */
  readonly appOrigin: string;
  /** Token accepted only by the app's internal channel routes. */
  readonly serviceToken: string;
  /** Token accepted only by Eve's ID-addressed HTTP session routes. */
  readonly eveToken: string;
  readonly fetch?: typeof fetch;
}

export interface BuilderBffDependencies {
  readonly repository: StateRepository;
  readonly blobs: BlobStore;
  readonly auth: Authenticator;
  readonly config: { organizationId: string; publicOrigin: string; maxBodyBytes: number };
  readonly authoring: AuthoringHandlerDependencies;
  readonly runtime: BuilderBffRuntime;
}

interface BuilderTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

interface BuilderSessionDto {
  id: string;
  binding: DraftBinding;
  state: SkillBuilderSessionRecord['state'];
  turns: BuilderTurn[];
  proposal?: Record<string, unknown> | null;
}

interface BuilderEvent {
  type?: unknown;
  data?: Record<string, unknown>;
  meta?: { id?: unknown; at?: unknown };
}

type BuilderSessionLifecycle = 'ready' | 'running' | 'failed' | 'completed';

/**
 * Same-origin registry facade for the separate Eve builder app. All calls to
 * Eve are made with server credentials after the registry has authenticated
 * and namespace-checked the browser principal. The facade only exposes the
 * opaque registry session id to the browser.
 */
export function createBuilderBffHandler(deps: BuilderBffDependencies): (request: Request, principal: Principal) => Promise<Response | undefined> {
  const fetchImpl = deps.runtime.fetch ?? fetch;
  return async (request, principal) => {
    const parsed = parseBuilderPath(request.url);
    if (!parsed) return undefined;
    try {
      if (request.method.toUpperCase() === 'POST') assertSameOriginMutation(request, deps.config.publicOrigin);
      const draft = await readBoundDraft(deps.repository, parsed.draftId, principal, deps.config.organizationId);
      const binding = parseBindingFromRequest(request, parsed.draftId, draft.revision, draft.digest);
      if (binding.revision !== draft.revision || binding.digest !== draft.digest) throw builderError('STALE_BINDING', 'Draft revision is stale', 409);

      if (parsed.operation === 'availability') {
        if (request.method.toUpperCase() !== 'GET') return methodNotAllowed(['GET']);
        return await availability(fetchImpl, deps.runtime);
      }
      if (parsed.operation === 'session') {
        if (request.method.toUpperCase() === 'GET') return await loadSession(deps, fetchImpl, parsed.draftId, principal, binding);
        if (request.method.toUpperCase() === 'POST') return await createSession(deps, parsed.draftId, principal, binding, request);
        return methodNotAllowed(['GET', 'POST']);
      }
      if (parsed.operation === 'sessionId') {
        if (parsed.sessionId !== undefined) boundedSessionId(parsed.sessionId);
        if (request.method.toUpperCase() === 'GET' && parsed.action === 'stream') return await streamSession(deps, fetchImpl, parsed.draftId, principal, binding, parsed.sessionId!);
        if (request.method.toUpperCase() === 'GET') return await loadSession(deps, fetchImpl, parsed.draftId, principal, binding, parsed.sessionId);
        if (request.method.toUpperCase() === 'POST' && parsed.action === 'prompt') return await sendPrompt(deps, fetchImpl, parsed.draftId, principal, binding, parsed.sessionId, request);
        if (request.method.toUpperCase() === 'POST' && parsed.action === 'stop' && parsed.sessionId) return await stopSession(deps, fetchImpl, parsed.draftId, principal, binding, parsed.sessionId, request);
        return methodNotAllowed(['GET', 'POST']);
      }
      return undefined;
    } catch (error) {
      return builderErrorResponse(error);
    }
  };
}

async function availability(fetchImpl: typeof fetch, runtime: BuilderBffRuntime): Promise<Response> {
  try {
    const response = await fetchWithTimeout(fetchImpl, `${runtime.appOrigin}/internal/builder/status`, {
      method: 'GET',
      headers: { authorization: `Bearer ${runtime.serviceToken}`, accept: 'application/json' },
      redirect: 'error',
    });
    const value = await boundedJson(response, 64 * 1024);
    if (!response.ok || !isRecord(value)) return json({ enabled: false, reason: 'The skill builder is unavailable.' }, 200);
    const model = typeof value.model === 'string' && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu.test(value.model)
      ? value.model
      : undefined;
    return json({
      enabled: value.enabled === true,
      ...(model ? { model } : {}),
      ...(value.enabled === true ? {} : { reason: availabilityReason(value) }),
    }, 200);
  } catch {
    return json({ enabled: false, reason: 'The skill builder is unavailable.' }, 200);
  }
}

async function loadSession(
  deps: BuilderBffDependencies,
  fetchImpl: typeof fetch,
  draftId: string,
  principal: Principal,
  binding: DraftBinding,
  requestedSessionId?: string,
): Promise<Response> {
  const state = await deps.repository.read(deps.config.organizationId);
  const sessions = (state.builderSessions ?? []).filter((candidate) =>
    candidate.organizationId === deps.config.organizationId &&
    candidate.subject === principal.subject &&
    candidate.draftId === draftId,
  );
  const record = requestedSessionId === undefined
    ? sessions.filter((candidate) => candidate.draftRevision === binding.revision && candidate.draftDigest === binding.digest).sort(compareUpdated).at(-1)
    : sessions.find((candidate) => candidate.id === requestedSessionId);
  if (!record) throw builderError('BUILDER_SESSION_NOT_FOUND', 'No builder session exists for this draft revision', 404);
  assertSessionBinding(record, principal, binding, false);
  if (!record.eveSessionId) return json({ session: toSessionDto(record, []) }, 200);
  const snapshot = await fetchSessionSnapshot(fetchImpl, deps.runtime, record.eveSessionId);
  await reconcileSnapshot(deps.repository, deps.config.organizationId, record, snapshot);
  if (snapshot.lifecycle) record.state = snapshot.lifecycle;
  if (snapshot.lifecycle === 'ready' || snapshot.lifecycle === 'failed' || snapshot.lifecycle === 'completed') delete record.activeTurnId;
  else if (snapshot.activeTurnId) record.activeTurnId = snapshot.activeTurnId;
  return json({ session: toSessionDto(record, snapshot.events) }, 200);
}

async function createSession(
  deps: BuilderBffDependencies,
  draftId: string,
  principal: Principal,
  binding: DraftBinding,
  request: Request,
): Promise<Response> {
  const body = await readBoundedJson(request);
  assertBodyBinding(body, binding, draftId);
  boundedText(body.requestId, 'requestId', MAX_REQUEST_ID_BYTES);
  const record = await createPendingSession(deps.repository, principal, binding);
  return json({ session: toSessionDto(record, []) }, 200);
}

async function sendPrompt(
  deps: BuilderBffDependencies,
  fetchImpl: typeof fetch,
  draftId: string,
  principal: Principal,
  binding: DraftBinding,
  requestedSessionId: string | undefined,
  request: Request,
): Promise<Response> {
  const body = await readBoundedJson(request);
  assertBodyBinding(body, binding, draftId);
  const prompt = boundedText(body.prompt, 'prompt', MAX_PROMPT_BYTES);
  const requestId = boundedText(body.requestId, 'requestId', MAX_REQUEST_ID_BYTES);
  const selectedPath = optionalSelectedPath(body.selectedPath);
  const state = await deps.repository.read(deps.config.organizationId);
  const candidate = requestedSessionId === undefined
    ? (state.builderSessions ?? []).find((session) => session.organizationId === deps.config.organizationId && session.subject === principal.subject && session.draftId === draftId && session.draftRevision === binding.revision && session.draftDigest === binding.digest)
    : (state.builderSessions ?? []).find((session) => session.id === requestedSessionId && session.organizationId === deps.config.organizationId && session.subject === principal.subject && session.draftId === draftId);
  let record: SkillBuilderSessionRecord;
  if (candidate) {
    // A local session has no Eve id until the first prompt is accepted.
    assertSessionBinding(candidate, principal, binding, false);
    record = await reserveRequest(deps.repository, candidate.id, principal, requestId, binding, await digestBuilderRequest({
      draftId,
      revision: binding.revision,
      digest: binding.digest,
      sessionId: candidate.id,
      prompt,
      ...(selectedPath === undefined ? {} : { selectedPath }),
    }));
  } else {
    if (requestedSessionId !== undefined) throw builderError('BUILDER_SESSION_NOT_FOUND', 'Builder session is unavailable', 404);
    record = await createPendingSession(deps.repository, principal, binding);
    record = await reserveRequest(deps.repository, record.id, principal, requestId, binding, await digestBuilderRequest({
      draftId,
      revision: binding.revision,
      digest: binding.digest,
      sessionId: record.id,
      prompt,
      ...(selectedPath === undefined ? {} : { selectedPath }),
    }));
  }

  if (record.requests.find((candidate) => candidate.id === requestId)?.state === 'completed' && record.eveSessionId) {
    const snapshot = await fetchSessionSnapshot(fetchImpl, deps.runtime, record.eveSessionId);
    return json({ session: toSessionDto(record, snapshot.events) }, 200);
  }

  const payload = {
    sessionKey: record.sessionKey,
    draftId,
    revision: binding.revision,
    digest: binding.digest,
    message: prompt,
    requestId,
    requestDigest: record.requests.find((candidate) => candidate.id === requestId)?.requestDigest,
    ...(selectedPath === undefined ? {} : { selectedPath }),
  };
  let accepted: Record<string, unknown>;
  try {
    const response = await fetchWithTimeout(fetchImpl, `${deps.runtime.appOrigin}/internal/builder/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.runtime.serviceToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'error',
    });
    const value = await boundedJson(response, 64 * 1024);
    if (!response.ok || !isRecord(value) || typeof value.sessionId !== 'string') throw builderError('BUILDER_UPSTREAM', 'The skill builder could not accept the prompt', 502);
    accepted = { ...value, sessionId: boundedAcceptedSessionId(value.sessionId) };
  } catch (error) {
    // A transport or response failure is ambiguous: Eve may have accepted the
    // durable turn before the registry observed the response.  Keep the
    // request fenced until a later reconciliation can resolve the Eve id.
    await markRequest(
      deps.repository,
      deps.config.organizationId,
      record.id,
      requestId,
      record.requests.find((candidate) => candidate.id === requestId)?.requestDigest ?? await digestBuilderRequest({ draftId, revision: binding.revision, digest: binding.digest, sessionId: record.id, prompt, ...(selectedPath === undefined ? {} : { selectedPath }) }),
      'uncertain',
    );
    throw error;
  }
  record = await bindAcceptedSession(deps.repository, deps.config.organizationId, record.id, requestId, binding, String(accepted.sessionId));
  const snapshot = await fetchSessionSnapshot(fetchImpl, deps.runtime, record.eveSessionId);
  await reconcileSnapshot(deps.repository, deps.config.organizationId, record, snapshot);
  if (snapshot.lifecycle) record.state = snapshot.lifecycle;
  if (snapshot.lifecycle === 'ready' || snapshot.lifecycle === 'failed' || snapshot.lifecycle === 'completed') delete record.activeTurnId;
  else if (snapshot.activeTurnId) record.activeTurnId = snapshot.activeTurnId;
  return json({ session: toSessionDto(record, snapshot.events) }, 202);
}

async function stopSession(
  deps: BuilderBffDependencies,
  fetchImpl: typeof fetch,
  draftId: string,
  principal: Principal,
  binding: DraftBinding,
  sessionId: string,
  request: Request,
): Promise<Response> {
  const body = await readBoundedJson(request);
  const requestId = boundedText(body.requestId, 'requestId', MAX_REQUEST_ID_BYTES);
  const state = await deps.repository.read(deps.config.organizationId);
  const record = findOwnedSession(state, draftId, sessionId, principal);
  assertSessionBinding(record, principal, binding);
  if (record.state !== 'running') throw builderError('BUILDER_NOT_ACTIVE', 'The builder session has no active prompt', 409);
  const stopRequestDigest = await digestBuilderRequest({
    kind: 'stop',
    draftId,
    revision: binding.revision,
    digest: binding.digest,
    sessionId,
    requestId,
  });
  await fetchEve(fetchImpl, deps.runtime, `/eve/v1/session/${encodeURIComponent(boundedSessionId(record.eveSessionId))}/cancel`, {
    method: 'POST',
    body: JSON.stringify(record.activeTurnId ? { turnId: record.activeTurnId } : {}),
    headers: { 'content-type': 'application/json' },
  });
  await updateSession(deps.repository, deps.config.organizationId, record.id, (current) => {
    current.state = 'stopped';
    delete current.activeTurnId;
    delete current.activeRequestId;
    rememberRequest(current, requestId, stopRequestDigest, 'completed');
  });
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

async function streamSession(
  deps: BuilderBffDependencies,
  fetchImpl: typeof fetch,
  draftId: string,
  principal: Principal,
  binding: DraftBinding,
  sessionId: string,
): Promise<Response> {
  const state = await deps.repository.read(deps.config.organizationId);
  const record = findOwnedSession(state, draftId, sessionId, principal);
  assertSessionBinding(record, principal, binding);
  // Keep the registry facade sanitized.  Eve's raw stream includes tool,
  // tracing, and provider events that are server-internal; the browser gets
  // the same bounded turn DTO as the session routes.
  const snapshot = await fetchSessionSnapshot(fetchImpl, deps.runtime, boundedSessionId(record.eveSessionId));
  await reconcileSnapshot(deps.repository, deps.config.organizationId, record, snapshot);
  if (snapshot.lifecycle) record.state = snapshot.lifecycle;
  if (snapshot.lifecycle === 'ready' || snapshot.lifecycle === 'failed' || snapshot.lifecycle === 'completed') delete record.activeTurnId;
  else if (snapshot.activeTurnId) record.activeTurnId = snapshot.activeTurnId;
  return json({ session: toSessionDto(record, snapshot.events) }, 200);
}

async function createPendingSession(repository: StateRepository, principal: Principal, binding: DraftBinding): Promise<SkillBuilderSessionRecord> {
  const now = new Date().toISOString();
  const record: SkillBuilderSessionRecord = {
    id: randomId('builder'),
    organizationId: principal.organizationId,
    subject: principal.subject,
    draftId: binding.draftId,
    draftRevision: binding.revision,
    draftDigest: binding.digest,
    sessionKey: randomId('builder-key'),
    eveSessionId: '',
    state: 'ready',
    requests: [],
    proposals: [],
    createdAt: now,
    updatedAt: now,
  };
  return await repository.transaction(principal.organizationId, (state) => {
    state.builderSessions ??= [];
    const existing = state.builderSessions.find((candidate) => candidate.organizationId === principal.organizationId && candidate.subject === principal.subject && candidate.draftId === binding.draftId && candidate.draftRevision === binding.revision && candidate.draftDigest === binding.digest);
    if (existing) {
      return existing;
    }
    state.builderSessions.push(record);
    return record;
  });
}

async function reserveRequest(
  repository: StateRepository,
  sessionId: string,
  principal: Principal,
  requestId: string,
  binding: DraftBinding,
  requestDigest: Digest,
): Promise<SkillBuilderSessionRecord> {
  return await repository.transaction(principal.organizationId, (state) => {
    const record = findOwnedSession(state, binding.draftId, sessionId, principal);
    assertSessionBinding(record, principal, binding, false);
    const existing = record.requests.find((candidate) => candidate.id === requestId);
    if (existing && existing.requestDigest !== requestDigest) {
      throw builderError('IDEMPOTENCY_CONFLICT', 'That request id was already used with different prompt data', 409);
    }
    if (existing?.state === 'completed') return record;
    const unresolved = record.requests.find((candidate) => candidate.state === 'uncertain');
    if (unresolved && unresolved.id !== requestId) {
      throw builderError('BUILDER_RECONCILIATION_REQUIRED', 'The previous prompt has an unresolved provider result', 409);
    }
    const activeRequest = record.activeRequestId ?? record.requests.find((candidate) => candidate.state === 'accepted')?.id;
    if (activeRequest && activeRequest !== requestId) throw builderError('BUILDER_BUSY', 'That builder session is already processing a prompt', 409);
    if (existing?.state === 'accepted' || record.state === 'running') throw builderError('BUILDER_BUSY', 'That builder session is already processing a prompt', 409);
    record.activeRequestId = requestId;
    rememberRequest(record, requestId, requestDigest, 'accepted');
    return record;
  });
}

async function bindAcceptedSession(repository: StateRepository, organizationId: string, sessionId: string, requestId: string, binding: DraftBinding, eveSessionId: string): Promise<SkillBuilderSessionRecord> {
  return await repository.transaction(organizationId, (state) => {
    const record = (state.builderSessions ?? []).find((candidate) => candidate.id === sessionId && candidate.draftId === binding.draftId);
    if (!record || record.draftRevision !== binding.revision || record.draftDigest !== binding.digest) throw builderError('STALE_BINDING', 'Builder session binding changed', 409);
    if (record.eveSessionId && record.eveSessionId !== eveSessionId) throw builderError('BUILDER_UPSTREAM', 'Builder session identity changed', 502);
    record.eveSessionId = eveSessionId;
    record.state = 'running';
    const request = record.requests.find((candidate) => candidate.id === requestId);
    if (!request) throw builderError('BUILDER_UPSTREAM', 'Builder request record is missing', 502);
    rememberRequest(record, requestId, request.requestDigest, 'completed');
    record.updatedAt = new Date().toISOString();
    return record;
  });
}

async function markRequest(
  repository: StateRepository,
  organizationId: string,
  sessionId: string,
  requestId: string,
  requestDigest: Digest,
  status: 'accepted' | 'completed' | 'failed' | 'uncertain',
): Promise<void> {
  // A failed upstream request must still be durable so a retry can use a new
  // request id while an identical retry remains replay-safe.
  await repository.transaction(organizationId, (state) => {
    const record = (state.builderSessions ?? []).find((candidate) => candidate.id === sessionId);
    if (record) {
      rememberRequest(record, requestId, requestDigest, status);
      if ((status === 'failed' || status === 'uncertain') && record.activeRequestId === requestId) {
        // An uncertain request remains represented in the request log but no
        // longer blocks reconciliation from claiming the provider session.
        delete record.activeRequestId;
      }
    }
  });
}

async function updateSession(repository: StateRepository, organizationId: string, sessionId: string, updater: (record: SkillBuilderSessionRecord) => void): Promise<void> {
  await repository.transaction(organizationId, (state) => {
    const record = (state.builderSessions ?? []).find((candidate) => candidate.id === sessionId);
    if (record) {
      updater(record);
      record.updatedAt = new Date().toISOString();
    }
  });
}

function rememberRequest(record: SkillBuilderSessionRecord, id: string, requestDigest: Digest, state: 'accepted' | 'completed' | 'failed' | 'uncertain'): void {
  const now = new Date().toISOString();
  const current = record.requests.find((candidate) => candidate.id === id);
  if (current) {
    if (current.requestDigest !== requestDigest) throw builderError('IDEMPOTENCY_CONFLICT', 'That request id was already used with different prompt data', 409);
    current.state = state;
    current.updatedAt = now;
  } else {
    record.requests = [...record.requests.slice(-(MAX_REQUESTS - 1)), { id, requestDigest, state, createdAt: now, updatedAt: now }];
  }
}

function findOwnedSession(state: RegistryState, draftId: string, sessionId: string, principal: Principal): SkillBuilderSessionRecord {
  const record = (state.builderSessions ?? []).find((candidate) => candidate.id === sessionId && candidate.organizationId === principal.organizationId && candidate.subject === principal.subject && candidate.draftId === draftId);
  if (!record) throw builderError('BUILDER_SESSION_NOT_FOUND', 'Builder session is unavailable', 404);
  return record;
}

function assertSessionBinding(record: SkillBuilderSessionRecord, principal: Principal, binding: DraftBinding, requireEve = true): void {
  if (record.organizationId !== principal.organizationId || record.subject !== principal.subject || record.draftId !== binding.draftId || record.draftRevision !== binding.revision || record.draftDigest !== binding.digest || (requireEve && !record.eveSessionId)) {
    throw builderError('STALE_BINDING', 'Builder session is not bound to this draft revision', 409);
  }
}

async function readBoundDraft(repository: StateRepository, draftId: string, principal: Principal, organizationId: string): Promise<{ id: string; name: string; revision: number; digest: Digest }> {
  const state = await repository.read(organizationId);
  const draft = state.drafts?.find((candidate) => candidate.id === draftId && candidate.organizationId === organizationId);
  if (!draft || !canReadNamespace(principal, draft.name)) throw builderError('NOT_FOUND', 'Draft is unavailable', 404);
  assertPublisher(principal);
  if (draft.status !== 'open') throw builderError('DRAFT_CLOSED', 'Draft is no longer editable', 409);
  return { id: draft.id, name: draft.name, revision: draft.revision, digest: draft.digest };
}

async function reconcileSnapshot(
  repository: StateRepository,
  organizationId: string,
  record: SkillBuilderSessionRecord,
  snapshot: { lifecycle?: BuilderSessionLifecycle; activeTurnId?: string },
): Promise<void> {
  await updateSession(repository, organizationId, record.id, (current) => {
    if (current.state === 'stopped') return;
    if (snapshot.lifecycle) current.state = snapshot.lifecycle;
    if (snapshot.lifecycle === 'ready' || snapshot.lifecycle === 'failed' || snapshot.lifecycle === 'completed') {
      delete current.activeTurnId;
      delete current.activeRequestId;
    }
    else if (snapshot.activeTurnId) current.activeTurnId = snapshot.activeTurnId;
  });
}

async function fetchSessionSnapshot(fetchImpl: typeof fetch, runtime: BuilderBffRuntime, eveSessionId: string): Promise<{ events: BuilderEvent[]; activeTurnId?: string; lifecycle?: BuilderSessionLifecycle }> {
  const response = await fetchEve(fetchImpl, runtime, `/eve/v1/session/${encodeURIComponent(boundedSessionId(eveSessionId))}/stream?startIndex=0&includeTailIndex=1`, { method: 'GET' });
  const text = await boundedTextResponse(response, MAX_EVE_STREAM_BYTES);
  const events: BuilderEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) events.push(value as BuilderEvent);
    } catch {
      throw builderError('BUILDER_UPSTREAM', 'The builder returned an invalid event stream', 502);
    }
  }
  let activeTurnId: string | undefined;
  let lifecycle: BuilderSessionLifecycle | undefined;
  for (const event of events) {
    const turnId = typeof event.data?.turnId === 'string' ? event.data.turnId : undefined;
    if (turnId) activeTurnId = turnId;
    if (event.type === 'session.waiting') lifecycle = 'ready';
    else if (event.type === 'session.failed') lifecycle = 'failed';
    else if (event.type === 'session.completed') lifecycle = 'completed';
    else if (event.type === 'turn.started' || event.type === 'message.received') lifecycle = 'running';
  }
  return {
    events,
    ...(activeTurnId ? { activeTurnId } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  };
}

function toSessionDto(record: SkillBuilderSessionRecord, events: readonly BuilderEvent[]): BuilderSessionDto {
  const turns: BuilderTurn[] = [];
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    const data = event.data ?? {};
    const at = typeof event.meta?.at === 'string' ? event.meta.at : new Date().toISOString();
    if (type === 'message.received') {
      const content = boundedEventText(data.message ?? data.text);
      if (content) turns.push({ id: eventId(event, `user-${turns.length}`), role: 'user', content, createdAt: at });
    } else if (type === 'message.completed') {
      const content = boundedEventText(data.message ?? data.text);
      if (content) {
        const existing = turns.find((turn) => turn.id === eventId(event, ''));
        if (existing) existing.content = content;
        else turns.push({ id: eventId(event, `assistant-${turns.length}`), role: 'assistant', content, createdAt: at });
      }
    } else if (type === 'message.appended') {
      const delta = boundedEventText(data.messageDelta ?? data.textDelta ?? data.message);
      if (delta) {
        const id = eventId(event, `assistant-${turns.length}`);
        const existing = turns.find((turn) => turn.id === id);
        if (existing) existing.content = `${existing.content}${delta}`.slice(0, MAX_TURN_TEXT_BYTES);
        else turns.push({ id, role: 'assistant', content: delta, createdAt: at });
      }
    }
  }
  const proposal = [...record.proposals].reverse().find((candidate) => candidate.state === 'pending' || candidate.state === 'applied' || candidate.state === 'rejected');
  return {
    id: record.id,
    binding: { draftId: record.draftId, revision: record.draftRevision, digest: record.draftDigest },
    state: record.state,
    turns: turns.slice(-MAX_TURNS),
    ...(proposal ? { proposal: publicProposal(proposal) } : { proposal: null }),
  };
}

function publicProposal(proposal: SkillBuilderProposalRecord): Record<string, unknown> {
  return {
    id: proposal.id,
    draftId: proposal.draftId,
    baseRevision: proposal.baseRevision,
    baseDigest: proposal.baseDigest,
    proposedDigest: proposal.proposedDigest,
    state: proposal.state,
    sessionId: proposal.sessionId,
    createdAt: proposal.createdAt,
    operations: proposal.operations.map((operation) => ({
      op: operation.op,
      path: operation.path,
      ...(operation.op === 'rename' ? { newPath: operation.newPath } : {}),
      ...(operation.op === 'add' || operation.op === 'edit' ? { contentBytes: new TextEncoder().encode(operation.content).byteLength } : {}),
    })),
  };
}

function parseBuilderPath(rawUrl: string): { draftId: string; operation: 'availability' | 'session' | 'sessionId'; sessionId?: string; action?: 'prompt' | 'stop' | 'stream' } | undefined {
  let segments: string[];
  try { segments = new URL(rawUrl).pathname.replaceAll('\\', '/').split('/').filter(Boolean).map(decodeURIComponent); } catch { return undefined; }
  if (segments[0] !== 'v1' || segments[1] !== 'drafts' || !segments[2] || segments[3] !== 'builder') return undefined;
  if (segments.length === 5 && (segments[4] === 'availability' || segments[4] === 'session')) return { draftId: segments[2], operation: segments[4] };
  if (segments.length === 6 && segments[4] === 'session') return { draftId: segments[2], operation: 'sessionId', sessionId: segments[5] };
  if (segments.length === 7 && segments[4] === 'session' && (segments[6] === 'prompt' || segments[6] === 'stop' || segments[6] === 'stream')) return { draftId: segments[2], operation: 'sessionId', sessionId: segments[5], action: segments[6] };
  return undefined;
}

function parseBindingFromRequest(request: Request, draftId: string, fallbackRevision: number, fallbackDigest: Digest): DraftBinding {
  const url = new URL(request.url);
  const revisionValue = url.searchParams.get('revision');
  const raw = {
    draftId,
    revision: revisionValue === null || revisionValue.trim() === '' ? fallbackRevision : Number(revisionValue),
    digest: url.searchParams.get('digest') ?? fallbackDigest,
  };
  try {
    const binding = validateDraftBinding(raw);
    if (binding.draftId !== draftId) throw new Error('draft id mismatch');
    return binding;
  } catch {
    throw builderError('INVALID_REQUEST', 'revision and digest are required for the selected draft', 400);
  }
}

function assertBodyBinding(body: Record<string, unknown>, binding: DraftBinding, draftId: string): void {
  if (body.draftId !== undefined && body.draftId !== draftId) throw builderError('STALE_BINDING', 'Draft binding does not match the selected draft', 409);
  const rawRevision = body.revision ?? body.draftRevision;
  const rawDigest = body.digest ?? body.draftDigest;
  if (rawRevision === undefined || rawDigest === undefined) throw builderError('INVALID_REQUEST', 'revision and digest are required', 400);
  try {
    const candidate = validateDraftBinding({ draftId, revision: typeof rawRevision === 'string' ? Number(rawRevision) : rawRevision, digest: rawDigest });
    if (candidate.revision !== binding.revision || candidate.digest !== binding.digest) throw new Error('stale binding');
  } catch {
    throw builderError('STALE_BINDING', 'Draft revision is stale', 409);
  }
}

async function fetchEve(fetchImpl: typeof fetch, runtime: BuilderBffRuntime, path: string, init: RequestInit): Promise<Response> {
  try {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${runtime.eveToken}`);
    headers.set('accept', 'application/json, application/x-ndjson');
    const response = await fetchWithTimeout(fetchImpl, `${runtime.appOrigin}${path}`, { ...init, headers, redirect: 'error' });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* release an upstream error body without exposing it */ }
      throw builderError('BUILDER_UPSTREAM', 'The builder service could not complete the request', 502);
    }
    return response;
  } catch {
    throw builderError('BUILDER_UPSTREAM', 'The builder service is unavailable', 502);
  }
}

async function fetchWithTimeout(fetchImpl: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  const signal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    : undefined;
  return await fetchImpl(input, { ...init, ...(signal ? { signal } : {}) });
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const text = await boundedTextResponse(response, maximum);
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

async function boundedTextResponse(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number.isSafeInteger(Number(declared)) && Number(declared) > maximum) throw builderError('BUILDER_UPSTREAM', 'Builder response is too large', 502);
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximum) throw builderError('BUILDER_UPSTREAM', 'Builder response is too large', 502);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw builderError('BUILDER_UPSTREAM', 'Builder response is too large', 502);
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw builderError('BUILDER_UPSTREAM', 'Builder response is not valid UTF-8', 502);
  }
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared && Number.isSafeInteger(Number(declared)) && Number(declared) > MAX_BODY_BYTES) throw builderError('PAYLOAD_TOO_LARGE', 'Builder request is too large', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw builderError('PAYLOAD_TOO_LARGE', 'Builder request is too large', 413);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw builderError('INVALID_REQUEST', 'Builder request must be valid JSON', 400); }
  if (!isRecord(value)) throw builderError('INVALID_REQUEST', 'Builder request must be an object', 400);
  return value;
}

function boundedText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > maximumBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw builderError('INVALID_REQUEST', `${field} is invalid`, 400);
  return value;
}

function boundedEventText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, MAX_TURN_TEXT_BYTES);
}

function eventId(event: BuilderEvent, fallback: string): string {
  return typeof event.meta?.id === 'string' ? event.meta.id : fallback;
}

function availabilityReason(value: Record<string, unknown>): string {
  const reasons = Array.isArray(value.reasonCodes) ? value.reasonCodes.filter((item): item is string => typeof item === 'string') : [];
  return reasons.length > 0 ? `The skill builder is unavailable (${reasons.join(', ')}).` : 'The skill builder is unavailable.';
}

function compareUpdated(left: SkillBuilderSessionRecord, right: SkillBuilderSessionRecord): number {
  return left.updatedAt.localeCompare(right.updatedAt);
}

function boundedSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SESSION_ID_LENGTH || /[\u0000-\u001f\u007f/\\]/u.test(value)) {
    throw builderError('INVALID_REQUEST', 'session id is invalid', 400);
  }
  return value;
}

function boundedAcceptedSessionId(value: unknown): string {
  if (typeof value !== 'string') throw builderError('BUILDER_UPSTREAM', 'The builder returned an invalid session id', 502);
  return boundedSessionId(value);
}

function optionalSelectedPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw builderError('INVALID_REQUEST', 'selectedPath is invalid', 400);
  }
  return value;
}

async function digestBuilderRequest(value: unknown): Promise<Digest> {
  return await digestBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function assertSameOriginMutation(request: Request, publicOrigin: string): void {
  if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') throw builderError('CSRF_DENIED', 'Cross-site builder mutations are not allowed', 403);
  const origin = request.headers.get('origin');
  if (!origin) {
    if (request.headers.get('cookie')) throw builderError('CSRF_DENIED', 'Origin is required for cookie builder mutations', 403);
    return;
  }
  try {
    if (new URL(origin).origin !== new URL(publicOrigin).origin) throw new Error('origin mismatch');
  } catch {
    throw builderError('CSRF_DENIED', 'Builder mutation origin is not allowed', 403);
  }
}

function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function methodNotAllowed(methods: string[]): Response {
  return json({ code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }, 405, { allow: methods.join(', ') });
}

function builderError(code: string, message: string, status: number): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

function builderErrorResponse(error: unknown): Response {
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  const status = typeof value.status === 'number' && Number.isSafeInteger(value.status) ? value.status : 500;
  const code = typeof value.code === 'string' ? value.code : 'BUILDER_UNAVAILABLE';
  const message = typeof value.message === 'string' && value.message.length <= 240 ? value.message : 'The skill builder is unavailable.';
  return json({ code, message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function randomId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
