import { canAccessNamespace, hasScope } from '../../auth/src/index.js';
import { getVisibleApprovedSkills } from '../../core/src/index.js';
import type {
  BlobStore,
  Digest,
  Authenticator,
  Principal,
  RegistryState,
  SkillVersion,
  StateRepository,
} from '../../contracts/src/index.js';
import {
  EMBEDDING_LIMITS,
  type EmbeddingProvider,
} from './embeddings.js';
import {
  DefaultReviewPersistenceService,
  ReviewServiceError,
  type ReviewPersistenceService,
  type ReviewRun,
  type ReviewRunProvenance,
  type ReviewSkillSnapshot,
  type ReviewSuggestion,
} from '../../reviews/src/index.js';
import {
  type SearchDocument,
  type SearchHit,
  type SemanticIndex,
} from '../../search/src/types.js';
import {
  decodeBundle,
  digestBytes,
  parseSkillMetadata,
} from '../../storage/src/index.js';

const DEFAULT_MAX_BODY_BYTES = 3_000_000;
const MAX_QUERY_CHARACTERS = 12_000;
const MAX_SEARCH_LIMIT = 50;
const MAX_REVIEW_SNAPSHOT = 60;
const MAX_REVIEW_DOCUMENT_CHARACTERS = 12_000;
// The Eve tool currently accepts at most 8,000 characters per candidate. Keep
// the verifier's 12,000-character ceiling for future callers, but return the
// stricter wire shape to the current reviewer client.
const MAX_REVIEW_CANDIDATE_CHARACTERS = 8_000;
const MAX_REVIEW_TOTAL_CHARACTERS = 120_000;
const MAX_ID_LENGTH = 256;
const MAX_TOKEN_LENGTH = 512;
const DEFAULT_REVIEW_MODEL = 'eve-reviewer';

const REVIEW_READ_SCOPES = ['reviews:read', 'registry:read', 'skills:read'] as const;
const REVIEW_WRITE_SCOPES = ['reviews:write', 'registry:admin'] as const;
const SEARCH_READ_SCOPES = ['search:read', 'skills:read', 'registry:read'] as const;
const SEARCH_WRITE_SCOPES = ['search:write', 'registry:admin'] as const;

type RequestAuthenticator =
  | ((request: Request) => Promise<Principal | null>)
  | Authenticator;

export interface IntelligenceHandlerConfig {
  organizationId: string;
  publicOrigin: string;
  maxBodyBytes?: number;
  /** The dedicated PSKILLS_REVIEWER_TOKEN value, never a user bearer token. */
  reviewerToken?: string;
}

export interface IntelligenceHandlerOptions {
  repository: StateRepository;
  blobs: BlobStore;
  authenticate: RequestAuthenticator;
  /** Either pass `config`, or the top-level fields used by runtime adapters. */
  config?: IntelligenceHandlerConfig;
  organizationId?: string;
  publicOrigin?: string;
  maxBodyBytes?: number;
  reviewerToken?: string;
  index?: SemanticIndex;
  embeddingProvider?: EmbeddingProvider;
  reviewService?: ReviewPersistenceService;
  /** Starts the external reviewer session; it must not receive artifact text. */
  triggerReview?: (organizationId: string) => Promise<unknown> | unknown;
}

export interface IntelligenceHandler {
  (request: Request): Promise<Response | undefined>;
}

export class IntelligenceHttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message);
    this.name = 'IntelligenceHttpError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

interface Context {
  repository: StateRepository;
  blobs: BlobStore;
  authenticate: RequestAuthenticator;
  config: Required<IntelligenceHandlerConfig>;
  index?: SemanticIndex;
  embeddingProvider?: EmbeddingProvider;
  reviews: ReviewPersistenceService;
  triggerReview?: (organizationId: string) => Promise<unknown> | unknown;
}

interface VerifiedSkillDocument {
  skill: SkillVersion;
  text: string;
  contentDigest: Digest;
}

interface PublicRun extends Omit<ReviewRun, 'leaseToken' | 'leaseExpiresAt' | 'snapshot'> {
  snapshot: ReviewSkillSnapshot[];
  snapshotValid: boolean;
}

interface PublicSuggestion extends Omit<ReviewSuggestion, 'snapshot'> {
  snapshot: ReviewSkillSnapshot[];
  snapshotValid: boolean;
}

/**
 * Compose the intelligence routes without coupling them to a Nitro runtime.
 * Unrelated paths return `undefined` so a host can delegate them to the main
 * registry handler.
 */
export function createIntelligenceHandler(options: IntelligenceHandlerOptions): IntelligenceHandler {
  const config = normalizeConfig(options.config ?? {
    organizationId: options.organizationId ?? '',
    publicOrigin: options.publicOrigin ?? '',
    maxBodyBytes: options.maxBodyBytes,
    reviewerToken: options.reviewerToken,
  });
  const context: Context = {
    repository: options.repository,
    blobs: options.blobs,
    authenticate: options.authenticate,
    config,
    index: options.index,
    embeddingProvider: options.embeddingProvider,
    reviews: options.reviewService ?? new DefaultReviewPersistenceService(options.repository),
    triggerReview: options.triggerReview,
  };

  return async (request: Request): Promise<Response | undefined> => {
    const requestId = crypto.randomUUID?.() ?? `intelligence-${Date.now()}`;
    try {
      const route = routeFor(request);
      if (!route) return undefined;
      return await dispatch(route, request, context);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}

type Route =
  | { kind: 'search'; method: string }
  | { kind: 'search-status'; method: string }
  | { kind: 'search-reindex'; method: string }
  | { kind: 'reviews'; method: string }
  | { kind: 'review-decision'; method: string; id: string }
  | { kind: 'review-run'; method: string }
  | { kind: 'reviewer-prepare'; method: string }
  | { kind: 'reviewer-complete'; method: string };

function routeFor(request: Request): Route | undefined {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  const path = normalizePath(url.pathname);
  const method = request.method.toUpperCase();
  if (path === '/v1/search') return { kind: 'search', method };
  if (path === '/v1/search/status') return { kind: 'search-status', method };
  if (path === '/v1/search/reindex') return { kind: 'search-reindex', method };
  if (path === '/v1/reviews') return { kind: 'reviews', method };
  if (path === '/v1/reviews/run') return { kind: 'review-run', method };
  const decisionMatch = /^\/v1\/reviews\/([^/]+)\/decision$/u.exec(path);
  if (decisionMatch) {
    return {
      kind: 'review-decision',
      method,
      id: decodePathPart(decisionMatch[1]!),
    };
  }
  if (path === '/internal/reviewer/prepare') return { kind: 'reviewer-prepare', method };
  if (path === '/internal/reviewer/complete') return { kind: 'reviewer-complete', method };
  return undefined;
}

async function dispatch(route: Route, request: Request, context: Context): Promise<Response> {
  switch (route.kind) {
    case 'search':
      if (route.method !== 'GET') return methodNotAllowed(['GET']);
      return searchRoute(request, context);
    case 'search-status':
      if (route.method !== 'GET') return methodNotAllowed(['GET']);
      return searchStatusRoute(request, context);
    case 'search-reindex':
      if (route.method !== 'POST') return methodNotAllowed(['POST']);
      return searchReindexRoute(request, context);
    case 'reviews':
      if (route.method !== 'GET') return methodNotAllowed(['GET']);
      return reviewsRoute(request, context);
    case 'review-decision':
      if (route.method !== 'POST') return methodNotAllowed(['POST']);
      return reviewDecisionRoute(route.id, request, context);
    case 'review-run':
      if (route.method !== 'POST') return methodNotAllowed(['POST']);
      return reviewRunRoute(request, context);
    case 'reviewer-prepare':
      if (route.method !== 'POST') return methodNotAllowed(['POST']);
      return reviewerPrepareRoute(request, context);
    case 'reviewer-complete':
      if (route.method !== 'POST') return methodNotAllowed(['POST']);
      return reviewerCompleteRoute(request, context);
  }
}

async function searchRoute(request: Request, context: Context): Promise<Response> {
  const principal = await requirePrincipal(request, context, 'reader', SEARCH_READ_SCOPES);
  const url = new URL(request.url);
  const rawQuery = url.searchParams.get('q');
  if (rawQuery === null || rawQuery.trim() === '') {
    throw new IntelligenceHttpError('INVALID_QUERY', 'A search query is required', 400);
  }
  const query = boundedText(rawQuery.trim(), MAX_QUERY_CHARACTERS, 'Search query');
  const limit = parseLimit(url.searchParams.get('limit'), MAX_SEARCH_LIMIT, 20);
  const provider = context.embeddingProvider;
  if (!provider || !context.index) {
    throw new IntelligenceHttpError('SEARCH_UNAVAILABLE', 'Semantic search is not configured', 503, true);
  }

  const state = await readState(context.repository, context.config.organizationId);
  const visible = getVisibleApprovedSkills(state, principal);
  const allowedResourceIds = visible.map((skill) => skill.id);
  let vector: number[];
  try {
    vector = await provider.embedQuery(query);
  } catch {
    throw new IntelligenceHttpError('SEARCH_UNAVAILABLE', 'Semantic search is temporarily unavailable', 503, true);
  }
  let hits: readonly SearchHit[];
  try {
    hits = await context.index.search({
      organizationId: context.config.organizationId,
      allowedResourceIds,
      profileId: provider.profile.id,
      vector,
      limit,
    });
  } catch {
    throw new IntelligenceHttpError('SEARCH_UNAVAILABLE', 'Semantic search is temporarily unavailable', 503, true);
  }

  // Re-read the approval source after the index query.  A revoked release or
  // replaced artifact must disappear even when the index contains a stale row.
  const currentState = await readState(context.repository, context.config.organizationId);
  const currentVisible = new Map(
    getVisibleApprovedSkills(currentState, principal).map((skill) => [skill.id, skill]),
  );
  const results: Array<Record<string, unknown>> = [];
  for (const hit of hits) {
    if (!isSearchHit(hit)) continue;
    const skill = currentVisible.get(hit.resourceId);
    if (!skill || skill.artifact.digest !== hit.artifactDigest) continue;
    const document = await verifiedSkillDocument(skill, context.blobs).catch(() => undefined);
    if (!document || document.contentDigest !== hit.contentDigest) continue;
    results.push({
      resourceId: skill.id,
      name: skill.name,
      skillName: skill.skillName,
      version: skill.version,
      description: skill.description,
      artifactDigest: skill.artifact.digest,
      contentDigest: document.contentDigest,
      score: hit.score,
      text: document.text,
    });
  }
  return jsonResponse({ results });
}

async function searchStatusRoute(request: Request, context: Context): Promise<Response> {
  const principal = await requirePrincipal(request, context, 'reader', SEARCH_READ_SCOPES);
  void principal;
  if (!context.embeddingProvider || !context.index) {
    return jsonResponse({ status: 'degraded', provider: 'disabled', error: 'embedding provider unavailable' });
  }
  try {
    const health = await context.index.health();
    const status = health.status === 'ok' ? 'ok' : 'degraded';
    const provider = typeof health.provider === 'string' && /^[A-Za-z0-9._:/-]{1,128}$/u.test(health.provider)
      ? health.provider
      : 'unknown';
    return jsonResponse({
      status,
      provider,
      profileId: context.embeddingProvider.profile.id,
      ...(health.status === 'degraded' ? { error: 'search index unavailable' } : {}),
    });
  } catch {
    return jsonResponse({
      status: 'degraded',
      provider: 'unknown',
      profileId: context.embeddingProvider.profile.id,
      error: 'search index unavailable',
    });
  }
}

async function searchReindexRoute(request: Request, context: Context): Promise<Response> {
  const principal = await requirePrincipal(request, context, ['owner', 'admin'], SEARCH_WRITE_SCOPES);
  assertMutationSafe(request, context.config.publicOrigin);
  const provider = context.embeddingProvider;
  if (!provider || !context.index) {
    throw new IntelligenceHttpError('SEARCH_UNAVAILABLE', 'Semantic search is not configured', 503, true);
  }
  const body = await readOptionalJson(request, context.config.maxBodyBytes);
  const state = await readState(context.repository, context.config.organizationId);
  const visible = getVisibleApprovedSkills(state, principal)
    .sort((left, right) => left.id.localeCompare(right.id));
  const cursor = decodeReindexCursor(body.cursor);
  const start = cursor === undefined
    ? 0
    : visible.findIndex((skill) => skill.id === cursor) + 1;
  if (cursor !== undefined && start === 0) {
    throw new IntelligenceHttpError('INVALID_CURSOR', 'The reindex cursor is no longer valid', 400);
  }
  const page: VerifiedSkillDocument[] = [];
  let pageCharacters = 0;
  let nextIndex = start;
  const verified: VerifiedSkillDocument[] = [];
  try {
    for (; nextIndex < visible.length; nextIndex += 1) {
      if (page.length >= EMBEDDING_LIMITS.maxTexts) break;
      const document = await verifiedSkillDocument(visible[nextIndex]!, context.blobs);
      const characters = [...document.text].length;
      if (page.length > 0 && pageCharacters + characters > EMBEDDING_LIMITS.maxTotalCharacters) break;
      page.push(document);
      pageCharacters += characters;
    }
  } catch {
    throw new IntelligenceHttpError('SEARCH_REINDEX_FAILED', 'A currently approved artifact could not be verified', 409);
  }
  verified.push(...page);

  const indexed: SearchDocument[] = [];
  for (const batch of documentBatches(verified)) {
    let vectors: number[][];
    try {
      vectors = await provider.embedMany(batch.map((document) => document.text));
    } catch {
      throw new IntelligenceHttpError('SEARCH_UNAVAILABLE', 'Semantic indexing is temporarily unavailable', 503, true);
    }
    if (vectors.length !== batch.length) {
      throw new IntelligenceHttpError('SEARCH_UNAVAILABLE', 'Semantic indexing returned an invalid result', 503, true);
    }
    for (let index = 0; index < batch.length; index += 1) {
      const document = batch[index]!;
      indexed.push({
        organizationId: context.config.organizationId,
        resourceId: document.skill.id,
        artifactDigest: document.skill.artifact.digest,
        contentDigest: document.contentDigest,
        text: document.text,
        vector: vectors[index]!,
        profileId: provider.profile.id,
        indexedAt: new Date().toISOString(),
      });
    }
  }
  try {
    if (indexed.length > 0) await context.index.upsert(indexed);
    const visibleIds = new Set(visible.map((skill) => skill.id));
    const staleIds = state.skills
      .filter((skill) => namespaceVisible(principal, skill.name) && !visibleIds.has(skill.id))
      .map((skill) => skill.id);
    if (staleIds.length > 0) await context.index.remove(context.config.organizationId, staleIds);
  } catch {
    throw new IntelligenceHttpError('SEARCH_UNAVAILABLE', 'Semantic index update failed', 503, true);
  }
  const hasMore = nextIndex < visible.length;
  return jsonResponse({
    indexed: indexed.length,
    profileId: provider.profile.id,
    truncated: hasMore,
    ...(hasMore && page.length > 0 ? { nextCursor: encodeReindexCursor(page[page.length - 1]!.skill.id) } : {}),
  });
}

async function reviewsRoute(request: Request, context: Context): Promise<Response> {
  const principal = await requirePrincipal(request, context, 'reader', REVIEW_READ_SCOPES);
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), 100, 100);
  const state = await readState(context.repository, context.config.organizationId);
  const currentVisible = new Map(
    getVisibleApprovedSkills(state, principal).map((skill) => [skill.id, skill]),
  );
  const [runs, suggestions] = await Promise.all([
    context.reviews.listRuns(context.config.organizationId, { limit }),
    context.reviews.listSuggestions(context.config.organizationId, { limit }),
  ]);
  return jsonResponse({
    runs: runs
      .map((run) => publicRun(run, principal, currentVisible))
      .filter((run): run is PublicRun => run !== undefined),
    suggestions: suggestions
      .map((suggestion) => publicSuggestion(suggestion, principal, currentVisible))
      .filter((suggestion): suggestion is PublicSuggestion => suggestion !== undefined),
  });
}

async function reviewDecisionRoute(id: string, request: Request, context: Context): Promise<Response> {
  const principal = await requirePrincipal(request, context, ['owner', 'admin'], REVIEW_WRITE_SCOPES);
  assertMutationSafe(request, context.config.publicOrigin);
  const body = await readJson(request, context.config.maxBodyBytes);
  const decision = body.decision;
  if (decision !== 'accepted' && decision !== 'dismissed') {
    throw new IntelligenceHttpError('INVALID_DECISION', 'Decision must be accepted or dismissed', 400);
  }
  const state = await readState(context.repository, context.config.organizationId);
  const currentVisible = new Map(
    getVisibleApprovedSkills(state, principal).map((skill) => [skill.id, skill]),
  );
  const candidates = await context.reviews.listSuggestions(context.config.organizationId, { limit: 100 });
  const current = candidates.find((suggestion) => suggestion.id === id);
  if (!current || !publicSuggestion(current, principal, currentVisible)) {
    throw new IntelligenceHttpError('NOT_FOUND', 'Review suggestion was not found', 404);
  }
  try {
    const suggestion = await context.reviews.decideSuggestion(
      context.config.organizationId,
      id,
      decision,
      principal.subject,
    );
    const publicValue = publicSuggestion(suggestion, principal, currentVisible);
    if (!publicValue) throw new IntelligenceHttpError('NOT_FOUND', 'Review suggestion was not found', 404);
    return jsonResponse({ suggestion: publicValue });
  } catch (error) {
    throw mapReviewError(error);
  }
}

async function reviewRunRoute(request: Request, context: Context): Promise<Response> {
  const principal = await requirePrincipal(request, context, ['owner', 'admin'], REVIEW_WRITE_SCOPES);
  assertMutationSafe(request, context.config.publicOrigin);
  void principal;
  if (!context.triggerReview) {
    throw new IntelligenceHttpError('REVIEW_UNAVAILABLE', 'Review automation is not configured', 501);
  }
  let result: unknown;
  try {
    result = await context.triggerReview(context.config.organizationId);
  } catch {
    throw new IntelligenceHttpError('REVIEW_UNAVAILABLE', 'Review automation is temporarily unavailable', 503, true);
  }
  const record = isRecord(result) ? result : {};
  const sessionId = boundedOptionalString(record.sessionId, MAX_ID_LENGTH);
  const returnedStatus = boundedOptionalString(record.status, 64);
  const status = returnedStatus === 'started' || returnedStatus === 'queued' || returnedStatus === 'running'
    ? returnedStatus
    : 'started';
  return jsonResponse({
    ...(sessionId ? { sessionId } : {}),
    status,
  }, 202);
}

async function reviewerPrepareRoute(request: Request, context: Context): Promise<Response> {
  requireReviewerToken(request, context.config.reviewerToken);
  // The reviewer token is deliberately insufficient to export candidate text
  // when AI is disabled.  Runtime wiring omits the provider in that mode;
  // persisted review history remains readable through /v1/reviews.
  if (!context.embeddingProvider) {
    throw new IntelligenceHttpError('REVIEW_UNAVAILABLE', 'Review automation is not configured', 503, true);
  }
  const body = await readOptionalJson(request, context.config.maxBodyBytes);
  const model = body.model === undefined
    ? DEFAULT_REVIEW_MODEL
    : boundedText(body.model, 256, 'Review model');
  const eveSessionId = body.eveSessionId === undefined
    ? undefined
    : boundedOpaqueId(body.eveSessionId, MAX_ID_LENGTH, 'Eve session ID');
  // The reviews service performs strict validation. Keep this boundary
  // structural so the reviewer app can carry only its bounded provenance
  // object without exposing prompt or report content.
  const provenance = body.provenance === undefined
    ? undefined
    : body.provenance as ReviewRunProvenance;
  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `common-skill-review:${day}`;
  try {
    const existing = await context.reviews.listRuns(context.config.organizationId, { limit: 100 });
    const completed = existing.find((run) => run.idempotencyKey === idempotencyKey && run.day === day && run.state === 'completed');
    if (completed) return jsonResponse({ runId: completed.id, alreadyCompleted: true, candidates: [] });
  } catch (error) {
    throw mapReviewError(error);
  }
  const state = await readState(context.repository, context.config.organizationId);
  const reviewer = reviewerPrincipal(context.config.organizationId);
  const visible = getVisibleApprovedSkills(state, reviewer).sort((left, right) => left.id.localeCompare(right.id));
  const selected: VerifiedSkillDocument[] = [];
  let totalCharacters = 0;
  for (const skill of visible) {
    if (selected.length >= MAX_REVIEW_SNAPSHOT) break;
    if ([...skill.description].length > 2_000) continue;
    let document: VerifiedSkillDocument;
    try {
      document = await verifiedSkillDocument(skill, context.blobs, MAX_REVIEW_CANDIDATE_CHARACTERS);
    } catch {
      continue;
    }
    const characters = [...document.text].length;
    if (totalCharacters + characters > MAX_REVIEW_TOTAL_CHARACTERS) break;
    selected.push(document);
    totalCharacters += characters;
  }
  if (selected.length === 0) return jsonResponse({ candidates: [] });
  let claim;
  try {
    claim = await context.reviews.beginRun(context.config.organizationId, {
      key: idempotencyKey,
      model,
      snapshot: selected.map(toReviewSnapshot),
      ...(eveSessionId === undefined ? {} : { eveSessionId }),
      ...(provenance === undefined ? {} : { provenance }),
    });
  } catch (error) {
    throw mapReviewError(error);
  }
  if (claim.run.state === 'completed') {
    return jsonResponse({ runId: claim.run.id, alreadyCompleted: true, candidates: [] });
  }
  if (!claim.claimed) {
    // Another reviewer session owns the active lease. Never return its lease
    // token to a duplicate caller; the durable reviewer state will continue
    // with the original claimant.
    return jsonResponse({ runId: claim.run.id, candidates: [] });
  }
  const leaseToken = claim.leaseToken ?? claim.run.leaseToken;
  if (!leaseToken) {
    throw new IntelligenceHttpError('REVIEW_UNAVAILABLE', 'Review lease is unavailable', 503, true);
  }
  return jsonResponse({
    runId: claim.run.id,
    leaseToken,
    candidates: selected.map((document) => ({
      resourceId: document.skill.id,
      name: document.skill.name,
      version: document.skill.version,
      artifactDigest: document.skill.artifact.digest,
      description: document.skill.description,
      text: document.text,
    })),
  });
}

async function reviewerCompleteRoute(request: Request, context: Context): Promise<Response> {
  requireReviewerToken(request, context.config.reviewerToken);
  const body = await readJson(request, context.config.maxBodyBytes);
  const runId = boundedText(body.runId, MAX_ID_LENGTH, 'runId');
  const leaseToken = boundedText(body.leaseToken, MAX_TOKEN_LENGTH, 'leaseToken');
  boundedText(body.summary, 8_000, 'Review summary');
  const rawProposals = body.proposals ?? body.suggestions;
  if (!Array.isArray(rawProposals) || rawProposals.length > MAX_REVIEW_SNAPSHOT) {
    throw new IntelligenceHttpError('INVALID_REVIEW', 'Review proposals are invalid', 400);
  }
  const currentState = await readState(context.repository, context.config.organizationId);
  const reviewer = reviewerPrincipal(context.config.organizationId);
  const visible = new Map(
    getVisibleApprovedSkills(currentState, reviewer).map((skill) => [skill.id, skill]),
  );
  let runs: ReviewRun[];
  try {
    runs = await context.reviews.listRuns(context.config.organizationId, { limit: 100 });
  } catch (error) {
    throw mapReviewError(error);
  }
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) throw new IntelligenceHttpError('REVIEW_NOT_FOUND', 'Review run was not found', 404);
  if (run.snapshot.some((candidate) => {
    const skill = visible.get(candidate.resourceId);
    return !skill || skill.name !== candidate.name || skill.version !== candidate.version || skill.artifact.digest !== candidate.artifactDigest;
  })) {
    throw new IntelligenceHttpError('REVIEW_SNAPSHOT_STALE', 'The review snapshot is no longer current', 409);
  }
  const proposals = rawProposals.map((value, index) => normalizeProposal(value, index));
  try {
    const completion = await context.reviews.completeRun(
      context.config.organizationId,
      runId,
      leaseToken,
      proposals,
    );
    return jsonResponse({
      run: internalRun(completion.run),
      suggestions: completion.suggestions,
    });
  } catch (error) {
    throw mapReviewError(error);
  }
}

function normalizeConfig(input: IntelligenceHandlerConfig): Required<IntelligenceHandlerConfig> {
  if (!input || typeof input.organizationId !== 'string' || input.organizationId.trim() === '') {
    throw new Error('Intelligence organizationId is required');
  }
  let publicOrigin: string;
  try {
    const parsed = new URL(input.publicOrigin);
    if (parsed.origin === 'null' || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) throw new Error();
    publicOrigin = parsed.origin;
  } catch {
    throw new Error('Intelligence publicOrigin is invalid');
  }
  const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > 25 * 1024 * 1024) {
    throw new Error('Intelligence maxBodyBytes is invalid');
  }
  if (input.reviewerToken !== undefined && (input.reviewerToken.length === 0 || input.reviewerToken.length > MAX_TOKEN_LENGTH)) {
    throw new Error('Intelligence reviewerToken is invalid');
  }
  return {
    organizationId: input.organizationId,
    publicOrigin,
    maxBodyBytes,
    reviewerToken: input.reviewerToken ?? '',
  };
}

async function authenticateRequest(authenticator: RequestAuthenticator, request: Request): Promise<Principal | null> {
  try {
    return typeof authenticator === 'function'
      ? await authenticator(request)
      : await authenticator.authenticate(request);
  } catch {
    return null;
  }
}

async function requirePrincipal(
  request: Request,
  context: Context,
  roles: string | readonly string[],
  scopes: readonly string[],
): Promise<Principal> {
  const principal = await authenticateRequest(context.authenticate, request);
  if (!principal || principal.organizationId !== context.config.organizationId || !principal.subject) {
    throw new IntelligenceHttpError('UNAUTHORIZED', 'Authentication required', 401);
  }
  const identity = (principal as Principal & { identity?: unknown }).identity;
  if (identity === 'worker' || principal.roles.includes('worker')) {
    throw new IntelligenceHttpError('FORBIDDEN', 'Worker credentials cannot access user intelligence routes', 403);
  }
  const allowedRoles = typeof roles === 'string' ? [roles] : roles;
  if (!allowedRoles.some((role) => roleSatisfied(principal, role))) {
    throw new IntelligenceHttpError('FORBIDDEN', 'The principal lacks the required role', 403);
  }
  const suppliedScopes = (principal as Principal & { scopes?: unknown }).scopes;
  if (suppliedScopes !== undefined && !scopes.some((scope) => hasScope(principal, scope))) {
    throw new IntelligenceHttpError('FORBIDDEN', 'The principal lacks the required scope', 403);
  }
  return principal;
}

function roleSatisfied(principal: Principal, required: string): boolean {
  if (required === 'reader') {
    return principal.roles.some((role) => ['reader', 'publisher', 'admin', 'owner'].includes(role));
  }
  if (required === 'publisher') {
    return principal.roles.some((role) => ['publisher', 'admin', 'owner'].includes(role));
  }
  if (required === 'admin') return principal.roles.includes('admin') || principal.roles.includes('owner');
  if (required === 'owner') return principal.roles.includes('owner');
  return principal.roles.includes(required as Principal['roles'][number]);
}

function assertMutationSafe(request: Request, publicOrigin: string): void {
  if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    throw new IntelligenceHttpError('CSRF_DENIED', 'Cross-site mutations are not allowed', 403);
  }
  const origin = request.headers.get('origin');
  const hasBearer = /^Bearer[ \t]+[^ \t]+$/iu.test(request.headers.get('authorization') ?? '');
  const hasCookie = request.headers.has('cookie');
  if (origin) {
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw new IntelligenceHttpError('CSRF_DENIED', 'Mutation origin is invalid', 403);
    }
    if (normalized !== publicOrigin) {
      throw new IntelligenceHttpError('CSRF_DENIED', 'Mutation origin is not allowed', 403);
    }
  } else if (hasCookie || !hasBearer) {
    throw new IntelligenceHttpError('CSRF_DENIED', 'Origin is required for cookie mutations', 403);
  }
}

function requireReviewerToken(request: Request, configured: string): void {
  if (!configured) throw new IntelligenceHttpError('NOT_FOUND', 'Route not found', 404);
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = /^Bearer[ \t]+([^ \t]+)$/iu.exec(authorization)?.[1];
  const header = request.headers.get('x-pskills-reviewer-token');
  if (bearer !== undefined && header !== null && bearer !== header) {
    throw new IntelligenceHttpError('UNAUTHORIZED', 'Reviewer authentication required', 401);
  }
  const presented = bearer ?? header ?? '';
  if (presented.length > MAX_TOKEN_LENGTH) {
    throw new IntelligenceHttpError('UNAUTHORIZED', 'Reviewer authentication required', 401);
  }
  const left = new TextEncoder().encode(configured);
  const right = new TextEncoder().encode(presented);
  if (!timingSafeEqual(left, right)) {
    throw new IntelligenceHttpError('UNAUTHORIZED', 'Reviewer authentication required', 401);
  }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function readState(repository: StateRepository, organizationId: string): Promise<RegistryState> {
  try {
    return await repository.read(organizationId);
  } catch {
    throw new IntelligenceHttpError('STATE_UNAVAILABLE', 'Registry state is temporarily unavailable', 503, true);
  }
}

async function readJson(request: Request, maximum: number): Promise<Record<string, unknown>> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    throw new IntelligenceHttpError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit', 413);
  }
  const bytes = await readBoundedBytes(request, maximum);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new IntelligenceHttpError('INVALID_JSON', 'Request body must be valid JSON', 400);
  }
  if (!isRecord(parsed)) throw new IntelligenceHttpError('INVALID_JSON', 'Request body must be a JSON object', 400);
  return parsed;
}

async function readBoundedBytes(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        throw new IntelligenceHttpError('INVALID_REQUEST', 'Request body could not be read', 400);
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        try {
          await reader.cancel();
        } catch {
          // The bounded payload error remains the externally visible result.
        }
        throw new IntelligenceHttpError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit', 413);
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
  return bytes;
}

async function readOptionalJson(request: Request, maximum: number): Promise<Record<string, unknown>> {
  const length = request.headers.get('content-length');
  if (length === '0') return {};
  if (!request.body && length === null) return {};
  return readJson(request, maximum);
}

function decodePathPart(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      throw new Error();
    }
    return decoded;
  } catch {
    throw new IntelligenceHttpError('INVALID_PATH', 'Route identifier is invalid', 400);
  }
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+/gu, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1);
  return normalized || '/';
}

function encodeReindexCursor(lastId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, lastId }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `v1.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

function decodeReindexCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !value.startsWith('v1.')) {
    throw new IntelligenceHttpError('INVALID_CURSOR', 'The reindex cursor is invalid', 400);
  }
  const encoded = value.slice(3);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new IntelligenceHttpError('INVALID_CURSOR', 'The reindex cursor is invalid', 400);
  }
  let parsed: unknown;
  try {
    const padded = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new IntelligenceHttpError('INVALID_CURSOR', 'The reindex cursor is invalid', 400);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.lastId !== 'string' ||
      Object.keys(parsed).length !== 2 || parsed.lastId.length === 0 || parsed.lastId.length > MAX_ID_LENGTH) {
    throw new IntelligenceHttpError('INVALID_CURSOR', 'The reindex cursor is invalid', 400);
  }
  return parsed.lastId;
}

function parseLimit(value: string | null, maximum: number, fallback: number): number {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/u.test(value)) throw new IntelligenceHttpError('INVALID_LIMIT', 'Limit must be a positive integer', 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new IntelligenceHttpError('INVALID_LIMIT', 'Limit must be a positive integer', 400);
  return Math.min(parsed, maximum);
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || [...value].length > maximum) {
    throw new IntelligenceHttpError('INVALID_REQUEST', `${label} is invalid or exceeds its limit`, 400);
  }
  return value.trim();
}

function boundedOpaqueId(value: unknown, maximum: number, label: string): string {
  const result = boundedText(value, maximum, label);
  if (/[\u0000-\u001f\u007f]/u.test(result)) {
    throw new IntelligenceHttpError('INVALID_REQUEST', `${label} contains invalid characters`, 400);
  }
  return result;
}

function boundedOptionalString(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maximum) return undefined;
  return value;
}

async function verifiedSkillDocument(
  skill: SkillVersion,
  blobs: BlobStore,
  maximumCharacters = MAX_REVIEW_DOCUMENT_CHARACTERS,
): Promise<VerifiedSkillDocument> {
  let bytes: Uint8Array;
  try {
    bytes = await blobs.get(skill.artifact.key);
  } catch {
    throw new Error('artifact unavailable');
  }
  if (!(bytes instanceof Uint8Array)) throw new Error('artifact bytes invalid');
  const artifactDigest = await digestBytes(bytes);
  if (artifactDigest !== skill.artifact.digest) throw new Error('artifact digest mismatch');
  const bundle = decodeBundle(bytes);
  const metadata = parseSkillMetadata(bundle);
  if (metadata.skillName !== skill.skillName) throw new Error('skill metadata mismatch');
  const file = bundle.files.find((candidate) => candidate.path === 'SKILL.md');
  if (!file) throw new Error('SKILL.md missing');
  const content = decodeBase64Utf8(file.content);
  if ([...content.text].length > maximumCharacters) throw new Error('SKILL.md exceeds limit');
  return {
    skill,
    text: content.text,
    contentDigest: await digestBytes(content.bytes),
  };
}

function decodeBase64Utf8(value: string): { text: string; bytes: Uint8Array } {
  if (value.length > Math.ceil((MAX_REVIEW_DOCUMENT_CHARACTERS + 3) / 3) * 4) throw new Error('SKILL.md exceeds limit');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error('SKILL.md encoding invalid');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { text, bytes };
}

function documentBatches(documents: readonly VerifiedSkillDocument[]): VerifiedSkillDocument[][] {
  const batches: VerifiedSkillDocument[][] = [];
  let batch: VerifiedSkillDocument[] = [];
  let characters = 0;
  for (const document of documents) {
    const length = [...document.text].length;
    if (batch.length > 0 && (batch.length >= EMBEDDING_LIMITS.maxTexts || characters + length > EMBEDDING_LIMITS.maxTotalCharacters)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(document);
    characters += length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function toReviewSnapshot(document: VerifiedSkillDocument): ReviewSkillSnapshot {
  return {
    resourceId: document.skill.id,
    name: document.skill.name,
    version: document.skill.version,
    artifactDigest: document.skill.artifact.digest as `sha256:${string}`,
  };
}

function reviewerPrincipal(organizationId: string): Principal {
  return { organizationId, subject: 'internal-reviewer', roles: ['owner'], namespaces: [] };
}

function publicRun(
  run: ReviewRun,
  principal: Principal,
  currentVisible: ReadonlyMap<string, SkillVersion>,
): PublicRun | undefined {
  const visibleSnapshot = run.snapshot.filter((candidate) => namespaceVisible(principal, candidate.name));
  if (visibleSnapshot.length === 0) return undefined;
  const snapshotValid = run.snapshot.every((candidate) => {
    const skill = currentVisible.get(candidate.resourceId);
    return !!skill && skill.name === candidate.name && skill.version === candidate.version && skill.artifact.digest === candidate.artifactDigest;
  });
  const { leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt, ...withoutLease } = run;
  return { ...withoutLease, snapshot: visibleSnapshot, snapshotValid };
}

function publicSuggestion(
  suggestion: ReviewSuggestion,
  principal: Principal,
  currentVisible: ReadonlyMap<string, SkillVersion>,
): PublicSuggestion | undefined {
  if (!suggestion.snapshot.every((candidate) => namespaceVisible(principal, candidate.name))) return undefined;
  const snapshotValid = suggestion.snapshot.every((candidate) => {
    const skill = currentVisible.get(candidate.resourceId);
    return !!skill && skill.name === candidate.name && skill.version === candidate.version && skill.artifact.digest === candidate.artifactDigest;
  });
  return { ...suggestion, snapshot: suggestion.snapshot, snapshotValid };
}

function internalRun(run: ReviewRun): ReviewRun {
  return JSON.parse(JSON.stringify(run)) as ReviewRun;
}

function namespaceVisible(principal: Principal, name: string): boolean {
  const namespace = name.split('/')[0]!;
  if (canAccessNamespace(principal, namespace)) return true;
  // Auth tokens in the wild use both `team` and `@team`; preserve the core
  // namespace predicate's compatibility without broadening access.
  return namespace.startsWith('@')
    ? canAccessNamespace(principal, namespace.slice(1))
    : canAccessNamespace(principal, `@${namespace}`);
}

function normalizeProposal(value: unknown, index: number): {
  resourceIds: string[];
  title: string;
  rationale: string;
  overlap: string;
  differences: string;
  mergePlan: string;
  similarity: number;
} {
  if (!isRecord(value)) throw new IntelligenceHttpError('INVALID_REVIEW', `Review proposal ${index + 1} is invalid`, 400);
  const rawIds = value.skillIds ?? value.resourceIds;
  if (!Array.isArray(rawIds) || rawIds.length < 2 || rawIds.some((id) => typeof id !== 'string')) {
    throw new IntelligenceHttpError('INVALID_REVIEW', `Review proposal ${index + 1} has invalid skill IDs`, 400);
  }
  if (rawIds.length > MAX_REVIEW_SNAPSHOT) {
    throw new IntelligenceHttpError('INVALID_REVIEW', `Review proposal ${index + 1} has too many skill IDs`, 400);
  }
  const resourceIds = rawIds.map((id) => boundedText(id, MAX_ID_LENGTH, 'Review skill ID'));
  const textField = (field: string, fallback: string): string => {
    const raw = value[field];
    if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return fallback;
    if (Array.isArray(raw)) {
      if (raw.length > 32 || raw.some((entry) => typeof entry !== 'string')) {
        throw new IntelligenceHttpError('INVALID_REVIEW', `Review ${field} is invalid`, 400);
      }
      if (raw.length === 0) return fallback;
      const lines = raw.map((entry) => boundedText(entry, 2_000, `Review ${field}`));
      return boundedText(lines.map((line) => `- ${line}`).join('\n'), 4_000, `Review ${field}`);
    }
    return boundedText(raw, 4_000, `Review ${field}`);
  };
  const similarity = value.similarity === undefined ? 0 : value.similarity;
  if (typeof similarity !== 'number' || !Number.isFinite(similarity) || similarity < 0 || similarity > 1) {
    throw new IntelligenceHttpError('INVALID_REVIEW', `Review proposal ${index + 1} similarity is invalid`, 400);
  }
  return {
    resourceIds,
    title: textField('title', 'Skill consolidation suggestion'),
    rationale: textField('rationale', 'Reviewer generated a consolidation suggestion.'),
    overlap: textField('overlap', 'The selected skills have overlapping capabilities.'),
    differences: textField('differences', 'Review the selected skill differences before merging.'),
    mergePlan: textField('mergePlan', 'Combine the compatible instructions and preserve required behavior.'),
    similarity,
  };
}

function mapReviewError(error: unknown): IntelligenceHttpError {
  if (!(error instanceof ReviewServiceError)) {
    return new IntelligenceHttpError('REVIEW_UNAVAILABLE', 'Review persistence is temporarily unavailable', 503, true);
  }
  switch (error.code) {
    case 'REVIEW_NOT_FOUND':
      return new IntelligenceHttpError('REVIEW_NOT_FOUND', 'Review record was not found', 404);
    case 'REVIEW_LEASE_FENCED':
    case 'REVIEW_LEASE_EXPIRED':
    case 'REVIEW_RUN_NOT_RUNNING':
    case 'REVIEW_CONFLICT':
    case 'REVIEW_DECISION_CONFLICT':
      return new IntelligenceHttpError('REVIEW_CONFLICT', 'Review state is no longer current', 409);
    case 'INVALID_REVIEW_INPUT':
      return new IntelligenceHttpError('INVALID_REVIEW', 'Review input is invalid', 400);
    default:
      return new IntelligenceHttpError('REVIEW_UNAVAILABLE', 'Review persistence is temporarily unavailable', 503, true);
  }
}

function isSearchHit(value: unknown): value is SearchHit {
  if (!isRecord(value)) return false;
  return typeof value.resourceId === 'string'
    && typeof value.artifactDigest === 'string'
    && /^sha256:[0-9a-f]{64}$/u.test(value.artifactDigest)
    && typeof value.contentDigest === 'string'
    && /^sha256:[0-9a-f]{64}$/u.test(value.contentDigest)
    && typeof value.score === 'number'
    && Number.isFinite(value.score);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      ...headers,
    },
  });
}

function methodNotAllowed(allow: readonly string[]): Response {
  return jsonResponse({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'HTTP method is not allowed for this route',
    },
  }, 405, { allow: allow.join(', ') });
}

function errorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof IntelligenceHttpError ? error : undefined;
  const status = known?.status ?? 500;
  const payload = {
    error: {
      code: known?.code ?? 'INTERNAL_ERROR',
      message: known?.message ?? 'An internal error occurred',
      requestId,
      retryable: known?.retryable ?? false,
    },
  };
  return jsonResponse(payload, status, known?.retryable ? { 'retry-after': '1' } : {});
}
