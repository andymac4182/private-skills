/*
 * Logical backup/restore for the private registry.
 *
 * This module deliberately works through StateRepository and BlobStore.  The
 * command-line entry point wires those interfaces to the local Node adapters;
 * hosted operators must supply an already-authorized, isolated destination.
 * It never deletes from a source or target and never prints manifest contents.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  BlobStore,
  Digest,
  RegistryState,
  StateRepository,
  StoredBlob,
} from '../packages/contracts/src/index.js';
import {
  assertRegistryState,
  cloneRegistryState,
  createFileStateRepository,
  defaultRegistryState,
  stateRevision,
} from '../packages/database/src/index.js';
import { DEFAULT_STORAGE_MAX_BYTES, digestBytes, isSha256Digest } from '../packages/storage/src/index.js';

export const LOGICAL_BACKUP_VERSION = 1 as const;
export const MAX_BACKUP_OBJECTS = 10_000;
export const MAX_BACKUP_OBJECT_BYTES = DEFAULT_STORAGE_MAX_BYTES;
/** Default aggregate byte budget for all referenced objects in one rehearsal. */
export const MAX_BACKUP_TOTAL_OBJECT_BYTES = 512 * 1024 * 1024;
/** Operators may raise the budget only within this bounded process limit. */
export const HARD_MAX_BACKUP_TOTAL_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_STATE_DEPTH = 64;
export const MAX_STATE_NODES = 200_000;
export const MAX_STATE_STRING_BYTES = MAX_BACKUP_MANIFEST_BYTES;

export type DeletionFenceKind =
  | 'offline-test'
  | 'provider-snapshot'
  | 'delete-disabled'
  | 'operator-quiescence';

export type CaptureConsistency =
  | 'offline-filesystem'
  | 'single-row-read'
  | 'postgres-mvcc-snapshot'
  | 'provider-snapshot';

export type LocationKind = 'filesystem' | 'postgres' | 'object-store' | 'http' | 'composite';

/**
 * A location is a provider resource identity, never a credential-bearing URL.
 * Filesystem locations additionally carry canonical private roots so the
 * backup directory and target cannot accidentally overlap them.
 */
export interface QualifiedLocation {
  kind: LocationKind;
  identity: string;
  roots?: string[];
}

export interface DeletionFenceEvidence {
  /** `offline` is only for hermetic tests and local development. */
  scope: 'offline' | 'hosted';
  kind: DeletionFenceKind;
  /** A non-secret operator record, change id, or test evidence identifier. */
  evidenceRef: string;
  observedAt: string;
}

export interface LogicalBackupObject {
  /** The exact key found in the source metadata snapshot. */
  key: string;
  digest: Digest;
  size: number;
  /** Relative path inside the backup directory. */
  archivePath: string;
  /** JSON paths that referenced this key in the captured state. */
  references: string[];
}

export interface LogicalBackupManifest {
  schemaVersion: typeof LOGICAL_BACKUP_VERSION;
  organizationId: string;
  sourceIdentity: string;
  sourceLocation: QualifiedLocation;
  capturedAt: string;
  captureConsistency: CaptureConsistency;
  metadataRevision: number;
  deletionFence: DeletionFenceEvidence;
  state: RegistryState;
  objects: LogicalBackupObject[];
}

export interface CreateLogicalBackupOptions {
  sourceRepository: StateRepository;
  sourceBlobs: BlobStore;
  organizationId: string;
  sourceIdentity: string;
  sourceLocation: QualifiedLocation;
  backupDirectory: string;
  captureConsistency: CaptureConsistency;
  deletionFence: DeletionFenceEvidence;
  /** Aggregate referenced-object budget; bounded by the process hard limit. */
  maxTotalObjectBytes?: number;
  now?: () => Date;
}

export interface CreateLogicalBackupResult {
  manifest: LogicalBackupManifest;
  manifestPath: string;
  objectCount: number;
}

export interface RestoreLogicalBackupOptions {
  targetRepository: StateRepository;
  targetBlobs: BlobStore;
  organizationId: string;
  targetIdentity: string;
  targetLocation: QualifiedLocation;
  backupDirectory: string;
  /** Aggregate backup-object budget; bounded by the process hard limit. */
  maxTotalObjectBytes?: number;
  /** The caller must explicitly attest that this destination is isolated. */
  targetIsolated: true;
  /**
   * Repository-specific atomic seed for an empty isolated destination. The
   * portable transaction interface intentionally cannot preserve an imported
   * revision, so restore refuses to continue without this explicit capability.
   */
  targetSeed: IsolatedStateSeed;
}

export interface IsolatedStateSeed {
  readonly kind: 'isolated-empty-state-v1';
  /** Persist the supplied state, including its exact metadataRevision. */
  seed(organizationId: string, state: RegistryState): Promise<void>;
}

export interface ReadLogicalBackupOptions {
  /** Aggregate backup-object budget; bounded by the process hard limit. */
  maxTotalObjectBytes?: number;
}

/**
 * Qualified local seed capability. The FileStateRepository constructor's
 * `initial` path writes the complete state atomically; the caller must still
 * prove the directory is an isolated restore destination before using it.
 */
export function createFileStateSeed(directory: string): IsolatedStateSeed {
  const targetDirectory = resolve(nonEmpty(directory, 'target seed directory', 4_096));
  return {
    kind: 'isolated-empty-state-v1',
    async seed(organizationId, state) {
      const seeded = createFileStateRepository({
        directory: targetDirectory,
        initial: { [organizationId]: cloneRegistryState(state) },
      });
      await seeded.read(organizationId);
    },
  };
}

export interface RestoreLogicalBackupResult {
  organizationId: string;
  sourceIdentity: string;
  targetIdentity: string;
  metadataRevision: number;
  objectCount: number;
  remappedObjectCount: number;
  keyMap: Readonly<Record<string, string>>;
}

export type RestoreBackupErrorCode =
  | 'INVALID_OPTIONS'
  | 'FENCE_REQUIRED'
  | 'SOURCE_TARGET_SAME'
  | 'BACKUP_EXISTS'
  | 'MANIFEST_INVALID'
  | 'PERMISSION'
  | 'OBJECT_MISSING'
  | 'OBJECT_DIGEST_MISMATCH'
  | 'SIZE_LIMIT'
  | 'TARGET_NOT_EMPTY'
  | 'REVISION_UNSUPPORTED'
  | 'TARGET_DIGEST_MISMATCH'
  | 'TARGET_STATE_MISMATCH';

export class RestoreBackupError extends Error {
  readonly code: RestoreBackupErrorCode;

  constructor(code: RestoreBackupErrorCode, message: string) {
    super(message);
    this.name = 'RestoreBackupError';
    this.code = code;
  }
}

const MANIFEST_FILE = 'manifest.json';
const OBJECTS_DIRECTORY = 'objects';
const LOCATION_KINDS: readonly LocationKind[] = ['filesystem', 'postgres', 'object-store', 'http', 'composite'];
const MAX_ID_LENGTH = 512;
const MAX_EVIDENCE_LENGTH = 2_048;
const MAX_KEY_LENGTH = 4_096;

function fail(code: RestoreBackupErrorCode, message: string): never {
  throw new RestoreBackupError(code, message);
}

function nonEmpty(value: unknown, field: string, maxLength = MAX_ID_LENGTH): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_OPTIONS', `${field} must be a bounded non-empty string`);
  }
  return value;
}

function validateLocationShape(value: unknown, field: string): QualifiedLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_OPTIONS', `${field} must identify a qualified resource location`);
  }
  const candidate = value as Partial<QualifiedLocation>;
  const kind = candidate.kind;
  if (!LOCATION_KINDS.includes(kind as LocationKind)) fail('INVALID_OPTIONS', `${field} has an unsupported location kind`);
  const identity = nonEmpty(candidate.identity, `${field}.identity`, MAX_ID_LENGTH);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(identity) || /(?:bearer|token|password|secret)=/iu.test(identity)) {
    fail('INVALID_OPTIONS', `${field}.identity must not contain a URL or credential`);
  }
  if (candidate.roots !== undefined && (!Array.isArray(candidate.roots) || candidate.roots.length === 0 || candidate.roots.length > 8)) {
    fail('INVALID_OPTIONS', `${field}.roots must contain one to eight filesystem roots`);
  }
  if (kind !== 'filesystem' && candidate.roots !== undefined) {
    fail('INVALID_OPTIONS', `${field}.roots are only valid for filesystem locations`);
  }
  if (kind === 'filesystem' && (!candidate.roots || candidate.roots.length === 0)) {
    fail('INVALID_OPTIONS', `${field}.roots are required for a filesystem location`);
  }
  const roots = candidate.roots?.map((root, index) => nonEmpty(root, `${field}.roots[${index}]`, 4_096));
  return { kind: kind as LocationKind, identity, ...(roots ? { roots } : {}) };
}

async function canonicalPrivateRoot(value: string, field: string): Promise<string> {
  const resolved = resolve(value);
  try {
    await assertNoSymlinkParents(resolved, field);
    const details = await lstat(resolved);
    if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
      fail('PERMISSION', `${field} must be a private regular directory`);
    }
    const canonical = await realpath(resolved);
    const canonicalDetails = await lstat(canonical);
    if (!canonicalDetails.isDirectory() || canonicalDetails.isSymbolicLink() || (canonicalDetails.mode & 0o077) !== 0) {
      fail('PERMISSION', `${field} must be a private regular directory`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof RestoreBackupError) throw error;
    fail('PERMISSION', `${field} is unavailable or not private`);
  }
}

async function assertNoSymlinkParents(value: string, field: string): Promise<void> {
  // Check every existing ancestor before resolving the path.  A canonical
  // leaf alone is insufficient when an operator supplied a symlinked parent:
  // the apparent location could change outside the attested root.  Missing
  // leaves are allowed here because callers use this check before mkdir.
  let ancestor = resolve(value);
  while (true) {
    try {
      const ancestorDetails = await lstat(ancestor);
      // macOS exposes the temporary directory through the stable `/var` (and
      // sometimes `/tmp`) alias. Those platform aliases are safe to cross;
      // an application-supplied symlink below them remains rejected.
      if (ancestorDetails.isSymbolicLink() && ancestor !== '/var' && ancestor !== '/tmp') {
        fail('PERMISSION', `${field} has a symbolic-link parent`);
      }
      if (ancestor === dirname(ancestor)) break;
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code !== 'ENOENT') throw error;
      if (ancestor === dirname(ancestor)) break;
    }
    ancestor = dirname(ancestor);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relativePath = relative(left, right);
  const reversePath = relative(right, left);
  const contained = (value: string) => value === '' || (!value.startsWith('..') && !isAbsolute(value));
  return contained(relativePath) || contained(reversePath);
}

function locationsOverlap(left: QualifiedLocation, right: QualifiedLocation): boolean {
  if (left.identity === right.identity) return true;
  for (const leftRoot of left.roots ?? []) {
    for (const rightRoot of right.roots ?? []) {
      if (pathsOverlap(leftRoot, rightRoot)) return true;
    }
  }
  return false;
}

async function canonicalLocation(value: unknown, field: string): Promise<QualifiedLocation> {
  const shape = validateLocationShape(value, field);
  if (!shape.roots) return shape;
  const roots = await Promise.all(shape.roots.map((root, index) => canonicalPrivateRoot(root, `${field}.roots[${index}]`)));
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      if (pathsOverlap(roots[index]!, roots[other]!)) fail('SOURCE_TARGET_SAME', `${field}.roots overlap`);
    }
  }
  return { ...shape, roots };
}

function validateFence(fence: DeletionFenceEvidence): DeletionFenceEvidence {
  if (!fence || typeof fence !== 'object') fail('FENCE_REQUIRED', 'a deletion/lifecycle fence is required');
  const kind = (fence as DeletionFenceEvidence).kind;
  const scope = (fence as DeletionFenceEvidence).scope;
  const evidenceRef = nonEmpty((fence as DeletionFenceEvidence).evidenceRef, 'deletion fence evidenceRef', MAX_EVIDENCE_LENGTH);
  const observedAt = nonEmpty((fence as DeletionFenceEvidence).observedAt, 'deletion fence observedAt', 128);
  const validKinds: readonly DeletionFenceKind[] = [
    'offline-test',
    'provider-snapshot',
    'delete-disabled',
    'operator-quiescence',
  ];
  if (!validKinds.includes(kind) || (scope !== 'offline' && scope !== 'hosted')) {
    fail('FENCE_REQUIRED', 'the deletion/lifecycle fence has an unsupported scope or mechanism');
  }
  if (scope === 'offline' && kind !== 'offline-test') {
    fail('FENCE_REQUIRED', 'offline captures must use the offline-test fence mechanism');
  }
  if (scope === 'hosted' && kind === 'offline-test') {
    fail('FENCE_REQUIRED', 'hosted captures require provider or operator deletion/lifecycle evidence');
  }
  return { scope, kind, evidenceRef, observedAt };
}

function safeStorageKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH &&
    !value.startsWith('/') && !value.endsWith('/') && !value.includes('\\') &&
    !value.includes(':') && !value.includes('//') && !value.includes('\u0000') &&
    !value.split('/').some((segment) => segment === '.' || segment === '..');
}

function validBlobRecord(value: unknown): value is StoredBlob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return safeStorageKey(candidate.key) && isSha256Digest(candidate.digest) &&
    typeof candidate.size === 'number' && Number.isSafeInteger(candidate.size) && candidate.size >= 0;
}

/**
 * A StoredBlob is deliberately recognized by its complete shape.  Several
 * persisted authoring records also have a `key` and a `digest` (the
 * idempotency/publication history), while compact file-manifest entries have
 * a `digest` and `size`.  Treating any one of those fields as a blob marker
 * makes draft history look like an invalid object and either omits the
 * sealed artifact or aborts the backup.  Requiring all three fields lets the
 * recursive walk discover current and historical draft artifacts while
 * preserving the surrounding metadata records verbatim.
 */
function hasStoredBlobShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return 'key' in candidate && 'digest' in candidate && 'size' in candidate;
}

function totalObjectByteBudget(value: unknown, field: string): number {
  if (value === undefined) return MAX_BACKUP_TOTAL_OBJECT_BYTES;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > HARD_MAX_BACKUP_TOTAL_OBJECT_BYTES
  ) {
    fail('INVALID_OPTIONS', `${field} must be a positive bounded byte budget`);
  }
  return value;
}

function assertAggregateObjectBytes(sizes: readonly number[], limit: number, field: string): number {
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > limit - total) {
      fail('SIZE_LIMIT', `${field} exceed the aggregate restore limit`);
    }
    total += size;
  }
  return total;
}

interface StateBudget {
  nodes: number;
  stringBytes: number;
}

function assertStateBudget(value: unknown, depth = 0, budget: StateBudget = { nodes: 0, stringBytes: 0 }, seen = new WeakSet<object>()): void {
  if (depth > MAX_STATE_DEPTH) fail('SIZE_LIMIT', 'state nesting exceeds the restore limit');
  if (typeof value === 'string') {
    budget.stringBytes += value.length * 2;
    if (value.length > MAX_STATE_STRING_BYTES || budget.stringBytes > MAX_STATE_STRING_BYTES) {
      fail('SIZE_LIMIT', 'state strings exceed the restore limit');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('MANIFEST_INVALID', 'state contains a cyclic object');
  seen.add(value);
  budget.nodes += 1;
  if (budget.nodes > MAX_STATE_NODES) fail('SIZE_LIMIT', 'state entries exceed the restore limit');
  if (Array.isArray(value)) {
    if (value.length > MAX_STATE_NODES) fail('SIZE_LIMIT', 'state collection exceeds the restore limit');
    for (const entry of value) assertStateBudget(entry, depth + 1, budget, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertStateBudget(key, depth + 1, budget, seen);
    assertStateBudget(entry, depth + 1, budget, seen);
  }
}

function boundedJson(value: unknown, field: string, maxBytes: number, pretty = false): { text: string; bytes: Uint8Array } {
  let text: string;
  try {
    text = JSON.stringify(value, undefined, pretty ? 2 : undefined);
  } catch {
    fail('MANIFEST_INVALID', `${field} is not JSON serializable`);
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) fail('SIZE_LIMIT', `${field} exceeds the restore limit`);
  return { text, bytes };
}

interface BlobReference {
  key: string;
  digest: Digest;
  size: number;
  path: string;
}

function collectBlobReferences(value: unknown, path = 'state', seen = new WeakSet<object>()): BlobReference[] {
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) fail('MANIFEST_INVALID', 'state contains a cyclic object');
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectBlobReferences(entry, `${path}[${index}]`, seen));
  }
  const record = value as Record<string, unknown>;
  if (hasStoredBlobShape(record)) {
    if (!validBlobRecord(record)) fail('MANIFEST_INVALID', `invalid sealed-object reference at ${path}`);
    return [{ key: record.key, digest: record.digest, size: record.size, path }];
  }
  return Object.entries(record).flatMap(([key, entry]) => collectBlobReferences(entry, `${path}.${key}`, seen));
}

function assertOrganization(state: RegistryState, organizationId: string): void {
  const visit = (value: unknown, seen = new WeakSet<object>()): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) fail('MANIFEST_INVALID', 'state contains a cyclic object');
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, seen);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.organizationId !== undefined && record.organizationId !== organizationId) {
      fail('MANIFEST_INVALID', 'state contains a cross-organization record');
    }
    for (const entry of Object.values(record)) visit(entry, seen);
  };
  visit(state);
}

function keyArchivePath(key: string): string {
  const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');
  return `${OBJECTS_DIRECTORY}/${keyHash}.bin`;
}

function pathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function pathInsideOrSame(root: string, candidate: string): boolean {
  return root === candidate || pathInside(root, candidate);
}

/**
 * Resolve a backup member without following a symlink in the backup tree.
 * The lexical containment check catches traversal; checking every descendant
 * with lstat catches an `objects/` symlink; canonical parent containment also
 * protects against a provider/operator replacing a parent during validation.
 */
async function checkedBackupPath(
  root: string,
  memberPath: string,
  missingCode: 'MANIFEST_INVALID' | 'OBJECT_MISSING',
): Promise<string> {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, memberPath);
  if (!pathInside(resolvedRoot, candidate)) fail('MANIFEST_INVALID', 'backup path escapes its directory');
  try {
    const rootDetails = await lstat(resolvedRoot);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink() || (rootDetails.mode & 0o077) !== 0) {
      fail('PERMISSION', 'backup root is not a private directory');
    }
    const pathParts = relative(resolvedRoot, candidate).split(sep).filter(Boolean);
    let current = resolvedRoot;
    for (const [index, part] of pathParts.entries()) {
      current = join(current, part);
      const details = await lstat(current);
      if (details.isSymbolicLink()) fail('PERMISSION', 'backup path contains a symbolic link');
      if (details.mode & 0o077) fail('PERMISSION', 'backup path is not private');
      if (index < pathParts.length - 1 && !details.isDirectory()) fail(missingCode, 'backup path parent is not a directory');
    }
    const canonicalRoot = await realpath(resolvedRoot);
    const canonicalParent = await realpath(dirname(candidate));
    if (!pathInsideOrSame(canonicalRoot, canonicalParent)) fail('PERMISSION', 'backup path resolves outside its directory');
    return candidate;
  } catch (error) {
    if (error instanceof RestoreBackupError) throw error;
    fail(missingCode, 'backup path is unavailable');
  }
}

async function ensurePrivateDirectory(directory: string, code: RestoreBackupErrorCode = 'PERMISSION'): Promise<void> {
  try {
    await assertNoSymlinkParents(directory, 'backup directory');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
      fail(code, 'backup directory is not a private regular directory');
    }
    await chmod(directory, 0o700);
    const protectedDetails = await lstat(directory);
    if (!protectedDetails.isDirectory() || protectedDetails.isSymbolicLink() || (protectedDetails.mode & 0o077) !== 0) {
      fail(code, 'backup directory is not a private regular directory');
    }
  } catch (error) {
    if (error instanceof RestoreBackupError) throw error;
    fail(code, 'unable to create a private backup directory');
  }
}

async function privateFile(
  path: string,
  bytes: Uint8Array | string,
  overwrite = false,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  const byteLength = typeof bytes === 'string' ? new TextEncoder().encode(bytes).byteLength : bytes.byteLength;
  if (byteLength > maxBytes) fail('SIZE_LIMIT', 'private file exceeds the restore limit');
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, overwrite ? 'w' : 'wx', 0o600);
    if (typeof bytes === 'string') await handle.writeFile(bytes, 'utf8');
    else await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) fail('PERMISSION', 'backup file is not a private regular file');
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the original failure */ }
    }
    // The temporary name is random and never points at a source object.  Do
    // not remove provider objects as part of a failed backup or restore.
    try { await unlink(temporary); } catch { /* a failed temporary cleanup is harmless */ }
    if (error instanceof RestoreBackupError) throw error;
    fail('PERMISSION', 'unable to write a private backup file');
  }
}

async function ensureEmptyBackupDirectory(directory: string, sourceLocation: QualifiedLocation): Promise<string> {
  const resolved = resolve(directory);
  try {
    const details = await lstat(resolved);
    if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
      fail('BACKUP_EXISTS', 'backup destination is not a private directory');
    }
    const entries = await readdir(resolved);
    if (entries.length > 0) fail('BACKUP_EXISTS', 'backup destination already contains data');
  } catch (error) {
    if (error instanceof RestoreBackupError) throw error;
    await ensurePrivateDirectory(resolved);
  }
  await ensurePrivateDirectory(resolved);
  const canonical = await canonicalPrivateRoot(resolved, 'backupDirectory');
  if ((sourceLocation.roots ?? []).some((root) => pathsOverlap(canonical, root))) {
    fail('SOURCE_TARGET_SAME', 'backup destination overlaps the source location');
  }
  return canonical;
}

function refsByKey(state: RegistryState): Map<string, BlobReference[]> {
  const result = new Map<string, BlobReference[]>();
  for (const reference of collectBlobReferences(state)) {
    const existing = result.get(reference.key) ?? [];
    existing.push(reference);
    result.set(reference.key, existing);
  }
  for (const references of result.values()) {
    const first = references[0]!;
    if (references.some((reference) => reference.digest !== first.digest || reference.size !== first.size)) {
      fail('MANIFEST_INVALID', 'one sealed key is referenced with conflicting digest or size');
    }
  }
  return result;
}

export async function createLogicalBackup(options: CreateLogicalBackupOptions): Promise<CreateLogicalBackupResult> {
  const organizationId = nonEmpty(options.organizationId, 'organizationId');
  const sourceIdentity = nonEmpty(options.sourceIdentity, 'sourceIdentity');
  const sourceLocation = await canonicalLocation(options.sourceLocation, 'sourceLocation');
  const backupDirectory = resolve(nonEmpty(options.backupDirectory, 'backupDirectory', 4_096));
  const maxTotalObjectBytes = totalObjectByteBudget(options.maxTotalObjectBytes, 'maxTotalObjectBytes');
  if (!options.sourceRepository || !options.sourceBlobs) fail('INVALID_OPTIONS', 'source repository and blob store are required');
  if (!options.captureConsistency) fail('INVALID_OPTIONS', 'capture consistency is required');
  const deletionFence = validateFence(options.deletionFence);
  if (options.captureConsistency === 'offline-filesystem' && deletionFence.scope !== 'offline') {
    fail('FENCE_REQUIRED', 'offline filesystem captures require offline fence evidence');
  }
  if (options.captureConsistency !== 'offline-filesystem' && deletionFence.scope !== 'hosted') {
    fail('FENCE_REQUIRED', 'hosted captures require hosted deletion/lifecycle evidence');
  }
  const backupRoot = await ensureEmptyBackupDirectory(backupDirectory, sourceLocation);

  const capturedState = await options.sourceRepository.read(organizationId);
  assertStateBudget(capturedState);
  const state = cloneRegistryState(capturedState);
  assertStateBudget(state);
  assertRegistryState(state);
  assertOrganization(state, organizationId);
  const revision = stateRevision(state);
  const grouped = refsByKey(state);
  if (grouped.size > MAX_BACKUP_OBJECTS) fail('SIZE_LIMIT', 'backup references exceed the restore limit');
  assertAggregateObjectBytes(
    [...grouped.values()].map((references) => references[0]!.size),
    maxTotalObjectBytes,
    'source object bytes',
  );
  const objects: LogicalBackupObject[] = [];
  const objectsDirectory = join(backupRoot, OBJECTS_DIRECTORY);
  await ensurePrivateDirectory(objectsDirectory);
  let totalObjectBytes = 0;

  for (const [key, references] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    let bytes: Uint8Array;
    try {
      bytes = await options.sourceBlobs.get(key);
    } catch {
      fail('OBJECT_MISSING', 'a referenced source object could not be read');
    }
    if (bytes.byteLength > MAX_BACKUP_OBJECT_BYTES || bytes.byteLength > maxTotalObjectBytes - totalObjectBytes) {
      fail('SIZE_LIMIT', 'source object bytes exceed the aggregate restore limit');
    }
    totalObjectBytes += bytes.byteLength;
    const digest = await digestBytes(bytes);
    const expected = references[0]!;
    if (digest !== expected.digest || bytes.byteLength !== expected.size) {
      fail('OBJECT_DIGEST_MISMATCH', 'a referenced source object failed digest or size verification');
    }
    const archivePath = keyArchivePath(key);
    await privateFile(join(backupRoot, archivePath), bytes, false, MAX_BACKUP_OBJECT_BYTES);
    objects.push({
      key,
      digest: expected.digest,
      size: expected.size,
      archivePath,
      references: references.map((reference) => reference.path).sort(),
    });
  }

  const manifest: LogicalBackupManifest = {
    schemaVersion: LOGICAL_BACKUP_VERSION,
    organizationId,
    sourceIdentity,
    sourceLocation,
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
    captureConsistency: options.captureConsistency,
    metadataRevision: revision,
    deletionFence,
    state,
    objects,
  };
  const manifestPath = join(backupRoot, MANIFEST_FILE);
  const serializedManifest = boundedJson(manifest, 'backup manifest', MAX_BACKUP_MANIFEST_BYTES, true);
  await privateFile(manifestPath, serializedManifest.bytes, false, MAX_BACKUP_MANIFEST_BYTES);
  return { manifest, manifestPath, objectCount: objects.length };
}

function sameObjectEntries(left: LogicalBackupObject[], right: LogicalBackupObject[]): boolean {
  if (left.length !== right.length) return false;
  const normalize = (entry: LogicalBackupObject) => ({
    key: entry.key,
    digest: entry.digest,
    size: entry.size,
    references: [...entry.references].sort(),
  });
  const leftValues = left.map(normalize).sort((a, b) => a.key.localeCompare(b.key));
  const rightValues = right.map(normalize).sort((a, b) => a.key.localeCompare(b.key));
  return JSON.stringify(leftValues) === JSON.stringify(rightValues);
}

async function readPrivateJson(root: string, memberPath: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = await checkedBackupPath(root, memberPath, 'MANIFEST_INVALID');
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
      fail('PERMISSION', 'backup manifest is not a private regular file');
    }
    if (details.size > MAX_BACKUP_MANIFEST_BYTES) fail('SIZE_LIMIT', 'backup manifest exceeds the restore limit');
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(path, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BACKUP_MANIFEST_BYTES) fail('SIZE_LIMIT', 'backup manifest exceeds the restore limit');
    const bytes = await handle.readFile();
    await handle.close();
    handle = undefined;
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the original failure */ }
    }
    if (error instanceof RestoreBackupError) throw error;
    fail('MANIFEST_INVALID', 'backup manifest is missing or invalid');
  }
}

async function readPrivateBytes(root: string, archivePath: string): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const candidate = await checkedBackupPath(root, archivePath, 'OBJECT_MISSING');
    const details = await lstat(candidate);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0 || details.size > MAX_BACKUP_OBJECT_BYTES) {
      fail(details.size > MAX_BACKUP_OBJECT_BYTES ? 'SIZE_LIMIT' : 'PERMISSION', 'backup object is not a private regular file');
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(candidate, flags);
    const opened = await handle.stat();
    if (!opened.isFile()) fail('OBJECT_MISSING', 'backup object is not a regular file');
    if (opened.size > MAX_BACKUP_OBJECT_BYTES) fail('SIZE_LIMIT', 'backup object exceeds the restore limit');
    const bytes = await handle.readFile();
    await handle.close();
    handle = undefined;
    if (bytes.byteLength > MAX_BACKUP_OBJECT_BYTES) fail('SIZE_LIMIT', 'backup object exceeds the restore limit');
    return new Uint8Array(bytes);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the original failure */ }
    }
    if (error instanceof RestoreBackupError) throw error;
    fail('OBJECT_MISSING', 'a backup object is missing');
  }
}

function validateManifest(value: unknown, backupDirectory: string, maxTotalObjectBytes: number): LogicalBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MANIFEST_INVALID', 'backup manifest has an invalid shape');
  assertStateBudget(value);
  const candidate = value as Partial<LogicalBackupManifest>;
  if (candidate.schemaVersion !== LOGICAL_BACKUP_VERSION) fail('MANIFEST_INVALID', 'backup manifest version is unsupported');
  const organizationId = nonEmpty(candidate.organizationId, 'manifest organizationId');
  const sourceIdentity = nonEmpty(candidate.sourceIdentity, 'manifest sourceIdentity');
  const sourceLocation = validateLocationShape(candidate.sourceLocation, 'manifest sourceLocation');
  if (sourceLocation.roots?.some((root) => !isAbsolute(root))) {
    fail('MANIFEST_INVALID', 'manifest source location roots must be absolute');
  }
  const capturedAt = nonEmpty(candidate.capturedAt, 'manifest capturedAt', 128);
  const consistency = candidate.captureConsistency;
  const validConsistency: readonly CaptureConsistency[] = [
    'offline-filesystem',
    'single-row-read',
    'postgres-mvcc-snapshot',
    'provider-snapshot',
  ];
  if (!validConsistency.includes(consistency as CaptureConsistency)) fail('MANIFEST_INVALID', 'backup capture consistency is unsupported');
  if (typeof candidate.metadataRevision !== 'number' || !Number.isSafeInteger(candidate.metadataRevision) || candidate.metadataRevision < 0) {
    fail('MANIFEST_INVALID', 'backup metadata revision is invalid');
  }
  const deletionFence = validateFence(candidate.deletionFence as DeletionFenceEvidence);
  if (consistency === 'offline-filesystem' && deletionFence.scope !== 'offline') {
    fail('MANIFEST_INVALID', 'offline filesystem backups require offline fence evidence');
  }
  if (consistency !== 'offline-filesystem' && deletionFence.scope !== 'hosted') {
    fail('MANIFEST_INVALID', 'hosted backups require hosted deletion/lifecycle evidence');
  }
  if (!candidate.state || !candidate.objects || !Array.isArray(candidate.objects)) fail('MANIFEST_INVALID', 'backup manifest is missing state or objects');
  if (candidate.objects.length > MAX_BACKUP_OBJECTS) fail('SIZE_LIMIT', 'backup object count exceeds the restore limit');
  assertStateBudget(candidate.state);
  const state = cloneRegistryState(candidate.state);
  assertStateBudget(state);
  assertRegistryState(state);
  assertOrganization(state, organizationId);
  if (stateRevision(state) !== candidate.metadataRevision) fail('MANIFEST_INVALID', 'state and manifest revisions differ');
  const grouped = refsByKey(state);
  const objects = candidate.objects.map((entry) => {
    if (!entry || typeof entry !== 'object') fail('MANIFEST_INVALID', 'backup object manifest entry is invalid');
    const object = entry as LogicalBackupObject;
    const key = nonEmpty(object.key, 'backup object key', MAX_KEY_LENGTH);
    if (!safeStorageKey(key) || !isSha256Digest(object.digest) || typeof object.size !== 'number' || !Number.isSafeInteger(object.size) || object.size < 0) {
      fail('MANIFEST_INVALID', 'backup object manifest contains an invalid key, digest, or size');
    }
    if (object.size > MAX_BACKUP_OBJECT_BYTES) fail('SIZE_LIMIT', 'backup object exceeds the restore limit');
    const archivePath = nonEmpty(object.archivePath, 'backup archive path', 4_096);
    const expectedArchivePath = keyArchivePath(key);
    if (archivePath !== expectedArchivePath || !pathInside(resolve(backupDirectory), resolve(backupDirectory, archivePath))) {
      fail('MANIFEST_INVALID', 'backup archive path is invalid');
    }
    if (!Array.isArray(object.references) || object.references.length > MAX_STATE_NODES || object.references.some((reference) => (
      typeof reference !== 'string' || reference.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/u.test(reference)
    ))) {
      fail('MANIFEST_INVALID', 'backup object references are invalid');
    }
    return {
      key,
      digest: object.digest,
      size: object.size,
      archivePath,
      references: [...object.references].sort(),
    };
  });
  assertAggregateObjectBytes(objects.map((object) => object.size), maxTotalObjectBytes, 'manifest object bytes');
  if (!sameObjectEntries(objects, [...grouped.entries()].map(([key, references]) => ({
    key,
    digest: references[0]!.digest,
    size: references[0]!.size,
    archivePath: keyArchivePath(key),
    references: references.map((reference) => reference.path).sort(),
  })))) {
    fail('MANIFEST_INVALID', 'backup object manifest does not match state references');
  }
  const seenKeys = new Set<string>();
  for (const object of objects) {
    if (seenKeys.has(object.key)) fail('MANIFEST_INVALID', 'backup object keys are duplicated');
    seenKeys.add(object.key);
  }
  return {
    schemaVersion: LOGICAL_BACKUP_VERSION,
    organizationId,
    sourceIdentity,
    sourceLocation,
    capturedAt,
    captureConsistency: consistency as CaptureConsistency,
    metadataRevision: candidate.metadataRevision,
    deletionFence,
    state,
    objects,
  };
}

export async function readLogicalBackup(
  backupDirectory: string,
  options: ReadLogicalBackupOptions = {},
): Promise<LogicalBackupManifest> {
  const maxTotalObjectBytes = totalObjectByteBudget(options.maxTotalObjectBytes, 'maxTotalObjectBytes');
  const root = await canonicalPrivateRoot(resolve(nonEmpty(backupDirectory, 'backupDirectory', 4_096)), 'backupDirectory');
  const value = await readPrivateJson(root, MANIFEST_FILE);
  return validateManifest(value, root, maxTotalObjectBytes);
}

function emptyState(state: RegistryState): boolean {
  const baselinePolicies = [
    defaultRegistryState().policy,
    defaultRegistryState({ production: false, allowUnscanned: true }).policy,
  ];
  for (const [key, value] of Object.entries(state)) {
    if (key === 'metadataRevision' || key === 'schemaVersion') continue;
    if (key === 'policy') {
      if (!baselinePolicies.some((policy) => canonicalJson(policy) === canonicalJson(value))) return false;
      continue;
    }
    if (!Array.isArray(value) || value.length !== 0) return false;
  }
  return stateRevision(state) === 0;
}

function rewriteBlobKeys(value: unknown, keyMap: ReadonlyMap<string, StoredBlob>, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) fail('MANIFEST_INVALID', 'state contains a cyclic object');
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => rewriteBlobKeys(entry, keyMap, seen));
  const record = value as Record<string, unknown>;
  if (hasStoredBlobShape(record)) {
    if (!validBlobRecord(record)) fail('MANIFEST_INVALID', 'invalid sealed-object reference during restore');
    const replacement = keyMap.get(record.key);
    if (!replacement) fail('MANIFEST_INVALID', 'sealed-object reference has no restored object');
    return { ...record, key: replacement.key, digest: replacement.digest, size: replacement.size };
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, rewriteBlobKeys(entry, keyMap, seen)]));
}

function withoutRevision(state: RegistryState): RegistryState {
  const copy = cloneRegistryState(state) as RegistryState & { metadataRevision?: number };
  delete copy.metadataRevision;
  return copy;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

export async function restoreLogicalBackup(options: RestoreLogicalBackupOptions): Promise<RestoreLogicalBackupResult> {
  const organizationId = nonEmpty(options.organizationId, 'organizationId');
  const targetIdentity = nonEmpty(options.targetIdentity, 'targetIdentity');
  if (options.targetIsolated !== true) fail('INVALID_OPTIONS', 'restore requires an explicitly isolated target');
  if (!options.targetRepository || !options.targetBlobs) fail('INVALID_OPTIONS', 'target repository and blob store are required');
  const targetLocation = await canonicalLocation(options.targetLocation, 'targetLocation');
  const backupDirectory = resolve(nonEmpty(options.backupDirectory, 'backupDirectory', 4_096));
  const maxTotalObjectBytes = totalObjectByteBudget(options.maxTotalObjectBytes, 'maxTotalObjectBytes');
  const backupRoot = await canonicalPrivateRoot(backupDirectory, 'backupDirectory');
  const manifest = await readLogicalBackup(backupDirectory, { maxTotalObjectBytes });
  if (manifest.organizationId !== organizationId) fail('MANIFEST_INVALID', 'backup organization does not match target organization');
  if (manifest.sourceIdentity === targetIdentity || locationsOverlap(manifest.sourceLocation, targetLocation)) {
    fail('SOURCE_TARGET_SAME', 'restore source and target are identical');
  }
  if ((targetLocation.roots ?? []).some((root) => pathsOverlap(backupRoot, root))) {
    fail('SOURCE_TARGET_SAME', 'restore target overlaps the backup directory');
  }
  if (!options.targetSeed || options.targetSeed.kind !== 'isolated-empty-state-v1' || typeof options.targetSeed.seed !== 'function') {
    // StateRepository.transaction intentionally advances revisions.  A
    // repository-specific empty-target seed is required to preserve the
    // captured revision without replaying an unbounded number of updates.
    fail('REVISION_UNSUPPORTED', 'restore requires an explicit isolated state-seed capability');
  }

  const targetBefore = await options.targetRepository.read(organizationId);
  assertRegistryState(targetBefore);
  if (!emptyState(targetBefore)) fail('TARGET_NOT_EMPTY', 'restore target already contains metadata');

  const keyMap = new Map<string, StoredBlob>();
  let totalObjectBytes = 0;
  for (const object of manifest.objects) {
    const bytes = await readPrivateBytes(backupRoot, object.archivePath);
    const digest = await digestBytes(bytes);
    if (digest !== object.digest || bytes.byteLength !== object.size) fail('OBJECT_DIGEST_MISMATCH', 'a backup object failed digest or size verification');
    if (bytes.byteLength > maxTotalObjectBytes - totalObjectBytes) {
      fail('SIZE_LIMIT', 'backup object bytes exceed the aggregate restore limit');
    }
    totalObjectBytes += bytes.byteLength;
    let restored: StoredBlob;
    try {
      restored = await options.targetBlobs.put(bytes);
    } catch {
      fail('TARGET_DIGEST_MISMATCH', 'target storage rejected a restored object');
    }
    if (!validBlobRecord(restored) || restored.digest !== object.digest || restored.size !== object.size) {
      fail('TARGET_DIGEST_MISMATCH', 'target storage returned an unexpected digest or size');
    }
    let verifiedTargetBytes: Uint8Array;
    try {
      verifiedTargetBytes = await options.targetBlobs.get(restored.key);
    } catch {
      fail('TARGET_DIGEST_MISMATCH', 'restored target object could not be read back');
    }
    if (verifiedTargetBytes.byteLength !== object.size || await digestBytes(verifiedTargetBytes) !== object.digest) {
      fail('TARGET_DIGEST_MISMATCH', 'restored target object failed read-back verification');
    }
    keyMap.set(object.key, restored);
  }
  const restoredState = rewriteBlobKeys(cloneRegistryState(manifest.state), keyMap) as RegistryState & { metadataRevision?: number };
  assertRegistryState(restoredState);
  await options.targetSeed.seed(organizationId, restoredState);

  const targetAfter = await options.targetRepository.read(organizationId);
  assertRegistryState(targetAfter);
  if (stateRevision(targetAfter) !== manifest.metadataRevision || canonicalJson(withoutRevision(targetAfter)) !== canonicalJson(withoutRevision(rewriteBlobKeys(cloneRegistryState(manifest.state), keyMap) as RegistryState))) {
    fail('TARGET_STATE_MISMATCH', 'restored metadata does not match the captured policy, revocations, or state');
  }
  const serializedMap: Record<string, string> = {};
  for (const [sourceKey, targetBlob] of keyMap) serializedMap[sourceKey] = targetBlob.key;
  return {
    organizationId,
    sourceIdentity: manifest.sourceIdentity,
    targetIdentity,
    metadataRevision: manifest.metadataRevision,
    objectCount: manifest.objects.length,
    remappedObjectCount: [...keyMap].filter(([sourceKey, targetBlob]) => sourceKey !== targetBlob.key).length,
    keyMap: serializedMap,
  };
}

interface CliArguments {
  command: 'backup' | 'restore';
  values: Map<string, string>;
}

function parseCliArguments(argv: string[]): CliArguments {
  const command = argv[0];
  if (command !== 'backup' && command !== 'restore') throw new Error('usage: restore-backup.ts backup|restore --key value');
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--') || !argv[index + 1] || argv[index + 1]!.startsWith('--')) throw new Error('every option requires a value');
    values.set(argument.slice(2), argv[index + 1]!);
    index += 1;
  }
  return { command, values };
}

function cliValue(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

async function localBlobStore(root: string, prefix: string | undefined): Promise<BlobStore> {
  const { createNodeFilesSdkBlobStore } = await import('../packages/storage/src/node.js');
  return createNodeFilesSdkBlobStore({ provider: 'fs', root, prefix });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArguments(argv);
  const organizationId = cliValue(parsed.values, 'organization');
  const stateDirectory = resolve(cliValue(parsed.values, parsed.command === 'backup' ? 'state-dir' : 'target-state-dir'));
  const blobDirectory = resolve(cliValue(parsed.values, parsed.command === 'backup' ? 'blob-dir' : 'target-blob-dir'));
  const prefix = parsed.values.get('blob-prefix');
  await ensurePrivateDirectory(stateDirectory);
  await ensurePrivateDirectory(blobDirectory);
  if (parsed.command === 'backup') {
    const { createFileStateRepository } = await import('../packages/database/src/index.js');
    const result = await createLogicalBackup({
      sourceRepository: createFileStateRepository({ directory: stateDirectory, stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }) }),
      sourceBlobs: await localBlobStore(blobDirectory, prefix),
      organizationId,
      sourceIdentity: cliValue(parsed.values, 'source-id'),
      sourceLocation: {
        kind: 'filesystem',
        identity: cliValue(parsed.values, 'source-id'),
        roots: [stateDirectory, blobDirectory],
      },
      backupDirectory: resolve(cliValue(parsed.values, 'output')),
      captureConsistency: 'offline-filesystem',
      deletionFence: {
        scope: 'offline',
        kind: 'offline-test',
        evidenceRef: cliValue(parsed.values, 'fence-evidence'),
        observedAt: new Date().toISOString(),
      },
    });
    console.log(JSON.stringify({ ok: true, operation: 'backup', organizationId, metadataRevision: result.manifest.metadataRevision, objectCount: result.objectCount }));
    return;
  }
  if (parsed.values.get('target-isolated') !== 'true') throw new Error('restore requires --target-isolated true');
  const { createFileStateRepository } = await import('../packages/database/src/index.js');
  const result = await restoreLogicalBackup({
    targetRepository: createFileStateRepository({ directory: stateDirectory }),
    targetBlobs: await localBlobStore(blobDirectory, prefix),
    organizationId,
    targetIdentity: cliValue(parsed.values, 'target-id'),
    targetLocation: {
      kind: 'filesystem',
      identity: cliValue(parsed.values, 'target-id'),
      roots: [stateDirectory, blobDirectory],
    },
    backupDirectory: resolve(cliValue(parsed.values, 'backup')),
    targetIsolated: true,
    targetSeed: createFileStateSeed(stateDirectory),
  });
  console.log(JSON.stringify({ ok: true, operation: 'restore', organizationId, metadataRevision: result.metadataRevision, objectCount: result.objectCount, remappedObjectCount: result.remappedObjectCount }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const code = error instanceof RestoreBackupError ? error.code : 'RESTORE_BACKUP_FAILED';
    console.error(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  });
}
