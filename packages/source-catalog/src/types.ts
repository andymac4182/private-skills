/**
 * Host-neutral contracts for federated skill discovery.
 *
 * Discovery adapters return metadata and a server-owned, typed acquisition
 * identity.  They never return a client-selected URL or executable bytes.
 * The registry turns the acquisition identity into its existing import job,
 * scanner, and approved-cache flow.
 */

import type { Resolution } from '../../contracts/src/index.js';
import type { OpenClawNormalizedSource } from '../../openclaw/src/types.js';

export const SOURCE_CATALOG_PROTOCOL_VERSION = 1 as const;

/** Stable ids used by built-in adapters. Custom adapters may use another id. */
export const BUILT_IN_SOURCE_IDS = [
  'skillsmp',
  'clawhub',
  'skillhub-public',
  'tessl',
  'polyskill',
  'skills-directory',
  'skillhub-pro',
  'github-code-search',
  'github-openai-skills',
  'github-anthropics-skills',
  'github-google-skills',
  'github-vercel-agent-skills',
  'github-custom',
] as const;

export type BuiltInSourceId = (typeof BUILT_IN_SOURCE_IDS)[number];
export type SourceId = BuiltInSourceId | (string & {});

export type SourceCapability = 'search' | 'resolve';

export type SourceAvailability =
  | { state: 'available'; reason?: string }
  | { state: 'unavailable'; code: string; reason: string; retryable?: boolean }
  | { state: 'disabled'; reason: string };

export interface SourceDescriptor {
  id: SourceId;
  label: string;
  capabilities: readonly SourceCapability[];
  availability: SourceAvailability;
  /** Server configuration revision used for warm-cache invalidation. */
  configRevision: string;
}

export type SourceValue = string | number | boolean | null;

/** Metadata exposed by search. Values are deliberately scalar and bounded. */
export interface SourceSearchResult {
  sourceId: SourceId;
  externalId: string;
  title: string;
  description?: string;
  version?: string;
  sourceUrl?: string;
  repository?: string;
  path?: string;
  ref?: string;
  installable: boolean;
  unavailableReason?: string;
  sourceType?: string;
  /** Provider supplied immutable snapshot/content digest, if available. */
  snapshotDigest?: `sha256:${string}`;
  metadata?: Readonly<Record<string, SourceValue>>;
}

/** Short name retained for route/UI code that calls search rows catalog rows. */
export type SourceCatalogRow = SourceSearchResult;

export interface SourceSearchRequest {
  query: string;
  source?: SourceId;
  limit?: number;
  /** Organization derived from the authenticated principal, never request data. */
  organizationId: string;
  signal?: AbortSignal;
}

export interface SourceSearchSourceStatus extends SourceDescriptor {
  resultCount: number;
  error?: { code: string; message: string; retryable?: boolean };
}

export interface SourceSearchResponse {
  protocolVersion: typeof SOURCE_CATALOG_PROTOCOL_VERSION;
  query: string;
  data: readonly SourceSearchResult[];
  sources: readonly SourceSearchSourceStatus[];
}

/**
 * Existing worker adapters are intentionally the only acquisition targets.
 * A generic URL/bundle target is excluded until it has bounded transport and
 * integrity semantics equivalent to the existing adapters.
 */
export type SourceAcquisition =
  | {
      kind: 'github';
      repository: string;
      path: string;
      ref: string;
      /** Provider origin is evidence only; transport remains worker-owned. */
      sourceProviderOrigin?: string;
      contentDigest?: `sha256:${string}`;
    }
  | {
      kind: 'registry';
      baseUrl: string;
      package: string;
      version: string;
      sourceProviderOrigin?: string;
      artifactDigest?: `sha256:${string}`;
    }
  | {
      kind: 'openclaw';
      source: OpenClawNormalizedSource;
      sourceProviderOrigin?: string;
      allowedArtifactOrigins?: readonly string[];
    }
  | {
      kind: 'tessl';
      workspace: string;
      tile: string;
      version: string;
      fingerprint: string;
      skillPath: string;
      artifactDigest?: `sha256:${string}`;
      sourceProviderOrigin: 'https://api.tessl.io';
    }
  | {
      kind: 'polyskill';
      name: string;
      version: string;
      contentDigest: `sha256:${string}`;
      sourceProviderOrigin: string;
    }
  | {
      kind: 'clawhub';
      owner: string;
      slug: string;
      version: string;
      files: readonly { path: string; size: number; sha256: string }[];
      artifactDigest?: `sha256:${string}`;
      sourceProviderOrigin: string;
    };

export interface SourceResolution {
  sourceId: SourceId;
  externalId: string;
  row: SourceSearchResult;
  /** Canonical server-owned key persisted on the import request. */
  reference: string;
  title: string;
  description?: string;
  version: string;
  sourceType?: string;
  sourceUrl?: string;
  snapshotDigest?: `sha256:${string}`;
  metadata?: Readonly<Record<string, SourceValue>>;
  acquisition: SourceAcquisition;
  /** Fresh provider identity/revision used to bind an import. */
  configRevision: string;
  resolvedAt: string;
}

export interface SourceResolveRequest {
  sourceId: SourceId;
  /** @deprecated Adapter compatibility alias; route input always uses sourceId. */
  source?: SourceId;
  externalId: string;
  refresh?: boolean;
  /** Organization derived from the authenticated principal. */
  organizationId: string;
  signal?: AbortSignal;
}

export interface SourceCatalogAdapterContext {
  organizationId: string;
  signal?: AbortSignal;
}

export interface SourceCatalogAdapter {
  readonly id: SourceId;
  readonly label: string;
  readonly capabilities: readonly SourceCapability[];
  /** Changes whenever server-owned source config or trust changes. */
  readonly configRevision: string;
  availability(context: SourceCatalogAdapterContext): Promise<SourceAvailability> | SourceAvailability;
  search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]>;
  resolve(input: SourceResolveRequest): Promise<SourceResolution>;
}

export interface SourceConfiguration {
  enabled?: boolean;
  /** Exact origins accepted for provider metadata and resolved transport. */
  trustedOrigins?: readonly string[];
}

export interface SourceCatalogConfiguration {
  /** Public adapters are enabled by default; missing credentials stay unavailable. */
  enabled?: boolean;
  sources?: Readonly<Record<string, SourceConfiguration>>;
  maxQueryLength?: number;
  maxResultsPerSource?: number;
  maxTotalResults?: number;
  requestTimeoutMs?: number;
}

export interface SourceCatalogListResponse {
  protocolVersion: typeof SOURCE_CATALOG_PROTOCOL_VERSION;
  sources: readonly SourceDescriptor[];
}

export type SourceResolveResponse =
  | {
      sourceId: SourceId;
      externalId: string;
      reference: string;
      operation: { id: string; state: 'queued' | 'running' };
      resolution?: Resolution;
    }
  | {
      sourceId: SourceId;
      externalId: string;
      reference: string;
      resolution: Resolution;
      operation?: { id: string; state: 'queued' | 'running' };
    };

export type SourceCatalogErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_DISABLED'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_CAPABILITY_UNAVAILABLE'
  | 'SOURCE_INVALID_QUERY'
  | 'SOURCE_INVALID_EXTERNAL_ID'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_RESOLUTION_INVALID'
  | 'SOURCE_ORIGIN_UNTRUSTED';

export class SourceCatalogError extends Error {
  readonly code: SourceCatalogErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly source?: SourceId;

  constructor(
    code: SourceCatalogErrorCode,
    message: string,
    status: number,
    options: { retryable?: boolean; source?: SourceId } = {},
  ) {
    super(message);
    this.name = 'SourceCatalogError';
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.source = options.source;
  }
}
