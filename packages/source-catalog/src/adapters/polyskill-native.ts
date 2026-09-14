/**
 * Host-neutral handling for PolySkill's native skill representation.
 *
 * PolySkill's read API returns the source package as JSON.  A native package
 * is made up of a required `skill.json` manifest and optional
 * `instructions.md` and `tools.json` files.  This module only validates and
 * canonicalizes that data; it does not perform I/O, read process state, or
 * activate a tool definition.
 */

import type { Digest } from '../../../contracts/src/index.js';

export const POLYSKILL_SOURCE_ID = 'polyskill' as const;
export const POLYSKILL_API_ORIGIN = 'https://polyskill.ai' as const;
/** Alias retained for callers that use the provider/origin terminology. */
export const POLYSKILL_ORIGIN = POLYSKILL_API_ORIGIN;
export const POLYSKILL_NATIVE_FORMAT = 'polyskill-native-v1' as const;

export type PolyskillJsonPrimitive = string | number | boolean | null;
export type PolyskillJsonValue =
  | PolyskillJsonPrimitive
  | PolyskillJsonValue[]
  | { readonly [key: string]: PolyskillJsonValue };

export interface PolyskillNativeManifest extends Readonly<Record<string, PolyskillJsonValue>> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

export interface PolyskillNativeSkill {
  readonly manifest: PolyskillNativeManifest;
  readonly instructions?: string;
  readonly tools?: PolyskillJsonValue | null;
  readonly adapters?: PolyskillJsonValue | null;
}

/** Tunable bounds used before a native value is retained or hashed. */
export interface PolyskillNativeLimits {
  maxManifestBytes: number;
  maxInstructionsBytes: number;
  maxToolsBytes: number;
  maxAdaptersBytes: number;
  maxSemanticBytes: number;
  maxToolCount: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
}

export const DEFAULT_POLYSKILL_NATIVE_LIMITS: Readonly<PolyskillNativeLimits> = Object.freeze({
  maxManifestBytes: 512 * 1024,
  maxInstructionsBytes: 10 * 1024 * 1024,
  maxToolsBytes: 2 * 1024 * 1024,
  maxAdaptersBytes: 4 * 1024 * 1024,
  maxSemanticBytes: 16 * 1024 * 1024,
  maxToolCount: 256,
  maxJsonDepth: 16,
  maxJsonNodes: 100_000,
});

export type PolyskillNativeErrorCode =
  | 'malformed'
  | 'bounds'
  | 'identity_mismatch'
  | 'unsupported_external_reference'
  | 'unsupported_composite'
  | 'unsupported_remote_tool'
  | 'missing_file';

export class PolyskillNativeError extends Error {
  readonly code: PolyskillNativeErrorCode;

  constructor(code: PolyskillNativeErrorCode, message: string) {
    super(message);
    this.name = 'PolyskillNativeError';
    this.code = code;
  }
}

interface NativeRecord {
  readonly [key: string]: unknown;
}

const TOOL_DEFINITION_KEYS = new Set(['name', 'description', 'parameters', 'inputSchema']);
const SKILL_REFERENCE_KEYS = new Set(['instructions', 'tools']);
const COMPOSITION_KEYS = new Set(['compose', 'composes', 'dependencies', 'dependency', 'requires']);
const NORMALIZED_NATIVE_SKILLS = new WeakSet<object>();

/**
 * Parse and validate one exact PolySkill API response.  Provider listing
 * fields such as `id`, `verified`, and timestamps are deliberately ignored:
 * they are catalog metadata rather than the native package's semantic
 * content and must not silently change an artifact digest.
 */
export function parsePolyskillNativeSkill(
  value: unknown,
  limitsInput: Partial<PolyskillNativeLimits> = {},
): PolyskillNativeSkill {
  const limits = mergeLimits(limitsInput);
  const record = asRecord(value);
  if (!record) throw nativeError('malformed', 'PolySkill response must be an object');

  const manifest = parseManifest(hasOwn(record, 'manifest') ? record.manifest : undefined, limits);
  if (hasOwn(record, 'name') && record.name !== manifest.name) {
    throw nativeError('identity_mismatch', 'PolySkill response name does not match its manifest');
  }
  if (hasOwn(record, 'version') && record.version !== manifest.version) {
    throw nativeError('identity_mismatch', 'PolySkill response version does not match its manifest');
  }
  const instructions = parseOptionalText(hasOwn(record, 'instructions') ? record.instructions : undefined, 'instructions.md', limits.maxInstructionsBytes);
  const tools = parseTools(hasOwn(record, 'tools') ? record.tools : undefined, limits);
  const adapters = parseOptionalJson(hasOwn(record, 'adapters') ? record.adapters : undefined, 'adapters', limits.maxAdaptersBytes, limits);

  const skill = asRecord(manifest.skill);
  const instructionReference = skill?.instructions;
  if (instructionReference !== undefined && instructionReference !== './instructions.md') {
    throw nativeError('unsupported_external_reference', 'PolySkill instructions reference must be ./instructions.md');
  }
  const toolReference = skill?.tools;
  if (toolReference !== undefined && toolReference !== './tools.json') {
    throw nativeError('unsupported_external_reference', 'PolySkill tools reference must be ./tools.json');
  }
  if (instructionReference !== undefined && instructions === undefined) {
    throw nativeError('missing_file', 'PolySkill manifest references a missing instructions.md');
  }
  if (toolReference !== undefined && tools === undefined) {
    throw nativeError('missing_file', 'PolySkill manifest references a missing tools.json');
  }

  const normalized: PolyskillNativeSkill = {
    manifest,
    ...(instructions === undefined ? {} : { instructions }),
    ...(tools === undefined ? {} : { tools }),
    ...(adapters === undefined ? {} : { adapters }),
  };
  NORMALIZED_NATIVE_SKILLS.add(normalized);
  const semanticBytes = serializePolyskillNativeSemanticFields(normalized, limits);
  if (semanticBytes.byteLength > limits.maxSemanticBytes) {
    throw nativeError('bounds', 'PolySkill semantic content exceeds its byte limit');
  }
  return normalized;
}

/** Alias used by adapters that describe this operation as validation. */
export const validatePolyskillNativeSkill = parsePolyskillNativeSkill;

/**
 * Return the exact semantic bytes bound to a PolySkill content digest.
 * Object keys are recursively sorted, while array order and instruction
 * bytes remain unchanged.  Null represents an absent optional field so that
 * omitted and explicit-null API fields have one deterministic spelling.
 */
export function serializePolyskillNativeSemanticFields(
  input: PolyskillNativeSkill | unknown,
  limitsInput: Partial<PolyskillNativeLimits> = {},
): Uint8Array {
  const limits = mergeLimits(limitsInput);
  const skill = isNativeSkill(input) ? input : parsePolyskillNativeSkill(input, limits);
  const semantic = {
    manifest: skill.manifest,
    instructions: skill.instructions ?? null,
    tools: skill.tools ?? null,
    adapters: skill.adapters ?? null,
  } as const;
  const text = canonicalJson(semantic, limits);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > limits.maxSemanticBytes) {
    throw nativeError('bounds', 'PolySkill semantic content exceeds its byte limit');
  }
  return bytes;
}

/** Stable JSON text is useful to non-WebCrypto worker runtimes as well. */
export function canonicalPolyskillNativeJson(
  input: PolyskillNativeSkill | unknown,
  limitsInput: Partial<PolyskillNativeLimits> = {},
): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    serializePolyskillNativeSemanticFields(input, limitsInput),
  );
}

/** Canonical JSON spelling for one retained native source file. */
export function canonicalPolyskillFileJson(
  value: unknown,
  limitsInput: Partial<PolyskillNativeLimits> = {},
): string {
  const limits = mergeLimits(limitsInput);
  assertJsonValue(value, limits, 'native file');
  return canonicalJson(value, limits);
}

/** Compute the provider identity digest without importing a Node crypto API. */
export async function polyskillContentDigest(
  input: PolyskillNativeSkill | unknown,
  limitsInput: Partial<PolyskillNativeLimits> = {},
): Promise<Digest> {
  const bytes = serializePolyskillNativeSemanticFields(input, limitsInput);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw nativeError('malformed', 'Web Crypto SHA-256 is unavailable');
  // TS 7 models Uint8Array buffers as ArrayBufferLike, while WebCrypto's
  // DOM declaration currently requires an ArrayBuffer-backed view. The bytes
  // are freshly allocated by TextEncoder, so this assertion does not widen
  // the data that crosses the digest boundary.
  const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBufferView<ArrayBuffer>);
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

/** Alias retained for callers that use a verb-first naming convention. */
export const computePolyskillContentDigest = polyskillContentDigest;

/** Return the safe Agent Skills slug used by the generated SKILL.md wrapper. */
export function polyskillSkillSlug(name: string): string {
  const parsed = validateSkillName(name);
  let slug = parsed.slice(1).replaceAll('/', '-').replaceAll(/[._]+/gu, '-').replaceAll(/[^a-z0-9-]/gu, '-');
  slug = slug.replaceAll(/-+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!slug) throw nativeError('malformed', 'PolySkill name cannot produce a safe skill slug');
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/u, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw nativeError('malformed', 'PolySkill name cannot produce a safe skill slug');
  }
  return slug;
}

/** Extract a validated native identity for a catalog or worker binding. */
export async function polyskillNativeIdentity(input: unknown): Promise<{
  name: string;
  version: string;
  contentDigest: Digest;
}> {
  const skill = isNativeSkill(input) ? input : parsePolyskillNativeSkill(input);
  const contentDigest = await polyskillContentDigest(skill);
  return {
    name: skill.manifest.name,
    version: skill.manifest.version,
    contentDigest,
  };
}

function parseManifest(value: unknown, limits: PolyskillNativeLimits): PolyskillNativeManifest {
  const manifest = asRecord(value);
  if (!manifest) throw nativeError('malformed', 'PolySkill manifest is required');
  assertJsonValue(manifest, limits, 'skill.json');
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest, limits)).byteLength;
  if (manifestBytes > limits.maxManifestBytes) throw nativeError('bounds', 'PolySkill skill.json exceeds its byte limit');

  if (!hasOwn(manifest, 'name') || !hasOwn(manifest, 'version') || !hasOwn(manifest, 'description')) {
    throw nativeError('malformed', 'PolySkill manifest requires name, version, and description');
  }
  const name = validateSkillName(manifest.name);
  const version = validateVersion(manifest.version);
  const description = validateDescription(manifest.description);
  if (manifest.type !== undefined) {
    if (typeof manifest.type !== 'string' || !/^(?:prompt|tool|workflow|composite)$/u.test(manifest.type)) {
      throw nativeError('malformed', 'PolySkill manifest type is invalid');
    }
    if (manifest.type === 'composite') throw nativeError('unsupported_composite', 'Composite PolySkill skills are unsupported');
  }
  for (const key of Object.keys(manifest)) {
    const normalizedKey = normalizeKey(key);
    // The native manifest is retained as data.  Fields such as `hooks` or
    // `scripts` are not executed by this boundary and therefore are not
    // rejected merely because their names sound executable.  Composition
    // metadata is different: without recursively acquiring its dependencies,
    // a composite package cannot be converted into one complete skill.
    if (COMPOSITION_KEYS.has(normalizedKey) && !isEmptyComposition(manifest[key])) {
      throw nativeError('unsupported_composite', `PolySkill manifest composition field ${key} is unresolved`);
    }
  }

  const skill = hasOwn(manifest, 'skill') ? manifest.skill : undefined;
  if (skill !== undefined) {
    const skillRecord = asRecord(skill);
    if (!skillRecord) throw nativeError('malformed', 'PolySkill manifest skill field is invalid');
    for (const key of Object.keys(skillRecord)) {
      if (!SKILL_REFERENCE_KEYS.has(key)) {
        throw nativeError('unsupported_external_reference', `PolySkill manifest skill field ${key} is unsupported`);
      }
      const valueAtKey = skillRecord[key];
      if (typeof valueAtKey !== 'string') throw nativeError('malformed', `PolySkill manifest skill.${key} must be a string`);
    }
  }

  // Retain every manifest field exactly as data after validation.  JSON
  // responses cannot contain executable values; the checks above ensure that
  // fields that could activate a host boundary are not admitted implicitly.
  return {
    ...(cloneJson(manifest) as Record<string, PolyskillJsonValue>),
    name,
    version,
    description,
  } as PolyskillNativeManifest;
}

function parseOptionalText(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || hasLoneSurrogate(value)) throw nativeError('malformed', `PolySkill ${label} must be text`);
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > maxBytes) throw nativeError('bounds', `PolySkill ${label} exceeds its byte limit`);
  return value;
}

function parseOptionalJson(
  value: unknown,
  label: string,
  maxBytes: number,
  limits: PolyskillNativeLimits,
): PolyskillJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  assertJsonValue(value, limits, label);
  const canonical = canonicalJson(value, limits);
  if (new TextEncoder().encode(canonical).byteLength > maxBytes) {
    throw nativeError('bounds', `PolySkill ${label} exceeds its byte limit`);
  }
  return cloneJson(value) as PolyskillJsonValue;
}

function parseTools(value: unknown, limits: PolyskillNativeLimits): PolyskillJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  // The documented file shape is `{ tools: [...] }`. A few API versions
  // exposed the array directly, so accept that equivalent read form while
  // retaining its original shape in the semantic digest and bundle.
  const tools = asRecord(value);
  if (tools !== undefined) {
    for (const key of Object.keys(tools)) {
      if (key !== 'tools') {
        throw nativeError('unsupported_remote_tool', `PolySkill tools.json field ${key} is unsupported`);
      }
    }
  }
  const toolList = Array.isArray(value) ? value : tools !== undefined && hasOwn(tools, 'tools') ? tools.tools : undefined;
  if (!Array.isArray(toolList)) throw nativeError('malformed', 'PolySkill tools.json requires a tools array');
  assertJsonValue(value, limits, 'tools.json');
  if (toolList.length > limits.maxToolCount) throw nativeError('bounds', 'PolySkill tools.json has too many tools');
  for (const tool of toolList) {
    const definition = asRecord(tool);
    if (!definition) throw nativeError('malformed', 'PolySkill tool definitions must be objects');
    for (const key of Object.keys(definition)) {
      if (!TOOL_DEFINITION_KEYS.has(key)) {
        throw nativeError('unsupported_remote_tool', `PolySkill tool field ${key} is unsupported`);
      }
    }
    if (typeof definition.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(definition.name) || hasLoneSurrogate(definition.name)) {
      throw nativeError('malformed', 'PolySkill tool name is invalid');
    }
    if (definition.description !== undefined && (typeof definition.description !== 'string' || hasLoneSurrogate(definition.description))) {
      throw nativeError('malformed', 'PolySkill tool description is invalid');
    }
    if (definition.parameters !== undefined && !isRecord(definition.parameters)) {
      throw nativeError('malformed', 'PolySkill tool parameters must be a JSON schema object');
    }
    if (definition.inputSchema !== undefined && !isRecord(definition.inputSchema)) {
      throw nativeError('malformed', 'PolySkill tool inputSchema must be a JSON schema object');
    }
  }
  const canonical = canonicalJson(value, limits);
  if (new TextEncoder().encode(canonical).byteLength > limits.maxToolsBytes) {
    throw nativeError('bounds', 'PolySkill tools.json exceeds its byte limit');
  }
  return cloneJson(value) as PolyskillJsonValue;
}

function isNativeSkill(value: unknown): value is PolyskillNativeSkill {
  return isRecord(value) && NORMALIZED_NATIVE_SKILLS.has(value);
}

function mergeLimits(input: Partial<PolyskillNativeLimits>): PolyskillNativeLimits {
  const output = { ...DEFAULT_POLYSKILL_NATIVE_LIMITS };
  for (const key of Object.keys(DEFAULT_POLYSKILL_NATIVE_LIMITS) as Array<keyof PolyskillNativeLimits>) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw nativeError('bounds', `PolySkill ${key} limit is invalid`);
    output[key] = value;
  }
  return output;
}

function assertJsonValue(value: unknown, limits: PolyskillNativeLimits, label: string): asserts value is PolyskillJsonValue {
  const budget = { nodes: 0 };
  walkJson(value, limits, 0, budget, label, new WeakSet<object>());
}

function walkJson(value: unknown, limits: PolyskillNativeLimits, depth: number, budget: { nodes: number }, label: string, ancestors: WeakSet<object>): void {
  budget.nodes += 1;
  if (budget.nodes > limits.maxJsonNodes || depth > limits.maxJsonDepth) throw nativeError('bounds', `PolySkill ${label} JSON is too complex`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && hasLoneSurrogate(value)) throw nativeError('malformed', `PolySkill ${label} contains invalid text`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw nativeError('malformed', `PolySkill ${label} contains an invalid number`);
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw nativeError('malformed', `PolySkill ${label} contains a cyclic value`);
    ancestors.add(value);
    for (const item of value) walkJson(item, limits, depth + 1, budget, label, ancestors);
    ancestors.delete(value);
    return;
  }
  if (!isRecord(value)) throw nativeError('malformed', `PolySkill ${label} contains a non-JSON value`);
  if (ancestors.has(value)) throw nativeError('malformed', `PolySkill ${label} contains a cyclic value`);
  ancestors.add(value);
  for (const key of Object.keys(value)) {
    if (hasLoneSurrogate(key)) throw nativeError('malformed', `PolySkill ${label} contains an invalid key`);
    walkJson(value[key], limits, depth + 1, budget, label, ancestors);
  }
  ancestors.delete(value);
}

function canonicalJson(value: unknown, limits: PolyskillNativeLimits): string {
  const budget = { nodes: 0 };
  const text = canonicalValue(value, limits, 0, budget, new WeakSet<object>());
  if (text === undefined) throw nativeError('malformed', 'PolySkill semantic data contains an unsupported value');
  return text;
}

function canonicalValue(value: unknown, limits: PolyskillNativeLimits, depth: number, budget: { nodes: number }, ancestors: WeakSet<object>): string | undefined {
  budget.nodes += 1;
  if (budget.nodes > limits.maxJsonNodes || depth > limits.maxJsonDepth) throw nativeError('bounds', 'PolySkill semantic JSON is too complex');
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw nativeError('malformed', 'PolySkill semantic data contains invalid text');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw nativeError('malformed', 'PolySkill semantic data contains a cyclic value');
    ancestors.add(value);
    const items = value.map((item) => canonicalValue(item, limits, depth + 1, budget, ancestors));
    ancestors.delete(value);
    if (items.some((item) => item === undefined)) return undefined;
    return `[${items.join(',')}]`;
  }
  if (!isRecord(value)) return undefined;
  if (ancestors.has(value)) throw nativeError('malformed', 'PolySkill semantic data contains a cyclic value');
  ancestors.add(value);
  const keys = Object.keys(value).sort();
  const entries: string[] = [];
  for (const key of keys) {
    if (hasLoneSurrogate(key)) throw nativeError('malformed', 'PolySkill semantic data contains an invalid key');
    const item = canonicalValue(value[key], limits, depth + 1, budget, ancestors);
    if (item === undefined) {
      ancestors.delete(value);
      return undefined;
    }
    entries.push(`${JSON.stringify(key)}:${item}`);
  }
  ancestors.delete(value);
  return `{${entries.join(',')}}`;
}

function cloneJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, { value: cloneJson((value as NativeRecord)[key]), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function validateSkillName(value: unknown): string {
  if (typeof value !== 'string' || hasLoneSurrogate(value) || !/^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw nativeError('malformed', 'PolySkill manifest name is invalid');
  }
  return value;
}

function validateVersion(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || hasLoneSurrogate(value) || /[\u0000-\u001f\u007f]/u.test(value) || /[\\/]/u.test(value)) {
    throw nativeError('malformed', 'PolySkill manifest version is invalid');
  }
  return value;
}

function validateDescription(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || hasLoneSurrogate(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw nativeError('malformed', 'PolySkill manifest description is invalid');
  }
  return value;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replaceAll(/[-_]/gu, '');
}

function isEmptyComposition(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function asRecord(value: unknown): NativeRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is NativeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: NativeRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function nativeError(code: PolyskillNativeErrorCode, message: string): PolyskillNativeError {
  return new PolyskillNativeError(code, message);
}

function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}
