import {
  SourceCatalogError,
  SOURCE_CATALOG_PROTOCOL_VERSION,
  type SourceAcquisition,
  type SourceAvailability,
  type SourceCatalogAdapter,
  type SourceCatalogConfiguration,
  type SourceCatalogListResponse,
  type SourceDescriptor,
  type SourceId,
  type SourceCapability,
  type SourceResolveRequest,
  type SourceResolution,
  type SourceSearchRequest,
  type SourceSearchResponse,
  type SourceSearchResult,
  type SourceSearchSourceStatus,
} from './types.js';

const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_MAX_RESULTS_PER_SOURCE = 50;
const DEFAULT_MAX_TOTAL_RESULTS = 200;
const DEFAULT_MAX_QUERY_LENGTH = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_SOURCE_ID_LENGTH = 128;
const MAX_EXTERNAL_ID_LENGTH = 1_024;
const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_VALUE_LENGTH = 1_024;

export interface SourceCatalogClientOptions {
  adapters: readonly SourceCatalogAdapter[];
  configuration?: SourceCatalogConfiguration;
}

/**
 * Registry-side source catalog orchestration.
 *
 * This class owns source enablement, bounds, timeout handling, and trust
 * checks. Adapters only describe provider-specific metadata and resolve a
 * fresh identity; they do not receive browser URLs or credentials.
 */
export class SourceCatalogClient {
  private readonly adapters: readonly SourceCatalogAdapter[];
  private readonly configuration: Required<Pick<SourceCatalogConfiguration,
    'maxQueryLength' | 'maxResultsPerSource' | 'maxTotalResults' | 'requestTimeoutMs'>>
    & SourceCatalogConfiguration;
  private readonly byId: ReadonlyMap<string, SourceCatalogAdapter>;

  constructor(options: SourceCatalogClientOptions) {
    if (!options || !Array.isArray(options.adapters)) {
      throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'Source catalog adapters are not configured', 503);
    }
    const seen = new Set<string>();
    const adapters = options.adapters.map((adapter) => {
      if (!adapter || typeof adapter.id !== 'string' || !validSourceId(adapter.id)) {
        throw new SourceCatalogError('SOURCE_UNAVAILABLE', 'Source catalog adapter id is invalid', 500);
      }
      if (seen.has(adapter.id)) {
        throw new SourceCatalogError('SOURCE_UNAVAILABLE', `Duplicate source adapter ${adapter.id}`, 500, { source: adapter.id });
      }
      if (typeof adapter.label !== 'string' || adapter.label.trim().length === 0 || adapter.label.length > MAX_TITLE_LENGTH) {
        throw new SourceCatalogError('SOURCE_UNAVAILABLE', `Source adapter ${adapter.id} label is invalid`, 500, { source: adapter.id });
      }
      if (!Array.isArray(adapter.capabilities) || adapter.capabilities.some((capability: SourceCapability) => capability !== 'search' && capability !== 'resolve')) {
        throw new SourceCatalogError('SOURCE_UNAVAILABLE', `Source adapter ${adapter.id} capabilities are invalid`, 500, { source: adapter.id });
      }
      if (typeof adapter.configRevision !== 'string' || adapter.configRevision.length === 0 || adapter.configRevision.length > 256) {
        throw new SourceCatalogError('SOURCE_UNAVAILABLE', `Source adapter ${adapter.id} configuration revision is invalid`, 500, { source: adapter.id });
      }
      if (typeof adapter.availability !== 'function' || typeof adapter.search !== 'function' || typeof adapter.resolve !== 'function') {
        throw new SourceCatalogError('SOURCE_UNAVAILABLE', `Source adapter ${adapter.id} is incomplete`, 500, { source: adapter.id });
      }
      seen.add(adapter.id);
      return adapter;
    });
    this.adapters = adapters;
    this.byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    const config = options.configuration ?? {};
    this.configuration = {
      ...config,
      maxQueryLength: boundedPositive(config.maxQueryLength, DEFAULT_MAX_QUERY_LENGTH, 2_000),
      maxResultsPerSource: boundedPositive(config.maxResultsPerSource, DEFAULT_MAX_RESULTS_PER_SOURCE, 100),
      maxTotalResults: boundedPositive(config.maxTotalResults, DEFAULT_MAX_TOTAL_RESULTS, 500),
      requestTimeoutMs: boundedPositive(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 60_000),
    };
  }

  async list(input: { organizationId: string; signal?: AbortSignal }): Promise<SourceCatalogListResponse> {
    const sources = await Promise.all(this.adapters.map(async (adapter) => this.describe(adapter, input.organizationId, input.signal)));
    return { protocolVersion: SOURCE_CATALOG_PROTOCOL_VERSION, sources };
  }

  /** Return the effective server configuration revision for warm-cache checks. */
  configRevision(sourceId: SourceId): string {
    const adapter = this.adapter(sourceId);
    return effectiveConfigRevision(adapter, this.configuration);
  }

  descriptor(sourceId: SourceId): SourceDescriptor {
    const adapter = this.adapter(sourceId);
    return {
      id: adapter.id,
      label: adapter.label,
      capabilities: [...adapter.capabilities],
      availability: this.configFor(adapter).enabled === false
        ? { state: 'disabled', reason: 'Source disabled by server configuration' }
        : { state: 'available' },
      configRevision: effectiveConfigRevision(adapter, this.configuration),
    };
  }

  /** Read the current server-side availability and trust revision for one source. */
  async status(input: { sourceId: SourceId; organizationId: string; signal?: AbortSignal }): Promise<SourceDescriptor> {
    return this.describe(this.adapter(input.sourceId), input.organizationId, input.signal);
  }

  async search(input: SourceSearchRequest): Promise<SourceSearchResponse> {
    const query = normalizeQuery(input.query, this.configuration.maxQueryLength);
    const limit = boundedPositive(input.limit, DEFAULT_QUERY_LIMIT, this.configuration.maxResultsPerSource);
    const selected = input.source === undefined
      ? this.adapters
      : [this.adapter(input.source)];
    const data: SourceSearchResult[] = [];
    const sources: SourceSearchSourceStatus[] = [];
    const results = await Promise.all(selected.map(async (adapter): Promise<SourceSearchEntry> => {
      const descriptor = await this.describe(adapter, input.organizationId, input.signal);
      if (descriptor.availability.state !== 'available') {
        return { descriptor, results: [] as SourceSearchResult[] };
      }
      if (!adapter.capabilities.includes('search')) {
        return {
          descriptor: {
            ...descriptor,
            availability: { state: 'unavailable' as const, code: 'SEARCH_UNSUPPORTED', reason: 'Source does not support search' },
            error: { code: 'SEARCH_UNSUPPORTED', message: 'Source does not support search' },
          },
          results: [] as SourceSearchResult[],
        };
      }
      try {
        const rows = await withTimeout(
          (signal) => adapter.search({ ...input, query, limit, organizationId: input.organizationId, signal }),
          this.configuration.requestTimeoutMs,
          input.signal,
        );
        const normalized = rows.slice(0, limit).map((row) => this.normalizeResult(adapter, row));
        return { descriptor, results: normalized };
      } catch (error) {
        const failure = sourceFailure(error);
        return {
          descriptor: {
            ...descriptor,
            error: failure,
            availability: { state: 'unavailable', code: failure.code, reason: failure.message, retryable: failure.retryable },
          },
          results: [] as SourceSearchResult[],
        };
      }
    }));
    for (const entry of results) {
      const resultCount = entry.results.length;
      sources.push({ ...entry.descriptor, resultCount });
      for (const row of entry.results) {
        if (data.length >= this.configuration.maxTotalResults) break;
        data.push(row);
      }
    }
    return { protocolVersion: SOURCE_CATALOG_PROTOCOL_VERSION, query, data, sources };
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    const externalId = normalizeExternalId(input.externalId);
    const adapter = this.adapter(input.sourceId);
    const descriptor = await this.describe(adapter, input.organizationId, input.signal);
    if (descriptor.availability.state === 'disabled') {
      throw new SourceCatalogError('SOURCE_DISABLED', descriptor.availability.reason, 403, { source: adapter.id });
    }
    if (descriptor.availability.state === 'unavailable') {
      throw new SourceCatalogError('SOURCE_UNAVAILABLE', descriptor.availability.reason, 503, {
        source: adapter.id,
        retryable: descriptor.availability.retryable,
      });
    }
    if (!adapter.capabilities.includes('resolve')) {
      throw new SourceCatalogError('SOURCE_CAPABILITY_UNAVAILABLE', 'Source does not support resolution', 501, { source: adapter.id });
    }
    try {
      const resolution = await withTimeout(
        (signal) => adapter.resolve({ ...input, sourceId: adapter.id, externalId, organizationId: input.organizationId, signal }),
        this.configuration.requestTimeoutMs,
        input.signal,
      );
      return this.normalizeResolution(adapter, resolution, externalId);
    } catch (error) {
      if (error instanceof SourceCatalogError) throw error;
      const failure = sourceFailure(error);
      throw new SourceCatalogError(
        failure.code === 'SOURCE_TIMEOUT' ? 'SOURCE_TIMEOUT' : 'SOURCE_RESOLUTION_INVALID',
        failure.message,
        failure.code === 'SOURCE_TIMEOUT' ? 504 : 502,
        { source: adapter.id, retryable: failure.retryable },
      );
    }
  }

  private adapter(sourceId: SourceId): SourceCatalogAdapter {
    if (typeof sourceId !== 'string' || !validSourceId(sourceId)) {
      throw new SourceCatalogError('SOURCE_NOT_FOUND', 'Source id is invalid', 404);
    }
    const adapter = this.byId.get(sourceId);
    if (adapter === undefined) {
      throw new SourceCatalogError('SOURCE_NOT_FOUND', `Source ${sourceId} is not configured`, 404, { source: sourceId });
    }
    return adapter;
  }

  private configFor(adapter: SourceCatalogAdapter): SourceConfigurationView {
    const configured = this.configuration.sources?.[adapter.id];
    return { enabled: this.configuration.enabled !== false && configured?.enabled !== false, trustedOrigins: configured?.trustedOrigins };
  }

  private async describe(adapter: SourceCatalogAdapter, organizationId: string, signal?: AbortSignal): Promise<SourceDescriptor> {
    const config = this.configFor(adapter);
    let availability: SourceAvailability;
    if (!config.enabled) {
      availability = { state: 'disabled', reason: 'Source disabled by server configuration' };
    } else {
      try {
        availability = await withTimeout(
          (availabilitySignal) => Promise.resolve(adapter.availability({ organizationId, signal: availabilitySignal })),
          this.configuration.requestTimeoutMs,
          signal,
        );
      } catch (error) {
        const failure = sourceFailure(error);
        availability = { state: 'unavailable', code: failure.code, reason: failure.message, retryable: failure.retryable };
      }
    }
    return {
      id: adapter.id,
      label: adapter.label,
      capabilities: [...adapter.capabilities],
      availability,
      configRevision: effectiveConfigRevision(adapter, this.configuration),
    };
  }

  private normalizeResult(adapter: SourceCatalogAdapter, row: SourceSearchResult): SourceSearchResult {
    if (!row || row.sourceId !== adapter.id || !validExternalId(row.externalId)) {
      throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'Source search returned an invalid identity', 502, { source: adapter.id });
    }
    const config = this.configFor(adapter);
    const sourceUrl = row.sourceUrl === undefined ? undefined : trustedUrl(row.sourceUrl, config.trustedOrigins, adapter.id);
    return {
      sourceId: adapter.id,
      externalId: row.externalId,
      title: boundedText(row.title, MAX_TITLE_LENGTH, 'title', adapter.id),
      ...(row.description === undefined ? {} : { description: boundedText(row.description, MAX_DESCRIPTION_LENGTH, 'description', adapter.id, true) }),
      ...(row.version === undefined ? {} : { version: boundedText(row.version, 128, 'version', adapter.id) }),
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(row.repository === undefined ? {} : { repository: boundedText(row.repository, 512, 'repository', adapter.id) }),
      ...(row.path === undefined ? {} : { path: boundedPath(row.path, 'path', adapter.id) }),
      ...(row.ref === undefined ? {} : { ref: boundedText(row.ref, 256, 'ref', adapter.id) }),
      installable: row.installable === true,
      ...(row.unavailableReason === undefined ? {} : { unavailableReason: boundedText(row.unavailableReason, MAX_DESCRIPTION_LENGTH, 'unavailable reason', adapter.id, true) }),
      ...(row.sourceType === undefined ? {} : { sourceType: boundedText(row.sourceType, 128, 'source type', adapter.id) }),
      ...(row.snapshotDigest === undefined ? {} : { snapshotDigest: validDigest(row.snapshotDigest, adapter.id) }),
      ...(row.metadata === undefined ? {} : { metadata: boundedMetadata(row.metadata, adapter.id) }),
    };
  }

  private normalizeResolution(adapter: SourceCatalogAdapter, resolution: SourceResolution, externalId: string): SourceResolution {
    if (!resolution || resolution.sourceId !== adapter.id || resolution.externalId !== externalId || !validExternalId(resolution.reference)) {
      throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'Source resolution returned an invalid identity', 502, { source: adapter.id });
    }
    if (!validExternalId(resolution.row.title) || !validExternalId(resolution.row.version ?? resolution.version)) {
      throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'Source resolution returned incomplete metadata', 502, { source: adapter.id });
    }
    validateAcquisition(resolution.acquisition, adapter.id, this.configFor(adapter).trustedOrigins);
    const sourceUrl = resolution.row.sourceUrl === undefined ? undefined : trustedUrl(resolution.row.sourceUrl, this.configFor(adapter).trustedOrigins, adapter.id);
    return {
      ...resolution,
      sourceId: adapter.id,
      externalId,
      reference: boundedText(resolution.reference, MAX_EXTERNAL_ID_LENGTH, 'reference', adapter.id),
      row: this.normalizeResult(adapter, resolution.row),
      configRevision: effectiveConfigRevision(adapter, this.configuration),
      resolvedAt: boundedText(resolution.resolvedAt, 128, 'resolvedAt', adapter.id),
    };
  }
}

interface SourceConfigurationView {
  enabled: boolean;
  trustedOrigins?: readonly string[];
}

interface SourceSearchEntry {
  descriptor: SourceDescriptor & { error?: { code: string; message: string; retryable?: boolean } };
  results: SourceSearchResult[];
}

function validSourceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SOURCE_ID_LENGTH && /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function validExternalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_EXTERNAL_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeExternalId(value: unknown): string {
  if (!validExternalId(value)) throw new SourceCatalogError('SOURCE_INVALID_EXTERNAL_ID', 'externalId is invalid', 400);
  return value;
}

function normalizeQuery(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'q is required', 400);
  const query = value.trim();
  if (query.length < 2 || query.length > maxLength || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'q must contain 2 to the configured maximum safe characters', 400);
  }
  return query;
}

function boundedPositive(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new SourceCatalogError('SOURCE_INVALID_QUERY', 'limit must be a positive integer', 400);
  return Math.min(value, max);
}

function boundedText(value: unknown, maxLength: number, label: string, source?: SourceId, allowWhitespace = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength ||
    (allowWhitespace ? /[\u0000\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)) {
    throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', `Source ${label} is invalid`, 502, { source });
  }
  return value;
}

function boundedPath(value: unknown, label: string, source?: SourceId): string {
  if (typeof value !== 'string' || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/') || value.split('/').some((part) => part === '..')) {
    throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', `Source ${label} is invalid`, 502, { source });
  }
  return value;
}

function validDigest(value: `sha256:${string}`, source: SourceId): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'Source digest is invalid', 502, { source });
  }
  return value;
}

function boundedMetadata(value: Readonly<Record<string, unknown>>, source: SourceId): Readonly<Record<string, string | number | boolean | null>> {
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_KEYS) throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'Source metadata is too large', 502, { source });
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key) || (typeof item === 'string' && item.length > MAX_METADATA_VALUE_LENGTH) ||
      (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && item !== null) ||
      (typeof item === 'number' && !Number.isFinite(item))) {
      throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'Source metadata contains an invalid value', 502, { source });
    }
    output[key] = item;
  }
  return output;
}

function trustedUrl(value: string, origins: readonly string[] | undefined, source: SourceId): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'Source URL is invalid', 502, { source }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'Source URL is not a trusted HTTPS URL', 502, { source });
  }
  if (origins !== undefined && !origins.some((origin) => sameOrigin(url, origin))) {
    throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'Source URL is outside the configured trust boundary', 502, { source });
  }
  return url.href;
}

function sameOrigin(url: URL, originValue: string): boolean {
  try { return url.origin === new URL(originValue).origin; } catch { return false; }
}

function validateAcquisition(acquisition: SourceAcquisition, source: SourceId, trustedOrigins: readonly string[] | undefined): void {
  if (!acquisition || typeof acquisition !== 'object' || typeof acquisition.kind !== 'string') {
    throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'Source acquisition is missing', 502, { source });
  }
  if (acquisition.kind === 'github') {
    boundedText(acquisition.repository, 512, 'repository', source);
    boundedPath(acquisition.path, 'path', source);
    boundedText(acquisition.ref, 256, 'ref', source);
    if (acquisition.sourceProviderOrigin !== undefined) trustedUrl(acquisition.sourceProviderOrigin, trustedOrigins, source);
    if (acquisition.contentDigest !== undefined) validDigest(acquisition.contentDigest, source);
    return;
  }
  if (acquisition.kind === 'registry') {
    trustedUrl(acquisition.baseUrl, trustedOrigins, source);
    boundedText(acquisition.package, 512, 'package', source);
    boundedText(acquisition.version, 128, 'version', source);
    if (acquisition.sourceProviderOrigin !== undefined) trustedUrl(acquisition.sourceProviderOrigin, trustedOrigins, source);
    if (acquisition.artifactDigest !== undefined) validDigest(acquisition.artifactDigest, source);
    return;
  }
  if (acquisition.kind === 'openclaw') {
    if (acquisition.sourceProviderOrigin !== undefined) trustedUrl(acquisition.sourceProviderOrigin, trustedOrigins, source);
    if (acquisition.allowedArtifactOrigins !== undefined) {
      if (!Array.isArray(acquisition.allowedArtifactOrigins) || acquisition.allowedArtifactOrigins.length === 0) {
        throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'OpenClaw acquisition has no trusted artifact origin', 502, { source });
      }
      for (const origin of acquisition.allowedArtifactOrigins) trustedUrl(origin, trustedOrigins, source);
    }
    if (!acquisition.source || (acquisition.source.kind !== 'public-clawhub' && acquisition.source.kind !== 'public-github')) {
      throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'OpenClaw acquisition identity is invalid', 502, { source });
    }
    return;
  }
  if (acquisition.kind === 'tessl') {
    boundedText(acquisition.workspace, 256, 'workspace', source);
    boundedText(acquisition.tile, 512, 'tile', source);
    boundedText(acquisition.version, 128, 'version', source);
    boundedText(acquisition.fingerprint, 512, 'fingerprint', source);
    boundedPath(acquisition.skillPath, 'skill path', source);
    if (acquisition.artifactDigest !== undefined) validDigest(acquisition.artifactDigest, source);
    if (acquisition.sourceProviderOrigin !== 'https://api.tessl.io') {
      throw new SourceCatalogError('SOURCE_ORIGIN_UNTRUSTED', 'Tessl source origin is invalid', 502, { source });
    }
    trustedUrl(acquisition.sourceProviderOrigin, trustedOrigins, source);
    return;
  }
  if (acquisition.kind === 'polyskill') {
    boundedText(acquisition.name, 512, 'name', source);
    boundedText(acquisition.version, 128, 'version', source);
    validDigest(acquisition.contentDigest, source);
    trustedUrl(acquisition.sourceProviderOrigin, trustedOrigins, source);
    return;
  }
  if (acquisition.kind === 'clawhub') {
    boundedText(acquisition.owner, 128, 'owner', source);
    boundedText(acquisition.slug, 256, 'slug', source);
    boundedText(acquisition.version, 128, 'version', source);
    if (!Array.isArray(acquisition.files) || acquisition.files.length === 0 || acquisition.files.length > 2_000) {
      throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'ClawHub source manifest is invalid', 502, { source });
    }
    for (const file of acquisition.files) {
      boundedPath(file.path, 'ClawHub file path', source);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 10 * 1024 * 1024 || !/^[0-9a-f]{64}$/u.test(file.sha256)) {
        throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'ClawHub source manifest entry is invalid', 502, { source });
      }
    }
    if (acquisition.artifactDigest !== undefined) validDigest(acquisition.artifactDigest, source);
    trustedUrl(acquisition.sourceProviderOrigin, trustedOrigins, source);
    return;
  }
  throw new SourceCatalogError('SOURCE_RESOLUTION_INVALID', 'Source acquisition kind is unsupported', 502, { source });
}

function effectiveConfigRevision(adapter: SourceCatalogAdapter, configuration: SourceCatalogConfiguration): string {
  const configured = configuration.sources?.[adapter.id];
  const enabled = configuration.enabled !== false && configured?.enabled !== false ? 'enabled' : 'disabled';
  const origins = configured?.trustedOrigins === undefined ? '' : [...configured.trustedOrigins].sort().join(',');
  return `${adapter.configRevision}:${enabled}:${origins}`;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal): Promise<T> {
  if (parentSignal?.aborted) throw new SourceCatalogError('SOURCE_TIMEOUT', 'Source request cancelled', 499, { retryable: false });
  const controller = new AbortController();
  let rejectCancelled: ((reason: SourceCatalogError) => void) | undefined;
  const cancelled = parentSignal === undefined ? undefined : new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  const abortParent = (): void => {
    controller.abort();
    rejectCancelled?.(new SourceCatalogError('SOURCE_TIMEOUT', 'Source request cancelled', 499, { retryable: false }));
  };
  parentSignal?.addEventListener('abort', abortParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceCatalogError('SOURCE_TIMEOUT', 'Source request timed out', 504, { retryable: true }));
    }, timeoutMs);
  });
  try {
    const started = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race([started, timeout, ...(cancelled === undefined ? [] : [cancelled])]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortParent);
    controller.abort();
  }
}

function sourceFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof SourceCatalogError) return { code: error.code, message: safeSourceCatalogMessage(error.code), retryable: error.retryable };
  if (error instanceof Error) return { code: 'SOURCE_ADAPTER_ERROR', message: 'Source adapter failed', retryable: true };
  return { code: 'SOURCE_ADAPTER_ERROR', message: 'Source adapter failed', retryable: true };
}

function safeSourceCatalogMessage(code: string): string {
  switch (code) {
    case 'SOURCE_TIMEOUT': return 'Source request timed out';
    case 'SOURCE_DISABLED': return 'Source disabled by server configuration';
    case 'SOURCE_UNAVAILABLE': return 'Source is unavailable';
    case 'SOURCE_CAPABILITY_UNAVAILABLE': return 'Source capability is unavailable';
    default: return 'Source adapter failed';
  }
}
