import type { Digest, StateRepository } from '../../contracts/src/index';

/** The largest embedding accepted by the built-in adapters. */
export const MAX_EMBEDDING_DIMENSIONS = 2_000;

/** The default profile used when an application does not configure one. */
export const DEFAULT_EMBEDDING_PROFILE: EmbeddingProfile = {
  id: 'default',
  model: 'unspecified',
  dimensions: 1_536,
};

/** A stable model identity and its output shape. */
export interface EmbeddingProfile {
  id: string;
  model: string;
  dimensions: number;
}

/** A document that is safe for the caller to put into a semantic index.
 *
 * The application is responsible for deciding whether a document is approved
 * and readable before passing it here.  The adapters deliberately do not
 * fetch or infer authorization from a document's text.
 */
export interface SearchDocument {
  organizationId: string;
  resourceId: string;
  artifactDigest: Digest;
  contentDigest: Digest;
  text: string;
  vector: number[];
  profileId: string;
  indexedAt: string;
}

export interface SearchQuery {
  organizationId: string;
  allowedResourceIds: string[];
  profileId: string;
  vector: number[];
  limit: number;
}

export interface SearchHit {
  resourceId: string;
  artifactDigest: Digest;
  contentDigest: Digest;
  score: number;
}

export interface SearchHealth {
  status: 'ok' | 'degraded';
  provider: string;
  error?: string;
}

export interface SemanticIndex {
  upsert(documents: readonly SearchDocument[]): Promise<void>;
  search(query: SearchQuery): Promise<readonly SearchHit[]>;
  remove(organizationId: string, resourceIds: readonly string[]): Promise<void>;
  health(): Promise<SearchHealth>;
}

export interface SearchProfileOptions {
  /** Profiles accepted by this index. Unknown profile ids are rejected. */
  profiles?: readonly EmbeddingProfile[];
  /** Convenience form for callers with one profile. */
  profile?: EmbeddingProfile;
}

export interface StateSemanticIndexOptions extends SearchProfileOptions {
  repository: StateRepository;
}

export class SearchValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SearchValidationError';
    this.code = code;
  }
}

export function configuredProfiles(options: SearchProfileOptions = {}): ReadonlyMap<string, EmbeddingProfile> {
  const supplied = options.profiles ?? (options.profile ? [options.profile] : [DEFAULT_EMBEDDING_PROFILE]);
  if (supplied.length === 0) throw new SearchValidationError('PROFILE_REQUIRED', 'At least one embedding profile is required');
  const result = new Map<string, EmbeddingProfile>();
  for (const profile of supplied) {
    validateProfile(profile);
    if (result.has(profile.id)) throw new SearchValidationError('PROFILE_DUPLICATE', `Embedding profile ${profile.id} is duplicated`);
    result.set(profile.id, { ...profile });
  }
  return result;
}

export function validateProfile(profile: EmbeddingProfile): void {
  if (!profile || typeof profile !== 'object') throw new SearchValidationError('PROFILE_INVALID', 'Embedding profile is required');
  if (!nonEmptyBounded(profile.id, 128) || !nonEmptyBounded(profile.model, 512)) {
    throw new SearchValidationError('PROFILE_INVALID', 'Embedding profile id and model must be non-empty strings');
  }
  if (!Number.isSafeInteger(profile.dimensions) || profile.dimensions < 1 || profile.dimensions > MAX_EMBEDDING_DIMENSIONS) {
    throw new SearchValidationError('PROFILE_DIMENSIONS', `Embedding dimensions must be an integer between 1 and ${MAX_EMBEDDING_DIMENSIONS}`);
  }
}

export function profileFor(profiles: ReadonlyMap<string, EmbeddingProfile>, profileId: string): EmbeddingProfile {
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new SearchValidationError('PROFILE_REQUIRED', 'Embedding profile id is required');
  }
  const profile = profiles.get(profileId);
  if (!profile) throw new SearchValidationError('PROFILE_MISMATCH', `Embedding profile ${profileId} is not configured`);
  return profile;
}

export function validateVector(vector: readonly number[], profile: EmbeddingProfile): number[] {
  if (!Array.isArray(vector)) throw new SearchValidationError('VECTOR_INVALID', 'Embedding vector must be an array');
  if (vector.length !== profile.dimensions) {
    throw new SearchValidationError('VECTOR_DIMENSIONS', `Profile ${profile.id} requires ${profile.dimensions} dimensions`);
  }
  let magnitude = 0;
  const normalized = new Array<number>(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SearchValidationError('VECTOR_INVALID', `Embedding vector value at ${index} is not finite`);
    }
    normalized[index] = Object.is(value, -0) ? 0 : value;
    magnitude += value * value;
  }
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    throw new SearchValidationError('VECTOR_ZERO', 'Embedding vector must have a non-zero magnitude');
  }
  return normalized;
}

export function validateDocument(document: SearchDocument, profiles: ReadonlyMap<string, EmbeddingProfile>): SearchDocument {
  if (!document || typeof document !== 'object') throw new SearchValidationError('DOCUMENT_INVALID', 'Search document is required');
  validateIdentifier(document.organizationId, 'organization id');
  validateIdentifier(document.resourceId, 'resource id');
  validateDigest(document.artifactDigest, 'artifact digest');
  validateDigest(document.contentDigest, 'content digest');
  if (typeof document.text !== 'string' || document.text.length > 1_048_576) {
    throw new SearchValidationError('DOCUMENT_TEXT', 'Search document text must be a string of at most 1 MiB');
  }
  if (typeof document.indexedAt !== 'string' || !Number.isFinite(Date.parse(document.indexedAt))) {
    throw new SearchValidationError('DOCUMENT_TIME', 'Search document indexedAt must be an ISO date string');
  }
  const profile = profileFor(profiles, document.profileId);
  const vector = validateVector(document.vector, profile);
  return { ...document, vector };
}

export function validateQuery(query: SearchQuery, profiles: ReadonlyMap<string, EmbeddingProfile>): SearchQuery {
  if (!query || typeof query !== 'object') throw new SearchValidationError('QUERY_INVALID', 'Search query is required');
  validateIdentifier(query.organizationId, 'organization id');
  const profile = profileFor(profiles, query.profileId);
  const vector = validateVector(query.vector, profile);
  if (!Array.isArray(query.allowedResourceIds)) throw new SearchValidationError('RESOURCE_ALLOWLIST', 'Allowed resource ids must be an array');
  const allowedResourceIds = [...new Set(query.allowedResourceIds)];
  for (const resourceId of allowedResourceIds) validateIdentifier(resourceId, 'resource id');
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
    throw new SearchValidationError('QUERY_LIMIT', 'Search limit must be an integer from 1 to 100');
  }
  return { ...query, allowedResourceIds, vector };
}

export function validateOrganizationId(organizationId: string): void {
  validateIdentifier(organizationId, 'organization id');
}

export function validateResourceIds(resourceIds: readonly string[]): string[] {
  if (!Array.isArray(resourceIds)) throw new SearchValidationError('RESOURCE_IDS', 'Resource ids must be an array');
  const unique = [...new Set(resourceIds)];
  for (const resourceId of unique) validateIdentifier(resourceId, 'resource id');
  return unique;
}

export function validateDigest(value: unknown, label = 'digest'): asserts value is Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new SearchValidationError('DIGEST_INVALID', `${label} must be a lowercase sha256 digest`);
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) throw new SearchValidationError('VECTOR_DIMENSIONS', 'Vectors must have the same non-zero dimension');
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (!Number.isFinite(dot) || leftMagnitude <= 0 || rightMagnitude <= 0) {
    throw new SearchValidationError('VECTOR_ZERO', 'Cosine similarity requires non-zero finite vectors');
  }
  const score = dot / Math.sqrt(leftMagnitude * rightMagnitude);
  if (!Number.isFinite(score)) throw new SearchValidationError('VECTOR_INVALID', 'Cosine similarity is not finite');
  return Math.max(-1, Math.min(1, score));
}

export function rankHits(documents: readonly SearchDocument[], query: SearchQuery): SearchHit[] {
  const allowed = new Set(query.allowedResourceIds);
  return documents
    .filter((document) => document.organizationId === query.organizationId
      && document.profileId === query.profileId
      && allowed.has(document.resourceId))
    .map((document) => ({
      resourceId: document.resourceId,
      artifactDigest: document.artifactDigest,
      contentDigest: document.contentDigest,
      score: cosineSimilarity(document.vector, query.vector),
    }))
    .sort((left, right) => {
      const score = right.score - left.score;
      if (score !== 0) return score;
      return left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0;
    })
    .slice(0, query.limit);
}

function validateIdentifier(value: unknown, label: string): asserts value is string {
  if (!nonEmptyBounded(value, 512)) throw new SearchValidationError('IDENTIFIER_INVALID', `${label} must be a non-empty string`);
}

function nonEmptyBounded(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
