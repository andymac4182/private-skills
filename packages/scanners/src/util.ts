import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type {
  Coverage,
  ScanFinding,
  ScanRequest,
  ScanResult,
  ScannerId,
} from './types.js';
import { SCAN_SCHEMA_VERSION } from './types.js';

const MAX_ERROR_LENGTH = 2048;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_EVIDENCE_LENGTH = 2048;
const MAX_PATH_LENGTH = 1024;

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Stable JSON used for configuration hashes and cache keys. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(',')}}`;
}

export function configurationHash(value: unknown): `sha256:${string}` {
  return sha256(stableJson(value ?? {}));
}

export function boundedText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  // Reports are untrusted. Remove control characters while preserving tabs/newlines
  // that are useful for an operator reading a finding.
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export function redactEvidence(value: unknown): string | undefined {
  if (value == null) return undefined;
  let text = boundedText(value, MAX_EVIDENCE_LENGTH);
  // Keep report excerpts useful without allowing common credential forms into
  // logs and notifications. Raw reports remain private and bounded by the runner.
  text = text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key|token|secret|password)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED]');
  return text || undefined;
}

export function normalizeSeverity(value: unknown): ScanFinding['severity'] {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'critical' || text === 'crit' || text === 'blocker') return 'critical';
  if (text === 'high' || text === 'error' || text === 'severe') return 'high';
  if (text === 'medium' || text === 'moderate' || text === 'warning' || text === 'warn') return 'medium';
  if (text === 'low' || text === 'minor') return 'low';
  return 'info';
}

export function normalizeFilePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!candidate || candidate.length > MAX_PATH_LENGTH || candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) {
    return undefined;
  }
  const parts = candidate.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\u0000'))) {
    return undefined;
  }
  return parts.join('/');
}

export function findingFingerprint(
  ruleId: string,
  file: string | undefined,
  line: number | undefined,
  message: string,
): `sha256:${string}` {
  return sha256(`${ruleId}\u0000${file ?? ''}\u0000${line ?? ''}\u0000${message}`);
}

export interface ReportFindingLike {
  ruleId?: unknown;
  rule_id?: unknown;
  id?: unknown;
  category?: unknown;
  type?: unknown;
  severity?: unknown;
  level?: unknown;
  message?: unknown;
  description?: unknown;
  title?: unknown;
  file?: unknown;
  file_path?: unknown;
  path?: unknown;
  line?: unknown;
  line_number?: unknown;
  start_line?: unknown;
  evidence?: unknown;
  snippet?: unknown;
  fingerprint?: unknown;
}

export function normalizeFinding(value: ReportFindingLike): ScanFinding | undefined {
  const ruleId = boundedText(value.ruleId ?? value.rule_id ?? value.id ?? 'unknown', 128).trim();
  const message = boundedText(value.message ?? value.description ?? value.title ?? 'Scanner finding', MAX_MESSAGE_LENGTH).trim();
  if (!ruleId || !message) return undefined;
  const file = normalizeFilePath(value.file ?? value.file_path ?? value.path);
  const rawLine = value.line ?? value.line_number ?? value.start_line;
  const lineNumber = typeof rawLine === 'number' ? rawLine : Number.parseInt(String(rawLine ?? ''), 10);
  const line = Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : undefined;
  const category = boundedText(value.category ?? value.type ?? 'scanner', 128).trim() || 'scanner';
  const fingerprintText = typeof value.fingerprint === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value.fingerprint)
    ? value.fingerprint.toLowerCase() as `sha256:${string}`
    : findingFingerprint(ruleId, file, line, message);
  return {
    ruleId,
    fingerprint: fingerprintText,
    severity: normalizeSeverity(value.severity ?? value.level),
    category,
    message,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    ...(redactEvidence(value.evidence ?? value.snippet) ? { redactedEvidence: redactEvidence(value.evidence ?? value.snippet) } : {}),
  };
}

export function emptyCoverage(filesEnumerated = 0, limitations: string[] = []): Coverage {
  return {
    filesEnumerated,
    filesAnalyzed: 0,
    filesSkipped: 0,
    filesUnsupported: 0,
    limitations: uniqueLimitations(limitations),
    externalDestinations: [],
  };
}

export function uniqueLimitations(values: unknown[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = boundedText(value, 1024).trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      output.push(item);
    }
  }
  return output.slice(0, 100);
}

export async function enumerateRegularFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symlink is not allowed in scanner input: ${relative(root, absolute)}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        output.push(relative(root, absolute).split(sep).join('/'));
      } else {
        throw new Error(`special file is not allowed in scanner input: ${relative(root, absolute)}`);
      }
    }
  }
  await visit(root);
  return output;
}

export async function countInputFiles(root: string): Promise<number> {
  try {
    return (await enumerateRegularFiles(root)).length;
  } catch {
    return 0;
  }
}

export function makeInvocationId(request: ScanRequest): string {
  return request.invocationId ?? randomUUID();
}

export function resultBase(
  request: ScanRequest,
  scannerId: ScannerId,
  metadata: ScanResult['adapter'],
  status: ScanResult['status'],
  durationMs: number,
  coverage: Coverage,
  findings: ScanFinding[] = [],
  error?: unknown,
): ScanResult {
  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    organizationId: boundedText(request.organizationId, 128),
    jobId: boundedText(request.jobId, 128),
    invocationId: makeInvocationId(request),
    artifactDigest: request.artifactDigest,
    policyRevision: boundedText(request.policyRevision, 128),
    adapter: { ...metadata, id: scannerId },
    status,
    durationMs: Math.max(0, Math.floor(durationMs)),
    coverage,
    findings,
    ...(error ? { error: boundedText(error, MAX_ERROR_LENGTH) } : {}),
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`scanner input is not a directory: ${path}`);
}

