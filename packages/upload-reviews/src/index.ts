import type {
  Digest,
  RegistryState,
  StateRepository,
} from '../../contracts/src/index.js';

/**
 * Upload/edit review state is intentionally separate from packages/reviews.
 * The daily consolidation reviewer must never be able to claim or complete
 * an upload/edit job.
 */
export const MAX_UPLOAD_REVIEW_FILES = 2_000;
export const MAX_UPLOAD_REVIEW_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_REVIEW_TEXT_CHARS = 16_000;
export const MAX_UPLOAD_REVIEW_TOTAL_TEXT_CHARS = 160_000;
export const MAX_UPLOAD_REVIEW_FINDINGS = 60;
export const MAX_UPLOAD_REVIEW_JOBS = 100;
export const MAX_UPLOAD_REVIEW_RESULTS = 100;
export const DEFAULT_UPLOAD_REVIEW_LEASE_SECONDS = 15 * 60;

const MAX_ID_LENGTH = 256;
const MAX_KEY_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 256;
const MAX_POLICY_LENGTH = 256;
const MAX_VERSION_LENGTH = 128;
const MAX_TITLE_LENGTH = 256;
const MAX_CATEGORY_LENGTH = 128;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_EVIDENCE_LENGTH = 4_000;
const MAX_RECOMMENDATION_LENGTH = 4_000;
const MAX_REASON_LENGTH = 1_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const SAFE_PATH_SEGMENT = /^(?:\.|\.{2})$/u;

export type UploadReviewState = 'pending' | 'running' | 'passed' | 'failed' | 'stale';
export type UploadReviewFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type UploadReviewFileKind = 'text' | 'binary' | 'oversize';

export interface UploadReviewBinding {
  draftId: string;
  draftRevision: number;
  contentDigest: Digest;
  baseReleaseId?: string;
  baseReleaseVersion?: string;
  baseDigest?: Digest;
  policyRevision: string;
}

/**
 * The queue stores a bounded, server-selected snapshot. Binary and oversized
 * files remain metadata-only; no reviewer tool receives an executable file.
 */
export interface UploadReviewSnapshotFile {
  path: string;
  kind: UploadReviewFileKind;
  size: number;
  digest: Digest;
  text?: string;
}

export interface UploadReviewSnapshot {
  files: readonly UploadReviewSnapshotFile[];
}

export interface UploadReviewFinding {
  /** Server-assigned stable finding identity within one result. */
  id: string;
  severity: UploadReviewFindingSeverity;
  category: string;
  title: string;
  summary: string;
  evidence?: string;
  recommendation?: string;
  path?: string;
  line?: number;
  decision: UploadReviewFindingDecision;
  decisionReason?: string;
}

export type UploadReviewFindingDecision = 'open' | 'acknowledged' | 'dismissed';

export interface UploadReviewFindingInput {
  severity: UploadReviewFindingSeverity;
  category: string;
  title: string;
  summary: string;
  evidence?: string;
  recommendation?: string;
  path?: string;
  line?: number;
}

export interface UploadReviewJob {
  id: string;
  organizationId: string;
  idempotencyKey: string;
  binding: UploadReviewBinding;
  snapshot: UploadReviewSnapshot;
  model: string;
  reviewerRevision: string;
  state: UploadReviewState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  staleReason?: string;
  resultId?: string;
  /** Opaque Eve session metadata; never a bearer credential. */
  eveSessionId?: string;
  /** Present only while the queue lease is active. */
  leaseToken?: string;
  leaseExpiresAt?: string;
}

export interface UploadReviewResult {
  id: string;
  jobId: string;
  organizationId: string;
  binding: UploadReviewBinding;
  model: string;
  reviewerRevision: string;
  state: Extract<UploadReviewState, 'passed' | 'failed' | 'stale'>;
  findings: UploadReviewFinding[];
  createdAt: string;
  finishedAt: string;
  error?: string;
  staleReason?: string;
}

export interface EnqueueUploadReviewInput {
  idempotencyKey?: string;
  binding: UploadReviewBinding;
  snapshot: UploadReviewSnapshot;
  model: string;
  reviewerRevision: string;
  now?: ReviewNow;
}

export interface UploadReviewClaim {
  job: UploadReviewJob;
  claimed: boolean;
  leaseToken?: string;
}

export interface CompleteUploadReviewInput {
  findings: readonly UploadReviewFindingInput[];
  now?: ReviewNow;
}

export interface MarkUploadReviewStaleInput {
  draftId: string;
  current: UploadReviewBinding;
  /** Optional reviewer contract values; changing either also stales old results. */
  reviewerRevision?: string;
  model?: string;
  reason: string;
  now?: ReviewNow;
}

export interface UploadReviewListOptions {
  draftId?: string;
  state?: UploadReviewState;
  limit?: number;
}

export interface UploadReviewPersistenceService {
  enqueue(organizationId: string, input: EnqueueUploadReviewInput): Promise<UploadReviewJob>;
  bindEveSession(organizationId: string, jobId: string, eveSessionId: string, now?: ReviewNow): Promise<UploadReviewJob>;
  claimForEveSession(
    organizationId: string,
    eveSessionId: string,
    options?: { now?: ReviewNow },
  ): Promise<UploadReviewClaim>;
  claim(
    organizationId: string,
    jobId: string,
    options?: { eveSessionId?: string; now?: ReviewNow },
  ): Promise<UploadReviewClaim>;
  getLeasedJob(organizationId: string, jobId: string, leaseToken: string, now?: ReviewNow): Promise<UploadReviewJob>;
  complete(
    organizationId: string,
    jobId: string,
    leaseToken: string,
    input: CompleteUploadReviewInput,
  ): Promise<UploadReviewResult>;
  fail(
    organizationId: string,
    jobId: string,
    leaseToken: string,
    error: string,
    now?: ReviewNow,
  ): Promise<UploadReviewResult>;
  markStale(organizationId: string, input: MarkUploadReviewStaleInput): Promise<UploadReviewJob[]>;
  requeue(organizationId: string, jobId: string, now?: ReviewNow, actor?: string): Promise<UploadReviewJob>;
  updateFindingDecision(
    organizationId: string,
    resultId: string,
    findingId: string,
    decision: UploadReviewFindingDecision,
    actor: string,
    nowOrOptions?: ReviewNow | { now?: ReviewNow; reason?: string },
  ): Promise<UploadReviewResult>;
  listJobs(organizationId: string, options?: UploadReviewListOptions): Promise<UploadReviewJob[]>;
  listResults(organizationId: string, options?: UploadReviewListOptions): Promise<UploadReviewResult[]>;
}

export interface UploadReviewStateExtension {
  uploadReviewJobs?: UploadReviewJob[];
  uploadReviewResults?: UploadReviewResult[];
}

export type UploadReviewRegistryState = RegistryState & UploadReviewStateExtension;
export type ReviewNow = Date | string | number;

export class UploadReviewError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'UploadReviewError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class UploadReviewValidationError extends UploadReviewError {
  constructor(message: string) {
    super('INVALID_UPLOAD_REVIEW_INPUT', message);
  }
}

export class UploadReviewNotFoundError extends UploadReviewError {
  constructor(message = 'upload review job was not found') {
    super('UPLOAD_REVIEW_NOT_FOUND', message);
  }
}

export class UploadReviewConflictError extends UploadReviewError {
  constructor(message: string) {
    super('UPLOAD_REVIEW_CONFLICT', message);
  }
}

export class UploadReviewLeaseError extends UploadReviewError {
  constructor(code: 'UPLOAD_REVIEW_LEASE_FENCED' | 'UPLOAD_REVIEW_LEASE_EXPIRED' | 'UPLOAD_REVIEW_NOT_RUNNING', message: string) {
    super(code, message, code === 'UPLOAD_REVIEW_LEASE_EXPIRED');
  }
}

export class UploadReviewStateError extends UploadReviewError {
  constructor(message: string) {
    super('UPLOAD_REVIEW_STATE_INVALID', message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedString(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new UploadReviewValidationError(field + ' must be a string');
  const result = value.trim();
  if (!allowEmpty && result.length === 0) throw new UploadReviewValidationError(field + ' must not be empty');
  if (result.length > maximum) throw new UploadReviewValidationError(field + ' exceeds the maximum length');
  if (CONTROL_CHARACTER.test(result)) throw new UploadReviewValidationError(field + ' contains invalid characters');
  return result;
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, field, maximum);
}

function validateDigest(value: unknown, field: string): Digest {
  const result = boundedString(value, field, 80);
  if (!DIGEST_PATTERN.test(result)) throw new UploadReviewValidationError(field + ' must be a sha256 digest');
  return result as Digest;
}

function validateRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1) {
    throw new UploadReviewValidationError(field + ' must be a positive bounded integer');
  }
  return value;
}

function parseClock(value: ReviewNow | undefined): { milliseconds: number; iso: string } {
  let milliseconds: number;
  if (value === undefined) milliseconds = Date.now();
  else if (value instanceof Date) milliseconds = value.getTime();
  else if (typeof value === 'number') milliseconds = value;
  else milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new UploadReviewValidationError('now must be a valid timestamp');
  const iso = new Date(milliseconds).toISOString();
  return { milliseconds, iso };
}

function validateBinding(value: unknown): UploadReviewBinding {
  if (!isRecord(value)) throw new UploadReviewValidationError('binding must be an object');
  const baseReleaseId = optionalString(value.baseReleaseId, 'binding.baseReleaseId', MAX_ID_LENGTH);
  const baseReleaseVersion = optionalString(value.baseReleaseVersion, 'binding.baseReleaseVersion', MAX_VERSION_LENGTH);
  const baseDigest = value.baseDigest === undefined ? undefined : validateDigest(value.baseDigest, 'binding.baseDigest');
  return {
    draftId: boundedString(value.draftId, 'binding.draftId', MAX_ID_LENGTH),
    draftRevision: validateRevision(value.draftRevision, 'binding.draftRevision'),
    contentDigest: validateDigest(value.contentDigest, 'binding.contentDigest'),
    ...(baseReleaseId === undefined ? {} : { baseReleaseId }),
    ...(baseReleaseVersion === undefined ? {} : { baseReleaseVersion }),
    ...(baseDigest === undefined ? {} : { baseDigest }),
    policyRevision: boundedString(value.policyRevision, 'binding.policyRevision', MAX_POLICY_LENGTH),
  };
}

function validateSnapshotFile(value: unknown, index: number): UploadReviewSnapshotFile {
  if (!isRecord(value)) throw new UploadReviewValidationError('snapshot.files[' + index + '] must be an object');
  const path = boundedString(value.path, 'snapshot.files[' + index + '].path', 4_096);
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => segment.length === 0 || SAFE_PATH_SEGMENT.test(segment))
  ) {
    throw new UploadReviewValidationError('snapshot.files[' + index + '].path is unsafe');
  }
  const kind = value.kind;
  if (kind !== 'text' && kind !== 'binary' && kind !== 'oversize') {
    throw new UploadReviewValidationError('snapshot.files[' + index + '].kind is invalid');
  }
  const size = value.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_REVIEW_FILE_BYTES) {
    throw new UploadReviewValidationError('snapshot.files[' + index + '].size is invalid');
  }
  const digest = validateDigest(value.digest, 'snapshot.files[' + index + '].digest');
  if (kind === 'text') {
    const text = boundedString(value.text, 'snapshot.files[' + index + '].text', MAX_UPLOAD_REVIEW_TEXT_CHARS, true);
    if (new TextEncoder().encode(text).byteLength > size) {
      throw new UploadReviewValidationError('snapshot.files[' + index + '].text exceeds its declared size');
    }
    return { path, kind, size, digest, text };
  }
  if (value.text !== undefined) {
    throw new UploadReviewValidationError('snapshot.files[' + index + '] must not include text');
  }
  return { path, kind, size, digest };
}

function validateSnapshot(value: unknown): UploadReviewSnapshot {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new UploadReviewValidationError('snapshot.files must be an array');
  }
  if (value.files.length > MAX_UPLOAD_REVIEW_FILES) {
    throw new UploadReviewValidationError('snapshot contains too many files');
  }
  const files = value.files.map((file, index) => validateSnapshotFile(file, index));
  const seen = new Set<string>();
  let textCharacters = 0;
  for (const file of files) {
    const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new UploadReviewValidationError('snapshot contains duplicate paths');
    seen.add(key);
    if (file.text !== undefined) textCharacters += [...file.text].length;
  }
  if (textCharacters > MAX_UPLOAD_REVIEW_TOTAL_TEXT_CHARS) {
    throw new UploadReviewValidationError('snapshot text exceeds the review limit');
  }
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function sameBinding(left: UploadReviewBinding, right: UploadReviewBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSnapshot(left: UploadReviewSnapshot, right: UploadReviewSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeEnqueueInput(input: EnqueueUploadReviewInput): {
  idempotencyKey: string;
  binding: UploadReviewBinding;
  snapshot: UploadReviewSnapshot;
  model: string;
  reviewerRevision: string;
  clock: { milliseconds: number; iso: string };
} {
  if (!isRecord(input)) throw new UploadReviewValidationError('enqueue input must be an object');
  const binding = validateBinding(input.binding);
  const snapshot = validateSnapshot(input.snapshot);
  const model = boundedString(input.model, 'model', MAX_MODEL_LENGTH);
  const reviewerRevision = boundedString(input.reviewerRevision, 'reviewerRevision', MAX_VERSION_LENGTH);
  const idempotencyKey = input.idempotencyKey === undefined
    ? uploadReviewIdempotencyKey(binding, reviewerRevision)
    : boundedString(input.idempotencyKey, 'idempotencyKey', MAX_KEY_LENGTH);
  return {
    idempotencyKey,
    binding,
    snapshot,
    model,
    reviewerRevision,
    clock: parseClock(input.now),
  };
}

export function uploadReviewIdempotencyKey(binding: UploadReviewBinding, reviewerRevision: string): string {
  const normalized = validateBinding(binding);
  const revision = boundedString(reviewerRevision, 'reviewerRevision', MAX_VERSION_LENGTH);
  return [
    'upload-edit-review',
    normalized.draftId,
    String(normalized.draftRevision),
    normalized.contentDigest,
    normalized.baseReleaseId ?? '-',
    normalized.baseDigest ?? '-',
    normalized.policyRevision,
    revision,
  ].join(':');
}

function randomId(prefix: string): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.randomUUID) return prefix + '_' + webCrypto.randomUUID();
  if (!webCrypto?.getRandomValues) throw new UploadReviewStateError('a WebCrypto random source is required');
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return prefix + '_' + value;
}

function leaseExpired(job: UploadReviewJob, milliseconds: number): boolean {
  return !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= milliseconds;
}

function clearLease(job: UploadReviewJob): void {
  delete job.leaseToken;
  delete job.leaseExpiresAt;
}

function redactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/(token|secret|password|authorization)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_REASON_LENGTH) || 'upload review failed';
}

function collections(state: RegistryState): { jobs: UploadReviewJob[]; results: UploadReviewResult[] } {
  const extension = state as UploadReviewRegistryState;
  if (extension.uploadReviewJobs !== undefined && !Array.isArray(extension.uploadReviewJobs)) {
    throw new UploadReviewStateError('uploadReviewJobs is not an array');
  }
  if (extension.uploadReviewResults !== undefined && !Array.isArray(extension.uploadReviewResults)) {
    throw new UploadReviewStateError('uploadReviewResults is not an array');
  }
  return {
    jobs: extension.uploadReviewJobs ?? [],
    results: extension.uploadReviewResults ?? [],
  };
}

function writableCollections(state: RegistryState): { jobs: UploadReviewJob[]; results: UploadReviewResult[] } {
  const extension = state as UploadReviewRegistryState;
  const value = collections(state);
  extension.uploadReviewJobs = value.jobs;
  extension.uploadReviewResults = value.results;
  return value;
}

function assertOrganizationId(organizationId: string): void {
  boundedString(organizationId, 'organizationId', MAX_ID_LENGTH);
}

function assertRetentionAvailable(jobs: readonly UploadReviewJob[], additional: number): void {
  if (jobs.length + additional <= MAX_UPLOAD_REVIEW_JOBS) return;
  const active = jobs.filter((job) => job.state === 'pending' || job.state === 'running').length;
  if (active >= MAX_UPLOAD_REVIEW_JOBS) {
    throw new UploadReviewError('UPLOAD_REVIEW_RETENTION_LIMIT', 'upload review queue retention limit is reached');
  }
}

function pruneCollections(jobs: UploadReviewJob[], results: UploadReviewResult[]): void {
  while (jobs.length > MAX_UPLOAD_REVIEW_JOBS) {
    const removable = jobs
      .filter((job) => job.state !== 'pending' && job.state !== 'running')
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))[0];
    if (!removable) throw new UploadReviewError('UPLOAD_REVIEW_RETENTION_LIMIT', 'upload review queue retention limit is reached');
    jobs.splice(jobs.indexOf(removable), 1);
    for (let index = results.length - 1; index >= 0; index -= 1) {
      if (results[index]?.jobId === removable.id) results.splice(index, 1);
    }
  }
  while (results.length > MAX_UPLOAD_REVIEW_RESULTS) {
    results.sort((left, right) => Date.parse(left.finishedAt) - Date.parse(right.finishedAt));
    results.shift();
  }
}

function findJob(jobs: readonly UploadReviewJob[], organizationId: string, jobId: string): UploadReviewJob {
  const job = jobs.find((candidate) => candidate.organizationId === organizationId && candidate.id === jobId);
  if (!job) throw new UploadReviewNotFoundError();
  return job;
}

function requireLease(job: UploadReviewJob, leaseToken: string, milliseconds: number): void {
  const cleanToken = boundedString(leaseToken, 'leaseToken', MAX_ID_LENGTH);
  if (job.state !== 'running' || !job.leaseToken || job.leaseToken !== cleanToken) {
    throw new UploadReviewLeaseError('UPLOAD_REVIEW_LEASE_FENCED', 'upload review lease is stale');
  }
  if (leaseExpired(job, milliseconds)) {
    throw new UploadReviewLeaseError('UPLOAD_REVIEW_LEASE_EXPIRED', 'upload review lease has expired');
  }
}

function validateFindings(
  findings: readonly UploadReviewFindingInput[],
  snapshot: UploadReviewSnapshot,
): UploadReviewFinding[] {
  if (!Array.isArray(findings)) throw new UploadReviewValidationError('findings must be an array');
  if (findings.length > MAX_UPLOAD_REVIEW_FINDINGS) {
    throw new UploadReviewValidationError('too many upload review findings');
  }
  const paths = new Set(snapshot.files.map((file) => file.path));
  return findings.map((finding, index) => {
    if (!isRecord(finding)) throw new UploadReviewValidationError('findings[' + index + '] must be an object');
    const severity = finding.severity;
    if (severity !== 'info' && severity !== 'low' && severity !== 'medium' && severity !== 'high' && severity !== 'critical') {
      throw new UploadReviewValidationError('findings[' + index + '].severity is invalid');
    }
    const path = finding.path === undefined ? undefined : boundedString(finding.path, 'findings[' + index + '].path', 4_096);
    if (path !== undefined && !paths.has(path)) {
      throw new UploadReviewValidationError('findings[' + index + '].path is outside the review snapshot');
    }
    const line = finding.line === undefined ? undefined : validateRevision(finding.line, 'findings[' + index + '].line');
    const evidence = finding.evidence === undefined
      ? undefined
      : boundedString(finding.evidence, 'findings[' + index + '].evidence', MAX_EVIDENCE_LENGTH);
    const recommendation = finding.recommendation === undefined
      ? undefined
      : boundedString(finding.recommendation, 'findings[' + index + '].recommendation', MAX_RECOMMENDATION_LENGTH);
    return {
      id: randomId('upload-review-finding'),
      severity,
      category: boundedString(finding.category, 'findings[' + index + '].category', MAX_CATEGORY_LENGTH),
      title: boundedString(finding.title, 'findings[' + index + '].title', MAX_TITLE_LENGTH),
      summary: boundedString(finding.summary, 'findings[' + index + '].summary', MAX_SUMMARY_LENGTH),
      ...(evidence === undefined ? {} : { evidence }),
      ...(recommendation === undefined ? {} : { recommendation }),
      ...(path === undefined ? {} : { path }),
      ...(line === undefined ? {} : { line }),
      decision: 'open',
    };
  });
}

function sameRequest(
  job: UploadReviewJob,
  input: Pick<EnqueueUploadReviewInput, 'binding' | 'snapshot' | 'model' | 'reviewerRevision'>,
): boolean {
  return (
    sameBinding(job.binding, input.binding) &&
    sameSnapshot(job.snapshot, input.snapshot) &&
    job.model === input.model &&
    job.reviewerRevision === input.reviewerRevision
  );
}

export class DefaultUploadReviewPersistenceService implements UploadReviewPersistenceService {
  constructor(
    private readonly repository: StateRepository,
    private readonly leaseSeconds = DEFAULT_UPLOAD_REVIEW_LEASE_SECONDS,
  ) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > 24 * 60 * 60) {
      throw new UploadReviewValidationError('leaseSeconds is outside the supported range');
    }
  }

  async enqueue(organizationId: string, input: EnqueueUploadReviewInput): Promise<UploadReviewJob> {
    assertOrganizationId(organizationId);
    const normalized = normalizeEnqueueInput(input);
    return this.repository.transaction(organizationId, (rawState) => {
      const { jobs, results } = writableCollections(rawState);
      const existing = jobs.find((job) => job.organizationId === organizationId && job.idempotencyKey === normalized.idempotencyKey);
      if (existing) {
        if (!sameRequest(existing, normalized)) {
          throw new UploadReviewConflictError('idempotencyKey was already used with different upload review input');
        }
        return clone(existing);
      }
      assertRetentionAvailable(jobs, 1);
      const job: UploadReviewJob = {
        id: randomId('upload-review-job'),
        organizationId,
        idempotencyKey: normalized.idempotencyKey,
        binding: normalized.binding,
        snapshot: normalized.snapshot,
        model: normalized.model,
        reviewerRevision: normalized.reviewerRevision,
        state: 'pending',
        createdAt: normalized.clock.iso,
        updatedAt: normalized.clock.iso,
      };
      jobs.push(job);
      pruneCollections(jobs, results);
      return clone(job);
    });
  }

  async bindEveSession(organizationId: string, jobId: string, eveSessionId: string, now?: ReviewNow): Promise<UploadReviewJob> {
    assertOrganizationId(organizationId);
    const cleanJobId = boundedString(jobId, 'jobId', MAX_ID_LENGTH);
    const cleanSessionId = boundedString(eveSessionId, 'eveSessionId', MAX_ID_LENGTH);
    const clock = parseClock(now);
    return this.repository.transaction(organizationId, (rawState) => {
      const { jobs } = writableCollections(rawState);
      const job = findJob(jobs, organizationId, cleanJobId);
      const duplicate = jobs.find((candidate) =>
        candidate.organizationId === organizationId &&
        candidate.id !== job.id &&
        candidate.eveSessionId === cleanSessionId,
      );
      if (duplicate) throw new UploadReviewConflictError('Eve session is already bound to another upload review');
      if (job.state !== 'pending' && job.state !== 'running') {
        throw new UploadReviewConflictError('only pending or running upload reviews may bind an Eve session');
      }
      if (job.eveSessionId !== undefined && job.eveSessionId !== cleanSessionId) {
        throw new UploadReviewConflictError('upload review is already bound to another Eve session');
      }
      job.eveSessionId = cleanSessionId;
      job.updatedAt = clock.iso;
      return clone(job);
    });
  }

  async claimForEveSession(
    organizationId: string,
    eveSessionId: string,
    options: { now?: ReviewNow } = {},
  ): Promise<UploadReviewClaim> {
    assertOrganizationId(organizationId);
    const cleanSessionId = boundedString(eveSessionId, 'eveSessionId', MAX_ID_LENGTH);
    const state = await this.repository.read(organizationId);
    const jobs = collections(state).jobs;
    const matches = jobs.filter((job) => job.organizationId === organizationId && job.eveSessionId === cleanSessionId);
    if (matches.length !== 1) throw new UploadReviewNotFoundError();
    return this.claim(organizationId, matches[0]!.id, { ...options, eveSessionId: cleanSessionId });
  }

  async claim(
    organizationId: string,
    jobId: string,
    options: { eveSessionId?: string; now?: ReviewNow } = {},
  ): Promise<UploadReviewClaim> {
    assertOrganizationId(organizationId);
    const cleanJobId = boundedString(jobId, 'jobId', MAX_ID_LENGTH);
    const eveSessionId = options.eveSessionId === undefined
      ? undefined
      : boundedString(options.eveSessionId, 'eveSessionId', MAX_ID_LENGTH);
    const clock = parseClock(options.now);
    return this.repository.transaction(organizationId, (rawState) => {
      const { jobs, results } = writableCollections(rawState);
      const job = findJob(jobs, organizationId, cleanJobId);
      if (job.state === 'passed' || job.state === 'failed' || job.state === 'stale') {
        return { job: clone(job), claimed: false };
      }
      if (job.state === 'running' && !leaseExpired(job, clock.milliseconds)) {
        return {
          job: clone(job),
          claimed: false,
          ...(eveSessionId !== undefined && job.eveSessionId === eveSessionId && job.leaseToken !== undefined
            ? { leaseToken: job.leaseToken }
            : {}),
        };
      }
      if (eveSessionId === undefined) delete job.eveSessionId;
      else job.eveSessionId = eveSessionId;
      job.state = 'running';
      job.startedAt = job.startedAt ?? clock.iso;
      job.updatedAt = clock.iso;
      job.leaseToken = randomId('upload-review-lease');
      job.leaseExpiresAt = new Date(clock.milliseconds + this.leaseSeconds * 1_000).toISOString();
      delete job.finishedAt;
      delete job.error;
      delete job.staleReason;
      pruneCollections(jobs, results);
      return { job: clone(job), claimed: true, leaseToken: job.leaseToken };
    });
  }

  async getLeasedJob(organizationId: string, jobId: string, leaseToken: string, now?: ReviewNow): Promise<UploadReviewJob> {
    assertOrganizationId(organizationId);
    const clock = parseClock(now);
    return this.repository.transaction(organizationId, (rawState) => {
      const { jobs } = writableCollections(rawState);
      const job = findJob(jobs, organizationId, boundedString(jobId, 'jobId', MAX_ID_LENGTH));
      requireLease(job, leaseToken, clock.milliseconds);
      return clone(job);
    });
  }

  async complete(
    organizationId: string,
    jobId: string,
    leaseToken: string,
    input: CompleteUploadReviewInput,
  ): Promise<UploadReviewResult> {
    assertOrganizationId(organizationId);
    const clock = parseClock(input.now);
    return this.repository.transaction(organizationId, (rawState) => {
      const { jobs, results } = writableCollections(rawState);
      const job = findJob(jobs, organizationId, boundedString(jobId, 'jobId', MAX_ID_LENGTH));
      requireLease(job, leaseToken, clock.milliseconds);
      const findings = validateFindings(input.findings, job.snapshot);
      const result: UploadReviewResult = {
        id: randomId('upload-review-result'),
        jobId: job.id,
        organizationId,
        binding: clone(job.binding),
        model: job.model,
        reviewerRevision: job.reviewerRevision,
        state: 'passed',
        findings,
        createdAt: clock.iso,
        finishedAt: clock.iso,
      };
      job.state = 'passed';
      job.updatedAt = clock.iso;
      job.finishedAt = clock.iso;
      job.resultId = result.id;
      clearLease(job);
      results.push(result);
      pruneCollections(jobs, results);
      return clone(result);
    });
  }

  async fail(
    organizationId: string,
    jobId: string,
    leaseToken: string,
    error: string,
    now?: ReviewNow,
  ): Promise<UploadReviewResult> {
    assertOrganizationId(organizationId);
    const clock = parseClock(now);
    return this.repository.transaction(organizationId, (rawState) => {
      const { jobs, results } = writableCollections(rawState);
      const job = findJob(jobs, organizationId, boundedString(jobId, 'jobId', MAX_ID_LENGTH));
      requireLease(job, leaseToken, clock.milliseconds);
      const result: UploadReviewResult = {
        id: randomId('upload-review-result'),
        jobId: job.id,
        organizationId,
        binding: clone(job.binding),
        model: job.model,
        reviewerRevision: job.reviewerRevision,
        state: 'failed',
        findings: [],
        createdAt: clock.iso,
        finishedAt: clock.iso,
        error: redactError(error),
      };
      job.state = 'failed';
      job.updatedAt = clock.iso;
      job.finishedAt = clock.iso;
      job.error = result.error;
      job.resultId = result.id;
      clearLease(job);
      results.push(result);
      pruneCollections(jobs, results);
      return clone(result);
    });
  }

  async markStale(organizationId: string, input: MarkUploadReviewStaleInput): Promise<UploadReviewJob[]> {
    assertOrganizationId(organizationId);
    const draftId = boundedString(input.draftId, 'draftId', MAX_ID_LENGTH);
    const current = validateBinding(input.current);
    const reviewerRevision = input.reviewerRevision === undefined
      ? undefined
      : boundedString(input.reviewerRevision, 'reviewerRevision', MAX_VERSION_LENGTH);
    const model = input.model === undefined ? undefined : boundedString(input.model, 'model', MAX_MODEL_LENGTH);
    const reason = boundedString(input.reason, 'reason', MAX_REASON_LENGTH);
    const clock = parseClock(input.now);
    return this.repository.transaction(organizationId, (rawState) => {
      const { jobs, results } = writableCollections(rawState);
      const changed: UploadReviewJob[] = [];
      for (const job of jobs) {
        if (job.organizationId !== organizationId || job.binding.draftId !== draftId) continue;
        const contractChanged = (reviewerRevision !== undefined && job.reviewerRevision !== reviewerRevision) ||
          (model !== undefined && job.model !== model);
        if (sameBinding(job.binding, current) && !contractChanged) continue;
        if (job.state === 'stale') continue;
        job.state = 'stale';
        job.updatedAt = clock.iso;
        job.finishedAt = clock.iso;
        job.staleReason = reason;
        clearLease(job);
        if (job.resultId) {
          const existing = results.find((result) => result.id === job.resultId);
          if (existing) {
            existing.state = 'stale';
            existing.staleReason = reason;
            existing.finishedAt = clock.iso;
          }
        } else {
          const result: UploadReviewResult = {
            id: randomId('upload-review-result'),
            jobId: job.id,
            organizationId,
            binding: clone(job.binding),
            model: job.model,
            reviewerRevision: job.reviewerRevision,
            state: 'stale',
            findings: [],
            createdAt: clock.iso,
            finishedAt: clock.iso,
            staleReason: reason,
          };
          job.resultId = result.id;
          results.push(result);
        }
        changed.push(clone(job));
      }
      pruneCollections(jobs, results);
      return changed;
    });
  }

  async requeue(organizationId: string, jobId: string, now?: ReviewNow, actor?: string): Promise<UploadReviewJob> {
    assertOrganizationId(organizationId);
    const cleanActor = actor === undefined ? undefined : boundedString(actor, 'actor', MAX_ID_LENGTH);
    const clock = parseClock(now);
    return this.repository.transaction(organizationId, (rawState) => {
      const { jobs, results } = writableCollections(rawState);
      const job = findJob(jobs, organizationId, boundedString(jobId, 'jobId', MAX_ID_LENGTH));
      if (job.state !== 'failed' && job.state !== 'stale') {
        throw new UploadReviewConflictError('only failed or stale upload reviews may be requeued');
      }
      job.state = 'pending';
      job.updatedAt = clock.iso;
      delete job.finishedAt;
      delete job.error;
      delete job.staleReason;
      delete job.resultId;
      delete job.eveSessionId;
      clearLease(job);
      if (cleanActor !== undefined) {
        rawState.audit.push({
          id: randomId('audit'),
          organizationId,
          subject: cleanActor,
          action: 'upload-review.rerun.requested',
          resourceId: job.id,
          createdAt: clock.iso,
        });
      }
      pruneCollections(jobs, results);
      return clone(job);
    });
  }

  async updateFindingDecision(
    organizationId: string,
    resultId: string,
    findingId: string,
    decision: UploadReviewFindingDecision,
    actor: string,
    nowOrOptions?: ReviewNow | { now?: ReviewNow; reason?: string },
  ): Promise<UploadReviewResult> {
    assertOrganizationId(organizationId);
    const cleanResultId = boundedString(resultId, 'resultId', MAX_ID_LENGTH);
    const cleanFindingId = boundedString(findingId, 'findingId', MAX_ID_LENGTH);
    const cleanActor = boundedString(actor, 'actor', MAX_ID_LENGTH);
    if (decision !== 'open' && decision !== 'acknowledged' && decision !== 'dismissed') {
      throw new UploadReviewValidationError('decision is invalid');
    }
    const options = nowOrOptions !== undefined && typeof nowOrOptions === 'object' && !(nowOrOptions instanceof Date)
      ? nowOrOptions
      : { now: nowOrOptions as ReviewNow | undefined };
    const reason = options.reason === undefined ? undefined : boundedString(options.reason, 'reason', MAX_REASON_LENGTH);
    if (decision === 'dismissed' && reason === undefined) {
      throw new UploadReviewValidationError('dismissed findings require a reason');
    }
    const clock = parseClock(options.now);
    return this.repository.transaction(organizationId, (rawState) => {
      const { results } = writableCollections(rawState);
      const result = results.find((candidate) => candidate.organizationId === organizationId && candidate.id === cleanResultId);
      if (!result) throw new UploadReviewNotFoundError('upload review result was not found');
      const finding = result.findings.find((candidate) => candidate.id === cleanFindingId);
      if (!finding) throw new UploadReviewNotFoundError('upload review finding was not found');
      finding.decision = decision;
      if (reason === undefined) delete finding.decisionReason;
      else finding.decisionReason = reason;
      rawState.audit.push({
        id: randomId('audit'),
        organizationId,
        subject: cleanActor,
        action: 'upload-review.finding.decision',
        resourceId: cleanResultId,
        createdAt: clock.iso,
        details: { findingId: cleanFindingId, decision, ...(reason === undefined ? {} : { reason }) },
      });
      return clone(result);
    });
  }

  async listJobs(organizationId: string, options: UploadReviewListOptions = {}): Promise<UploadReviewJob[]> {
    assertOrganizationId(organizationId);
    const limit = options.limit === undefined ? MAX_UPLOAD_REVIEW_JOBS : Math.min(
      validateRevision(options.limit, 'limit'),
      MAX_UPLOAD_REVIEW_JOBS,
    );
    return this.repository.read(organizationId).then((rawState) => {
      const { jobs } = collections(rawState);
      return jobs
        .filter((job) => job.organizationId === organizationId)
        .filter((job) => options.draftId === undefined || job.binding.draftId === options.draftId)
        .filter((job) => options.state === undefined || job.state === options.state)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, limit)
        .map(clone);
    });
  }

  async listResults(organizationId: string, options: UploadReviewListOptions = {}): Promise<UploadReviewResult[]> {
    assertOrganizationId(organizationId);
    const limit = options.limit === undefined ? MAX_UPLOAD_REVIEW_RESULTS : Math.min(
      validateRevision(options.limit, 'limit'),
      MAX_UPLOAD_REVIEW_RESULTS,
    );
    return this.repository.read(organizationId).then((rawState) => {
      const { results } = collections(rawState);
      return results
        .filter((result) => result.organizationId === organizationId)
        .filter((result) => options.draftId === undefined || result.binding.draftId === options.draftId)
        .filter((result) => options.state === undefined || result.state === options.state)
        .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt))
        .slice(0, limit)
        .map(clone);
    });
  }
}

export function createUploadReviewPersistenceService(
  repository: StateRepository,
  options: { leaseSeconds?: number } = {},
): UploadReviewPersistenceService {
  return new DefaultUploadReviewPersistenceService(repository, options.leaseSeconds);
}

export * from './http.js';
export * from './snapshot.js';
export * from './trigger.js';
