import type { RegistryState, StateRepository } from '../../contracts/src/index';
import {
  assertRegistryState,
  assertSynchronousResult,
  cloneRegistryState,
  ConcurrentStateUpdateError,
  StateRepositoryError,
  stateRevision,
  advanceStateRevision,
  UnsupportedTransportError,
  validateAndCloneState,
} from './state';

export const HTTP_REPOSITORY_PROTOCOL_VERSION = 1 as const;

interface StateEnvelope {
  protocolVersion: typeof HTTP_REPOSITORY_PROTOCOL_VERSION;
  version: number;
  state: RegistryState;
}

class HttpCasConflict extends Error {
  readonly version: number;

  constructor(version: number) {
    super('Repository state changed');
    this.name = 'HttpCasConflict';
    this.version = version;
  }
}

export interface HttpStateRepositoryOptions {
  /** Base URL of the internal metadata service. */
  baseUrl: string;
  /** Injected fetch keeps the client portable across Nitro runtimes and tests. */
  fetch?: typeof globalThis.fetch;
  /** Service-auth headers.  A function avoids keeping a rotating token in logs. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  maxRetries?: number;
  statePath?: string;
  transactionPath?: string;
}

export interface HttpRepositoryServerOptions {
  repository: StateRepository;
  /** Protect the internal route with service authentication. */
  authorize?: (request: Request, organizationId: string) => boolean | Promise<boolean>;
  basePath?: string;
  maxBodyBytes?: number;
}

type FetchLike = typeof globalThis.fetch;

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers(headers);
  merged.set('content-type', 'application/json; charset=utf-8');
  merged.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: merged });
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || !trimmed.startsWith('/')) {
    throw new StateRepositoryError('INVALID_TRANSPORT', 'HTTP repository paths must be absolute');
  }
  return trimmed.replace(/\/+$/, '') || '/';
}

function buildUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (base.username || base.password) {
    throw new StateRepositoryError('INVALID_TRANSPORT', 'HTTP repository URL cannot contain credentials');
  }
  return new URL(path.replace(/^\//, ''), `${base.origin}${base.pathname.replace(/\/$/, '')}/`).toString();
}

function versionFrom(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new StateRepositoryError('INVALID_TRANSPORT', 'HTTP repository returned an invalid state version');
  }
  return number;
}

async function bodyJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new StateRepositoryError('INVALID_TRANSPORT', 'HTTP repository returned invalid JSON');
  }
}

function transportMessage(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return fallback;
}

/**
 * StateRepository client for the explicit HTTP CAS protocol.  The remote
 * server applies a complete proposed state only when `expectedVersion` still
 * matches, under the server repository's transaction boundary.  A conflict
 * replays the synchronous updater against the latest state; no local-memory
 * fallback is attempted.
 */
export class HttpStateRepository implements StateRepository {
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly headers?: HttpStateRepositoryOptions['headers'];
  private readonly maxRetries: number;
  private readonly statePath: string;
  private readonly transactionPath: string;

  constructor(options: HttpStateRepositoryOptions) {
    this.baseUrl = options.baseUrl;
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== 'function') {
      throw new UnsupportedTransportError('A Web fetch implementation is required for HTTP persistence');
    }
    this.fetcher = fetcher.bind(globalThis);
    this.headers = options.headers;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 5));
    this.statePath = normalizePath(options.statePath ?? '/v1/internal/state');
    this.transactionPath = normalizePath(
      options.transactionPath ?? '/v1/internal/state/transaction',
    );
  }

  private async requestHeaders(): Promise<Headers> {
    const value = typeof this.headers === 'function' ? await this.headers() : this.headers;
    const headers = new Headers(value);
    headers.set('accept', 'application/json');
    return headers;
  }

  private async getEnvelope(organizationId: string): Promise<StateEnvelope> {
    const headers = await this.requestHeaders();
    const response = await this.fetcher(
      buildUrl(this.baseUrl, `${this.statePath}/${encodeURIComponent(organizationId)}`),
      { method: 'GET', headers },
    );
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new UnsupportedTransportError('HTTP server does not implement state reads');
    }
    const body = await bodyJson(response);
    if (!response.ok) {
      throw new StateRepositoryError(
        (body as { code?: string } | null)?.code ?? 'TRANSPORT_ERROR',
        transportMessage(body, 'HTTP state read failed'),
      );
    }
    if (!body || typeof body !== 'object') {
      throw new UnsupportedTransportError('HTTP state read response is not a repository envelope');
    }
    const candidate = body as Partial<StateEnvelope>;
    if (candidate.protocolVersion !== HTTP_REPOSITORY_PROTOCOL_VERSION) {
      throw new UnsupportedTransportError('HTTP repository protocol version is unsupported');
    }
    const state = validateAndCloneState(candidate.state);
    const version = versionFrom(candidate.version);
    if (version !== stateRevision(state)) {
      throw new UnsupportedTransportError('HTTP repository version is not bound to persisted state');
    }
    return {
      protocolVersion: HTTP_REPOSITORY_PROTOCOL_VERSION,
      version,
      state,
    };
  }

  async read(organizationId: string): Promise<RegistryState> {
    return cloneRegistryState((await this.getEnvelope(organizationId)).state);
  }

  private async compareAndSet(
    organizationId: string,
    expectedVersion: number,
    state: RegistryState,
  ): Promise<void> {
    const headers = await this.requestHeaders();
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('if-match', `"${expectedVersion}"`);
    const response = await this.fetcher(
      buildUrl(this.baseUrl, `${this.transactionPath}/${encodeURIComponent(organizationId)}`),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocolVersion: HTTP_REPOSITORY_PROTOCOL_VERSION,
          expectedVersion,
          state,
        }),
      },
    );
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new UnsupportedTransportError('HTTP server does not implement state CAS transactions');
    }
    if (response.status === 409 || response.status === 412) {
      throw new ConcurrentStateUpdateError();
    }
    const body = response.status === 204 ? undefined : await bodyJson(response);
    if (!response.ok) {
      throw new StateRepositoryError(
        (body as { code?: string } | null)?.code ?? 'TRANSPORT_ERROR',
        transportMessage(body, 'HTTP state transaction failed'),
      );
    }
    if (body !== undefined && body !== null && typeof body === 'object') {
      const protocolVersion = (body as { protocolVersion?: unknown }).protocolVersion;
      if (protocolVersion !== HTTP_REPOSITORY_PROTOCOL_VERSION) {
        throw new UnsupportedTransportError('HTTP repository transaction protocol is unsupported');
      }
    }
  }

  async transaction<T>(
    organizationId: string,
    update: (state: RegistryState) => T,
  ): Promise<T> {
    let lastConflict: ConcurrentStateUpdateError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const envelope = await this.getEnvelope(organizationId);
      const working = cloneRegistryState(envelope.state);
      const result = update(working);
      assertSynchronousResult(result);
      assertRegistryState(working);
      try {
        await this.compareAndSet(organizationId, envelope.version, working);
        return result;
      } catch (error) {
        if (error instanceof ConcurrentStateUpdateError) {
          lastConflict = error;
          continue;
        }
        throw error;
      }
    }
    throw lastConflict ?? new ConcurrentStateUpdateError();
  }
}

/**
 * HTTP repository endpoint.  The CAS version is persisted in the state row
 * and checked inside the supplied repository transaction.  This keeps stale
 * reads, API restarts, and multiple handler instances safe as long as the
 * underlying StateRepository provides its documented per-organization atomic
 * transaction.
 */
export class HttpRepositoryServer {
  private readonly repository: StateRepository;
  private readonly authorize?: HttpRepositoryServerOptions['authorize'];
  private readonly basePath: string;
  private readonly transactionPath: string;
  private readonly maxBodyBytes: number;

  constructor(options: HttpRepositoryServerOptions) {
    this.repository = options.repository;
    this.authorize = options.authorize;
    this.basePath = normalizePath(options.basePath ?? '/v1/internal/state');
    this.transactionPath = `${this.basePath}/transaction`;
    this.maxBodyBytes = Math.max(1, options.maxBodyBytes ?? 2 * 1024 * 1024);
  }

  private async isAuthorized(request: Request, organizationId: string): Promise<boolean> {
    if (!this.authorize) return true;
    try {
      return await this.authorize(request, organizationId);
    } catch {
      return false;
    }
  }

  private async parseBody(request: Request): Promise<unknown> {
    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > this.maxBodyBytes) {
      throw new StateRepositoryError('BODY_TOO_LARGE', 'HTTP repository body exceeds its configured limit');
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > this.maxBodyBytes) {
      throw new StateRepositoryError('BODY_TOO_LARGE', 'HTTP repository body exceeds its configured limit');
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new StateRepositoryError('INVALID_TRANSPORT', 'HTTP repository request is not valid JSON');
    }
  }

  async handle(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse({ code: 'INVALID_TRANSPORT', message: 'Invalid repository URL' }, 400);
    }

    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const isTransaction = pathname.startsWith(`${this.transactionPath}/`);
    const isRead = pathname.startsWith(`${this.basePath}/`) && !isTransaction;
    if (!isRead && !isTransaction) {
      return jsonResponse({ code: 'NOT_FOUND', message: 'Repository route not found' }, 404);
    }

    const prefix = isTransaction ? `${this.transactionPath}/` : `${this.basePath}/`;
    const encodedOrganizationId = pathname.slice(prefix.length);
    if (!encodedOrganizationId || encodedOrganizationId.includes('/')) {
      return jsonResponse({ code: 'INVALID_ORGANIZATION', message: 'Organization id is invalid' }, 400);
    }
    let organizationId: string;
    try {
      organizationId = decodeURIComponent(encodedOrganizationId);
    } catch {
      return jsonResponse({ code: 'INVALID_ORGANIZATION', message: 'Organization id is invalid' }, 400);
    }

    if (!(await this.isAuthorized(request, organizationId))) {
      return jsonResponse({ code: 'UNAUTHORIZED', message: 'Repository authentication failed' }, 401);
    }

    if (isRead && request.method === 'GET') {
      try {
        const state = await this.repository.read(organizationId);
        const version = stateRevision(state);
        return jsonResponse(
          { protocolVersion: HTTP_REPOSITORY_PROTOCOL_VERSION, version, state },
          200,
          { etag: `"${version}"` },
        );
      } catch {
        return jsonResponse({ code: 'STATE_READ_FAILED', message: 'Repository state is unavailable' }, 500);
      }
    }

    if (isTransaction && request.method === 'POST') {
      return this.handleTransaction(request, organizationId);
    }

    return jsonResponse({ code: 'METHOD_NOT_ALLOWED', message: 'Repository method is unsupported' }, 405, {
      allow: isRead ? 'GET' : 'POST',
    });
  }

  private async handleTransaction(request: Request, organizationId: string): Promise<Response> {
    try {
      const body = await this.parseBody(request);
      if (!body || typeof body !== 'object') {
        return jsonResponse({ code: 'INVALID_TRANSPORT', message: 'Repository request is invalid' }, 400);
      }
      const candidate = body as {
        protocolVersion?: unknown;
        expectedVersion?: unknown;
        state?: unknown;
      };
      if (candidate.protocolVersion !== HTTP_REPOSITORY_PROTOCOL_VERSION) {
        throw new UnsupportedTransportError('HTTP repository protocol version is unsupported');
      }
      const expectedVersion = versionFrom(candidate.expectedVersion);
      const proposed = validateAndCloneState(candidate.state);

      await this.repository.transaction(organizationId, (state) => {
        const current = stateRevision(state);
        if (expectedVersion !== current) throw new HttpCasConflict(current);
        Object.assign(state, cloneRegistryState(proposed));
        // The adapter also commits the revision after the callback.  Setting
        // it here makes the invariant explicit and prevents client-proposed
        // metadataRevision values from being trusted.
        advanceStateRevision(state, current);
      });
      const version = expectedVersion + 1;
      return jsonResponse(
        { protocolVersion: HTTP_REPOSITORY_PROTOCOL_VERSION, version },
        200,
        { etag: `"${version}"` },
      );
    } catch (error) {
      if (error instanceof HttpCasConflict) {
        return jsonResponse(
          { code: 'VERSION_CONFLICT', message: error.message, version: error.version },
          409,
          { etag: `"${error.version}"` },
        );
      }
      if (error instanceof UnsupportedTransportError) {
        return jsonResponse({ code: error.code, message: error.message }, 501);
      }
      if (error instanceof StateRepositoryError) {
        return jsonResponse({ code: error.code, message: error.message }, 400);
      }
      return jsonResponse({ code: 'STATE_WRITE_FAILED', message: 'Repository state was not committed' }, 500);
    }
  }
}

export function createHttpRepositoryHandler(
  options: HttpRepositoryServerOptions,
): (request: Request) => Promise<Response> {
  const server = new HttpRepositoryServer(options);
  return server.handle.bind(server);
}

export function createHttpStateRepository(options: HttpStateRepositoryOptions): HttpStateRepository {
  return new HttpStateRepository(options);
}

export { ConcurrentStateUpdateError, StateRepositoryError, UnsupportedTransportError };
