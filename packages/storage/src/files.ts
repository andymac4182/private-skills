import type {
  BlobStore,
  Digest,
  RecoverableBlobStore,
  StorageObjectInspection,
  StoredBlob,
} from "../../contracts/src/index.js";
import { digestBytes, isSha256Digest } from "./digest.js";
import { normalizeStorageProviderBinding } from "./receipt.js";

export const DEFAULT_STORAGE_MAX_BYTES = 100 * 1024 * 1024;

export type FilesStoredObject = {
  size?: number;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  blob?: () => Promise<Blob>;
  stream?: () => ReadableStream<Uint8Array>;
  body?: ReadableStream<Uint8Array>;
  byteLength?: number;
};

/** The small part of `files-sdk` used by the storage boundary. */
export interface FilesClientLike {
  upload(
    key: string,
    body: Uint8Array,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  download(
    key: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  delete(key: string, options?: Record<string, unknown>): Promise<unknown>;
  head?(
    key: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  /**
   * Optional host/provider proof that an earlier upload for this key is
   * terminal and cannot materialize later. Absence means unknown, never true.
   */
  confirmWriteTerminated?(key: string): boolean | Promise<boolean>;
  /** Exposed by the real Files instance for native create-only uploads. */
  capabilities?: {
    conditional?: {
      create?: boolean;
    };
  };
}

export interface FilesSdkBlobStoreOptions {
  /** An actual `Files` instance, usually built by the Node loader. */
  client: FilesClientLike;
  /** Prefix for private sealed objects. It must be a relative key prefix. */
  prefix?: string;
  /** Maximum object size accepted by put/get. */
  maxBytes?: number;
  /**
   * Stable, non-secret identity for the provider configuration. Omit it for
   * legacy hosts; without a binding no verified recovery receipt is minted.
   */
  providerBinding?: string;
}

export type StorageErrorCode =
  | "configuration"
  | "invalid_key"
  | "limit"
  | "integrity";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly key?: string;

  constructor(code: StorageErrorCode, message: string, key?: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.key = key;
  }
}

interface BlobRecord {
  digest: Digest;
  size: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertClient(client: unknown): asserts client is FilesClientLike {
  if (!isObject(client)) {
    throw new StorageError(
      "configuration",
      "FilesSdkBlobStore requires an injected files-sdk Files client"
    );
  }
  for (const method of ["upload", "download", "delete"] as const) {
    if (typeof client[method] !== "function") {
      throw new StorageError(
        "configuration",
        `injected Files client is missing ${method}()`
      );
    }
  }
}

function assertLimit(maxBytes: number | undefined): number {
  const value = maxBytes ?? DEFAULT_STORAGE_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StorageError(
      "configuration",
      "maxBytes must be a positive safe integer"
    );
  }
  return value;
}

function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === "") return "";
  const value = prefix.replace(/^\/+|\/+$/gu, "");
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new StorageError(
      "configuration",
      "storage prefix must be a safe relative object-key prefix"
    );
  }
  return value;
}

function assertKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 4_096 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.includes("//") ||
    key.includes(":") ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new StorageError("invalid_key", "storage key is not safe", key);
  }
}

function assertSealedKey(key: string, prefix: string): void {
  assertKey(key);
  const expectedPrefix = `${prefix ? `${prefix}/` : ""}sealed/`;
  if (!key.startsWith(expectedPrefix) || !/^[0-9a-f]{48}$/u.test(key.slice(expectedPrefix.length))) {
    throw new StorageError(
      "invalid_key",
      "storage key is not a Private Skills sealed-object key",
      key
    );
  }
}

function randomKeyPart(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new StorageError(
      "configuration",
      "secure Web Crypto randomness is required for sealed storage keys"
    );
  }
  const bytes = new Uint8Array(24);
  cryptoApi.getRandomValues(bytes);
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function sizeOf(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const size = value.size ?? value.byteLength;
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0
    ? size
    : undefined;
}

function providerErrorCode(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const code = value.code ?? value.name;
  return typeof code === "string" ? code : undefined;
}

/**
 * Files SDK adapters normalize not-found failures to `code: "NotFound"`.
 * Keep a narrow compatibility match for simple injected clients used by
 * local hosts; every other provider failure remains unknown and therefore
 * cannot trigger destructive cleanup or a billing release.
 */
function isKnownNotFound(error: unknown): boolean {
  if (isObject(error)) {
    const code = providerErrorCode(error)?.toLowerCase();
    const status = error.status ?? error.statusCode;
    if (code === "notfound" || code === "not_found" || code === "enoent" || status === 404) return true;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.trim();
  // Vercel Blob's private `head()` maps a missing key to a provider error
  // without preserving a status/code. Keep this exact message match narrow;
  // other provider failures must remain unknown for recovery purposes.
  return /^(?:not[ -]?found|enoent)$/iu.test(message)
    || /^Vercel Blob:\s+The requested blob does not exist$/u.test(message);
}

function inspectionFailure(key: string, error: unknown): StorageObjectInspection {
  if (isKnownNotFound(error)) return { state: "absent", key };
  if (error instanceof StorageError && error.code === "limit") {
    return { state: "unknown", key, reason: "limit" };
  }
  if (error instanceof StorageError && error.code === "integrity") {
    return { state: "unknown", key, reason: "integrity" };
  }
  return { state: "unknown", key, reason: "provider-error" };
}

async function asBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (isObject(value)) {
    if (typeof value.arrayBuffer === "function") {
      return new Uint8Array(await value.arrayBuffer());
    }
    if (typeof value.blob === "function") {
      const blob = await value.blob();
      return new Uint8Array(await blob.arrayBuffer());
    }
    if (typeof value.stream === "function") {
      return new Uint8Array(await new Response(value.stream()).arrayBuffer());
    }
    if (
      typeof ReadableStream !== "undefined" &&
      value.body instanceof ReadableStream
    ) {
      return new Uint8Array(await new Response(value.body).arrayBuffer());
    }
  }
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  throw new StorageError(
    "integrity",
    "Files SDK download returned a value without a readable body"
  );
}

/**
 * BlobStore backed by an injected Files SDK `Files` instance.
 *
 * Every put uses a fresh cryptographically random key, uploads once, then
 * reads the sealed object back and hashes those retrieved bytes. The store
 * never uses a digest as a provider key and never overwrites an existing key.
 */
export class FilesSdkBlobStore implements RecoverableBlobStore {
  readonly #client: FilesClientLike;
  readonly #prefix: string;
  readonly #maxBytes: number;
  readonly #providerBinding?: string;
  readonly #records = new Map<string, BlobRecord>();

  constructor(options: FilesSdkBlobStoreOptions) {
    assertClient(options?.client);
    this.#client = options.client;
    this.#prefix = normalizePrefix(options.prefix);
    this.#maxBytes = assertLimit(options.maxBytes);
    if (options.providerBinding !== undefined) {
      const binding = normalizeStorageProviderBinding(options.providerBinding);
      if (!binding) {
        throw new StorageError(
          "configuration",
          "providerBinding must be a stable non-secret storage identity",
        );
      }
      this.#providerBinding = binding;
    }
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  get providerBinding(): string | undefined {
    return this.#providerBinding;
  }

  async confirmWriteTerminated(key: string): Promise<boolean> {
    assertSealedKey(key, this.#prefix);
    if (typeof this.#client.confirmWriteTerminated !== "function") return false;
    try {
      return (await this.#client.confirmWriteTerminated(key)) === true;
    } catch {
      return false;
    }
  }

  /** Read the object and verify it against a caller-supplied digest. */
  async getVerified(key: string, expectedDigest: Digest): Promise<Uint8Array> {
    assertSealedKey(key, this.#prefix);
    if (!isSha256Digest(expectedDigest)) {
      throw new StorageError("integrity", "expected digest is not sha256", key);
    }
    const bytes = await this.get(key);
    const actual = await digestBytes(bytes);
    if (actual !== expectedDigest) {
      throw new StorageError(
        "integrity",
        `sealed object digest mismatch: expected ${expectedDigest}, got ${actual}`,
        key
      );
    }
    return bytes;
  }

  async put(
    input: Uint8Array,
    metadata?: Record<string, string>
  ): Promise<StoredBlob> {
    const key = this.allocateObjectKey();
    return this.putAtKey(key, input, metadata);
  }

  allocateObjectKey(): string {
    let key: string | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `${this.#prefix ? `${this.#prefix}/` : ""}sealed/${randomKeyPart()}`;
      if (!this.#records.has(candidate)) {
        key = candidate;
        break;
      }
    }
    if (!key) {
      throw new StorageError("configuration", "could not allocate a unique sealed key");
    }
    return key;
  }

  async putAtKey(
    key: string,
    input: Uint8Array,
    metadata?: Record<string, string>,
  ): Promise<StoredBlob> {
    assertSealedKey(key, this.#prefix);
    if (!(input instanceof Uint8Array)) {
      throw new StorageError("integrity", "put expects a Uint8Array");
    }
    const bytes = new Uint8Array(input);
    if (bytes.byteLength > this.#maxBytes) {
      throw new StorageError(
        "limit",
        `object exceeds the ${this.#maxBytes}-byte storage limit`
      );
    }
    const digest = await digestBytes(bytes);

    // A retry first establishes whether the stable identity was already
    // written. An object with another digest is a hard conflict; an unknown
    // provider response is retained for operator reconciliation.
    const existing = await this.inspectObject(key);
    if (existing.state === "present") {
      if (existing.digest !== digest || existing.size !== bytes.byteLength) {
        throw new StorageError(
          "integrity",
          `sealed object ${key} does not match the requested bytes`,
          key,
        );
      }
      this.#records.set(key, { digest, size: bytes.byteLength });
      return { digest, key, size: bytes.byteLength };
    }
    if (existing.state === "unknown") {
      throw new StorageError(
        "integrity",
        `cannot establish whether sealed object ${key} exists`,
        key,
      );
    }

    const uploadOptions: Record<string, unknown> = {
      contentType: "application/octet-stream",
    };
    if (metadata !== undefined) uploadOptions.metadata = { ...metadata };
    if (this.#client.capabilities?.conditional?.create === true) {
      uploadOptions.condition = { type: "create" };
    }
    // Never delete after an uncertain write. The caller has already persisted
    // this exact key and the recovery workflow will verify it before cleanup.
    await this.#client.upload(key, bytes, uploadOptions);
    const retrieved = await this.#read(key);
    const retrievedDigest = await digestBytes(retrieved);
    if (
      retrieved.byteLength !== bytes.byteLength ||
      retrievedDigest !== digest
    ) {
      throw new StorageError(
        "integrity",
        `provider changed sealed bytes after upload (expected ${digest}, got ${retrievedDigest})`,
        key
      );
    }
    this.#records.set(key, { digest, size: bytes.byteLength });
    return { digest, key, size: bytes.byteLength };
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    assertSealedKey(key, this.#prefix);
    try {
      const head = this.#client.head
        ? await this.#client.head(key)
        : undefined;
      const declaredSize = sizeOf(head);
      if (declaredSize !== undefined && declaredSize > this.#maxBytes) {
        return { state: "unknown", key, reason: "limit" };
      }
      const bytes = await this.#read(key);
      if (bytes.byteLength > this.#maxBytes) {
        return { state: "unknown", key, reason: "limit" };
      }
      if (declaredSize !== undefined && bytes.byteLength !== declaredSize) {
        return { state: "unknown", key, reason: "integrity" };
      }
      const digest = await digestBytes(bytes);
      this.#records.set(key, { digest, size: bytes.byteLength });
      return { state: "present", key, digest, size: bytes.byteLength };
    } catch (error) {
      return inspectionFailure(key, error);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    assertSealedKey(key, this.#prefix);
    const head = this.#client.head
      ? await this.#client.head(key)
      : undefined;
    const declaredSize = sizeOf(head);
    if (declaredSize !== undefined && declaredSize > this.#maxBytes) {
      throw new StorageError(
        "limit",
        `object exceeds the ${this.#maxBytes}-byte storage limit`,
        key
      );
    }
    const bytes = await this.#read(key);
    if (bytes.byteLength > this.#maxBytes) {
      throw new StorageError(
        "limit",
        `object exceeds the ${this.#maxBytes}-byte storage limit`,
        key
      );
    }
    const record = this.#records.get(key);
    if (record) {
      const actual = await digestBytes(bytes);
      if (actual !== record.digest || bytes.byteLength !== record.size) {
        throw new StorageError(
          "integrity",
          `stored object ${key} no longer matches its sealed digest`,
          key
        );
      }
    }
    return bytes;
  }

  async remove(key: string): Promise<void> {
    assertSealedKey(key, this.#prefix);
    await this.#client.delete(key);
    this.#records.delete(key);
  }

  async #read(key: string): Promise<Uint8Array> {
    const downloaded = await this.#client.download(key, { as: "blob" });
    return asBytes(downloaded);
  }
}
