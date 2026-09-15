import type {
  BillingUsageAdmission,
  BlobStore,
  Digest,
  RecoverableBlobStore,
  RegistryState,
  StateRepository,
  StorageAttempt,
  StorageObjectInspection,
  StoredBlob,
} from "../../contracts/src/index.js";

/** Capability minted for the storage reconciler; tenant roles do not satisfy it. */
export const STORAGE_RECOVERY_CAPABILITY = "private-skills:storage-recovery-operator";
/** Scope carried by the dedicated operator credential used by this workflow. */
export const STORAGE_RECOVERY_SCOPE = "storage:recovery";

export type StorageRecoveryProof =
  | { kind: "writer-terminated"; reference: string }
  | { kind: "known-failure"; reference: string };

export interface StorageRecoveryActor {
  organizationId: string;
  subject: string;
  capability: string;
  scopes: readonly string[];
}

export interface StorageRecoveryRequest {
  organizationId: string;
  attemptId: string;
  actor: StorageRecoveryActor;
  proof: StorageRecoveryProof;
  /** Required before deleting a verified object; omission retains the charge. */
  cleanupConfirmed?: boolean;
  /** Explicitly resume a prior process that left the durable fence recovering. */
  resume?: boolean;
}

export interface StorageRecoveryProofContext {
  request: StorageRecoveryRequest;
  attempt: StorageAttempt;
}

export type StorageRecoveryReason =
  | "missing-object-key"
  | "metadata-referenced"
  | "proof-rejected"
  | "proof-unavailable"
  | "provider-unknown"
  | "object-digest-mismatch"
  | "cleanup-required"
  | "cleanup-failed"
  | "billing-unavailable"
  | "billing-failed"
  | "stale-recovery";

export type StorageRecoveryResult =
  | {
      status: "released";
      attempt: StorageAttempt;
      inspection: "absent" | "deleted";
      billing: "reconciled" | "unmetered";
    }
  | {
      status: "retained";
      reason: StorageRecoveryReason;
      attempt: StorageAttempt;
      inspection?: StorageObjectInspection;
    }
  | {
      status: "already-terminal";
      state: "committed" | "released";
      attempt: StorageAttempt;
    }
  | {
      status: "busy";
      attempt: StorageAttempt;
    };

export type StorageRecoveryErrorCode =
  | "RECOVERY_FORBIDDEN"
  | "RECOVERY_INVALID"
  | "RECOVERY_PROOF_UNAVAILABLE"
  | "STORAGE_ATTEMPT_NOT_FOUND"
  | "RECOVERY_PERSISTENCE_UNCERTAIN";

export class StorageRecoveryError extends Error {
  readonly code: StorageRecoveryErrorCode;

  constructor(code: StorageRecoveryErrorCode, message: string) {
    super(message);
    this.name = "StorageRecoveryError";
    this.code = code;
  }
}

export interface StorageRecoveryOptions {
  repository: StateRepository;
  blobs: RecoverableBlobStore;
  billing?: BillingUsageAdmission;
  /**
   * Verifies a trusted platform/operator record. The request's proof string
   * is never accepted as evidence by itself.
   */
  verifyProof: (context: StorageRecoveryProofContext) => boolean | Promise<boolean>;
  /**
   * Synchronous because it runs inside the organization transaction. Hosts
   * may include every metadata table they own; the default covers registry,
   * authoring, and queued-job references.
   */
  isObjectReferenced?: (state: RegistryState, attempt: StorageAttempt) => boolean;
  now?: () => Date;
}

interface ClaimedRecovery {
  attempt: StorageAttempt;
  token: string;
}

interface FinalizeResult {
  applied: boolean;
  attempt?: StorageAttempt;
  referenced?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentifier(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function validInspection(value: unknown, key: string): value is StorageObjectInspection {
  if (!isRecord(value) || value.key !== key) return false;
  if (value.state === "absent") return true;
  if (value.state === "unknown") {
    return value.reason === "provider-error" || value.reason === "integrity" || value.reason === "limit";
  }
  return value.state === "present" && validDigest(value.digest) && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0;
}

function nowIso(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new StorageRecoveryError("RECOVERY_INVALID", "storage recovery clock is invalid");
  }
  return value.toISOString();
}

function cloneAttempt(attempt: StorageAttempt): StorageAttempt {
  return { ...attempt };
}

function recoveryToken(): string {
  const candidate = globalThis.crypto?.randomUUID?.();
  if (candidate) return candidate;
  throw new StorageRecoveryError("RECOVERY_INVALID", "secure Web Crypto randomness is required for storage recovery");
}

function defaultObjectReferenceCheck(state: RegistryState, attempt: StorageAttempt): boolean {
  const key = attempt.objectKey;
  if (!key) return false;
  if (state.skills.some((skill) => skill.organizationId === attempt.organizationId && skill.artifact.key === key)) return true;
  if (state.jobs.some((job) => job.organizationId === attempt.organizationId && job.artifact?.key === key)) return true;
  for (const draft of state.drafts ?? []) {
    if (draft.organizationId !== attempt.organizationId) continue;
    if (draft.artifact.key === key) return true;
    if (draft.createIdempotency?.artifact.key === key) return true;
    if ((draft.idempotency ?? []).some((record) => record.artifact.key === key)) return true;
  }
  return false;
}

function assertActor(request: StorageRecoveryRequest): void {
  if (!isRecord(request) || !validIdentifier(request.organizationId) || !validIdentifier(request.attemptId)) {
    throw new StorageRecoveryError("RECOVERY_INVALID", "storage recovery request is invalid");
  }
  const actor = request.actor;
  if (
    !isRecord(actor) ||
    actor.organizationId !== request.organizationId ||
    !validIdentifier(actor.subject) ||
    actor.capability !== STORAGE_RECOVERY_CAPABILITY ||
    !Array.isArray(actor.scopes) ||
    !actor.scopes.includes(STORAGE_RECOVERY_SCOPE)
  ) {
    throw new StorageRecoveryError("RECOVERY_FORBIDDEN", "storage recovery requires the dedicated operator capability");
  }
  const proof = request.proof;
  if (
    !isRecord(proof) ||
    (proof.kind !== "writer-terminated" && proof.kind !== "known-failure") ||
    !validIdentifier(proof.reference, 512)
  ) {
    throw new StorageRecoveryError("RECOVERY_INVALID", "storage recovery proof is invalid");
  }
  if (request.cleanupConfirmed !== undefined && request.cleanupConfirmed !== true && request.cleanupConfirmed !== false) {
    throw new StorageRecoveryError("RECOVERY_INVALID", "storage cleanup confirmation is invalid");
  }
  if (request.resume !== undefined && request.resume !== true && request.resume !== false) {
    throw new StorageRecoveryError("RECOVERY_INVALID", "storage recovery resume flag is invalid");
  }
}

/** Structural capability check for adapters supplied by host runtimes. */
export function isRecoverableBlobStore(store: BlobStore): store is RecoverableBlobStore {
  return typeof (store as Partial<RecoverableBlobStore>).allocateObjectKey === "function" &&
    typeof (store as Partial<RecoverableBlobStore>).putAtKey === "function" &&
    typeof (store as Partial<RecoverableBlobStore>).inspectObject === "function";
}

/** Allocate a stable key when the configured host supports durable recovery. */
export function allocateStorageObjectKey(store: BlobStore): string | undefined {
  return isRecoverableBlobStore(store) ? store.allocateObjectKey() : undefined;
}

/** Use the attempt's precommitted key when available, retaining legacy stores. */
export function putStorageAttemptBlob(
  store: BlobStore,
  attempt: Pick<StorageAttempt, "objectKey">,
  bytes: Uint8Array,
): Promise<StoredBlob> {
  if (attempt.objectKey) {
    if (!isRecoverableBlobStore(store)) {
      return Promise.reject(new Error("stable storage recovery capability is unavailable"));
    }
    return store.putAtKey(attempt.objectKey, bytes);
  }
  return store.put(bytes);
}

/**
 * Reconcile a provider write only after a trusted writer proof and a verified
 * object absence. Unknown provider outcomes retain the attempt and its charge.
 */
export class StorageRecoveryService {
  readonly #repository: StateRepository;
  readonly #blobs: RecoverableBlobStore;
  readonly #billing?: BillingUsageAdmission;
  readonly #verifyProof: StorageRecoveryOptions["verifyProof"];
  readonly #isObjectReferenced: (state: RegistryState, attempt: StorageAttempt) => boolean;
  readonly #now: () => Date;

  constructor(options: StorageRecoveryOptions) {
    if (!options?.repository || typeof options.repository.read !== "function" || typeof options.repository.transaction !== "function") {
      throw new StorageRecoveryError("RECOVERY_INVALID", "storage recovery repository is required");
    }
    if (!isRecoverableBlobStore(options.blobs)) {
      throw new StorageRecoveryError("RECOVERY_INVALID", "storage recovery requires a recoverable blob store");
    }
    if (typeof options.verifyProof !== "function") {
      throw new StorageRecoveryError("RECOVERY_INVALID", "storage recovery proof verification is required");
    }
    this.#repository = options.repository;
    this.#blobs = options.blobs;
    this.#billing = options.billing;
    this.#verifyProof = options.verifyProof;
    this.#isObjectReferenced = options.isObjectReferenced ?? defaultObjectReferenceCheck;
    this.#now = options.now ?? (() => new Date());
  }

  async recover(request: StorageRecoveryRequest): Promise<StorageRecoveryResult> {
    assertActor(request);

    const current = await this.#repository.read(request.organizationId);
    const initialAttempt = (current.storageAttempts ?? []).find((candidate) => candidate.id === request.attemptId);
    if (!initialAttempt || initialAttempt.organizationId !== request.organizationId) {
      throw new StorageRecoveryError("STORAGE_ATTEMPT_NOT_FOUND", "storage attempt was not found");
    }
    if (initialAttempt.state === "committed" || initialAttempt.state === "released") {
      return { status: "already-terminal", state: initialAttempt.state, attempt: cloneAttempt(initialAttempt) };
    }
    if (initialAttempt.state === "recovering" && request.resume !== true) {
      return { status: "busy", attempt: cloneAttempt(initialAttempt) };
    }
    if (!initialAttempt.objectKey) {
      return this.#retain(request.organizationId, request.attemptId, undefined, "missing-object-key");
    }

    let proofAccepted: boolean;
    try {
      proofAccepted = await this.#verifyProof({ request, attempt: cloneAttempt(initialAttempt) });
    } catch {
      return this.#retain(request.organizationId, request.attemptId, undefined, "proof-unavailable");
    }
    if (!proofAccepted) {
      return this.#retain(request.organizationId, request.attemptId, undefined, "proof-rejected");
    }

    const claimed = await this.#claim(request, initialAttempt);
    if (claimed.status !== "claimed") return claimed.result;
    const claimedAttempt = claimed.attempt;
    const attempt = claimedAttempt;
    const key = attempt.objectKey!;

    let inspection = await this.#inspect(key);
    let cleanupPerformed = false;
    if (inspection.state === "unknown") {
      return this.#retainClaimed(request.organizationId, request.attemptId, claimed.token, inspection, "provider-unknown");
    }
    if (inspection.state === "present") {
      if (inspection.digest !== attempt.digest || inspection.size !== attempt.size) {
        return this.#retainClaimed(request.organizationId, request.attemptId, claimed.token, inspection, "object-digest-mismatch");
      }
      if (request.cleanupConfirmed !== true) {
        return this.#retainClaimed(request.organizationId, request.attemptId, claimed.token, inspection, "cleanup-required");
      }
      try {
        await this.#blobs.remove(key);
        cleanupPerformed = true;
      } catch {
        return this.#retainClaimed(request.organizationId, request.attemptId, claimed.token, inspection, "cleanup-failed");
      }
      inspection = await this.#inspect(key);
      if (inspection.state !== "absent") {
        return this.#retainClaimed(
          request.organizationId,
          request.attemptId,
          claimed.token,
          inspection,
          inspection.state === "unknown" ? "provider-unknown" : "cleanup-failed",
        );
      }
    }

    const billing = this.#billing;
    if (billing) {
      try {
        if (billing.status().enabled !== true) {
          return this.#retainClaimed(request.organizationId, request.attemptId, claimed.token, inspection, "billing-unavailable");
        }
      } catch {
        return this.#retainClaimed(request.organizationId, request.attemptId, claimed.token, inspection, "billing-unavailable");
      }
    }
    if (billing) {
      try {
        await billing.reconcileUsage(
          request.organizationId,
          attempt.reservationKey,
          { storageBytes: 0 },
          `private-skills:storage-recovery:${attempt.id}`,
        );
      } catch {
        return this.#retainClaimed(request.organizationId, request.attemptId, claimed.token, inspection, "billing-failed");
      }
    }

    const finalized = await this.#finalize(
      request.organizationId,
      request.attemptId,
      claimed.token,
      "released",
    );
    if (!finalized.applied || !finalized.attempt) {
      if (finalized.referenced) {
        return {
          status: "retained",
          reason: "metadata-referenced",
          attempt: finalized.attempt ?? claimedAttempt,
          inspection,
        };
      }
      return { status: "retained", reason: "stale-recovery", attempt: finalized.attempt ?? claimedAttempt, inspection };
    }
    return {
      status: "released",
      attempt: finalized.attempt,
      inspection: cleanupPerformed ? "deleted" : "absent",
      billing: billing ? "reconciled" : "unmetered",
    };
  }

  async #inspect(key: string): Promise<StorageObjectInspection> {
    try {
      const observed = await this.#blobs.inspectObject(key);
      if (validInspection(observed, key)) return observed;
      return { state: "unknown", key, reason: "integrity" };
    } catch {
      return { state: "unknown", key, reason: "provider-error" };
    }
  }

  async #claim(
    request: StorageRecoveryRequest,
    observedAttempt: StorageAttempt,
  ): Promise<
    | ({ status: "claimed" } & ClaimedRecovery)
    | { status: "already-terminal" | "busy" | "retained"; result: StorageRecoveryResult }
  > {
    const token = recoveryToken();
    const timestamp = nowIso(this.#now);
    const result = await this.#repository.transaction(request.organizationId, (state) => {
      state.storageAttempts ??= [];
      const attempt = state.storageAttempts.find((candidate) => candidate.id === request.attemptId);
      if (!attempt || attempt.organizationId !== request.organizationId) {
        return { kind: "retained" as const, reason: "missing-object-key" as const, attempt: observedAttempt };
      }
      if (attempt.state === "committed" || attempt.state === "released") {
        return { kind: "terminal" as const, state: attempt.state, attempt: cloneAttempt(attempt) };
      }
      if (attempt.state === "recovering" && request.resume !== true) {
        return { kind: "busy" as const, attempt: cloneAttempt(attempt) };
      }
      if (!attempt.objectKey) {
        return { kind: "retained" as const, reason: "missing-object-key" as const, attempt: cloneAttempt(attempt) };
      }
      if (this.#isObjectReferenced(state, attempt)) {
        if (attempt.state === "recovering" && request.resume === true) {
          attempt.state = "orphaned";
          delete attempt.recoveryToken;
          delete attempt.recoveryStartedAt;
          attempt.updatedAt = timestamp;
        }
        return { kind: "retained" as const, reason: "metadata-referenced" as const, attempt: cloneAttempt(attempt) };
      }
      attempt.state = "recovering";
      attempt.recoveryToken = token;
      attempt.recoveryStartedAt = timestamp;
      attempt.updatedAt = timestamp;
      return { kind: "claimed" as const, attempt: cloneAttempt(attempt) };
    });
    if (result.kind === "claimed") return { status: "claimed", attempt: result.attempt, token };
    if (result.kind === "terminal") {
      return {
        status: "already-terminal",
        result: { status: "already-terminal", state: result.state, attempt: result.attempt },
      };
    }
    if (result.kind === "busy") return { status: "busy", result: { status: "busy", attempt: result.attempt } };
    return {
      status: "retained",
      result: { status: "retained", reason: result.reason, attempt: result.attempt },
    };
  }

  async #retain(
    organizationId: string,
    attemptId: string,
    inspection: StorageObjectInspection | undefined,
    reason: StorageRecoveryReason,
  ): Promise<StorageRecoveryResult> {
    const finalized = await this.#finalize(organizationId, attemptId, undefined, "orphaned");
    return {
      status: "retained",
      reason: finalized.referenced ? "metadata-referenced" : reason,
      attempt: finalized.attempt ?? (await this.#readAttempt(organizationId, attemptId)),
      ...(inspection ? { inspection } : {}),
    };
  }

  async #retainClaimed(
    organizationId: string,
    attemptId: string,
    token: string,
    inspection: StorageObjectInspection,
    reason: StorageRecoveryReason,
  ): Promise<StorageRecoveryResult> {
    const finalized = await this.#finalize(organizationId, attemptId, token, "orphaned");
    return {
      status: "retained",
      reason: finalized.referenced ? "metadata-referenced" : reason,
      attempt: finalized.attempt ?? (await this.#readAttempt(organizationId, attemptId)),
      inspection,
    };
  }

  async #readAttempt(organizationId: string, attemptId: string): Promise<StorageAttempt> {
    const state = await this.#repository.read(organizationId);
    const attempt = (state.storageAttempts ?? []).find((candidate) => candidate.id === attemptId);
    if (!attempt) throw new StorageRecoveryError("STORAGE_ATTEMPT_NOT_FOUND", "storage attempt was not found");
    return cloneAttempt(attempt);
  }

  async #finalize(
    organizationId: string,
    attemptId: string,
    token: string | undefined,
    state: "orphaned" | "released",
  ): Promise<FinalizeResult> {
    try {
      return await this.#repository.transaction(organizationId, (current) => {
        current.storageAttempts ??= [];
        const attempt = current.storageAttempts.find((candidate) => candidate.id === attemptId);
        if (!attempt || attempt.organizationId !== organizationId) return { applied: false };
        if (token !== undefined && attempt.recoveryToken !== token) return { applied: false, attempt: cloneAttempt(attempt) };
        if (token === undefined && attempt.state === "recovering") return { applied: false, attempt: cloneAttempt(attempt) };
        // A proof check may race the original writer's final metadata commit.
        // Never turn a committed or released attempt back into an orphan.
        if (token === undefined && (attempt.state === "committed" || attempt.state === "released")) {
          return { applied: false, attempt: cloneAttempt(attempt) };
        }
        if (state === "released" && this.#isObjectReferenced(current, attempt)) {
          attempt.state = "orphaned";
          delete attempt.recoveryToken;
          delete attempt.recoveryStartedAt;
          attempt.updatedAt = nowIso(this.#now);
          return { applied: false, referenced: true, attempt: cloneAttempt(attempt) };
        }
        attempt.state = state;
        delete attempt.recoveryToken;
        delete attempt.recoveryStartedAt;
        attempt.updatedAt = nowIso(this.#now);
        return { applied: true, attempt: cloneAttempt(attempt) };
      });
    } catch (error) {
      throw new StorageRecoveryError(
        "RECOVERY_PERSISTENCE_UNCERTAIN",
        error instanceof Error ? "storage recovery state transition is uncertain" : "storage recovery state transition failed",
      );
    }
  }
}
