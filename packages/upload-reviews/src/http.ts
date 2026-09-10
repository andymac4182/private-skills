import { createHash, timingSafeEqual } from 'node:crypto';
import type { StateRepository } from '../../contracts/src/index.js';
import {
  createUploadReviewPersistenceService,
  type UploadReviewFindingInput,
  type UploadReviewCurrentBindingResolver,
  type UploadReviewPersistenceService,
  type UploadReviewSnapshotFile,
} from './index.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_ERROR_LENGTH = 1_000;

export interface UploadReviewHttpDependencies {
  repository: StateRepository;
  organizationId: string;
  /** A distinct upload-reviewer token; never reuse the daily reviewer token. */
  reviewerToken: string;
  /** Core-owned draft binding lookup evaluated inside queue transactions. */
  resolveCurrentBinding?: UploadReviewCurrentBindingResolver;
  service?: UploadReviewPersistenceService;
  maxBodyBytes?: number;
}

export interface UploadReviewPrepareResponse {
  status: 'prepared' | 'already_completed' | 'failed' | 'stale';
  jobId: string;
  draftId: string;
  draftRevision: number;
  contentDigest: string;
  baseReleaseId?: string;
  baseReleaseVersion?: string;
  baseDigest?: string;
  policyRevision: string;
  model: string;
  reviewerRevision: string;
  files?: UploadReviewSnapshotFile[];
  /** Internal tool-only lease; the Eve tool does not return it to the model. */
  leaseToken?: string;
}

export function createUploadReviewHttpHandler(
  dependencies: UploadReviewHttpDependencies,
): (request: Request) => Promise<Response | undefined> {
  const maxBodyBytes = normalizeBodyBytes(dependencies.maxBodyBytes);
  const service = dependencies.service ?? createUploadReviewPersistenceService(dependencies.repository, {
    resolveCurrentBinding: dependencies.resolveCurrentBinding,
  });
  assertToken(dependencies.reviewerToken);

  return async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname.replace(/\/+$/u, '') || '/';
    if (!path.startsWith('/internal/upload-review/')) return undefined;
    try {
      requireBearer(request, dependencies.reviewerToken);
      if (request.method.toUpperCase() !== 'POST') return methodNotAllowed();
      if (path === '/internal/upload-review/prepare') {
        return jsonResponse(await prepare(request, service, dependencies.organizationId, maxBodyBytes));
      }
      if (path === '/internal/upload-review/complete') {
        return jsonResponse(await complete(request, service, dependencies.organizationId, maxBodyBytes));
      }
      if (path === '/internal/upload-review/fail') {
        return jsonResponse(await fail(request, service, dependencies.organizationId, maxBodyBytes));
      }
      return jsonResponse({ error: 'not found' }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

async function prepare(
  request: Request,
  service: UploadReviewPersistenceService,
  organizationId: string,
  maxBodyBytes: number,
): Promise<UploadReviewPrepareResponse> {
  const body = await readJson(request, maxBodyBytes);
  const sessionId = requiredId(body.sessionId, 'sessionId');
  // Eve can start its first turn before the registry's post-create bind
  // returns. A job-specific opaque id lets this authenticated request finish
  // that bind atomically, without guessing among pending jobs.
  const jobId = body.jobId === undefined ? undefined : requiredId(body.jobId, 'jobId');
  if (jobId !== undefined) await service.bindEveSession(organizationId, jobId, sessionId);
  const claim = await service.claimForEveSession(organizationId, sessionId);
  const job = claim.job;
  if (job.state === 'passed') {
    return publicPrepare(job, 'already_completed');
  }
  if (job.state === 'failed') {
    return publicPrepare(job, 'failed');
  }
  if (job.state === 'stale') {
    return publicPrepare(job, 'stale');
  }
  const leaseToken = claim.leaseToken;
  if (!leaseToken) throw new UploadReviewHttpError(503, 'upload review lease is unavailable');
  const leased = await service.getLeasedJob(organizationId, job.id, leaseToken);
  return {
    ...publicPrepare(leased, 'prepared'),
    leaseToken,
    files: leased.snapshot.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      size: file.size,
      digest: file.digest,
      ...(file.text === undefined ? {} : { text: file.text }),
    })),
  };
}

async function complete(
  request: Request,
  service: UploadReviewPersistenceService,
  organizationId: string,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const body = await readJson(request, maxBodyBytes);
  const sessionId = requiredId(body.sessionId, 'sessionId');
  const jobId = requiredId(body.jobId, 'jobId');
  const leaseToken = requiredId(body.leaseToken, 'leaseToken');
  const findings = body.findings;
  if (!Array.isArray(findings)) throw new UploadReviewHttpError(400, 'findings must be an array');
  const job = await service.getLeasedJob(organizationId, jobId, leaseToken);
  if (job.eveSessionId !== sessionId) throw new UploadReviewHttpError(404, 'upload review job was not found');
  if (job.state === 'stale') return { status: 'stale', ...(job.resultId === undefined ? {} : { resultId: job.resultId }) };
  const result = await service.complete(organizationId, jobId, leaseToken, {
    findings: findings as UploadReviewFindingInput[],
  });
  return { status: result.state, resultId: result.id, findingCount: result.findings.length };
}

async function fail(
  request: Request,
  service: UploadReviewPersistenceService,
  organizationId: string,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const body = await readJson(request, maxBodyBytes);
  const sessionId = requiredId(body.sessionId, 'sessionId');
  const jobId = requiredId(body.jobId, 'jobId');
  const leaseToken = requiredId(body.leaseToken, 'leaseToken');
  const job = await service.getLeasedJob(organizationId, jobId, leaseToken);
  if (job.eveSessionId !== sessionId) throw new UploadReviewHttpError(404, 'upload review job was not found');
  if (job.state === 'stale') return { status: 'stale', ...(job.resultId === undefined ? {} : { resultId: job.resultId }) };
  const error = typeof body.error === 'string' ? body.error.slice(0, MAX_ERROR_LENGTH) : 'upload review failed';
  const result = await service.fail(organizationId, jobId, leaseToken, error);
  return { status: result.state, resultId: result.id };
}

function publicPrepare(
  job: Awaited<ReturnType<UploadReviewPersistenceService['getLeasedJob']>>,
  status: UploadReviewPrepareResponse['status'],
): UploadReviewPrepareResponse {
  return {
    status,
    jobId: job.id,
    draftId: job.binding.draftId,
    draftRevision: job.binding.draftRevision,
    contentDigest: job.binding.contentDigest,
    ...(job.binding.baseReleaseId === undefined ? {} : { baseReleaseId: job.binding.baseReleaseId }),
    ...(job.binding.baseReleaseVersion === undefined ? {} : { baseReleaseVersion: job.binding.baseReleaseVersion }),
    ...(job.binding.baseDigest === undefined ? {} : { baseDigest: job.binding.baseDigest }),
    policyRevision: job.binding.policyRevision,
    model: job.model,
    reviewerRevision: job.reviewerRevision,
  };
}

function requireBearer(request: Request, expected: string): void {
  const value = request.headers.get('authorization');
  const supplied = value?.match(/^Bearer\s+([^\s]+)$/u)?.[1];
  if (!supplied || !constantTimeEqual(expected, supplied)) throw new UploadReviewHttpError(401, 'authentication is required');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function assertToken(token: string): void {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH || /\s/u.test(token)) {
    throw new Error('upload-reviewer token is invalid');
  }
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new UploadReviewHttpError(400, `${field} is invalid`);
  }
  return value.trim();
}

async function readJson(request: Request, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > maxBodyBytes) {
    throw new UploadReviewHttpError(413, 'request body is too large');
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBodyBytes) throw new UploadReviewHttpError(413, 'request body is too large');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new UploadReviewHttpError(400, 'request body is invalid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UploadReviewHttpError(400, 'request body must be an object');
  }
  return value as Record<string, unknown>;
}

function normalizeBodyBytes(value: number | undefined): number {
  if (value === undefined) return MAX_BODY_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BODY_BYTES) throw new Error('maxBodyBytes is invalid');
  return value;
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: 'method not allowed' }), {
    status: 405,
    headers: { allow: 'POST', 'cache-control': 'no-store', 'content-type': 'application/json' },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
  });
}

class UploadReviewHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'UploadReviewHttpError';
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof UploadReviewHttpError) return jsonResponse({ error: error.message }, error.status);
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UPLOAD_REVIEW_UNAVAILABLE';
  const status = code === 'UPLOAD_REVIEW_NOT_FOUND' ? 404 : code.includes('VALIDATION') || code.includes('INVALID') ? 400 : 409;
  return jsonResponse({ error: status === 404 ? 'upload review job was not found' : 'upload review request could not be completed' }, status);
}
