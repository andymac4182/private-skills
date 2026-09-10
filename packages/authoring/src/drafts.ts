import type {
  BundleFile,
  Digest,
  Job,
  Principal,
  RegistryState,
  SkillDraft,
  SkillDraftFileManifestEntry,
  SkillDraftIdempotencyRecord,
  SkillDraftPublicationRecord,
  SkillVersion,
  StoredBlob,
} from '../../contracts/src/index.js';
import { createUploadReviewSnapshot } from '../../upload-reviews/src/snapshot.js';
import type {
  UploadReviewBinding,
  UploadReviewFindingDecision,
  UploadReviewJob,
  UploadReviewResult,
} from '../../upload-reviews/src/index.js';
import { valid as validSemver } from 'semver';
import {
  AuthoringApiError,
  assertPublisher,
  canReadNamespace,
  errorResponse,
  jsonResponse,
  readAuthorizedReleaseSnapshot,
  type AuthoringHandler,
  type AuthoringHandlerDependencies,
} from './index.js';
import {
  decodeBundle,
  digestBytes,
  encodeBundle,
  parseSkillMetadata,
  validateBundle,
} from '../../storage/src/index.js';

const MAX_IDEMPOTENCY_RECORDS = 32;
const MAX_IDEMPOTENCY_KEY_BYTES = 256;

export interface PublicSkillDraft {
  id: string;
  name: string;
  skillName: string;
  description: string;
  baseResourceId: string;
  baseDigest: Digest;
  revision: number;
  digest: Digest;
  size: number;
  files: BundleFile[];
  status: SkillDraft['status'];
  actor: string;
  createdAt: string;
  updatedAt: string;
  publications?: PublicSkillDraftPublication[];
}

export interface PublicSkillDraftPublication {
  revision: number;
  digest: Digest;
  version: string;
  resourceId: string;
  jobId: string;
  createdAt: string;
}

const MAX_PUBLICATION_HISTORY = 16;

/**
 * Create the explicit draft routes. Saving a draft only creates a fresh
 * sealed object and changes the tenant's draft record; publication queues a
 * separate immutable scanner job and never marks the draft release-approved.
 *
 * Routes:
 *   POST /v1/skills/:resourceId/drafts
 *   GET  /v1/drafts/:draftId
 *   PUT  /v1/drafts/:draftId
 *   POST /v1/drafts/:draftId/publish
 *   GET/POST /v1/drafts/:draftId/reviews
 *   POST /v1/drafts/:draftId/reviews/:resultId/decisions
 *   POST /v1/drafts/:draftId/reviews/:jobId/retry
 */
export function createDraftHandler(deps: AuthoringHandlerDependencies): AuthoringHandler {
  const maxBodyBytes = normalizeBodyLimit(deps.config.maxBodyBytes);

  return async function draftHandler(request: Request): Promise<Response> {
    try {
      const principal = await deps.auth.authenticate(request);
      if (!principal || principal.organizationId !== deps.config.organizationId) {
        throw new AuthoringApiError('UNAUTHORIZED', 'Authentication is required', 401);
      }
      const url = parseRequestUrl(request);
      const segments = splitPath(url.pathname);

      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'skills' && segments[3] === 'drafts') {
        if (request.method.toUpperCase() !== 'POST') {
          throw new AuthoringApiError('METHOD_NOT_ALLOWED', 'Only POST is supported', 405);
        }
        assertPublisher(principal);
        const resourceId = decodePathPart(segments[2]);
        if (!isSafeId(resourceId)) throw unavailableDraft();
        const body = await readJson(request, maxBodyBytes);
        return await createDraft(body, request, resourceId, principal, deps);
      }

      if (segments.length === 3 && segments[0] === 'v1' && segments[1] === 'drafts') {
        const draftId = decodePathPart(segments[2]);
        if (!isSafeId(draftId)) throw unavailableDraft();
        assertPublisher(principal);
        if (request.method.toUpperCase() === 'GET') {
          return await getDraft(draftId, principal, deps);
        }
        if (request.method.toUpperCase() === 'PUT') {
          const body = await readJson(request, maxBodyBytes);
          return await updateDraft(body, request, draftId, principal, deps);
        }
        throw new AuthoringApiError('METHOD_NOT_ALLOWED', 'Only GET and PUT are supported', 405);
      }

      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'drafts' && segments[3] === 'publish') {
        if (request.method.toUpperCase() !== 'POST') {
          throw new AuthoringApiError('METHOD_NOT_ALLOWED', 'Only POST is supported', 405);
        }
        const draftId = decodePathPart(segments[2]);
        if (!isSafeId(draftId)) throw unavailableDraft();
        assertPublisher(principal);
        const body = await readJson(request, maxBodyBytes);
        return await publishDraft(body, request, draftId, principal, deps);
      }

      if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'drafts' && segments[3] === 'reviews') {
        const draftId = decodePathPart(segments[2]);
        if (!isSafeId(draftId)) throw unavailableDraft();
        assertPublisher(principal);
        if (request.method.toUpperCase() === 'GET') {
          return await listDraftReviews(draftId, principal, deps);
        }
        if (request.method.toUpperCase() === 'POST') {
          const body = await readJson(request, maxBodyBytes);
          return await requestDraftReview(body, draftId, principal, deps);
        }
        throw new AuthoringApiError('METHOD_NOT_ALLOWED', 'Only GET and POST are supported', 405);
      }

      if (
        segments.length === 6 &&
        segments[0] === 'v1' &&
        segments[1] === 'drafts' &&
        segments[3] === 'reviews' &&
        segments[5] === 'decisions'
      ) {
        if (request.method.toUpperCase() !== 'POST') {
          throw new AuthoringApiError('METHOD_NOT_ALLOWED', 'Only POST is supported', 405);
        }
        const draftId = decodePathPart(segments[2]);
        const resultId = decodePathPart(segments[4]);
        if (!isSafeId(draftId) || !isSafeId(resultId)) throw unavailableDraft();
        assertPublisher(principal);
        const body = await readJson(request, maxBodyBytes);
        return await decideDraftReview(body, draftId, resultId, principal, deps);
      }

      if (
        segments.length === 6 &&
        segments[0] === 'v1' &&
        segments[1] === 'drafts' &&
        segments[3] === 'reviews' &&
        segments[5] === 'retry'
      ) {
        if (request.method.toUpperCase() !== 'POST') {
          throw new AuthoringApiError('METHOD_NOT_ALLOWED', 'Only POST is supported', 405);
        }
        const draftId = decodePathPart(segments[2]);
        const jobId = decodePathPart(segments[4]);
        if (!isSafeId(draftId) || !isSafeId(jobId)) throw unavailableDraft();
        assertPublisher(principal);
        return await retryDraftReview(draftId, jobId, principal, deps);
      }

      throw new AuthoringApiError('NOT_FOUND', 'Route not found', 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

async function createDraft(
  body: Record<string, unknown>,
  request: Request,
  resourceId: string,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<Response> {
  const idempotencyKey = requireIdempotencyKey(request);
  const baseDigest = requireDigest(body.baseDigest, 'baseDigest');
  const requestDigest = await digestText(JSON.stringify({ resourceId, baseDigest }));
  const existingState = await deps.repository.read(deps.config.organizationId);
  const existing = existingState.drafts?.find(
    (candidate) =>
      candidate.organizationId === deps.config.organizationId &&
      candidate.actor === principal.subject &&
      candidate.createIdempotency?.key === idempotencyKey,
  );
  if (existing) {
    if (!canReadNamespace(principal, existing.name)) throw unavailableDraft();
    if (existing.createIdempotency?.requestDigest !== requestDigest) {
      throw idempotencyConflict();
    }
    const existingDraft = await draftFromCreateRecord(existing, deps);
    return jsonResponse({ draft: toPublicDraft(existingDraft, { format: 'pskills-bundle-v1', files: existingDraft.files }), idempotent: true }, 200, {
      'cache-control': 'private, no-store',
    });
  }
  const snapshot = await readAuthorizedReleaseSnapshot(deps, principal, resourceId);
  if (snapshot.release.artifact.digest !== baseDigest) {
    throw new AuthoringApiError('DIGEST_MISMATCH', 'The selected release digest changed', 409);
  }
  const stored = await putVerifiedDraftBlob(deps, snapshot.bytes, snapshot.release.artifact.digest);
  const now = new Date().toISOString();
  const draftId = randomId('draft');
  const record: SkillDraftIdempotencyRecord = {
    key: idempotencyKey,
    subject: principal.subject,
    requestDigest,
    revision: 1,
    digest: snapshot.release.artifact.digest,
    artifact: stored,
    manifest: await compactManifest(snapshot.bundle.files),
    updatedAt: now,
  };
  const draft: SkillDraft = {
    id: draftId,
    organizationId: deps.config.organizationId,
    name: snapshot.release.name,
    skillName: snapshot.release.skillName,
    description: snapshot.release.description,
    baseResourceId: snapshot.release.id,
    baseDigest,
    revision: 1,
    digest: snapshot.release.artifact.digest,
    artifact: stored,
    files: snapshot.bundle.files,
    status: 'open',
    actor: principal.subject,
    createdAt: now,
    updatedAt: now,
    createIdempotency: record,
    idempotency: [],
  };

  const result = await deps.repository.transaction(deps.config.organizationId, (state) => {
    ensureDrafts(state);
    const existing = state.drafts!.find(
      (candidate) =>
        candidate.organizationId === deps.config.organizationId &&
        candidate.actor === principal.subject &&
        candidate.createIdempotency?.key === idempotencyKey,
    );
    if (existing) {
      if (!canReadNamespace(principal, existing.name)) throw unavailableDraft();
      if (existing.createIdempotency?.requestDigest !== requestDigest) {
        throw idempotencyConflict();
      }
      return { draft: existing, idempotent: true };
    }

    const current = state.skills.find((candidate) => candidate.id === resourceId);
    if (!current || !sameReadableBase(current, snapshot.release, state, principal, baseDigest)) {
      throw unavailableDraft();
    }
    state.drafts!.push(draft);
    appendDraftAudit(state, principal, 'draft.create', draft, deps.config.organizationId);
    return { draft, idempotent: false };
  });

  const responseDraft = result.idempotent ? await draftFromCreateRecord(result.draft, deps) : result.draft;
  const bundle = { format: 'pskills-bundle-v1' as const, files: responseDraft.files };
  await syncDraftReview(responseDraft, bundle.files, deps, false);
  return jsonResponse({ draft: toPublicDraft(responseDraft, bundle) }, result.idempotent ? 200 : 201, {
    'cache-control': 'private, no-store',
  });
}

async function getDraft(
  draftId: string,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<Response> {
  const state = await deps.repository.read(deps.config.organizationId);
  const draft = findDraft(state, draftId, principal, deps.config.organizationId);
  const bundle = await readDraftBundle(draft, deps);
  return jsonResponse({ draft: toPublicDraft(draft, bundle) }, 200, {
    'cache-control': 'private, no-store',
  });
}

async function updateDraft(
  body: Record<string, unknown>,
  request: Request,
  draftId: string,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<Response> {
  const idempotencyKey = requireIdempotencyKey(request);
  const expectedRevision = requireRevision(body.expectedRevision);
  if (!Array.isArray(body.files)) {
    throw new AuthoringApiError('INVALID_REQUEST', 'files must be an array', 400);
  }
  let bundle;
  try {
    const validated = validateBundle({ format: 'pskills-bundle-v1', files: body.files });
    // encodeBundle sorts paths; decode the exact bytes once so the persisted
    // manifest and every replay use the same canonical file order.
    bundle = decodeBundle(encodeBundle(validated));
  } catch {
    throw new AuthoringApiError('INVALID_BUNDLE', 'Draft files are not a safe canonical bundle', 400);
  }
  const encoded = encodeBundle(bundle);
  const digest = await digestBytes(encoded);
  const requestDigest = await digestText(JSON.stringify({ expectedRevision, digest }));
  const stateBefore = await deps.repository.read(deps.config.organizationId);
  const before = findDraft(stateBefore, draftId, principal, deps.config.organizationId);
  const prior = findIdempotency(before, idempotencyKey, principal.subject);
  if (prior) {
    if (prior.requestDigest !== requestDigest) throw idempotencyConflict();
    const replay = await draftFromIdempotency(before, prior, deps);
    return jsonResponse({ draft: toPublicDraft(replay, { format: 'pskills-bundle-v1', files: replay.files }), idempotent: true }, 200, {
      'cache-control': 'private, no-store',
    });
  }
  if (before.revision !== expectedRevision) {
    throw revisionConflict(before.revision);
  }
  if (before.status !== 'open') {
    throw new AuthoringApiError('DRAFT_CLOSED', 'Draft is no longer editable', 409);
  }

  const stored = await putVerifiedDraftBlob(deps, encoded, digest);
  const now = new Date().toISOString();
  const record: SkillDraftIdempotencyRecord = {
    key: idempotencyKey,
    subject: principal.subject,
    requestDigest,
    revision: expectedRevision + 1,
    digest,
    artifact: stored,
    manifest: await compactManifest(bundle.files),
    updatedAt: now,
  };

  const result = await deps.repository.transaction(deps.config.organizationId, (state) => {
    const current = findDraft(state, draftId, principal, deps.config.organizationId);
    const concurrent = findIdempotency(current, idempotencyKey, principal.subject);
    if (concurrent) {
      if (concurrent.requestDigest !== requestDigest) throw idempotencyConflict();
      return { draft: current, idempotent: true };
    }
    if (current.revision !== expectedRevision) throw revisionConflict(current.revision);
    if (current.status !== 'open') throw new AuthoringApiError('DRAFT_CLOSED', 'Draft is no longer editable', 409);
    current.revision = expectedRevision + 1;
    current.digest = digest;
    current.artifact = stored;
    current.files = bundle.files;
    current.updatedAt = now;
    current.idempotency = [...(current.idempotency ?? []).slice(-(MAX_IDEMPOTENCY_RECORDS - 1)), record];
    appendDraftAudit(state, principal, 'draft.update', current, deps.config.organizationId);
    return { draft: current, idempotent: false };
  });

  const responseDraft = result.idempotent
    ? await draftFromIdempotency(result.draft, findIdempotency(result.draft, idempotencyKey, principal.subject)!, deps)
    : result.draft;
  const responseBundle = { format: 'pskills-bundle-v1' as const, files: responseDraft.files };
  await syncDraftReview(responseDraft, responseBundle.files, deps, true);
  return jsonResponse({ draft: toPublicDraft(responseDraft, responseBundle), idempotent: result.idempotent }, 200, {
    'cache-control': 'private, no-store',
  });
}

/**
 * Review is advisory and therefore never makes a successful draft mutation
 * fail. The durable queue write happens after the draft transaction, and the
 * separate Eve trigger is best effort after that sealed queue row exists.
 */
async function syncDraftReview(
  draft: SkillDraft,
  files: BundleFile[],
  deps: AuthoringHandlerDependencies,
  markPreviousStale: boolean,
): Promise<UploadReviewJob | undefined> {
  const integration = deps.uploadReview;
  if (!integration) return undefined;
  try {
    const state = await deps.repository.read(deps.config.organizationId);
    const currentDraft = state.drafts?.find(
      (candidate) => candidate.id === draft.id && candidate.organizationId === deps.config.organizationId,
    );
    if (!currentDraft || currentDraft.revision !== draft.revision || currentDraft.digest !== draft.digest) return undefined;
    const base = state.skills.find(
      (candidate) => candidate.id === currentDraft.baseResourceId && candidate.organizationId === deps.config.organizationId,
    );
    const binding: UploadReviewBinding = {
      draftId: currentDraft.id,
      draftRevision: currentDraft.revision,
      contentDigest: currentDraft.digest,
      baseReleaseId: currentDraft.baseResourceId,
      ...(base?.version === undefined ? {} : { baseReleaseVersion: base.version }),
      baseDigest: currentDraft.baseDigest,
      policyRevision: state.policy.revision,
    };
    if (markPreviousStale) {
      try {
        await integration.service.markStale(deps.config.organizationId, {
          draftId: currentDraft.id,
          current: binding,
          model: integration.model,
          reviewerRevision: integration.reviewerRevision,
          reason: 'draft revision changed',
        });
      } catch {
        // The new review remains advisory and can still be queued below.
      }
    }
    const snapshot = await createUploadReviewSnapshot(files);
    const job = await integration.service.enqueue(deps.config.organizationId, {
      binding,
      snapshot,
      model: integration.model,
      reviewerRevision: integration.reviewerRevision,
    });
    if (job.state === 'pending' && job.eveSessionId === undefined && integration.trigger) {
      try {
        await integration.trigger(deps.config.organizationId, job.id, integration.service);
      } catch {
        // The pending row remains visible for a later trigger/retry. Review is
        // advisory and an Eve outage must not reject a saved draft.
      }
    }
    return job;
  } catch {
    return undefined;
  }
}

function reviewUnavailable(): AuthoringApiError {
  return new AuthoringApiError('REVIEW_UNAVAILABLE', 'Upload review is temporarily unavailable', 503);
}

function mapReviewError(error: unknown): AuthoringApiError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === 'UPLOAD_REVIEW_NOT_FOUND') return unavailableDraft();
  if (code === 'INVALID_UPLOAD_REVIEW_INPUT') return new AuthoringApiError('INVALID_REQUEST', 'Review request is invalid', 400);
  if (code === 'UPLOAD_REVIEW_CONFLICT') return new AuthoringApiError('REVIEW_CONFLICT', 'Review state changed; retry the request', 409);
  if (code === 'UPLOAD_REVIEW_LEASE_FENCED' || code === 'UPLOAD_REVIEW_LEASE_EXPIRED') {
    return new AuthoringApiError('REVIEW_CONFLICT', 'Review lease is no longer current', 409);
  }
  return reviewUnavailable();
}

function publicReviewJob(job: UploadReviewJob): Record<string, unknown> {
  return {
    id: job.id,
    binding: { ...job.binding },
    model: job.model,
    reviewerRevision: job.reviewerRevision,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.staleReason === undefined ? {} : { staleReason: job.staleReason }),
    ...(job.resultId === undefined ? {} : { resultId: job.resultId }),
  };
}

function publicReviewResult(result: UploadReviewResult): Record<string, unknown> {
  return {
    id: result.id,
    jobId: result.jobId,
    binding: { ...result.binding },
    model: result.model,
    reviewerRevision: result.reviewerRevision,
    state: result.state,
    findings: result.findings.map((finding) => ({ ...finding })),
    createdAt: result.createdAt,
    finishedAt: result.finishedAt,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.staleReason === undefined ? {} : { staleReason: result.staleReason }),
  };
}

async function listDraftReviews(
  draftId: string,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<Response> {
  if (!deps.uploadReview) throw reviewUnavailable();
  const state = await deps.repository.read(deps.config.organizationId);
  const draft = findDraft(state, draftId, principal, deps.config.organizationId);
  const jobs = await deps.uploadReview.service.listJobs(deps.config.organizationId, { draftId: draft.id });
  const results = await deps.uploadReview.service.listResults(deps.config.organizationId, { draftId: draft.id });
  return jsonResponse({
    reviews: jobs.map(publicReviewJob),
    results: results.map(publicReviewResult),
  }, 200, { 'cache-control': 'private, no-store' });
}

async function requestDraftReview(
  _body: Record<string, unknown>,
  draftId: string,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<Response> {
  if (!deps.uploadReview) throw reviewUnavailable();
  try {
    const state = await deps.repository.read(deps.config.organizationId);
    const draft = findDraft(state, draftId, principal, deps.config.organizationId);
    const job = await syncDraftReview(draft, draft.files, deps, false);
    if (!job) throw reviewUnavailable();
    return jsonResponse({ review: publicReviewJob(job) }, 202, { 'cache-control': 'private, no-store' });
  } catch (error) {
    if (error instanceof AuthoringApiError) throw error;
    throw mapReviewError(error);
  }
}

async function retryDraftReview(
  draftId: string,
  jobId: string,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<Response> {
  if (!deps.uploadReview) throw reviewUnavailable();
  try {
    const state = await deps.repository.read(deps.config.organizationId);
    const draft = findDraft(state, draftId, principal, deps.config.organizationId);
    const jobs = await deps.uploadReview.service.listJobs(deps.config.organizationId, { draftId: draft.id });
    const existing = jobs.find((job) => job.id === jobId);
    if (!existing) throw unavailableDraft();
    const job = await deps.uploadReview.service.requeue(deps.config.organizationId, existing.id, undefined, principal.subject);
    if (job.state === 'pending' && job.eveSessionId === undefined && deps.uploadReview.trigger) {
      try {
        await deps.uploadReview.trigger(deps.config.organizationId, job.id, deps.uploadReview.service);
      } catch {
        // Keep the durable pending row available for a later retry.
      }
    }
    return jsonResponse({ review: publicReviewJob(job) }, 202, { 'cache-control': 'private, no-store' });
  } catch (error) {
    if (error instanceof AuthoringApiError) throw error;
    throw mapReviewError(error);
  }
}

async function decideDraftReview(
  body: Record<string, unknown>,
  draftId: string,
  resultId: string,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<Response> {
  if (!deps.uploadReview) throw reviewUnavailable();
  const findingId = typeof body.findingId === 'string' ? body.findingId : '';
  const decision = body.decision;
  const reason = body.reason;
  if (!findingId || !isReviewDecision(decision) || (reason !== undefined && typeof reason !== 'string')) {
    throw new AuthoringApiError('INVALID_REQUEST', 'findingId, decision, and an optional reason are required', 400);
  }
  try {
    const state = await deps.repository.read(deps.config.organizationId);
    const draft = findDraft(state, draftId, principal, deps.config.organizationId);
    const results = await deps.uploadReview.service.listResults(deps.config.organizationId, { draftId: draft.id });
    if (!results.some((result) => result.id === resultId)) throw unavailableDraft();
    const updated = await deps.uploadReview.service.updateFindingDecision(
      deps.config.organizationId,
      resultId,
      findingId,
      decision,
      principal.subject,
      { reason: reason as string | undefined },
    );
    return jsonResponse({ review: publicReviewResult(updated) }, 200, { 'cache-control': 'private, no-store' });
  } catch (error) {
    if (error instanceof AuthoringApiError) throw error;
    throw mapReviewError(error);
  }
}

function isReviewDecision(value: unknown): value is UploadReviewFindingDecision {
  return value === 'open' || value === 'acknowledged' || value === 'dismissed';
}

interface DraftPublishOperation {
  id: string;
  resourceId: string;
  state: 'queued';
  version: string;
  revision: number;
  digest: Digest;
  scanRequired: true;
}

async function publishDraft(
  body: Record<string, unknown>,
  request: Request,
  draftId: string,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<Response> {
  const idempotencyKey = requireIdempotencyKey(request);
  const expectedRevision = requireRevision(body.expectedRevision);
  const version = requireVersion(body.version);
  const requestDigest = await digestText(JSON.stringify({ draftId, expectedRevision, version }));
  const stateBefore = await deps.repository.read(deps.config.organizationId);
  const before = findDraft(stateBefore, draftId, principal, deps.config.organizationId);
  const prior = findPublication(before, idempotencyKey, principal.subject);
  if (prior) {
    if (prior.requestDigest !== requestDigest) throw idempotencyConflict();
    return jsonResponse({ operation: operationFromPublication(prior), idempotent: true }, 200, {
      'cache-control': 'private, no-store',
    });
  }
  if (before.revision !== expectedRevision) throw revisionConflict(before.revision);
  if (before.status !== 'open') {
    throw new AuthoringApiError('DRAFT_CLOSED', 'Draft is no longer editable', 409);
  }

  // The draft bytes are re-read and verified before the job is queued. This
  // binds the scanner job to the exact revision/digest being published, and
  // publication derives release metadata from the new bytes rather than the
  // historical base release.
  const draftBundle = await readDraftBundle(before, deps);
  let metadata;
  try {
    metadata = parseSkillMetadata(draftBundle);
  } catch {
    throw new AuthoringApiError('INVALID_BUNDLE', 'Draft metadata is not a valid SKILL.md manifest', 400);
  }
  const base = await assertCurrentPublishableBase(stateBefore, before, principal, deps);
  const policy = clonePolicy(stateBefore.policy);
  const now = new Date().toISOString();
  const resourceId = randomId('skill');
  const jobId = randomId('job');
  const skill: SkillVersion = {
    id: resourceId,
    organizationId: deps.config.organizationId,
    name: before.name,
    skillName: metadata.skillName,
    version,
    description: metadata.description,
    artifact: before.artifact,
    state: 'pending',
    policyRevision: policy.revision,
    createdAt: now,
    provenance: { kind: 'native', sourceDigest: before.digest },
    fileCount: before.files.length,
    scanIds: [],
    authoring: {
      baseResourceId: before.baseResourceId,
      baseDigest: before.baseDigest,
      draftId: before.id,
      draftRevision: before.revision,
      actor: principal.subject,
    },
  };
  const job: Job = {
    id: jobId,
    organizationId: deps.config.organizationId,
    kind: 'scan',
    state: 'queued',
    resourceId,
    artifact: before.artifact,
    policyRevision: policy.revision,
    policy,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  const publication: SkillDraftPublicationRecord = {
    key: idempotencyKey,
    subject: principal.subject,
    requestDigest,
    revision: expectedRevision,
    digest: before.digest,
    version,
    resourceId,
    jobId,
    createdAt: now,
  };

  const result = await deps.repository.transaction(deps.config.organizationId, (state) => {
    const current = findDraft(state, draftId, principal, deps.config.organizationId);
    const concurrent = findPublication(current, idempotencyKey, principal.subject);
    if (concurrent) {
      if (concurrent.requestDigest !== requestDigest) throw idempotencyConflict();
      return { operation: operationFromPublication(concurrent), idempotent: true };
    }
    if (current.revision !== expectedRevision) throw revisionConflict(current.revision);
    if (current.status !== 'open') {
      throw new AuthoringApiError('DRAFT_CLOSED', 'Draft is no longer editable', 409);
    }
    const currentBase = state.skills.find((candidate) => candidate.id === current.baseResourceId);
    if (!currentBase || currentBase.organizationId !== deps.config.organizationId || !sameReadableBase(currentBase, currentBase, state, principal, current.baseDigest)) {
      throw unavailableDraft();
    }
    if (state.policy.revision !== policy.revision) {
      throw new AuthoringApiError('POLICY_CHANGED', 'The scanner policy changed; retry publication', 409);
    }
    if (!deps.releaseAdmissionAtCommit || !deps.releaseAdmissionAtCommit(state, currentBase, principal)) {
      throw new AuthoringApiError('RELEASE_UNAVAILABLE', 'Release admission could not be verified at commit', 503);
    }
    if (state.skills.some((candidate) => candidate.name === current.name && candidate.version === version)) {
      throw new AuthoringApiError('VERSION_CONFLICT', 'That skill version already exists', 409);
    }
    state.skills.push(skill);
    state.jobs.push(job);
    current.publications = [...(current.publications ?? []).slice(-(MAX_PUBLICATION_HISTORY - 1)), publication];
    appendDraftAudit(state, principal, 'draft.publish.queued', current, deps.config.organizationId, {
      digest: publication.digest,
      version,
      resourceId,
      jobId,
      draftRevision: expectedRevision,
      scanRequired: true,
    }, now);
    return { operation: operationFromPublication(publication), idempotent: false };
  });

  return jsonResponse(result, result.idempotent ? 200 : 202, {
    'cache-control': 'private, no-store',
  });
}

function operationFromPublication(publication: SkillDraftPublicationRecord): DraftPublishOperation {
  return {
    id: publication.jobId,
    resourceId: publication.resourceId,
    state: 'queued',
    version: publication.version,
    revision: publication.revision,
    digest: publication.digest,
    scanRequired: true,
  };
}

function findPublication(
  draft: SkillDraft,
  key: string,
  subject: string,
): SkillDraftPublicationRecord | undefined {
  return (draft.publications ?? []).find((publication) => publication.key === key && publication.subject === subject);
}

async function assertCurrentPublishableBase(
  state: RegistryState,
  draft: SkillDraft,
  principal: Principal,
  deps: AuthoringHandlerDependencies,
): Promise<SkillVersion> {
  const base = state.skills.find((candidate) => candidate.id === draft.baseResourceId);
  if (!base || base.organizationId !== deps.config.organizationId || !sameReadableBase(base, base, state, principal, draft.baseDigest)) {
    throw unavailableDraft();
  }
  let admitted = false;
  try {
    admitted = await deps.releaseAdmission(state, base, principal);
  } catch {
    throw new AuthoringApiError('RELEASE_UNAVAILABLE', 'Release admission could not be verified', 503);
  }
  if (!admitted) throw unavailableDraft();
  return base;
}

function findDraft(state: RegistryState, draftId: string, principal: Principal, organizationId: string): SkillDraft {
  const draft = state.drafts?.find(
    (candidate) => candidate.id === draftId && candidate.organizationId === organizationId && canReadNamespace(principal, candidate.name),
  );
  if (!draft) throw unavailableDraft();
  return draft;
}

async function readDraftBundle(draft: SkillDraft, deps: AuthoringHandlerDependencies): Promise<ReturnType<typeof decodeBundle>> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.blobs.get(draft.artifact.key);
  } catch {
    throw new AuthoringApiError('DRAFT_UNAVAILABLE', 'Draft content is temporarily unavailable', 503);
  }
  const actual = await digestBytes(bytes);
  if (actual !== draft.digest || actual !== draft.artifact.digest || bytes.byteLength !== draft.artifact.size) {
    throw new AuthoringApiError('DIGEST_MISMATCH', 'Draft content failed integrity verification', 409);
  }
  let bundle: ReturnType<typeof decodeBundle>;
  try {
    bundle = decodeBundle(bytes);
  } catch {
    throw new AuthoringApiError('DRAFT_INVALID', 'Draft content is not a canonical bundle', 409);
  }
  const manifestDigest = await digestBytes(encodeBundle(bundle));
  if (manifestDigest !== draft.digest || !sameFiles(bundle.files, draft.files)) {
    throw new AuthoringApiError('DRAFT_INVALID', 'Draft manifest does not match its sealed content', 409);
  }
  return bundle;
}

function toPublicDraft(draft: SkillDraft, bundle: { format: 'pskills-bundle-v1'; files: BundleFile[] }): PublicSkillDraft {
  return {
    id: draft.id,
    name: draft.name,
    skillName: draft.skillName,
    description: draft.description ?? '',
    baseResourceId: draft.baseResourceId,
    baseDigest: draft.baseDigest,
    revision: draft.revision,
    digest: draft.digest,
    size: draft.artifact.size,
    files: bundle.files,
    status: draft.status,
    actor: draft.actor,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    ...(draft.publications
      ? {
        publications: draft.publications.slice(-MAX_PUBLICATION_HISTORY).map((publication) => ({
          revision: publication.revision,
          digest: publication.digest,
          version: publication.version,
          resourceId: publication.resourceId,
          jobId: publication.jobId,
          createdAt: publication.createdAt,
        })),
      }
      : {}),
  };
}

async function draftFromCreateRecord(draft: SkillDraft, deps: AuthoringHandlerDependencies): Promise<SkillDraft> {
  const record = draft.createIdempotency;
  if (!record) return draft;
  const bundle = await readIdempotencyBundle(record, deps);
  return {
    ...draft,
    revision: record.revision,
    digest: record.digest,
    artifact: record.artifact,
    files: bundle.files,
    updatedAt: record.updatedAt,
  };
}

async function draftFromIdempotency(
  draft: SkillDraft,
  record: SkillDraftIdempotencyRecord,
  deps: AuthoringHandlerDependencies,
): Promise<SkillDraft> {
  const bundle = await readIdempotencyBundle(record, deps);
  return {
    ...draft,
    revision: record.revision,
    digest: record.digest,
    artifact: record.artifact,
    files: bundle.files,
    updatedAt: record.updatedAt,
  };
}

async function readIdempotencyBundle(
  record: SkillDraftIdempotencyRecord,
  deps: AuthoringHandlerDependencies,
): Promise<ReturnType<typeof decodeBundle>> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.blobs.get(record.artifact.key);
  } catch {
    throw new AuthoringApiError('DRAFT_UNAVAILABLE', 'Draft content is temporarily unavailable', 503);
  }
  const actual = await digestBytes(bytes);
  if (actual !== record.digest || actual !== record.artifact.digest || bytes.byteLength !== record.artifact.size) {
    throw new AuthoringApiError('DIGEST_MISMATCH', 'Draft content failed integrity verification', 409);
  }
  let bundle: ReturnType<typeof decodeBundle>;
  try {
    bundle = decodeBundle(bytes);
  } catch {
    throw new AuthoringApiError('DRAFT_INVALID', 'Draft content is not a canonical bundle', 409);
  }
  const manifest = await compactManifest(bundle.files);
  if (!Array.isArray(record.manifest) || !sameManifest(manifest, record.manifest)) {
    throw new AuthoringApiError('DRAFT_INVALID', 'Draft manifest does not match its sealed content', 409);
  }
  return bundle;
}

function findIdempotency(draft: SkillDraft, key: string, subject: string): SkillDraftIdempotencyRecord | undefined {
  return (draft.idempotency ?? []).find((record) => record.key === key && record.subject === subject);
}

function sameReadableBase(
  current: SkillVersion,
  expected: SkillVersion,
  state: RegistryState,
  principal: Principal,
  digest: Digest,
): boolean {
  return current.id === expected.id &&
    current.organizationId === expected.organizationId &&
    current.artifact.digest === digest &&
    current.state === 'approved' &&
    current.policyRevision === state.policy.revision &&
    canReadNamespace(principal, current.name);
}

function ensureDrafts(state: RegistryState): void {
  state.drafts ??= [];
}

function appendDraftAudit(
  state: RegistryState,
  principal: Principal,
  action: string,
  draft: SkillDraft,
  organizationId: string,
  extra: Record<string, unknown> = {},
  createdAt = draft.updatedAt,
): void {
  state.audit.push({
    id: randomId('audit'),
    organizationId,
    subject: principal.subject,
    action,
    resourceId: draft.id,
    createdAt,
    details: {
      baseResourceId: draft.baseResourceId,
      baseDigest: draft.baseDigest,
      revision: draft.revision,
      digest: draft.digest,
      ...extra,
    },
  });
}

async function compactManifest(files: BundleFile[]): Promise<SkillDraftFileManifestEntry[]> {
  return Promise.all(files.map(async (file) => {
    const bytes = decodeBase64(file.content);
    return {
      path: file.path,
      size: bytes.byteLength,
      digest: await digestBytes(bytes),
      ...(file.executable === true ? { executable: true } : {}),
    };
  }));
}

function sameManifest(
  left: SkillDraftFileManifestEntry[],
  right: SkillDraftFileManifestEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return file.path === other?.path &&
      file.size === other.size &&
      file.digest === other.digest &&
      file.executable === other.executable;
  });
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new AuthoringApiError('DRAFT_INVALID', 'Draft file content is not canonical base64', 409);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function putVerifiedDraftBlob(deps: AuthoringHandlerDependencies, bytes: Uint8Array, digest: Digest): Promise<StoredBlob> {
  let stored: StoredBlob;
  try {
    stored = await deps.blobs.put(bytes);
  } catch {
    throw new AuthoringApiError('STORAGE_UNAVAILABLE', 'Draft storage is temporarily unavailable', 503);
  }
  if (!stored || stored.digest !== digest || stored.size !== bytes.byteLength || !stored.key) {
    throw new AuthoringApiError('DIGEST_MISMATCH', 'Draft storage returned unexpected bytes', 409);
  }
  return stored;
}

async function digestText(value: string): Promise<Digest> {
  return digestBytes(new TextEncoder().encode(value));
}

function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get('idempotency-key')?.trim();
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_BYTES || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new AuthoringApiError('INVALID_REQUEST', 'Idempotency-Key is required', 400);
  }
  return key;
}

function requireDigest(value: unknown, field: string): Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new AuthoringApiError('INVALID_REQUEST', `${field} must be a sha256 digest`, 400);
  }
  return value as Digest;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
    throw new AuthoringApiError('INVALID_REQUEST', 'expectedRevision must be a positive integer', 400);
  }
  return value;
}

function requireVersion(value: unknown): string {
  const version = typeof value === 'string' ? validSemver(value) : null;
  const canonicalShape = typeof value === 'string' && /^(?:0|[1-9]\d*)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
  if (version === null || !canonicalShape) {
    throw new AuthoringApiError('INVALID_VERSION', 'Version must be SemVer', 400);
  }
  return value;
}

function clonePolicy(policy: RegistryState['policy']): RegistryState['policy'] {
  return JSON.parse(JSON.stringify(policy)) as RegistryState['policy'];
}

async function readJson(request: Request, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared && Number.isSafeInteger(Number(declared)) && Number(declared) > maxBodyBytes) {
    throw new AuthoringApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit', 413);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    throw new AuthoringApiError('INVALID_REQUEST', 'Request body could not be read', 400);
  }
  if (bytes.byteLength > maxBodyBytes) {
    throw new AuthoringApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit', 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AuthoringApiError('INVALID_JSON', 'Request body must be valid JSON', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthoringApiError('INVALID_JSON', 'Request body must be an object', 400);
  }
  return parsed as Record<string, unknown>;
}

function normalizeBodyLimit(value: number | undefined): number {
  if (value === undefined) return 10 * 1024 * 1024;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('maxBodyBytes must be a positive safe integer');
  return value;
}

function parseRequestUrl(request: Request): URL {
  try {
    return new URL(request.url);
  } catch {
    throw new AuthoringApiError('INVALID_REQUEST', 'Request URL is invalid', 400);
  }
}

function splitPath(pathname: string): string[] {
  return pathname.replaceAll('\\', '/').split('/').filter(Boolean);
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw unavailableDraft();
  }
}

function isSafeId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f/\\]/u.test(value);
}

function unavailableDraft(): AuthoringApiError {
  return new AuthoringApiError('NOT_FOUND', 'Draft is unavailable', 404);
}

function idempotencyConflict(): AuthoringApiError {
  return new AuthoringApiError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request', 409);
}

function revisionConflict(currentRevision: number): AuthoringApiError {
  return new AuthoringApiError('DRAFT_CONFLICT', 'Draft revision is stale; rebase before saving', 409, { currentRevision });
}

function sameFiles(left: BundleFile[], right: BundleFile[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return file.path === other?.path && file.content === other.content && file.executable === other.executable;
  });
}

function randomId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
