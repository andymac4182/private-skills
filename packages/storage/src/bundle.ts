import type { BundleFile, SkillBundle } from "../../contracts/src/index.js";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";

/** Maximum number of files accepted in one distribution bundle. */
export const MAX_BUNDLE_FILES = 2_000;

/** Maximum decoded byte size of one file in a distribution bundle. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Maximum expanded decoded byte size of a distribution bundle. */
export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const BUNDLE_KEYS = new Set(["format", "files"]);
const FILE_KEYS = new Set(["path", "content", "executable"]);
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED_CHARACTER = /[<>"|?*]/u;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_FILE_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;
/** Bound frontmatter before handing it to the YAML composer. */
export const MAX_FRONTMATTER_BYTES = 128 * 1024;
export const MAX_FRONTMATTER_LINES = 4_096;
export const MAX_FRONTMATTER_FIELDS = 256;
export const MAX_METADATA_FIELDS = 128;
export const MAX_METADATA_VALUE_CHARS = 4_096;
const MAX_FRONTMATTER_VALUE_CHARS = 16_384;
const MAX_FRONTMATTER_DEPTH = 8;
const MAX_FRONTMATTER_NODES = 2_048;
const MAX_FRONTMATTER_MAP_ITEMS = 256;
const MAX_FRONTMATTER_SEQUENCE_ITEMS = 128;
const FRONTMATTER_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const RESERVED_AGENT_SEGMENTS = new Set([
  ".agents",
  ".claude-plugin",
  ".codex",
  ".cursor",
  ".mcp",
  ".mcp.json",
  ".windsurf",
]);

function isPluginEnablingPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  // These directories/files are host activation/configuration boundaries;
  // admitting them would let a skill bundle install hooks, MCP servers, or
  // host-specific instructions as a side effect.
  return segments.some((segment) => RESERVED_AGENT_SEGMENTS.has(segment));
}

/** A structured validation failure suitable for returning as an HTTP 400. */
export class BundleValidationError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(message: string, code = "invalid_bundle", path?: string) {
    super(message);
    this.name = "BundleValidationError";
    this.code = code;
    this.path = path;
  }
}

export interface SkillMetadata {
  skillName: string;
  description: string;
  /** Parsed, non-executable frontmatter from the root SKILL.md. */
  frontmatter: Record<string, FrontmatterValue>;
}

export type FrontmatterScalar = string | number | boolean;
export type FrontmatterMetadata = Record<string, string>;
/** Bounded, data-only nested values accepted in extension metadata. */
export interface FrontmatterOpenClawMetadata {
  [key: string]: FrontmatterOpenClawValue;
}
export type FrontmatterOpenClawValue =
  | FrontmatterScalar
  | FrontmatterOpenClawMetadata
  | FrontmatterOpenClawValue[];
export type FrontmatterValue =
  | FrontmatterScalar
  | FrontmatterMetadata
  | FrontmatterOpenClawMetadata
  | FrontmatterOpenClawValue[];

/** Standard Agent Skills fields keep their defined scalar/map shapes. */
const KNOWN_FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowedtools",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  for (const key of ownKeys(value)) {
    if (!allowed.has(key)) {
      throw new BundleValidationError(
        `${label} contains unsupported property ${JSON.stringify(key)}`,
        "unsupported_property",
        label
      );
    }
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa !== "function") {
    throw new BundleValidationError(
      "base64 encoding is unavailable in this runtime",
      "configuration"
    );
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

function base64Sextet(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

/**
 * Check the padded RFC 4648 spelling without a backtracking expression.
 *
 * Large bundle files are valid input, so this must stay linear and avoid a
 * regex whose repeated groups can consume the JavaScript engine's stack.
 */
function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;

  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x3d) {
      // Padding is legal only in the final two positions.
      if (index < value.length - 2 || ++padding > 2) return false;
      continue;
    }
    if (padding > 0 || base64Sextet(code) < 0) return false;
  }

  if (padding === 0) return true;

  // Canonical base64 requires unused low bits to be zero. The final data
  // sextet is immediately before the padding, for either padding length.
  const finalSextet = base64Sextet(
    value.charCodeAt(value.length - padding - 1)
  );
  const unusedBits = padding === 2 ? 4 : 2;
  return finalSextet >= 0 && (finalSextet & ((1 << unusedBits) - 1)) === 0;
}

function decodeBase64(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string" || !isCanonicalBase64(value)) {
    throw new BundleValidationError(
      "bundle file content must be canonical base64",
      "invalid_base64",
      path
    );
  }
  if (typeof globalThis.atob !== "function") {
    throw new BundleValidationError(
      "base64 decoding is unavailable in this runtime",
      "configuration"
    );
  }
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new BundleValidationError(
      "bundle file content must be canonical base64",
      "invalid_base64",
      path
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  // atob is permissive in some hosts; require one canonical wire spelling.
  if (encodeBase64(bytes) !== value) {
    throw new BundleValidationError(
      "bundle file content must be canonical base64",
      "invalid_base64",
      path
    );
  }
  return bytes;
}

function decodeSkillText(content: string): string {
  const bytes = decodeBase64(content, "SKILL.md");
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new BundleValidationError(
      "SKILL.md content must be valid UTF-8",
      "invalid_skill_encoding",
      "SKILL.md"
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function pathCollisionKey(path: string): string {
  // NFC + lower case catches both decomposed Unicode aliases and the case
  // collisions that make a bundle install differently on Windows/macOS.
  return path.normalize("NFC").toLowerCase();
}

function validatePath(path: unknown, index: number): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new BundleValidationError(
      `files[${index}].path must be a non-empty string`,
      "invalid_path",
      `files[${index}].path`
    );
  }
  if (hasLoneSurrogate(path) || path !== path.normalize("NFC")) {
    throw new BundleValidationError(
      `files[${index}].path must contain valid NFC Unicode`,
      "invalid_path",
      path
    );
  }
  if (
    path.length > 4_096 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("//") ||
    WINDOWS_RESERVED_CHARACTER.test(path) ||
    CONTROL_CHARACTER.test(path)
  ) {
    throw new BundleValidationError(
      `files[${index}].path is not a safe relative path`,
      "unsafe_path",
      path
    );
  }

  const segments = path.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_SEGMENT.test(segment)
    ) {
      throw new BundleValidationError(
        `files[${index}].path contains an unsafe segment`,
        "unsafe_path",
        path
      );
    }
    if (textEncoder.encode(segment).byteLength > 255) {
      throw new BundleValidationError(
        `files[${index}].path contains an oversized segment`,
        "path_too_long",
        path
      );
    }
  }
  return path;
}

interface ValidatedFile {
  file: BundleFile;
  decodedBytes: number;
}

function validateFile(value: unknown, index: number): ValidatedFile {
  if (!isRecord(value)) {
    throw new BundleValidationError(
      `files[${index}] must be an object`,
      "invalid_file",
      `files[${index}]`
    );
  }
  assertOnlyKeys(value, FILE_KEYS, `files[${index}]`);

  const path = validatePath(value.path, index);
  if (isPluginEnablingPath(path)) {
    throw new BundleValidationError(
      `files[${index}].path is a plugin-enabling payload and is not allowed`,
      "plugin_payload",
      path
    );
  }
  if (typeof value.content !== "string") {
    throw new BundleValidationError(
      `files[${index}].content must be a string`,
      "invalid_content",
      path
    );
  }
  if (hasLoneSurrogate(value.content)) {
    throw new BundleValidationError(
      `files[${index}].content must be canonical base64`,
      "invalid_base64",
      path
    );
  }
  if (
    value.executable !== undefined &&
    typeof value.executable !== "boolean"
  ) {
    throw new BundleValidationError(
      `files[${index}].executable must be a boolean`,
      "invalid_executable",
      path
    );
  }
  if (value.content.length > MAX_FILE_BASE64_CHARS) {
    throw new BundleValidationError(
      `files[${index}].content exceeds the ${MAX_FILE_BYTES}-byte file limit`,
      "file_too_large",
      path
    );
  }
  const decodedBytes = decodeBase64(value.content, path).byteLength;
  if (decodedBytes > MAX_FILE_BYTES) {
    throw new BundleValidationError(
      `files[${index}].content exceeds the ${MAX_FILE_BYTES}-byte file limit`,
      "file_too_large",
      path
    );
  }

  return {
    file: {
      path,
      content: value.content,
      ...(value.executable === true ? { executable: true } : {}),
    },
    decodedBytes,
  };
}

/**
 * Validate and normalize a bundle without executing any file content.
 *
 * This checks transport shape, canonical base64 file content, path safety,
 * duplicate/case/Unicode aliases, and expanded decoded-byte size limits.
 * SKILL.md metadata is intentionally parsed by {@link parseSkillMetadata};
 * callers that publish a skill should call both.
 */
export function validateBundle(bundle: unknown): SkillBundle {
  if (!isRecord(bundle)) {
    throw new BundleValidationError("bundle must be an object");
  }
  assertOnlyKeys(bundle, BUNDLE_KEYS, "bundle");
  if (bundle.format !== "pskills-bundle-v1") {
    throw new BundleValidationError(
      "bundle.format must be pskills-bundle-v1",
      "invalid_format",
      "format"
    );
  }
  if (!Array.isArray(bundle.files)) {
    throw new BundleValidationError(
      "bundle.files must be an array",
      "invalid_files",
      "files"
    );
  }
  if (bundle.files.length === 0) {
    throw new BundleValidationError(
      "bundle.files must contain at least one file",
      "empty_bundle",
      "files"
    );
  }
  if (bundle.files.length > MAX_BUNDLE_FILES) {
    throw new BundleValidationError(
      `bundle.files exceeds the ${MAX_BUNDLE_FILES}-file limit`,
      "too_many_files",
      "files"
    );
  }

  const files: BundleFile[] = [];
  const seen = new Map<string, string>();
  let totalBytes = 0;
  for (const [index, value] of bundle.files.entries()) {
    const validated = validateFile(value, index);
    const file = validated.file;
    const key = pathCollisionKey(file.path);
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new BundleValidationError(
        `bundle contains colliding paths ${JSON.stringify(prior)} and ${JSON.stringify(file.path)}`,
        "path_collision",
        file.path
      );
    }
    seen.set(key, file.path);
    totalBytes += validated.decodedBytes;
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw new BundleValidationError(
        `bundle exceeds the ${MAX_BUNDLE_BYTES}-byte expanded size limit`,
        "bundle_too_large",
        file.path
      );
    }
    files.push(file);
  }

  return { format: "pskills-bundle-v1", files };
}

function comparePaths(left: BundleFile, right: BundleFile): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/** Encode a validated bundle as deterministic, compact UTF-8 JSON. */
export function encodeBundle(bundle: SkillBundle): Uint8Array {
  const normalized = validateBundle(bundle);
  const files = [...normalized.files]
    .sort(comparePaths)
    .map((file) => ({
      path: file.path,
      content: file.content,
      ...(file.executable === true ? { executable: true } : {}),
    }));
  return textEncoder.encode(
    JSON.stringify({ format: "pskills-bundle-v1", files })
  );
}

/** Decode UTF-8 JSON and apply the same validation as an in-memory bundle. */
export function decodeBundle(bytes: Uint8Array): SkillBundle {
  if (!(bytes instanceof Uint8Array)) {
    throw new BundleValidationError("bundle bytes must be a Uint8Array");
  }
  // A BOM is accepted by some JSON decoders but is not part of canonical
  // UTF-8 JSON and would produce two byte representations for one bundle.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new BundleValidationError("bundle JSON must not contain a UTF-8 BOM");
  }
  let decoded: string;
  try {
    decoded = textDecoder.decode(bytes);
  } catch {
    throw new BundleValidationError("bundle bytes are not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new BundleValidationError("bundle bytes are not valid JSON");
  }
  const normalized = validateBundle(parsed);
  const canonical = encodeBundle(normalized);
  if (!bytesEqual(canonical, bytes)) {
    throw new BundleValidationError(
      "bundle bytes are not canonical",
      "non_canonical"
    );
  }
  return normalized;
}

function frontmatterKey(key: string): string {
  return key.trim().toLowerCase();
}

const DANGEROUS_FRONTMATTER_KEYS = new Set([
  "plugin",
  "plugins",
  "pluginjson",
  "extension",
  "extensions",
  "mcp",
  "mcpserver",
  "mcpservers",
  "hook",
  "hooks",
  "command",
  "commands",
  "script",
  "scripts",
  "runtime",
  "runtimes",
  "entrypoint",
  "install",
  "installer",
  "tool",
  "tools",
]);
const DANGEROUS_FRONTMATTER_PARTS = [
  "plugin",
  "extension",
  "mcp",
  "hook",
  "command",
  "script",
  "runtime",
  "entrypoint",
  "install",
  "execute",
];

function isDangerousFrontmatterKey(rawKey: string): boolean {
  const normalized = frontmatterKey(rawKey);
  const compact = normalized.replaceAll(/[-_]/gu, "");
  // `allowed-tools` is a standard Agent Skills field. Keep it available as a
  // scalar while rejecting all other tool activation fields.
  if (compact === "allowedtools") return false;
  if (DANGEROUS_FRONTMATTER_KEYS.has(compact)) return true;

  // Match activation terms as their own key segments, or as the stem of a
  // compound key (`plugin-enabled`, `mcpServer`, `scriptPath`, ...). Do not
  // use an arbitrary substring match: ordinary metadata such as
  // `description` contains the letters "script".
  const segments = normalized
    .replaceAll(/([a-z])([A-Z])/gu, "$1-$2")
    .split(/[-_]+/u)
    .map((segment) => segment.toLowerCase());
  return DANGEROUS_FRONTMATTER_PARTS.some(
    (part) =>
      segments.includes(part) ||
      compact.startsWith(part) ||
      compact.endsWith(part)
  );
}


function frontmatterError(
  message: string,
  code: "invalid_frontmatter" | "unsafe_frontmatter" = "invalid_frontmatter"
): never {
  throw new BundleValidationError(message, code, "SKILL.md");
}

function assertFrontmatterText(
  value: string,
  key: string,
  maxChars: number,
  allowEmpty: boolean
): void {
  if (!allowEmpty && value.length === 0) {
    frontmatterError(
      "SKILL.md frontmatter field " + key + " cannot be empty",
      "invalid_frontmatter"
    );
  }
  if ([...value].length > maxChars) {
    frontmatterError(
      "SKILL.md frontmatter field " + key + " exceeds its size limit",
      "invalid_frontmatter"
    );
  }
  if (
    FRONTMATTER_CONTROL_CHARACTER.test(value) ||
    hasLoneSurrogate(value)
  ) {
    frontmatterError(
      "SKILL.md frontmatter field " + key + " contains control characters",
      "unsafe_frontmatter"
    );
  }
}

/**
 * Walk the YAML representation without converting it to JavaScript. This
 * keeps aliases, tags, and custom object construction out of the metadata
 * boundary.
 */
function assertSafeYamlNode(
  node: unknown,
  depth: number,
  budget: { nodes: number },
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_FRONTMATTER_NODES) {
    frontmatterError(
      "SKILL.md frontmatter exceeds the node limit",
      "unsafe_frontmatter",
    );
  }
  if (isAlias(node)) {
    frontmatterError(
      "SKILL.md frontmatter aliases are not allowed",
      "unsafe_frontmatter"
    );
  }
  if (node === null || typeof node !== "object") {
    frontmatterError("SKILL.md frontmatter contains an invalid YAML node");
  }

  const candidate = node as { anchor?: unknown; tag?: unknown };
  if (candidate.anchor !== undefined || candidate.tag !== undefined) {
    frontmatterError(
      "SKILL.md frontmatter anchors and tags are not allowed",
      "unsafe_frontmatter"
    );
  }

  if (isScalar(node)) {
    const value = node.value;
    if (typeof value === "string") {
      assertFrontmatterText(
        value,
        "scalar",
        MAX_FRONTMATTER_VALUE_CHARS,
        true
      );
      return;
    }
    if (typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    frontmatterError(
      "SKILL.md frontmatter scalar values must be strings, numbers, or booleans"
    );
  }

  if (isSeq(node)) {
    if (node.items.length > MAX_FRONTMATTER_SEQUENCE_ITEMS) {
      frontmatterError(
        "SKILL.md frontmatter sequence exceeds its item limit",
        "unsafe_frontmatter",
      );
    }
    for (const item of node.items) {
      assertSafeYamlNode(item, depth + 1, budget);
    }
    return;
  }

  if (isMap(node)) {
    if (depth > MAX_FRONTMATTER_DEPTH) {
      frontmatterError(
        "SKILL.md frontmatter nesting exceeds the allowed depth",
        "unsafe_frontmatter"
      );
    }
    if (node.items.length > MAX_FRONTMATTER_MAP_ITEMS) {
      frontmatterError(
        "SKILL.md frontmatter map exceeds its item limit",
        "unsafe_frontmatter",
      );
    }
    for (const pair of node.items) {
      assertSafeYamlNode(pair.key, depth + 1, budget);
      assertSafeYamlNode(pair.value, depth + 1, budget);
    }
    return;
  }

  frontmatterError("SKILL.md frontmatter contains an unsupported YAML node");
}

function yamlMapKey(node: unknown, location: string): string {
  if (!isScalar(node) || typeof node.value !== "string") {
    frontmatterError(
      "SKILL.md frontmatter " + location + " keys must be strings",
      "invalid_frontmatter"
    );
  }
  const key = node.value;
  if (
    key.length === 0 ||
    key.length > 64 ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key) ||
    FRONTMATTER_CONTROL_CHARACTER.test(key) ||
    hasLoneSurrogate(key)
  ) {
    frontmatterError(
      "SKILL.md frontmatter " + location + " contains an invalid field name",
      "invalid_frontmatter"
    );
  }
  return key;
}

function parseYamlScalar(
  node: unknown,
  key: string,
  maxChars: number,
  allowEmpty: boolean
): FrontmatterScalar {
  if (!isScalar(node)) {
    frontmatterError(
      "SKILL.md frontmatter field " + key + " must be a scalar",
      "unsafe_frontmatter"
    );
  }
  const value = node.value;
  if (typeof value === "string") {
    assertFrontmatterText(value, key, maxChars, allowEmpty);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  frontmatterError(
    "SKILL.md frontmatter field " +
      key +
      " must be a string, number, or boolean"
  );
}

function parseYamlString(
  node: unknown,
  key: string,
  maxChars: number,
  allowEmpty: boolean,
): string {
  const value = parseYamlScalar(node, key, maxChars, allowEmpty);
  if (typeof value !== "string") {
    frontmatterError(
      "SKILL.md frontmatter field " + key + " must be a string",
      "invalid_frontmatter",
    );
  }
  return value;
}

function parseMetadataMap(node: unknown): Record<string, FrontmatterValue> {
  if (!isMap(node)) {
    frontmatterError(
      "SKILL.md frontmatter metadata must be a map of strings",
      "unsafe_frontmatter"
    );
  }
  if (node.items.length > MAX_METADATA_FIELDS) {
    frontmatterError(
      "SKILL.md frontmatter metadata exceeds the " +
        MAX_METADATA_FIELDS +
        "-field limit",
      "invalid_frontmatter"
    );
  }

  const metadata: Record<string, FrontmatterValue> = Object.create(null) as Record<string, FrontmatterValue>;
  const seen = new Set<string>();
  for (const pair of node.items) {
    const key = yamlMapKey(pair.key, "metadata");
    const normalizedKey = frontmatterKey(key).replaceAll(/[-_]/gu, "");
    if (isDangerousFrontmatterKey(key)) {
      frontmatterError(
        "SKILL.md frontmatter metadata field " +
          key +
          " is not allowed to enable plugins or execution",
        "unsafe_frontmatter"
      );
    }
    if (
      seen.has(normalizedKey) ||
      key === "__proto__" ||
      key === "constructor"
    ) {
      frontmatterError(
        "SKILL.md frontmatter metadata contains a duplicate or reserved field " +
          key,
        "invalid_frontmatter"
      );
    }
    seen.add(normalizedKey);
    if (normalizedKey === "openclaw") {
      if (!isMap(pair.value)) {
        frontmatterError(
          "SKILL.md frontmatter metadata.openclaw must be a map",
          "unsafe_frontmatter",
        );
      }
      metadata[key] = parseStructuredMetadataMap(pair.value, "metadata." + key);
      continue;
    }
    const value = parseYamlScalar(
      pair.value,
      "metadata." + key,
      MAX_METADATA_VALUE_CHARS,
      true
    );
    if (typeof value !== "string") {
      frontmatterError(
        "SKILL.md frontmatter metadata field " + key + " must be a string",
        "invalid_frontmatter"
      );
    }
    metadata[key] = value;
  }
  return metadata;
}

/**
 * Parse extension metadata as inert data. This accepts only the bounded maps,
 * sequences, and scalar values already approved by `assertSafeYamlNode`.
 * Dangerous keys remain blocked at every nesting level so an extension field
 * cannot opt into plugins, hooks, or execution.
 */
function parseStructuredMetadataMap(
  node: unknown,
  location: string,
  depth = 0,
): FrontmatterOpenClawMetadata {
  if (!isMap(node)) {
    frontmatterError(
      "SKILL.md frontmatter " + location + " must be a map",
      "unsafe_frontmatter",
    );
  }
  if (depth > MAX_FRONTMATTER_DEPTH || node.items.length > MAX_FRONTMATTER_MAP_ITEMS) {
    frontmatterError(
      "SKILL.md frontmatter " + location + " exceeds its bounds",
      "unsafe_frontmatter",
    );
  }
  const metadata: FrontmatterOpenClawMetadata = Object.create(null) as FrontmatterOpenClawMetadata;
  const seen = new Set<string>();
  for (const pair of node.items) {
    const key = yamlMapKey(pair.key, location);
    const normalizedKey = frontmatterKey(key).replaceAll(/[-_]/gu, "");
    if (
      seen.has(normalizedKey) ||
      key === "__proto__" ||
      key === "constructor" ||
      isDangerousFrontmatterKey(key)
    ) {
      frontmatterError(
        "SKILL.md frontmatter " + location + " contains a duplicate or blocked field " + key,
        "unsafe_frontmatter",
      );
    }
    seen.add(normalizedKey);
    metadata[key] = parseStructuredValue(pair.value, location + "." + key, depth + 1);
  }
  return metadata;
}

function parseStructuredValue(
  node: unknown,
  location: string,
  depth: number,
): FrontmatterOpenClawValue {
  if (depth > MAX_FRONTMATTER_DEPTH) {
    frontmatterError(
      "SKILL.md frontmatter " + location + " exceeds the allowed depth",
      "unsafe_frontmatter",
    );
  }
  if (isScalar(node)) {
    return parseYamlScalar(node, location, MAX_FRONTMATTER_VALUE_CHARS, true);
  }
  if (isSeq(node)) {
    if (node.items.length > MAX_FRONTMATTER_SEQUENCE_ITEMS) {
      frontmatterError(
        "SKILL.md frontmatter " + location + " sequence exceeds its item limit",
        "unsafe_frontmatter",
      );
    }
    return node.items.map((item, index) =>
      parseStructuredValue(item, location + "[" + index + "]", depth + 1),
    );
  }
  if (isMap(node)) {
    return parseStructuredMetadataMap(node, location, depth);
  }
  frontmatterError(
    "SKILL.md frontmatter " + location + " contains an unsupported YAML node",
    "unsafe_frontmatter",
  );
}

function parseFrontmatter(text: string): Record<string, FrontmatterValue> {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines[0] !== "---") {
    throw new BundleValidationError(
      "SKILL.md must begin with YAML frontmatter",
      "missing_frontmatter",
      "SKILL.md"
    );
  }
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) {
    throw new BundleValidationError(
      "SKILL.md frontmatter is not closed",
      "invalid_frontmatter",
      "SKILL.md"
    );
  }
  if (end + 1 > MAX_FRONTMATTER_LINES) {
    frontmatterError(
      "SKILL.md frontmatter exceeds the " +
        MAX_FRONTMATTER_LINES +
        "-line limit",
      "invalid_frontmatter"
    );
  }
  const frontmatterBytes = textEncoder.encode(
    lines.slice(0, end + 1).join("\n")
  ).byteLength;
  if (frontmatterBytes > MAX_FRONTMATTER_BYTES) {
    frontmatterError(
      "SKILL.md frontmatter exceeds the " +
        MAX_FRONTMATTER_BYTES +
        "-byte limit",
      "invalid_frontmatter"
    );
  }

  const source = lines.slice(1, end).join("\n");
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      customTags: [],
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch {
    frontmatterError("SKILL.md frontmatter is not valid YAML");
  }
  const directives = document.directives;
  if (
    !directives ||
    document.errors.length > 0 ||
    document.warnings.length > 0 ||
    directives.docStart !== null ||
    directives.docEnd ||
    directives.yaml.explicit ||
    Object.keys(directives.tags).some((tag) => tag !== "!!")
  ) {
    frontmatterError("SKILL.md frontmatter is not valid safe YAML");
  }
  if (!isMap(document.contents)) {
    frontmatterError(
      "SKILL.md frontmatter must be a mapping",
      "invalid_frontmatter"
    );
  }
  if (document.contents.items.length > MAX_FRONTMATTER_FIELDS) {
    frontmatterError(
      "SKILL.md frontmatter exceeds the " +
        MAX_FRONTMATTER_FIELDS +
        "-field limit",
      "invalid_frontmatter"
    );
  }

  assertSafeYamlNode(document.contents, 0, { nodes: 0 });
  const result: Record<string, FrontmatterValue> = Object.create(null) as Record<
    string,
    FrontmatterValue
  >;
  const seen = new Set<string>();
  for (const pair of document.contents.items) {
    const key = yamlMapKey(pair.key, "frontmatter");
    const normalizedKey = frontmatterKey(key).replaceAll(/[-_]/gu, "");
    if (isDangerousFrontmatterKey(key)) {
      frontmatterError(
        "SKILL.md frontmatter field " +
          key +
          " is not allowed to enable plugins or execution",
        "unsafe_frontmatter"
      );
    }
    if (
      seen.has(normalizedKey) ||
      key === "__proto__" ||
      key === "constructor"
    ) {
      frontmatterError(
        "SKILL.md frontmatter contains a duplicate or reserved field " + key,
        "invalid_frontmatter"
      );
    }
    seen.add(normalizedKey);
    if (frontmatterKey(key) === "metadata") {
      result[key] = parseMetadataMap(pair.value);
    } else if (KNOWN_FRONTMATTER_FIELDS.has(normalizedKey)) {
      result[key] = parseYamlString(
        pair.value,
        key,
        MAX_FRONTMATTER_VALUE_CHARS,
        false,
      );
    } else {
      // The core specification defines a small set of known fields, but
      // real-world skills use additional top-level metadata such as `tags`,
      // `triggers`, and `category`. Preserve those values as bounded inert
      // data while keeping the known fields strict.
      result[key] = parseStructuredValue(pair.value, key, 0);
    }
  }
  return result;
}

/** Parse decoded root SKILL.md metadata without evaluating any payload. */
export function parseSkillMetadata(bundle: unknown): SkillMetadata {
  const normalized = validateBundle(bundle);
  const skillFile = normalized.files.find((file) => file.path === "SKILL.md");
  if (!skillFile) {
    throw new BundleValidationError(
      "bundle must contain a root SKILL.md",
      "missing_skill_metadata",
      "SKILL.md"
    );
  }
  const frontmatter = parseFrontmatter(decodeSkillText(skillFile.content));
  const nameValue = frontmatter.name;
  const descriptionValue = frontmatter.description;
  if (typeof nameValue !== "string" || !NAME_PATTERN.test(nameValue)) {
    throw new BundleValidationError(
      "SKILL.md frontmatter name must use lowercase letters, numbers, and single hyphens",
      "invalid_skill_name",
      "SKILL.md"
    );
  }
  if ([...nameValue].length > 64) {
    throw new BundleValidationError(
      "SKILL.md frontmatter name must be at most 64 characters",
      "invalid_skill_name",
      "SKILL.md"
    );
  }
  if (
    typeof descriptionValue !== "string" ||
    descriptionValue.trim().length === 0 ||
    [...descriptionValue].length > 1_024
  ) {
    throw new BundleValidationError(
      "SKILL.md frontmatter description must be 1-1024 characters",
      "invalid_skill_description",
      "SKILL.md"
    );
  }
  return {
    description: descriptionValue,
    frontmatter,
    skillName: nameValue,
  };
}
