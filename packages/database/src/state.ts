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
    authorizations: [],
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
