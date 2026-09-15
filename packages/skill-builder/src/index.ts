import type { Digest } from '../../contracts/src/index.js';
import type {
  BoundEveTenantService,
  EveTenantDelegationBinding,
} from '../../eve-tenant/src/index.js';

export type BuilderDigest = Digest;
export type DraftFileKind = 'text' | 'binary' | 'oversize';
export type PatchOperationKind = 'add' | 'edit' | 'rename' | 'delete';
export type SkillBuilderProposalState = 'pending' | 'applied' | 'rejected' | 'stale';

export const MAX_DRAFT_ID_LENGTH = 256;
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_FILE_PATH_LENGTH = 4096;
export const MAX_CONTEXT_FILES = 128;
export const MAX_CONTEXT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_MODEL_FILE_BYTES = 64 * 1024;
export const MAX_MODEL_TOTAL_BYTES = 512 * 1024;
export const MAX_PATCH_OPERATIONS = 40;
export const MAX_PATCH_CONTENT_BYTES = 64 * 1024;
export const MAX_PATCH_TOTAL_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_BUILDER_MESSAGE_BYTES = 64 * 1024;
export const MAX_BUILDER_REQUEST_ID_LENGTH = 256;
export const MAX_BUILDER_SELECTED_PATH_LENGTH = MAX_FILE_PATH_LENGTH;

const WINDOWS_RESERVED_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RESERVED_SEGMENT_NAMES = new Set([
  '.agents',
  '.claude-plugin',
  '.codex',
  '.cursor',
  '.mcp',
  '.windsurf',
]);

export interface DraftBinding {
  readonly draftId: string;
  readonly revision: number;
  readonly digest: BuilderDigest;
}

export interface DraftFileEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly digest: BuilderDigest;
  readonly kind: DraftFileKind;
  readonly contentAvailable: boolean;
}

export interface DraftContext extends DraftBinding {
  readonly organizationId?: string;
  /** The authoring service selects and bounds this list before the model can read it. */
  readonly files: readonly DraftFileEntry[];
}

export interface DraftFileContent extends DraftBinding {
  readonly path: string;
  readonly contentDigest: BuilderDigest;
  readonly content: string;
}

export interface AddFileOperation {
  readonly op: 'add';
  readonly path: string;
  readonly content: string;
}

export interface EditFileOperation {
  readonly op: 'edit';
  readonly path: string;
  readonly content: string;
}

export interface RenameFileOperation {
  readonly op: 'rename';
  readonly path: string;
  readonly newPath: string;
}

export interface DeleteFileOperation {
  readonly op: 'delete';
  readonly path: string;
}

export type PatchOperation =
  | AddFileOperation
  | EditFileOperation
  | RenameFileOperation
  | DeleteFileOperation;

export interface PatchOperationSummary {
  readonly op: PatchOperationKind;
  readonly path: string;
  readonly newPath?: string;
  readonly contentBytes?: number;
}

export interface SkillBuilderProposal {
  readonly id: string;
  readonly draftId: string;
  readonly baseRevision: number;
  readonly baseDigest: BuilderDigest;
  /** Computed by the authoring service from the complete canonical bundle. */
  readonly proposedDigest: BuilderDigest;
  readonly operations: readonly PatchOperationSummary[];
  readonly state: SkillBuilderProposalState;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface ReadDraftFilesInput {
  readonly context: DraftContext;
  readonly paths: readonly string[];
}

export interface PersistProposalInput {
  readonly context: DraftContext;
  readonly operations: readonly PatchOperation[];
  readonly sessionId: string;
  readonly idempotencyKey: string;
}

export interface SkillBuilderBackend {
  loadContext(binding: DraftBinding): Promise<DraftContext>;
  readFiles(input: ReadDraftFilesInput): Promise<readonly DraftFileContent[]>;
  persistProposal(input: PersistProposalInput): Promise<SkillBuilderProposal>;
}

export interface SkillBuilderRegistryClientOptions {
  readonly baseUrl: string;
  /** Legacy default-company bearer. Omit when tenantService is supplied. */
  readonly serviceToken?: string;
  /** Credential provider permanently bound to one tenant and service. */
  readonly tenantService?: BoundEveTenantService;
  /** Server-owned binding attached to every tenant callback request. */
  readonly tenantBinding?: EveTenantDelegationBinding;
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
}

/**
 * Authenticated request from the registry BFF to the separate Eve app.
 * `registrySessionId` is the registry-owned session identity used by proposal
 * callbacks; `sessionKey` remains an opaque provider channel key.
 */
export interface BuilderSessionStartRequest extends DraftBinding {
  readonly sessionKey: string;
  readonly registrySessionId: string;
  readonly message: string;
  readonly requestId: string;
  readonly requestDigest: BuilderDigest;
  readonly selectedPath?: string;
}

/** Acceptance returned by the Eve app after it creates the provider session. */
export interface BuilderSessionAcceptance {
  readonly status: 'accepted';
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly registrySessionId: string;
  readonly draftId: string;
  readonly revision: number;
  readonly digest: BuilderDigest;
  readonly requestId: string;
  readonly requestDigest: BuilderDigest;
  readonly selectedPath?: string;
}

export interface BuilderSessionAcceptanceExpectation {
  readonly sessionKey: string;
  readonly registrySessionId: string;
  readonly draftId: string;
  readonly revision: number;
  readonly digest: BuilderDigest;
  readonly requestId: string;
  readonly requestDigest: BuilderDigest;
  readonly selectedPath?: string;
}

export type SkillBuilderErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIGURATION_ERROR'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_CONFLICT'
  | 'UPSTREAM_SCHEMA_ERROR'
  | 'UPSTREAM_RESPONSE_TOO_LARGE';

export class SkillBuilderError extends Error {
  readonly code: SkillBuilderErrorCode;
  readonly status?: number;

  constructor(code: SkillBuilderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SkillBuilderError';
    this.code = code;
    this.status = status;
  }
}

export class SkillBuilderValidationError extends SkillBuilderError {
  constructor(message: string) {
    super('INVALID_INPUT', message);
    this.name = 'SkillBuilderValidationError';
  }
}

export class SkillBuilderConfigurationError extends SkillBuilderError {
  constructor(message: string) {
    super('CONFIGURATION_ERROR', message);
    this.name = 'SkillBuilderConfigurationError';
  }
}

export function isBuilderDigest(value: unknown): value is BuilderDigest {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

export function assertBuilderDigest(value: unknown, field = 'digest'): asserts value is BuilderDigest {
  if (!isBuilderDigest(value)) {
    throw new SkillBuilderValidationError(`${field} must be a sha256 digest`);
  }
}

export function validateDraftBinding(value: unknown): DraftBinding {
  if (!isRecord(value)) throw new SkillBuilderValidationError('draft binding must be an object');
  const draftId = boundedIdentifier(value.draftId, 'draftId', MAX_DRAFT_ID_LENGTH);
  const revision = boundedRevision(value.revision);
  assertBuilderDigest(value.digest);
  return { draftId, revision, digest: value.digest };
}

/** Validate an opaque registry/provider identifier without accepting path data. */
export function validateBuilderOpaqueId(value: unknown, field = 'sessionId', maximum = MAX_SESSION_ID_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\s\u0000-\u001f\u007f/\\]/u.test(value) || hasLoneSurrogate(value)) {
    throw new SkillBuilderValidationError(`${field} is invalid`);
  }
  return value;
}

/** Validate bounded model-facing text while preserving ordinary line breaks. */
export function validateBuilderMessage(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    utf8Bytes(value) > MAX_BUILDER_MESSAGE_BYTES ||
    hasLoneSurrogate(value) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new SkillBuilderValidationError('message must be bounded non-empty text');
  }
  return value;
}

function validateBuilderRequestId(value: unknown): string {
  return validateBuilderOpaqueId(value, 'requestId', MAX_BUILDER_REQUEST_ID_LENGTH);
}

export function validateBuilderSessionStartRequest(value: unknown): BuilderSessionStartRequest {
  if (!isRecord(value)) throw new SkillBuilderValidationError('builder session request must be an object');
  const binding = validateDraftBinding(value);
  const sessionKey = validateBuilderOpaqueId(value.sessionKey, 'sessionKey');
  const registrySessionId = validateBuilderOpaqueId(value.registrySessionId, 'registrySessionId');
  const message = validateBuilderMessage(value.message);
  const requestId = validateBuilderRequestId(value.requestId);
  assertBuilderDigest(value.requestDigest, 'requestDigest');
  const selectedPath = value.selectedPath === undefined ? undefined : validateSafePath(value.selectedPath, 'selectedPath');
  return {
    ...binding,
    sessionKey,
    registrySessionId,
    message,
    requestId,
    requestDigest: value.requestDigest,
    ...(selectedPath === undefined ? {} : { selectedPath }),
  };
}

export function validateBuilderSessionAcceptance(
  value: unknown,
  expected: BuilderSessionAcceptanceExpectation,
): BuilderSessionAcceptance {
  if (!isRecord(value) || value.status !== 'accepted') {
    throw new SkillBuilderValidationError('builder session acceptance is invalid');
  }
  const sessionId = validateBuilderOpaqueId(value.sessionId, 'sessionId');
  const sessionKey = validateBuilderOpaqueId(value.sessionKey, 'sessionKey');
  const registrySessionId = validateBuilderOpaqueId(value.registrySessionId, 'registrySessionId');
  const draftId = boundedIdentifier(value.draftId, 'draftId', MAX_DRAFT_ID_LENGTH);
  const revision = boundedRevision(value.revision);
  assertBuilderDigest(value.digest);
  const requestId = validateBuilderRequestId(value.requestId);
  assertBuilderDigest(value.requestDigest, 'requestDigest');
  const selectedPath = value.selectedPath === undefined ? undefined : validateSafePath(value.selectedPath, 'selectedPath');
  if (
    sessionKey !== expected.sessionKey ||
    registrySessionId !== expected.registrySessionId ||
    draftId !== expected.draftId ||
    revision !== expected.revision ||
    value.digest !== expected.digest ||
    requestId !== expected.requestId ||
    value.requestDigest !== expected.requestDigest ||
    selectedPath !== expected.selectedPath
  ) {
    throw new SkillBuilderValidationError('builder session acceptance does not match its request');
  }
  return {
    status: 'accepted',
    sessionId,
    sessionKey,
    registrySessionId,
    draftId,
    revision,
    digest: value.digest,
    requestId,
    requestDigest: value.requestDigest,
    ...(selectedPath === undefined ? {} : { selectedPath }),
  };
}

export function validateDraftContext(value: unknown): DraftContext {
  if (!isRecord(value)) throw new SkillBuilderValidationError('draft context must be an object');
  const binding = validateDraftBinding(value);
  const organizationId = value.organizationId === undefined
    ? undefined
    : boundedIdentifier(value.organizationId, 'organizationId', MAX_DRAFT_ID_LENGTH);
  if (!Array.isArray(value.files) || value.files.length > MAX_CONTEXT_FILES) {
    throw new SkillBuilderValidationError(`files must contain at most ${MAX_CONTEXT_FILES} entries`);
  }
  const seen = new Set<string>();
  const files = value.files.map((entry, index) => {
    if (!isRecord(entry)) throw new SkillBuilderValidationError(`files[${index}] must be an object`);
    const path = validateSafePath(entry.path, `files[${index}].path`);
    const collisionKey = path.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(collisionKey)) throw new SkillBuilderValidationError(`duplicate draft file path: ${path}`);
    seen.add(collisionKey);
    const sizeBytes = boundedFileSize(entry.sizeBytes, `files[${index}].sizeBytes`);
    assertBuilderDigest(entry.digest, `files[${index}].digest`);
    if (entry.kind !== 'text' && entry.kind !== 'binary' && entry.kind !== 'oversize') {
      throw new SkillBuilderValidationError(`files[${index}].kind is invalid`);
    }
    if (typeof entry.contentAvailable !== 'boolean') {
      throw new SkillBuilderValidationError(`files[${index}].contentAvailable must be boolean`);
    }
    if (entry.kind !== 'text' && entry.contentAvailable) {
      throw new SkillBuilderValidationError(`files[${index}] cannot expose non-text content`);
    }
    if (entry.contentAvailable && sizeBytes > MAX_MODEL_FILE_BYTES) {
      throw new SkillBuilderValidationError(`files[${index}] exceeds the model file limit`);
    }
    return { path, sizeBytes, digest: entry.digest, kind: entry.kind, contentAvailable: entry.contentAvailable } satisfies DraftFileEntry;
  });
  return { ...binding, ...(organizationId === undefined ? {} : { organizationId }), files };
}

export function validatePatchOperations(value: unknown): PatchOperation[] {
  if (!Array.isArray(value)) throw new SkillBuilderValidationError('operations must be an array');
  if (value.length === 0) throw new SkillBuilderValidationError('operations must not be empty');
  if (value.length > MAX_PATCH_OPERATIONS) {
    throw new SkillBuilderValidationError(`operations must contain at most ${MAX_PATCH_OPERATIONS} entries`);
  }

  let totalContentBytes = 0;
  const touched = new Set<string>();
  const operations = value.map((entry, index) => {
    if (!isRecord(entry)) throw new SkillBuilderValidationError(`operations[${index}] must be an object`);
    const op = entry.op;
    if (op !== 'add' && op !== 'edit' && op !== 'rename' && op !== 'delete') {
      throw new SkillBuilderValidationError(`operations[${index}].op is invalid`);
    }
    const path = validateSafePath(entry.path, `operations[${index}].path`);
    const key = path.normalize('NFC').toLocaleLowerCase('en-US');
    if (touched.has(key)) throw new SkillBuilderValidationError(`operations touch the same path more than once: ${path}`);
    touched.add(key);

    if (op === 'rename') {
      const newPath = validateSafePath(entry.newPath, `operations[${index}].newPath`);
      const newKey = newPath.normalize('NFC').toLocaleLowerCase('en-US');
      if (newKey === key) throw new SkillBuilderValidationError('rename must change the path');
      if (touched.has(newKey)) throw new SkillBuilderValidationError(`operations touch the same path more than once: ${newPath}`);
      touched.add(newKey);
      return { op, path, newPath } satisfies RenameFileOperation;
    }

    if (op === 'delete') return { op, path } satisfies DeleteFileOperation;

    const content = validatePatchContent(entry.content, `operations[${index}].content`);
    const contentBytes = utf8Bytes(content);
    totalContentBytes += contentBytes;
    if (totalContentBytes > MAX_PATCH_TOTAL_BYTES) {
      throw new SkillBuilderValidationError(`operation content exceeds ${MAX_PATCH_TOTAL_BYTES} bytes in total`);
    }
    return { op, path, content } satisfies AddFileOperation | EditFileOperation;
  });
  return operations;
}

export function summarizePatchOperations(operations: readonly PatchOperation[]): PatchOperationSummary[] {
  return operations.map((operation) => ({
    op: operation.op,
    path: operation.path,
    ...(operation.op === 'rename' ? { newPath: operation.newPath } : {}),
    ...(operation.op === 'add' || operation.op === 'edit' ? { contentBytes: utf8Bytes(operation.content) } : {}),
  }));
}

export function createProposalIdempotencyKey(sessionId: string, callId: string): string {
  const session = validateBuilderOpaqueId(sessionId, 'sessionId');
  const call = validateBuilderOpaqueId(callId, 'callId');
  return `skill-builder:${session}:${call}`;
}

export async function digestText(content: string): Promise<BuilderDigest> {
  if (hasLoneSurrogate(content)) throw new SkillBuilderValidationError('content contains an invalid Unicode surrogate');
  const bytes = new TextEncoder().encode(content);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new SkillBuilderError('CONFIGURATION_ERROR', 'Web Crypto SHA-256 is unavailable');
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of hash) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}` as BuilderDigest;
}

export class SkillBuilderRegistryClient implements SkillBuilderBackend {
  private readonly baseUrl: URL;
  private readonly serviceToken?: string;
  private readonly tenantService?: BoundEveTenantService;
  private readonly tenantBinding?: EveTenantDelegationBinding;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(options: SkillBuilderRegistryClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.serviceToken !== undefined && options.tenantService !== undefined) {
      throw new SkillBuilderConfigurationError('serviceToken and tenantService are mutually exclusive');
    }
    if (options.serviceToken === undefined && options.tenantService === undefined) {
      throw new SkillBuilderConfigurationError('a serviceToken or tenantService is required');
    }
    if (options.serviceToken !== undefined) {
      this.serviceToken = boundedIdentifier(options.serviceToken, 'serviceToken', 512);
      if (/\s/u.test(this.serviceToken)) throw new SkillBuilderConfigurationError('serviceToken must not contain whitespace');
    }
    this.tenantService = options.tenantService;
    this.tenantBinding = options.tenantBinding;
    if (this.tenantService && (!this.tenantBinding || !this.tenantBinding.registrySessionId)) {
      throw new SkillBuilderConfigurationError('tenantBinding.registrySessionId is required for tenant registry calls');
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > 10 * 1024 * 1024) {
      throw new SkillBuilderConfigurationError('maxResponseBytes is outside the supported range');
    }
  }

  async loadContext(binding: DraftBinding): Promise<DraftContext> {
    const normalized = validateDraftBinding(binding);
    const path = `/v1/drafts/${encodeURIComponent(normalized.draftId)}/builder-context?revision=${normalized.revision}&digest=${encodeURIComponent(normalized.digest)}`;
    const value = await this.requestJson(path, { method: 'GET' }, this.bindingFor(normalized));
    const context = validateDraftContext(value);
    if (context.draftId !== normalized.draftId || context.revision !== normalized.revision || context.digest !== normalized.digest) {
      throw new SkillBuilderError('UPSTREAM_CONFLICT', 'authoring service returned a different draft revision', 409);
    }
    return context;
  }

  async readFiles(input: ReadDraftFilesInput): Promise<readonly DraftFileContent[]> {
    const context = validateDraftContext(input.context);
    if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 16) {
      throw new SkillBuilderValidationError('paths must contain between 1 and 16 entries');
    }
    const allowed = new Map(context.files.map((file) => [file.path, file]));
    const seen = new Set<string>();
    const results: DraftFileContent[] = [];
    let totalBytes = 0;
    for (const rawPath of input.paths) {
      const path = validateSafePath(rawPath, 'path');
      if (seen.has(path)) throw new SkillBuilderValidationError(`duplicate requested path: ${path}`);
      seen.add(path);
      const entry = allowed.get(path);
      if (!entry || !entry.contentAvailable || entry.kind !== 'text') {
        throw new SkillBuilderError('UPSTREAM_CONFLICT', `path is not in the server-selected text file set: ${path}`, 409);
      }
      const value = await this.requestJson(`/v1/drafts/${encodeURIComponent(context.draftId)}/builder-file?revision=${context.revision}&digest=${encodeURIComponent(context.digest)}&path=${encodeURIComponent(path)}`, { method: 'GET' }, this.bindingFor(context));
      const content = parseDraftFileContent(value, context, path);
      totalBytes += utf8Bytes(content.content);
      if (totalBytes > MAX_MODEL_TOTAL_BYTES) throw new SkillBuilderValidationError('requested draft content exceeds the model total limit');
      const computedDigest = await digestText(content.content);
      if (computedDigest !== content.contentDigest || computedDigest !== entry.digest) {
        throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned content with a mismatched digest');
      }
      results.push(content);
    }
    return results;
  }

  async persistProposal(input: PersistProposalInput): Promise<SkillBuilderProposal> {
    const context = validateDraftContext(input.context);
    const operations = validatePatchOperations(input.operations);
    const sessionId = validateBuilderOpaqueId(input.sessionId, 'sessionId');
    const idempotencyKey = boundedIdentifier(input.idempotencyKey, 'idempotencyKey', 512);
    const responseValue = await this.requestJson(`/v1/drafts/${encodeURIComponent(context.draftId)}/proposals`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        draftId: context.draftId,
        draftRevision: context.revision,
        draftDigest: context.digest,
        sessionId,
        operations,
      }),
    }, this.bindingFor(context));
    if (!isRecord(responseValue) || !isRecord(responseValue.proposal)) {
      throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned an invalid proposal envelope');
    }
    const proposal = parseProposal(responseValue.proposal, context, sessionId);
    const expected = summarizePatchOperations(operations);
    if (JSON.stringify(proposal.operations) !== JSON.stringify(expected)) {
      throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned a proposal with different operations');
    }
    return proposal;
  }

  private async requestJson(path: string, init: RequestInit, binding?: EveTenantDelegationBinding): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (this.tenantService) {
      const tenantHeaders = await this.tenantService.headers(headers, binding);
      tenantHeaders.set('x-pskills-tool-identity', 'skill-builder');
      return this.fetchJson(path, init, tenantHeaders);
    }
    headers.set('authorization', `Bearer ${this.serviceToken!}`);
    headers.set('x-pskills-tool-identity', 'skill-builder');
    return this.fetchJson(path, init, headers);
  }

  private async fetchJson(path: string, init: RequestInit, headers: Headers): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.urlFor(path), { ...init, headers, redirect: 'error' });
    } catch {
      throw new SkillBuilderError('UPSTREAM_ERROR', 'authoring service request failed');
    }
    const body = await readBoundedText(response, this.maxResponseBytes);
    if (!response.ok) {
      const code = response.status === 409 ? 'UPSTREAM_CONFLICT' : 'UPSTREAM_ERROR';
      throw new SkillBuilderError(code, `authoring service returned HTTP ${response.status}`, response.status);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned invalid JSON');
    }
  }

  private bindingFor(binding: DraftBinding): EveTenantDelegationBinding | undefined {
    if (!this.tenantService) return undefined;
    return {
      ...this.tenantBinding,
      draftId: binding.draftId,
      draftRevision: binding.revision,
      draftDigest: binding.digest,
    };
  }

  private urlFor(path: string): string {
    return new URL(`${this.baseUrl.pathname.replace(/\/+$/u, '')}${path}`, this.baseUrl.origin).toString();
  }
}

function parseDraftFileContent(value: unknown, context: DraftContext, expectedPath: string): DraftFileContent {
  if (!isRecord(value)) throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned an invalid file response');
  const binding = validateDraftBinding(value);
  if (binding.draftId !== context.draftId || binding.revision !== context.revision || binding.digest !== context.digest) {
    throw new SkillBuilderError('UPSTREAM_CONFLICT', 'authoring service returned a stale draft file', 409);
  }
  const path = validateSafePath(value.path, 'path');
  if (path !== expectedPath || typeof value.content !== 'string') {
    throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned an invalid file payload');
  }
  const content = validatePatchContent(value.content, 'content');
  if (utf8Bytes(content) > MAX_MODEL_FILE_BYTES) throw new SkillBuilderValidationError('draft file exceeds the model file limit');
  if (typeof value.contentDigest !== 'string' || !isBuilderDigest(value.contentDigest)) {
    throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned an invalid file digest');
  }
  return { ...binding, path, contentDigest: value.contentDigest, content };
}

function parseProposal(value: unknown, context: DraftContext, sessionId: string): SkillBuilderProposal {
  if (!isRecord(value)) throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned an invalid proposal');
  const id = boundedIdentifier(value.id, 'proposal.id', MAX_SESSION_ID_LENGTH);
  const draftId = boundedIdentifier(value.draftId, 'proposal.draftId', MAX_DRAFT_ID_LENGTH);
  if (draftId !== context.draftId || value.baseRevision !== context.revision || value.baseDigest !== context.digest) {
    throw new SkillBuilderError('UPSTREAM_CONFLICT', 'authoring service returned a proposal for a different base', 409);
  }
  assertBuilderDigest(value.proposedDigest, 'proposal.proposedDigest');
  const operations = validatePatchSummaries(value.operations);
  if (value.state !== 'pending' && value.state !== 'applied' && value.state !== 'rejected' && value.state !== 'stale') {
    throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned an invalid proposal state');
  }
  const createdAt = boundedIdentifier(value.createdAt, 'proposal.createdAt', 128);
  return {
    id,
    draftId,
    baseRevision: context.revision,
    baseDigest: context.digest,
    proposedDigest: value.proposedDigest,
    operations,
    state: value.state,
    sessionId,
    createdAt,
  };
}

function validatePatchSummaries(value: unknown): PatchOperationSummary[] {
  if (!Array.isArray(value) || value.length > MAX_PATCH_OPERATIONS) {
    throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service returned invalid proposal operations');
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', `proposal.operations[${index}] is invalid`);
    const op = entry.op;
    if (op !== 'add' && op !== 'edit' && op !== 'rename' && op !== 'delete') {
      throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', `proposal.operations[${index}].op is invalid`);
    }
    const path = validateSafePath(entry.path, `proposal.operations[${index}].path`);
    const summary: PatchOperationSummary = { op, path };
    if (op === 'rename') {
      const newPath = validateSafePath(entry.newPath, `proposal.operations[${index}].newPath`);
      return { ...summary, newPath };
    }
    if (op === 'add' || op === 'edit') {
      const contentBytes = boundedFileSize(entry.contentBytes, `proposal.operations[${index}].contentBytes`);
      return { ...summary, contentBytes };
    }
    return summary;
  });
}

function normalizeBaseUrl(value: string): URL {
  if (typeof value !== 'string' || value.trim().length === 0) throw new SkillBuilderConfigurationError('baseUrl is required');
  let base: URL;
  try {
    base = new URL(value.trim());
  } catch {
    throw new SkillBuilderConfigurationError('baseUrl must be a valid URL');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new SkillBuilderConfigurationError('baseUrl must not contain credentials, query, or fragment data');
  }
  const development = process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && development && loopback.has(base.hostname))) {
    throw new SkillBuilderConfigurationError('baseUrl must use HTTPS outside loopback development');
  }
  return base;
}

function validateSafePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FILE_PATH_LENGTH) {
    throw new SkillBuilderValidationError(`${field} must be a bounded relative path`);
  }
  if (hasLoneSurrogate(value) || value !== value.normalize('NFC') || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes(':') || value.includes('//') || CONTROL_CHARACTER.test(value)) {
    throw new SkillBuilderValidationError(`${field} is not a safe relative path`);
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED_SEGMENT.test(segment) || RESERVED_SEGMENT_NAMES.has(segment.toLocaleLowerCase('en-US')) || segment.toLocaleLowerCase('en-US') === '.mcp.json') {
      throw new SkillBuilderValidationError(`${field} contains an unsafe path segment`);
    }
    if (utf8Bytes(segment) > 255) throw new SkillBuilderValidationError(`${field} contains an oversized path segment`);
  }
  return value;
}

function validatePatchContent(value: unknown, field: string): string {
  if (typeof value !== 'string' || hasLoneSurrogate(value)) throw new SkillBuilderValidationError(`${field} must be valid text`);
  const bytes = utf8Bytes(value);
  if (bytes > MAX_PATCH_CONTENT_BYTES) throw new SkillBuilderValidationError(`${field} exceeds ${MAX_PATCH_CONTENT_BYTES} bytes`);
  return value;
}

function boundedIdentifier(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new SkillBuilderValidationError(`${field} must be a string`);
  const result = value.trim();
  if (result.length === 0 || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new SkillBuilderValidationError(`${field} is invalid`);
  }
  return result;
}

function boundedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new SkillBuilderValidationError('revision must be a bounded non-negative integer');
  }
  return value as number;
}

function boundedFileSize(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_CONTEXT_FILE_BYTES) {
    throw new SkillBuilderValidationError(`${field} is outside the file size limit`);
  }
  return value as number;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > maximum) {
    throw new SkillBuilderError('UPSTREAM_RESPONSE_TOO_LARGE', 'authoring service response exceeded the configured limit');
  }
  if (!response.body) {
    const text = await response.text();
    if (utf8Bytes(text) > maximum) throw new SkillBuilderError('UPSTREAM_RESPONSE_TOO_LARGE', 'authoring service response exceeded the configured limit');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new SkillBuilderError('UPSTREAM_RESPONSE_TOO_LARGE', 'authoring service response exceeded the configured limit');
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SkillBuilderError('UPSTREAM_SCHEMA_ERROR', 'authoring service response was not valid UTF-8');
  }
}
