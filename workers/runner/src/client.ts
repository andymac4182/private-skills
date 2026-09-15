import { createHash } from 'node:crypto';

import type { Policy, ScanResult } from './protocol.js';
import {
  WORKER_OPERATION_AUDIENCE_HEADER,
  WORKER_SERVICE_IDENTITY_HEADER,
  type WorkerDelegationAudience,
  type WorkerTenantCredential,
  type WorkerTenantCredentialProvider,
  type WorkerTenantCredentialRequest,
} from './identity.js';
import type { Provenance, ScanResult as RegistryScanResult, SkillBundle } from '../../../packages/contracts/src/index.js';

export interface WorkerClaimedJob {
  id: string;
  kind: 'scan' | 'import' | string;
  organizationId: string;
  /** Registry resource created by an accepted import completion. */
  resourceId?: string;
  fencingToken?: string;
  /** Legacy name accepted while API deployments roll forward. */
  leaseToken?: string;
  artifactDigest?: string;
  artifact?: { digest?: string; size?: number; key?: string };
  policyRevision?: string;
  policy?: Policy;
  scanners?: Policy['scanners'];
  attempt?: number;
  expiresAt?: string;
  /** Server-owned OpenClaw source target/entry; never accepted from browser input. */
  openclawSource?: unknown;
  /** Server-owned native source acquisition descriptor; never browser input. */
  sourceAcquisition?: unknown;
  /** Server-owned metered reservation owner; retries must reuse this key. */
  meteredReservationKey?: string;
  /** Durable server settlement intent; workers only receive this for observability. */
  meteredScanSettlement?: 'unused' | 'executed' | 'released';
  [key: string]: unknown;
}

export interface WorkerApiClientOptions {
  baseUrl: string;
  /** Legacy fixed worker credential. Mutually exclusive with tenant credentials. */
  workerToken?: string;
  workerId: string;
  /** Server-selected tenant served by this worker invocation. */
  tenantId?: string;
  /** Fresh, operation-scoped credentials for a hosted tenant worker. */
  tenantCredentialProvider?: WorkerTenantCredentialProvider;
  fetch?: typeof fetch;
  artifactRoute?: (job: WorkerClaimedJob) => string;
  maxArtifactBytes?: number;
  userAgent?: string;
}

export interface ClaimResponse {
  job: WorkerClaimedJob | null;
  raw?: unknown;
}

export interface CompletionPayload {
  fencingToken: string;
  /** Sent only for backwards-compatible API deployments; server binds fencingToken. */
  leaseToken?: string;
  scanResults?: RegistryScanResult[];
  error?: string;
  artifactDigest?: string;
  attempt?: number;
  /** Required for import completions; omitted for scan-only jobs. */
  bundle?: SkillBundle;
  /** Source evidence captured by the acquisition adapter. */
  provenance?: Provenance;
  /** Set before the first scanner adapter invocation; omission is fail-closed. */
  scanInvocationStarted?: boolean;
}

export interface WorkerCompletionResponse {
  operation?: WorkerClaimedJob;
  raw?: unknown;
}

export class WorkerApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: string) {
    super(message);
    this.name = 'WorkerApiError';
  }
}

export class WorkerApiClient {
  private readonly requestFetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly artifactRoute: (job: WorkerClaimedJob) => string;
  private readonly maxArtifactBytes: number;

  constructor(private readonly options: WorkerApiClientOptions) {
    this.requestFetch = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.artifactRoute = options.artifactRoute ?? ((job) => `/internal/jobs/${encodeURIComponent(job.id)}/artifact`);
    this.maxArtifactBytes = options.maxArtifactBytes ?? 100 * 1024 * 1024 * 2;
    if (!this.baseUrl || !/^https?:\/\//.test(this.baseUrl)) throw new Error('worker API baseUrl must be an HTTP(S) origin');
    if (options.workerToken && options.tenantCredentialProvider) {
      throw new Error('worker token and tenant credential provider are mutually exclusive');
    }
    if (!options.workerToken && !options.tenantCredentialProvider) throw new Error('worker token or tenant credential provider is required');
    if (options.tenantCredentialProvider && typeof options.tenantCredentialProvider.resolve !== 'function') {
      throw new Error('tenant credential provider is invalid');
    }
    if (options.tenantCredentialProvider && (typeof options.tenantId !== 'string' || options.tenantId.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(options.tenantId) || options.tenantId.length > 256)) {
      throw new Error('tenant id is required for tenant credentials');
    }
  }

  async claim(signal?: AbortSignal): Promise<ClaimResponse> {
    const audience: WorkerDelegationAudience = 'worker-claim';
    const credential = await this.resolveCredential({ audience, signal });
    const response = await this.request('/internal/jobs/claim', {
      method: 'POST',
      signal,
      body: JSON.stringify({ workerId: this.options.workerId, capabilities: ['scan', 'import'], protocolVersion: 1 }),
    }, credential);
    if (response.status === 204) return { job: null };
    const value = await parseJson(response);
    if (value == null) return { job: null };
    const job = isObject(value) && Object.prototype.hasOwnProperty.call(value, 'job')
      ? value.job
      : value;
    if (job === null) return { job: null, raw: value };
    if (!isObject(job)) throw new WorkerApiError(response.status, 'claim response is not an object');
    if (job.id == null || typeof job.id !== 'string') throw new WorkerApiError(response.status, 'claim response omitted job id');
    const claimedJob = job as unknown as WorkerClaimedJob;
    if (credential && claimedJob.organizationId !== credential.tenantId) {
      throw new Error('claimed job organization does not match the tenant credential');
    }
    return { job: claimedJob, raw: value };
  }

  async downloadArtifact(job: WorkerClaimedJob, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertTenantBinding(job);
    const digest = artifactDigest(job);
    const token = fencingToken(job);
    const credential = await this.resolveCredential({
      audience: 'worker-artifact',
      tenantId: job.organizationId,
      jobId: job.id,
      leaseToken: token,
      signal,
    });
    const path = this.artifactRoute(job);
    if (!path.startsWith('/internal/')) throw new Error('artifact route must remain on the worker-internal API');
    const response = await this.request(path, {
      method: 'GET',
      signal,
      headers: {
        'X-Worker-Fencing-Token': token,
        'X-Artifact-Digest': digest,
      },
    }, credential);
    const bytes = await readBoundedBytes(response, this.maxArtifactBytes);
    const actual = digestBytes(bytes);
    if (actual !== digest) throw new Error(`downloaded artifact digest mismatch: expected ${digest}, received ${actual}`);
    const responseDigest = response.headers.get('x-artifact-digest');
    if (responseDigest && responseDigest !== digest) throw new Error('worker route returned a different artifact digest header');
    return bytes;
  }

  async complete(job: WorkerClaimedJob, payload: Omit<CompletionPayload, 'fencingToken'>, signal?: AbortSignal): Promise<WorkerCompletionResponse> {
    this.assertTenantBinding(job);
    const token = fencingToken(job);
    if (this.options.tenantCredentialProvider && payload.leaseToken !== undefined && payload.leaseToken !== token) {
      throw new Error('completion lease metadata does not match the tenant job lease');
    }
    const credential = await this.resolveCredential({
      audience: 'worker-complete',
      tenantId: job.organizationId,
      jobId: job.id,
      leaseToken: token,
      signal,
    });
    const response = await this.request(`/internal/jobs/${encodeURIComponent(job.id)}/complete`, {
      method: 'POST',
      signal,
      headers: { 'X-Worker-Fencing-Token': token },
      body: JSON.stringify({ ...payload, fencingToken: token, leaseToken: payload.leaseToken ?? job.leaseToken }),
    }, credential);
    if (!response.ok) {
      const body = await safeText(response);
      throw new WorkerApiError(response.status, `job completion rejected (${response.status})`, body);
    }
    const value = await parseJson(response);
    if (value === null) return {};
    if (!isObject(value)) throw new WorkerApiError(response.status, 'job completion response is not an object');
    const operation = value.operation;
    if (operation === undefined) return { raw: value };
    if (!isObject(operation) || typeof operation.id !== 'string') {
      throw new WorkerApiError(response.status, 'job completion response omitted operation id');
    }
    if (credential && operation.organizationId !== undefined && operation.organizationId !== credential.tenantId) {
      throw new Error('completion organization does not match the tenant credential');
    }
    return { operation: operation as unknown as WorkerClaimedJob, raw: value };
  }

  private async request(path: string, init: RequestInit, credential?: WorkerTenantCredential): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', credential ? credentialAuthorization(credential) : `Bearer ${this.options.workerToken}`);
    if (credential) {
      headers.set(WORKER_SERVICE_IDENTITY_HEADER, credential.serviceIdentity);
      headers.set(WORKER_OPERATION_AUDIENCE_HEADER, credential.audience);
    }
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json, application/octet-stream');
    headers.set('User-Agent', this.options.userAgent ?? 'private-skills-worker/0.1');
    const response = await this.requestFetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      redirect: 'error',
    });
    if (!response.ok) {
      const body = await safeText(response);
      throw new WorkerApiError(response.status, `worker API request rejected (${response.status})`, body);
    }
    return response;
  }

  private async resolveCredential(request: Omit<WorkerTenantCredentialRequest, 'workerId'>): Promise<WorkerTenantCredential | undefined> {
    const provider = this.options.tenantCredentialProvider;
    if (provider === undefined) return undefined;
    const tenantId = this.options.tenantId;
    if (tenantId === undefined) throw new Error('tenant id is required for tenant credentials');
    const credential = await provider.resolve({ ...request, workerId: this.options.workerId, tenantId: request.tenantId ?? tenantId });
    validateTenantCredential(credential, request.audience, tenantId);
    return credential;
  }

  private assertTenantBinding(job: WorkerClaimedJob): void {
    const tenantId = this.options.tenantId;
    if (this.options.tenantCredentialProvider && (tenantId === undefined || job.organizationId !== tenantId)) {
      throw new Error('job organization does not match the tenant worker');
    }
  }
}

export function artifactDigest(job: WorkerClaimedJob): `sha256:${string}` {
  const digest = job.artifactDigest ?? job.artifact?.digest;
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('claimed job omitted a valid artifact digest');
  return digest as `sha256:${string}`;
}

export function fencingToken(job: WorkerClaimedJob): string {
  const token = job.fencingToken ?? job.leaseToken;
  if (!token || token.length > 512) throw new Error('claimed job omitted fencingToken');
  return token;
}

export function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) throw new Error('artifact response exceeds worker limit');
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('artifact response exceeds worker limit');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error('artifact response exceeds worker limit');
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

async function parseJson(response: Response): Promise<unknown> {
  const text = await safeText(response);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new WorkerApiError(response.status, `worker API returned invalid JSON: ${String(error)}`);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 4096 ? `${text.slice(0, 4095)}…` : text;
  } catch {
    return '';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTenantCredential(
  credential: WorkerTenantCredential,
  audience: WorkerDelegationAudience,
  expectedTenantId: string,
): void {
  if (!credential || typeof credential !== 'object') throw new Error('tenant credential is invalid');
  const token = credential.token;
  const authorization = credential.authorization;
  if (token !== undefined && authorization !== undefined) throw new Error('tenant credential has ambiguous authorization');
  if (token === undefined && authorization === undefined) throw new Error('tenant credential token is invalid');
  if (token !== undefined && (token.length === 0 || token.length > 8192 || /[\u0000-\u001f\u007f]/.test(token))) {
    throw new Error('tenant credential token is invalid');
  }
  if (authorization !== undefined && (authorization.length === 0 || authorization.length > 8200 || /[\u0000-\u001f\u007f]/.test(authorization) || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))) {
    throw new Error('tenant credential authorization is invalid');
  }
  if (credential.tenantId !== expectedTenantId) throw new Error('tenant credential tenant does not match the worker tenant');
  if (credential.audience !== audience) throw new Error('tenant credential audience does not match the worker operation');
  if (typeof credential.serviceIdentity !== 'string' || credential.serviceIdentity.length === 0 || credential.serviceIdentity.length > 256 || /[\u0000-\u001f\u007f]/.test(credential.serviceIdentity)) {
    throw new Error('tenant credential service identity is invalid');
  }
  if (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now()) {
    throw new Error('tenant credential has expired');
  }
}

function credentialAuthorization(credential: WorkerTenantCredential): string {
  if (credential.authorization !== undefined) return credential.authorization;
  if (credential.token !== undefined) return `Bearer ${credential.token}`;
  throw new Error('tenant credential token is invalid');
}
