import type {
  RegistryState,
  SkillVersion,
  StateRepository,
} from '../../contracts/src/index.js';

/** The maximum number of candidates a review run can snapshot. */
export const MAX_REVIEW_CANDIDATES = 60;
/** The maximum number of proposals accepted in one completion. */
export const MAX_REVIEW_PROPOSALS = 60;
/** The maximum number of retained runs in one organization's state row. */
export const MAX_RETAINED_REVIEW_RUNS = 100;
/** The maximum number of retained suggestions in one organization's state row. */
export const MAX_RETAINED_REVIEW_SUGGESTIONS = 6_000;
/** The default lease duration used to fence duplicate workers. */
export const DEFAULT_REVIEW_LEASE_SECONDS = 15 * 60;

const MAX_ORGANIZATION_LENGTH = 256;
const MAX_ID_LENGTH = 256;
const MAX_MODEL_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_VERSION_LENGTH = 128;
const MAX_KEY_LENGTH = 256;
const MAX_TITLE_LENGTH = 256;
// Five bounded text fields times 60 proposals stays below the repository
// HTTP adapter's default 2 MiB request limit, even before compression.
const MAX_TEXT_LENGTH = 4_000;
const MAX_ERROR_LENGTH = 1_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type ReviewRunState = 'running' | 'completed' | 'failed';
export type ReviewSuggestionState = 'open' | 'accepted' | 'dismissed';
export type ReviewSuggestionDecision = Exclude<ReviewSuggestionState, 'open'>;
export type ReviewNow = Date | string | number;

export interface ReviewSkillSnapshot {
  resourceId: string;
  name: string;
  version: string;
  artifactDigest: `sha256:${string}`;
}

export interface ReviewRun {
  id: string;
  organizationId: string;
  idempotencyKey: string;
  day: string;
  model: string;
  /** Opaque Eve session ID that causally initiated the prepare call, when available. */
  eveSessionId?: string;
  state: ReviewRunState;
  snapshot: ReviewSkillSnapshot[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
  /** Present while a run is leased. It is cleared after a terminal transition. */
  leaseToken?: string;
  /** Present while a run is leased. It is cleared after a terminal transition. */
  leaseExpiresAt?: string;
}

export interface ReviewSuggestionProposal {
  /** Resource identities selected from the run snapshot. */
  resourceIds: readonly string[];
  title: string;
  rationale: string;
  overlap: string;
  differences: string;
  mergePlan: string;
  similarity: number;
  /**
   * An optional echo of the model's identity metadata. When supplied, every
   * entry must match the run snapshot exactly. The service stores its own
   * server-owned snapshot regardless of this optional field.
   */
  snapshot?: readonly ReviewSkillSnapshot[];
}

/** Alias used by integrations that call the persisted records proposals. */
export type ReviewProposal = ReviewSuggestionProposal;

export interface ReviewSuggestion {
  id: string;
  organizationId: string;
  runId: string;
  resourceIds: string[];
  snapshot: ReviewSkillSnapshot[];
  title: string;
  rationale: string;
  overlap: string;
  differences: string;
  mergePlan: string;
  similarity: number;
  state: ReviewSuggestionState;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface BeginReviewRunInput {
  /** The scheduler-facing key. `idempotencyKey` is accepted as a compatibility alias. */
  key?: string;
  idempotencyKey?: string;
  model: string;
  snapshot: readonly ReviewSkillSnapshot[];
  /** Opaque Eve session ID used to correlate a scheduled invocation with its run. */
  eveSessionId?: string;
  now?: ReviewNow;
}

export interface ReviewRunClaim {
  run: ReviewRun;
  /** True only when this call received a new lease and may process the run. */
  claimed: boolean;
  /** Convenience copy for a newly claimed run; absent for an idempotent read. */
  leaseToken?: string;
}

export interface ReviewCompletion {
  run: ReviewRun;
  suggestions: ReviewSuggestion[];
}

export interface ReviewListOptions {
  limit?: number;
  state?: ReviewRunState;
}

export interface ReviewSuggestionListOptions {
  limit?: number;
  state?: ReviewSuggestionState;
  runId?: string;
}

export interface ReviewPersistenceOptions {
  leaseSeconds?: number;
  maxRuns?: number;
  maxSuggestions?: number;
  maxProposalsPerRun?: number;
}

export interface ReviewPersistenceService {
  beginRun(organizationId: string, input: BeginReviewRunInput): Promise<ReviewRunClaim>;
  completeRun(
    organizationId: string,
    runId: string,
    leaseToken: string,
    proposals: readonly ReviewSuggestionProposal[],
    now?: ReviewNow,
  ): Promise<ReviewCompletion>;
  failRun(
    organizationId: string,
    runId: string,
    leaseToken: string,
    error: string,
    now?: ReviewNow,
  ): Promise<ReviewRun>;
  decideSuggestion(
    organizationId: string,
    suggestionId: string,
    decision: ReviewSuggestionDecision,
    subject: string,
    now?: ReviewNow,
  ): Promise<ReviewSuggestion>;
  listRuns(organizationId: string, options?: ReviewListOptions): Promise<ReviewRun[]>;
  listSuggestions(
    organizationId: string,
    options?: ReviewSuggestionListOptions,
  ): Promise<ReviewSuggestion[]>;
}

export type ReviewErrorCode =
  | 'INVALID_REVIEW_INPUT'
  | 'REVIEW_STATE_INVALID'
  | 'REVIEW_NOT_FOUND'
  | 'REVIEW_CONFLICT'
  | 'REVIEW_LEASE_FENCED'
  | 'REVIEW_LEASE_EXPIRED'
  | 'REVIEW_RUN_NOT_RUNNING'
  | 'REVIEW_DECISION_CONFLICT'
  | 'REVIEW_RETENTION_LIMIT';

export class ReviewServiceError extends Error {
  readonly code: ReviewErrorCode;

  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.name = 'ReviewServiceError';
    this.code = code;
  }
}

export class ReviewValidationError extends ReviewServiceError {
  constructor(message: string) {
    super('INVALID_REVIEW_INPUT', message);
    this.name = 'ReviewValidationError';
  }
}

export class ReviewStateError extends ReviewServiceError {
  constructor(message: string) {
    super('REVIEW_STATE_INVALID', message);
    this.name = 'ReviewStateError';
  }
}

export class ReviewNotFoundError extends ReviewServiceError {
  constructor(message = 'Review record was not found') {
    super('REVIEW_NOT_FOUND', message);
    this.name = 'ReviewNotFoundError';
  }
}

export class ReviewConflictError extends ReviewServiceError {
  constructor(message: string) {
    super('REVIEW_CONFLICT', message);
    this.name = 'ReviewConflictError';
  }
}

export class ReviewLeaseError extends ReviewServiceError {
  constructor(code: 'REVIEW_LEASE_FENCED' | 'REVIEW_LEASE_EXPIRED' | 'REVIEW_RUN_NOT_RUNNING', message: string) {
    super(code, message);
    this.name = 'ReviewLeaseError';
  }
}

export class ReviewDecisionConflictError extends ReviewServiceError {
  constructor(message: string) {
    super('REVIEW_DECISION_CONFLICT', message);
    this.name = 'ReviewDecisionConflictError';
  }
}

export interface ReviewStateExtension {
  reviewRuns?: ReviewRun[];
  reviewSuggestions?: ReviewSuggestion[];
}

export type ReviewRegistryState = RegistryState & ReviewStateExtension;

interface ReviewClock {
  milliseconds: number;
  iso: string;
  day: string;
}

interface NormalizedOptions {
  leaseSeconds: number;
  maxRuns: number;
  maxSuggestions: number;
  maxProposalsPerRun: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw new ReviewStateError('Review state is not JSON serializable');
  }
}

function assertOrganizationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ORGANIZATION_LENGTH) {
    throw new ReviewValidationError('organizationId must be a non-empty bounded string');
  }
}

function boundedString(
  value: unknown,
  field: string,
  maximum: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new ReviewValidationError(`${field} must be a string`);
  }
  const result = value.trim();
  if (!options.allowEmpty && result.length === 0) {
    throw new ReviewValidationError(`${field} must not be empty`);
  }
  if (result.length > maximum) {
    throw new ReviewValidationError(`${field} exceeds the maximum length`);
  }
  return result;
}

function parseClock(value: ReviewNow | undefined): ReviewClock {
  let milliseconds: number;
  if (value === undefined) {
    milliseconds = Date.now();
  } else if (value instanceof Date) {
    milliseconds = value.getTime();
  } else if (typeof value === 'number') {
    milliseconds = value;
  } else if (typeof value === 'string') {
    milliseconds = Date.parse(value);
  } else {
    throw new ReviewValidationError('now must be a Date, timestamp, or date string');
  }
  if (!Number.isFinite(milliseconds)) {
    throw new ReviewValidationError('now must be a valid time');
  }
  const date = new Date(milliseconds);
  return {
    milliseconds,
    iso: date.toISOString(),
    day: date.toISOString().slice(0, 10),
  };
}

function validateDigest(value: unknown, field: string): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ReviewValidationError(`${field} must be a lowercase sha256 digest`);
  }
  return value as `sha256:${string}`;
}

function validateSnapshotShape(value: unknown): ReviewSkillSnapshot[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REVIEW_CANDIDATES) {
    throw new ReviewValidationError(`snapshot must contain between 1 and ${MAX_REVIEW_CANDIDATES} candidates`);
  }
  const seen = new Set<string>();
  const result = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ReviewValidationError(`snapshot[${index}] must be an object`);
    }
    const resourceId = boundedString(entry.resourceId, `snapshot[${index}].resourceId`, MAX_ID_LENGTH);
    if (seen.has(resourceId)) {
      throw new ReviewValidationError('snapshot contains duplicate resource IDs');
    }
    seen.add(resourceId);
    return {
      resourceId,
      name: boundedString(entry.name, `snapshot[${index}].name`, MAX_NAME_LENGTH),
      version: boundedString(entry.version, `snapshot[${index}].version`, MAX_VERSION_LENGTH),
      artifactDigest: validateDigest(entry.artifactDigest, `snapshot[${index}].artifactDigest`),
    };
  });
  return result.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function normalizeBeginInput(input: BeginReviewRunInput): {
  idempotencyKey: string;
  model: string;
  snapshot: ReviewSkillSnapshot[];
  eveSessionId?: string;
  clock: ReviewClock;
} {
  if (!isRecord(input)) {
    throw new ReviewValidationError('beginRun input must be an object');
  }
  const key = input.key ?? input.idempotencyKey;
  if (input.key !== undefined && input.idempotencyKey !== undefined && input.key !== input.idempotencyKey) {
    throw new ReviewValidationError('key and idempotencyKey must match when both are supplied');
  }
  return {
    idempotencyKey: boundedString(key, 'key', MAX_KEY_LENGTH),
    model: boundedString(input.model, 'model', MAX_MODEL_LENGTH),
    snapshot: validateSnapshotShape(input.snapshot),
    ...(input.eveSessionId === undefined
      ? {}
      : { eveSessionId: boundedOpaqueId(input.eveSessionId, 'eveSessionId', MAX_ID_LENGTH) }),
    clock: parseClock(input.now as ReviewNow | undefined),
  };
}

function boundedOpaqueId(value: unknown, field: string, maximum: number): string {
  const result = boundedString(value, field, maximum);
  if (/[\u0000-\u001f\u007f]/u.test(result)) {
    throw new ReviewValidationError(`${field} contains invalid characters`);
  }
  return result;
}

function randomId(prefix: string): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.randomUUID) {
    return `${prefix}_${webCrypto.randomUUID()}`;
  }
  if (!webCrypto?.getRandomValues) {
    throw new ReviewServiceError('REVIEW_STATE_INVALID', 'A WebCrypto random source is required');
  }
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return `${prefix}_${value}`;
}

function sameSnapshot(left: readonly ReviewSkillSnapshot[], right: readonly ReviewSkillSnapshot[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        item.resourceId === other.resourceId &&
        item.name === other.name &&
        item.version === other.version &&
        item.artifactDigest === other.artifactDigest
      );
    })
  );
}

function sameRequest(run: ReviewRun, model: string, snapshot: readonly ReviewSkillSnapshot[]): boolean {
  return run.model === model && sameSnapshot(run.snapshot, snapshot);
}

function readCollections(state: RegistryState): {
  runs: ReviewRun[];
  suggestions: ReviewSuggestion[];
} {
  const extension = state as ReviewRegistryState;
  if (extension.reviewRuns !== undefined && !Array.isArray(extension.reviewRuns)) {
    throw new ReviewStateError('reviewRuns is not an array');
  }
  if (extension.reviewSuggestions !== undefined && !Array.isArray(extension.reviewSuggestions)) {
    throw new ReviewStateError('reviewSuggestions is not an array');
  }
  return {
    runs: extension.reviewRuns ?? [],
    suggestions: extension.reviewSuggestions ?? [],
  };
}

function writableCollections(state: RegistryState): {
  runs: ReviewRun[];
  suggestions: ReviewSuggestion[];
} {
  const extension = state as ReviewRegistryState;
  const collections = readCollections(state);
  extension.reviewRuns = collections.runs;
  extension.reviewSuggestions = collections.suggestions;
  return collections;
}

function findSkill(state: RegistryState, organizationId: string, resourceId: string): SkillVersion | undefined {
  return state.skills.find(
    (skill) => skill.organizationId === organizationId && skill.id === resourceId,
  );
}

function validateSnapshotAgainstState(
  state: RegistryState,
  organizationId: string,
  snapshot: readonly ReviewSkillSnapshot[],
): ReviewSkillSnapshot[] {
  return snapshot.map((candidate) => {
    const skill = findSkill(state, organizationId, candidate.resourceId);
    if (!skill) {
      // The HTTP/runtime boundary normally constructs snapshots from the
      // current approved view. Keep the persistence service usable with a
      // server-owned snapshot when a legacy state row has no skill metadata,
      // while still rejecting a resource that is visibly owned by another org.
      if (state.skills.some((entry) => entry.id === candidate.resourceId)) {
        throw new ReviewValidationError(`snapshot resource ${candidate.resourceId} is not in this organization`);
      }
      return { ...candidate };
    }
    if (
      skill.name !== candidate.name ||
      skill.version !== candidate.version ||
      skill.artifact.digest !== candidate.artifactDigest
    ) {
      throw new ReviewValidationError(`snapshot resource ${candidate.resourceId} does not match its current digest`);
    }
    return {
      resourceId: skill.id,
      name: skill.name,
      version: skill.version,
      artifactDigest: skill.artifact.digest,
    };
  });
}

function leaseIsExpired(run: ReviewRun, milliseconds: number): boolean {
  if (!run.leaseToken || !run.leaseExpiresAt) return true;
  const expiry = Date.parse(run.leaseExpiresAt);
  return !Number.isFinite(expiry) || expiry <= milliseconds;
}

function clearLease(run: ReviewRun): void {
  delete run.leaseToken;
  delete run.leaseExpiresAt;
}

function sanitizedError(value: unknown): string {
  const raw = boundedString(value, 'error', MAX_ERROR_LENGTH, { allowEmpty: false });
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bAuthorization\s*:\s*[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/\b(?:token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:token|secret|password|credential)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .slice(0, MAX_ERROR_LENGTH);
}

function validateLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewValidationError('limit must be a positive integer');
  }
  return Math.min(value, maximum);
}

function sortNewest<T extends { createdAt: string }>(records: readonly T[]): T[] {
  return [...records].sort((left, right) => {
    const difference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return Number.isFinite(difference) && difference !== 0
      ? difference
      : right.createdAt.localeCompare(left.createdAt);
  });
}

function pruneRetention(state: ReviewRegistryState, options: NormalizedOptions): void {
  const terminalRuns = () =>
    state.reviewRuns!
      .filter((run) => run.state !== 'running')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  while (state.reviewRuns!.length > options.maxRuns) {
    const removable = terminalRuns()[0];
    if (!removable) break;
    state.reviewRuns = state.reviewRuns!.filter((run) => run.id !== removable.id);
    state.reviewSuggestions = state.reviewSuggestions!.filter((suggestion) => suggestion.runId !== removable.id);
  }

  while (state.reviewSuggestions!.length > options.maxSuggestions) {
    const removable = [...state.reviewSuggestions!]
      .filter((suggestion) => suggestion.state !== 'open')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!removable) break;
    state.reviewSuggestions = state.reviewSuggestions!.filter((suggestion) => suggestion.id !== removable.id);
  }
}

function assertRetentionAvailable(
  state: ReviewRegistryState,
  options: NormalizedOptions,
  additionalRuns = 0,
  additionalSuggestions = 0,
): void {
  pruneRetention(state, options);
  const activeRuns = state.reviewRuns!.filter((run) => run.state === 'running').length;
  if (state.reviewRuns!.length + additionalRuns > options.maxRuns && activeRuns >= options.maxRuns) {
    throw new ReviewServiceError('REVIEW_RETENTION_LIMIT', 'review run retention limit is reached');
  }
  if (state.reviewSuggestions!.length + additionalSuggestions > options.maxSuggestions) {
    const terminalSuggestions = state.reviewSuggestions!.filter((suggestion) => suggestion.state !== 'open').length;
    if (state.reviewSuggestions!.length - terminalSuggestions + additionalSuggestions > options.maxSuggestions) {
      throw new ReviewServiceError('REVIEW_RETENTION_LIMIT', 'review suggestion retention limit is reached');
    }
  }
}

function normalizeOptions(options: ReviewPersistenceOptions): NormalizedOptions {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_REVIEW_LEASE_SECONDS;
  const maxRuns = options.maxRuns ?? MAX_RETAINED_REVIEW_RUNS;
  const maxSuggestions = options.maxSuggestions ?? MAX_RETAINED_REVIEW_SUGGESTIONS;
  const maxProposalsPerRun = options.maxProposalsPerRun ?? MAX_REVIEW_PROPOSALS;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > 7 * 24 * 60 * 60) {
    throw new ReviewValidationError('leaseSeconds is outside the supported range');
  }
  if (!Number.isSafeInteger(maxRuns) || maxRuns <= 0 || maxRuns > MAX_RETAINED_REVIEW_RUNS) {
    throw new ReviewValidationError('maxRuns is outside the supported range');
  }
  if (!Number.isSafeInteger(maxSuggestions) || maxSuggestions <= 0 || maxSuggestions > MAX_RETAINED_REVIEW_SUGGESTIONS) {
    throw new ReviewValidationError('maxSuggestions is outside the supported range');
  }
  if (!Number.isSafeInteger(maxProposalsPerRun) || maxProposalsPerRun <= 0 || maxProposalsPerRun > MAX_REVIEW_PROPOSALS) {
    throw new ReviewValidationError('maxProposalsPerRun is outside the supported range');
  }
  return { leaseSeconds, maxRuns, maxSuggestions, maxProposalsPerRun };
}

function validateProposal(
  proposal: ReviewSuggestionProposal,
  runSnapshot: readonly ReviewSkillSnapshot[],
  seenGroups: Set<string>,
): { resourceIds: string[]; snapshot: ReviewSkillSnapshot[]; title: string; rationale: string; overlap: string; differences: string; mergePlan: string; similarity: number } {
  if (!isRecord(proposal)) {
    throw new ReviewValidationError('review proposal must be an object');
  }
  if (!Array.isArray(proposal.resourceIds) || proposal.resourceIds.length < 2 || proposal.resourceIds.length > MAX_REVIEW_CANDIDATES) {
    throw new ReviewValidationError('each proposal must contain between 2 and 60 resource IDs');
  }
  const ids = proposal.resourceIds.map((value, index) => boundedString(value, `proposal.resourceIds[${index}]`, MAX_ID_LENGTH));
  if (new Set(ids).size !== ids.length) {
    throw new ReviewValidationError('a proposal must contain distinct resource IDs');
  }
  const byId = new Map(runSnapshot.map((entry) => [entry.resourceId, entry]));
  const selected = ids.map((resourceId) => {
    const candidate = byId.get(resourceId);
    if (!candidate) {
      throw new ReviewValidationError(`proposal references resource ${resourceId} outside its run snapshot`);
    }
    return candidate;
  });
  const canonicalIds = [...ids].sort();
  const groupKey = canonicalIds.join('\u0000');
  if (seenGroups.has(groupKey)) {
    throw new ReviewValidationError('duplicate proposal resource groups are not allowed');
  }
  seenGroups.add(groupKey);

  if (proposal.snapshot !== undefined) {
    const echoed = validateSnapshotShape(proposal.snapshot);
    if (!sameSnapshot(echoed, [...selected].sort((left, right) => left.resourceId.localeCompare(right.resourceId)))) {
      throw new ReviewValidationError('proposal snapshot metadata does not match the run snapshot');
    }
  }
  if (typeof proposal.similarity !== 'number' || !Number.isFinite(proposal.similarity) || proposal.similarity < 0 || proposal.similarity > 1) {
    throw new ReviewValidationError('proposal similarity must be a finite number from 0 to 1');
  }
  return {
    resourceIds: canonicalIds,
    snapshot: [...selected].sort((left, right) => left.resourceId.localeCompare(right.resourceId)).map((entry) => ({ ...entry })),
    title: boundedString(proposal.title, 'proposal.title', MAX_TITLE_LENGTH),
    rationale: boundedString(proposal.rationale, 'proposal.rationale', MAX_TEXT_LENGTH),
    overlap: boundedString(proposal.overlap, 'proposal.overlap', MAX_TEXT_LENGTH),
    differences: boundedString(proposal.differences, 'proposal.differences', MAX_TEXT_LENGTH),
    mergePlan: boundedString(proposal.mergePlan, 'proposal.mergePlan', MAX_TEXT_LENGTH),
    similarity: proposal.similarity,
  };
}

export class DefaultReviewPersistenceService implements ReviewPersistenceService {
  private readonly options: NormalizedOptions;

  constructor(
    private readonly repository: StateRepository,
    options: ReviewPersistenceOptions = {},
  ) {
    this.options = normalizeOptions(options);
  }

  async beginRun(organizationId: string, input: BeginReviewRunInput): Promise<ReviewRunClaim> {
    assertOrganizationId(organizationId);
    const normalized = normalizeBeginInput(input);
    return this.repository.transaction(organizationId, (rawState) => {
      const state = rawState as ReviewRegistryState;
      const collections = writableCollections(rawState);
      const existing = collections.runs.find(
        (run) => run.organizationId === organizationId && run.idempotencyKey === normalized.idempotencyKey && run.day === normalized.clock.day,
      );
      if (existing) {
        if (!sameRequest(existing, normalized.model, normalized.snapshot)) {
          throw new ReviewConflictError('idempotencyKey was already used with different review input');
        }
        if (existing.state === 'completed') {
          return { run: clone(existing), claimed: false };
        }
        if (existing.state === 'running' && !leaseIsExpired(existing, normalized.clock.milliseconds)) {
          return { run: clone(existing), claimed: false };
        }
        if (normalized.eveSessionId !== undefined) {
          // A retry after a failed or expired lease is owned by the new Eve
          // session. Keep the run join pointed at its current claimant.
          existing.eveSessionId = normalized.eveSessionId;
        }
        existing.state = 'running';
        existing.leaseToken = randomId('review-lease');
        existing.leaseExpiresAt = new Date(
          normalized.clock.milliseconds + this.options.leaseSeconds * 1_000,
        ).toISOString();
        delete existing.finishedAt;
        delete existing.error;
        pruneRetention(state, this.options);
        return { run: clone(existing), claimed: true, leaseToken: existing.leaseToken };
      }

      assertRetentionAvailable(state, this.options, 1);
      const snapshot = validateSnapshotAgainstState(rawState, organizationId, normalized.snapshot);
      const run: ReviewRun = {
        id: randomId('review-run'),
        organizationId,
        idempotencyKey: normalized.idempotencyKey,
        day: normalized.clock.day,
        model: normalized.model,
        ...(normalized.eveSessionId === undefined ? {} : { eveSessionId: normalized.eveSessionId }),
        state: 'running',
        snapshot,
        createdAt: normalized.clock.iso,
        leaseToken: randomId('review-lease'),
        leaseExpiresAt: new Date(
          normalized.clock.milliseconds + this.options.leaseSeconds * 1_000,
        ).toISOString(),
      };
      collections.runs.push(run);
      pruneRetention(state, this.options);
      return { run: clone(run), claimed: true, leaseToken: run.leaseToken };
    });
  }

  async completeRun(
    organizationId: string,
    runId: string,
    leaseToken: string,
    proposals: readonly ReviewSuggestionProposal[],
    now?: ReviewNow,
  ): Promise<ReviewCompletion> {
    assertOrganizationId(organizationId);
    const cleanRunId = boundedString(runId, 'runId', MAX_ID_LENGTH);
    const cleanLease = boundedString(leaseToken, 'leaseToken', MAX_ID_LENGTH);
    const clock = parseClock(now);
    if (!Array.isArray(proposals)) {
      throw new ReviewValidationError('proposals must be an array');
    }
    if (proposals.length > this.options.maxProposalsPerRun) {
      throw new ReviewValidationError(`a run accepts at most ${this.options.maxProposalsPerRun} proposals`);
    }
    return this.repository.transaction(organizationId, (rawState) => {
      const state = rawState as ReviewRegistryState;
      const collections = writableCollections(rawState);
      const run = collections.runs.find((candidate) => candidate.organizationId === organizationId && candidate.id === cleanRunId);
      if (!run) throw new ReviewNotFoundError('review run was not found');
      this.requireLease(run, cleanLease, clock.milliseconds);
      const validated = [] as ReturnType<typeof validateProposal>[];
      const seenGroups = new Set<string>();
      for (const proposal of proposals) {
        validated.push(validateProposal(proposal, run.snapshot, seenGroups));
      }
      assertRetentionAvailable(state, this.options, 0, validated.length);
      const suggestions = validated.map((proposal) => ({
        id: randomId('review-suggestion'),
        organizationId,
        runId: run.id,
        resourceIds: proposal.resourceIds,
        snapshot: proposal.snapshot,
        title: proposal.title,
        rationale: proposal.rationale,
        overlap: proposal.overlap,
        differences: proposal.differences,
        mergePlan: proposal.mergePlan,
        similarity: proposal.similarity,
        state: 'open' as const,
        createdAt: clock.iso,
      }));
      collections.suggestions.push(...suggestions);
      run.state = 'completed';
      run.finishedAt = clock.iso;
      clearLease(run);
      pruneRetention(state, this.options);
      return { run: clone(run), suggestions: clone(suggestions) };
    });
  }

  async failRun(
    organizationId: string,
    runId: string,
    leaseToken: string,
    error: string,
    now?: ReviewNow,
  ): Promise<ReviewRun> {
    assertOrganizationId(organizationId);
    const cleanRunId = boundedString(runId, 'runId', MAX_ID_LENGTH);
    const cleanLease = boundedString(leaseToken, 'leaseToken', MAX_ID_LENGTH);
    const cleanError = sanitizedError(error);
    const clock = parseClock(now);
    return this.repository.transaction(organizationId, (rawState) => {
      const state = rawState as ReviewRegistryState;
      const collections = writableCollections(rawState);
      const run = collections.runs.find((candidate) => candidate.organizationId === organizationId && candidate.id === cleanRunId);
      if (!run) throw new ReviewNotFoundError('review run was not found');
      this.requireLease(run, cleanLease, clock.milliseconds);
      run.state = 'failed';
      run.finishedAt = clock.iso;
      run.error = cleanError;
      clearLease(run);
      pruneRetention(state, this.options);
      return clone(run);
    });
  }

  async decideSuggestion(
    organizationId: string,
    suggestionId: string,
    decision: ReviewSuggestionDecision,
    subject: string,
    now?: ReviewNow,
  ): Promise<ReviewSuggestion> {
    assertOrganizationId(organizationId);
    const cleanSuggestionId = boundedString(suggestionId, 'suggestionId', MAX_ID_LENGTH);
    if (decision !== 'accepted' && decision !== 'dismissed') {
      throw new ReviewValidationError('decision must be accepted or dismissed');
    }
    const cleanSubject = boundedString(subject, 'subject', MAX_ID_LENGTH);
    const clock = parseClock(now);
    return this.repository.transaction(organizationId, (rawState) => {
      const state = rawState as ReviewRegistryState;
      const collections = writableCollections(rawState);
      const suggestion = collections.suggestions.find(
        (candidate) => candidate.organizationId === organizationId && candidate.id === cleanSuggestionId,
      );
      if (!suggestion) throw new ReviewNotFoundError('review suggestion was not found');
      if (suggestion.state !== 'open') {
        if (suggestion.state === decision) return clone(suggestion);
        throw new ReviewDecisionConflictError('review suggestion already has a different decision');
      }
      suggestion.state = decision;
      suggestion.decidedAt = clock.iso;
      suggestion.decidedBy = cleanSubject;
      pruneRetention(state, this.options);
      return clone(suggestion);
    });
  }

  async listRuns(organizationId: string, options: ReviewListOptions = {}): Promise<ReviewRun[]> {
    assertOrganizationId(organizationId);
    const limit = validateLimit(options.limit, 100, this.options.maxRuns);
    if (options.state !== undefined && !['running', 'completed', 'failed'].includes(options.state)) {
      throw new ReviewValidationError('invalid review run state filter');
    }
    const state = await this.repository.read(organizationId);
    const collections = readCollections(state);
    return clone(
      sortNewest(collections.runs.filter((run) => run.organizationId === organizationId && (options.state === undefined || run.state === options.state))).slice(0, limit),
    );
  }

  async listSuggestions(
    organizationId: string,
    options: ReviewSuggestionListOptions = {},
  ): Promise<ReviewSuggestion[]> {
    assertOrganizationId(organizationId);
    const limit = validateLimit(options.limit, 100, this.options.maxSuggestions);
    if (options.state !== undefined && !['open', 'accepted', 'dismissed'].includes(options.state)) {
      throw new ReviewValidationError('invalid review suggestion state filter');
    }
    const runId = options.runId === undefined ? undefined : boundedString(options.runId, 'runId', MAX_ID_LENGTH);
    const state = await this.repository.read(organizationId);
    const collections = readCollections(state);
    return clone(
      sortNewest(
        collections.suggestions.filter(
          (suggestion) =>
            suggestion.organizationId === organizationId &&
            (options.state === undefined || suggestion.state === options.state) &&
            (runId === undefined || suggestion.runId === runId),
        ),
      ).slice(0, limit),
    );
  }

  private requireLease(run: ReviewRun, leaseToken: string, milliseconds: number): void {
    if (run.state !== 'running') {
      throw new ReviewLeaseError('REVIEW_RUN_NOT_RUNNING', 'review run is no longer running');
    }
    if (!run.leaseToken || run.leaseToken !== leaseToken) {
      throw new ReviewLeaseError('REVIEW_LEASE_FENCED', 'review lease token is stale');
    }
    if (leaseIsExpired(run, milliseconds)) {
      throw new ReviewLeaseError('REVIEW_LEASE_EXPIRED', 'review lease has expired');
    }
  }
}

/** Constructor alias for callers that use the interface's descriptive name. */
export const ReviewPersistenceService = DefaultReviewPersistenceService;

/** Explicit factory for applications that prefer construction by function. */
export function createReviewPersistenceService(
  repository: StateRepository,
  options: ReviewPersistenceOptions = {},
): ReviewPersistenceService {
  return new DefaultReviewPersistenceService(repository, options);
}

/** Short alias for runtime composition. */
export const createReviewService = createReviewPersistenceService;
