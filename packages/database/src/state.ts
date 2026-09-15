import type {
  Policy,
  RegistryState,
  ScannerId,
  ScannerPolicy,
  StateRepository,
} from '../../contracts/src/index';

export class StateRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StateRepositoryError';
    this.code = code;
  }
}

export class UnsupportedTransportError extends StateRepositoryError {
  constructor(message = 'The configured persistence transport is unsupported') {
    super('UNSUPPORTED_TRANSPORT', message);
    this.name = 'UnsupportedTransportError';
  }
}

export class ConcurrentStateUpdateError extends StateRepositoryError {
  constructor(message = 'The state changed while the transaction was being applied') {
    super('VERSION_CONFLICT', message);
    this.name = 'ConcurrentStateUpdateError';
  }
}

export interface DefaultRegistryStateOptions {
  production?: boolean;
  allowUnscanned?: boolean;
  policyRevision?: string;
  evidenceMaxAgeSeconds?: number;
}

/** Optional persisted revision used by the HTTP CAS transport. */
export type VersionedRegistryState = RegistryState & { metadataRevision?: number };

const SCANNER_IDS: readonly ScannerId[] = [
  'cisco-skill-scanner',
  'nvidia-skillspector',
  'skillsguard',
];

function scannerPolicies(production: boolean): ScannerPolicy[] {
  const modes: ScannerPolicy['mode'][] = production
    ? ['required', 'advisory', 'advisory']
    : ['disabled', 'disabled', 'disabled'];
  return SCANNER_IDS.map((id, index) => ({
    id,
    mode: modes[index]!,
    blockSeverities: ['high', 'critical'],
    timeoutSeconds: 120,
  }));
}

function initialPolicy(options: DefaultRegistryStateOptions): Policy {
  return {
    revision: options.policyRevision ?? 'policy-initial',
    scanners: scannerPolicies(options.production ?? true),
    allowUnscanned: options.allowUnscanned ?? false,
    evidenceMaxAgeSeconds: options.evidenceMaxAgeSeconds ?? 86_400,
  };
}

/** Production-safe initial state. Development must opt in explicitly. */
export function defaultRegistryState(
  options: DefaultRegistryStateOptions = {},
): RegistryState {
  return {
    schemaVersion: 1,
    skills: [],
    packs: [],
    jobs: [],
    scans: [],
    policy: initialPolicy(options),
    upstreams: [],
    storageAttempts: [],
    meteredReservationOwners: [],
    authorizations: [],
    installReceiptTickets: [],
    installReceipts: [],
    grants: [],
    audit: [],
  };
}

export function cloneRegistryState(state: RegistryState): RegistryState {
  try {
    return JSON.parse(JSON.stringify(state)) as RegistryState;
  } catch {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state is not JSON serializable');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const STORAGE_ATTEMPT_STATES = new Set(['pending', 'committed', 'orphaned', 'recovering', 'releasing', 'released']);
const METERED_RESERVATION_OWNER_STATES = new Set(['owned', 'releasing', 'released']);

function validScannerPolicy(value: unknown): value is ScannerPolicy {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    SCANNER_IDS.includes(value.id as ScannerId) &&
    (value.mode === 'disabled' || value.mode === 'advisory' || value.mode === 'required') &&
    isStringArray(value.blockSeverities) &&
    value.blockSeverities.every((severity) => SEVERITIES.has(severity)) &&
    typeof value.timeoutSeconds === 'number' &&
    Number.isFinite(value.timeoutSeconds) &&
    value.timeoutSeconds > 0
  );
}

function validPolicy(value: unknown): value is Policy {
  if (!isObject(value)) return false;
  return (
    typeof value.revision === 'string' &&
    Array.isArray(value.scanners) &&
    value.scanners.every(validScannerPolicy) &&
    new Set(value.scanners.map((scanner) => scanner.id)).size === value.scanners.length &&
    typeof value.allowUnscanned === 'boolean' &&
    typeof value.evidenceMaxAgeSeconds === 'number' &&
    Number.isFinite(value.evidenceMaxAgeSeconds) &&
    value.evidenceMaxAgeSeconds >= 0 &&
    (value.hooks === undefined || Array.isArray(value.hooks))
  );
}

function validStorageAttempt(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const valid = (
    typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.organizationId === 'string' && value.organizationId.length > 0 &&
    typeof value.reservationKey === 'string' && value.reservationKey.length > 0 &&
    typeof value.digest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value.digest) &&
    Number.isSafeInteger(value.size) && (value.size as number) >= 0 &&
    typeof value.state === 'string' && STORAGE_ATTEMPT_STATES.has(value.state) &&
    (value.reservationGeneration === undefined || (Number.isSafeInteger(value.reservationGeneration) && (value.reservationGeneration as number) >= 1)) &&
    (value.billingCorrection === undefined || value.billingCorrection === 'release-pending' || value.billingCorrection === 'restore-pending') &&
    typeof value.createdAt === 'string' && value.createdAt.length > 0 &&
    typeof value.updatedAt === 'string' && value.updatedAt.length > 0 &&
    (value.objectKey === undefined || (typeof value.objectKey === 'string' && value.objectKey.length > 0)) &&
    (value.jobId === undefined || (typeof value.jobId === 'string' && value.jobId.length > 0)) &&
    (value.recoveryToken === undefined || (typeof value.recoveryToken === 'string' && value.recoveryToken.length > 0 && value.recoveryToken.length <= 256)) &&
    (value.recoveryStartedAt === undefined || (typeof value.recoveryStartedAt === 'string' && value.recoveryStartedAt.length > 0 && value.recoveryStartedAt.length <= 64))
  );
  if (!valid) return false;
  if (value.billingCorrection === 'restore-pending' && value.state !== 'orphaned') return false;
  if (value.billingCorrection === 'release-pending' && value.state !== 'recovering' && value.state !== 'releasing' && value.state !== 'orphaned') return false;
  if (value.state === 'recovering' || value.state === 'releasing') {
    return value.recoveryToken !== undefined && value.recoveryStartedAt !== undefined;
  }
  return value.recoveryToken === undefined && value.recoveryStartedAt === undefined;
}

function validMeteredReservationOwner(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  return (
    typeof value.reservationKey === 'string' && value.reservationKey.length > 0 && value.reservationKey.length <= 512 &&
    /^private-skills:scan:[^\s]{1,512}$/u.test(value.reservationKey) &&
    typeof value.state === 'string' && METERED_RESERVATION_OWNER_STATES.has(value.state) &&
    typeof value.updatedAt === 'string' && value.updatedAt.length > 0 && value.updatedAt.length <= 64 &&
    (value.jobId === undefined || (typeof value.jobId === 'string' && value.jobId.length > 0 && value.jobId.length <= 256)) &&
    (value.releaseToken === undefined || (typeof value.releaseToken === 'string' && value.releaseToken.length > 0 && value.releaseToken.length <= 256)) &&
    (value.reservationGeneration === undefined || (typeof value.reservationGeneration === 'number' && Number.isSafeInteger(value.reservationGeneration) && value.reservationGeneration >= 1)) &&
    (value.state !== 'releasing' || value.releaseToken !== undefined)
  );
}

export function assertRegistryState(value: unknown): asserts value is RegistryState {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an unsupported schema version');
  }
  const arrayFields = [
    'skills',
    'packs',
    'jobs',
    'scans',
    'upstreams',
    'authorizations',
    'grants',
    'audit',
  ] as const;
  if (arrayFields.some((field) => !Array.isArray(value[field]))) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid collection');
  }
  if (value.drafts !== undefined && !Array.isArray(value.drafts)) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid drafts collection');
  }
  // Analytics was added after the first state schema.  Keep these collections
  // optional so older persisted documents remain readable, while rejecting a
  // malformed value when a newer writer has supplied one.
  for (const field of ['installReceiptTickets', 'installReceipts'] as const) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid analytics collection');
    }
  }
  if (value.builderSessions !== undefined && !Array.isArray(value.builderSessions)) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid builder session collection');
  }
  if (value.tenantReviewDispatches !== undefined) {
    if (!Array.isArray(value.tenantReviewDispatches) || value.tenantReviewDispatches.length > 4_096 || value.tenantReviewDispatches.some((record) => !validTenantReviewDispatchRecord(record))) {
      throw new StateRepositoryError('INVALID_STATE', 'Registry state has invalid tenant review dispatch records');
    }
  }
  if (value.tenantReviewDispatchCursor !== undefined && !validTenantReviewDispatchCursor(value.tenantReviewDispatchCursor)) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid tenant review dispatch cursor');
  }
  if (value.storageAttempts !== undefined && !Array.isArray(value.storageAttempts)) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid storage attempt collection');
  }
  if (value.storageAttempts !== undefined) {
    const storageAttemptIds = new Set<string>();
    if (value.storageAttempts.some((attempt) => {
      if (!validStorageAttempt(attempt)) return true;
      if (storageAttemptIds.has(attempt.id as string)) return true;
      storageAttemptIds.add(attempt.id as string);
      return false;
    })) {
      throw new StateRepositoryError('INVALID_STATE', 'Registry state has invalid storage attempt metadata');
    }
  }
  if (value.meteredReservationOwners !== undefined && !Array.isArray(value.meteredReservationOwners)) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid metered reservation owner collection');
  }
  if (value.meteredReservationOwners !== undefined) {
    const reservationKeys = new Set<string>();
    if (value.meteredReservationOwners.length > 100_000 || value.meteredReservationOwners.some((owner) => {
      if (!validMeteredReservationOwner(owner)) return true;
      if (reservationKeys.has(owner.reservationKey as string)) return true;
      reservationKeys.add(owner.reservationKey as string);
      return false;
    })) {
      throw new StateRepositoryError('INVALID_STATE', 'Registry state has invalid metered reservation owner metadata');
    }
  }
  if (!validPolicy(value.policy)) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid scanner policy');
  }
  if (
    value.metadataRevision !== undefined &&
    (typeof value.metadataRevision !== 'number' ||
      !Number.isSafeInteger(value.metadataRevision) ||
      value.metadataRevision < 0)
  ) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state has an invalid metadata revision');
  }
}

function validTenantReviewDispatchRecord(value: unknown): boolean {
  if (!isObject(value) || typeof value.operationKey !== 'string' || value.operationKey.length === 0 || value.operationKey.length > 256 ||
      (value.state !== 'claimed' && value.state !== 'starting' && value.state !== 'completed' && value.state !== 'uncertain') || typeof value.leaseExpiresAt !== 'string' || value.leaseExpiresAt.length > 64 ||
      typeof value.updatedAt !== 'string' || value.updatedAt.length > 64) return false;
  if (value.claimToken !== undefined && (typeof value.claimToken !== 'string' || value.claimToken.length === 0 || value.claimToken.length > 256)) return false;
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 256)) return false;
  if (value.startingAt !== undefined && (typeof value.startingAt !== 'string' || value.startingAt.length > 64)) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== 'string' || value.completedAt.length > 64)) return false;
  if (value.uncertainAt !== undefined && (typeof value.uncertainAt !== 'string' || value.uncertainAt.length > 64)) return false;
  if (value.state === 'claimed' && value.claimToken === undefined) return false;
  if (value.state !== 'claimed' && value.state !== 'starting' && value.claimToken !== undefined) return false;
  if (value.state === 'starting' && value.startingAt === undefined) return false;
  return value.state !== 'uncertain' || value.uncertainAt !== undefined;
}

function validTenantReviewDispatchCursor(value: unknown): boolean {
  if (!isObject(value) || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.day) ||
      typeof value.updatedAt !== 'string' || value.updatedAt.length > 64 ||
      !Array.isArray(value.pendingOrganizationIds) || !Array.isArray(value.completedOrganizationIds) ||
      value.pendingOrganizationIds.length > 4_096 || value.completedOrganizationIds.length > 4_096 ||
      (value.blockedOrganizationIds !== undefined && (!Array.isArray(value.blockedOrganizationIds) || value.blockedOrganizationIds.length > 4_096))) return false;
  const validIds = (ids: unknown[]): boolean => ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id));
  const blocked = value.blockedOrganizationIds ?? [];
  return validIds(value.pendingOrganizationIds) && validIds(value.completedOrganizationIds) && validIds(blocked) &&
    new Set([...value.pendingOrganizationIds, ...value.completedOrganizationIds, ...blocked]).size === value.pendingOrganizationIds.length + value.completedOrganizationIds.length + blocked.length;
}

export function stateRevision(state: RegistryState): number {
  const revision = (state as VersionedRegistryState).metadataRevision;
  return revision === undefined ? 0 : revision;
}

export function advanceStateRevision(state: RegistryState, previousRevision = stateRevision(state)): number {
  const next = previousRevision + 1;
  if (!Number.isSafeInteger(next)) {
    throw new StateRepositoryError('INVALID_STATE', 'Registry state revision exhausted');
  }
  (state as VersionedRegistryState).metadataRevision = next;
  return next;
}

export function validateAndCloneState(value: unknown): RegistryState {
  assertRegistryState(value);
  const cloned = cloneRegistryState(value);
  assertRegistryState(cloned);
  return cloned;
}

export function assertSynchronousResult(value: unknown): void {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    throw new StateRepositoryError('ASYNC_UPDATER', 'StateRepository.transaction updates must be synchronous');
  }
}

export class OrganizationMutex {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(organizationId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(organizationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(organizationId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(organizationId) === current) this.queues.delete(organizationId);
    }
  }
}

export type RepositoryFactory = (organizationId: string) => RegistryState;
export interface StateRepositoryConstructorOptions { stateFactory?: RepositoryFactory }
export type { RegistryState, StateRepository };
