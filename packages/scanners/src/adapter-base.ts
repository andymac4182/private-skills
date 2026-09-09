import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defaultExecutor } from './executor.js';
import type {
  AdapterMetadata,
  AdapterScan,
  CommandExecutor,
  RawScanReport,
  ScanFinding,
  ScanRequest,
  ScanResult,
  ScannerAdapter,
} from './types.js';
import {
  assertDirectory,
  configurationHash,
  countInputFiles,
  emptyCoverage,
  isObject,
  normalizeFinding,
  resultBase,
  uniqueLimitations,
} from './util.js';

export interface ParsedCoverage {
  filesEnumerated?: number;
  filesAnalyzed?: number;
  filesSkipped?: number;
  filesUnsupported?: number;
  limitations?: string[];
  externalDestinations?: string[];
}

export interface ParsedReport {
  findings: ScanFinding[];
  coverage: ParsedCoverage;
  limitations: string[];
  /** false means the report did not contain enough structured evidence. */
  valid: boolean;
  error?: string;
}

export interface AdapterDefinition {
  id: ScannerAdapter['id'];
  command: string;
  metadata: Omit<AdapterMetadata, 'configurationHash'>;
  buildArgs(inputDir: string, outputPath: string, request: ScanRequest): string[];
  parseReport(report: unknown, inputFileCount: number): ParsedReport;
  fixedLimitations?: string[];
  outputFileName: string;
}

export interface AdapterOptions {
  command?: string;
  adapterVersion?: string;
  engineVersion?: string;
  rulesRevision?: string;
  configuration?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;

export function createCommandAdapter(
  definition: AdapterDefinition,
  options: AdapterOptions = {},
): ScannerAdapter {
  const effectiveConfiguration = {
    ...options.configuration,
    command: options.command ?? definition.command,
    adapter: definition.id,
    engineVersion: options.engineVersion ?? definition.metadata.engineVersion,
    rulesRevision: options.rulesRevision ?? definition.metadata.rulesRevision,
  };
  const metadata: Omit<AdapterMetadata, 'configurationHash'> = {
    ...definition.metadata,
    ...(options.adapterVersion ? { version: options.adapterVersion } : {}),
    ...(options.engineVersion ? { engineVersion: options.engineVersion } : {}),
    ...(options.rulesRevision ? { rulesRevision: options.rulesRevision } : {}),
  };
  const command = options.command ?? definition.command;
  const adapter: ScannerAdapter = {
    id: definition.id,
    command,
    metadata,
    async scan(request, executor = defaultExecutor()): Promise<AdapterScan> {
      const started = Date.now();
      const configHash = configurationHash(effectiveConfiguration);
      const adapterMetadata: AdapterMetadata = { ...metadata, configurationHash: configHash };
      const inputFileCount = await countInputFiles(request.inputDir);
      const baseLimitations = [
        ...(definition.fixedLimitations ?? []),
        ...(await findPublisherScannerControls(request.inputDir)),
      ];
      try {
        await assertDirectory(request.inputDir);
      } catch (error) {
        const result = resultBase(request, definition.id, adapterMetadata, 'error', Date.now() - started, emptyCoverage(inputFileCount), [], String(error));
        return { result };
      }

      const outputDir = join(dirname(request.inputDir), 'output');
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const outputPath = join(outputDir, definition.outputFileName);
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
      const args = definition.buildArgs(request.inputDir, outputPath, request);
      let execution;
      try {
        execution = await executor.run({
          command,
          args,
          cwd: request.inputDir,
          timeoutMs,
          maxOutputBytes,
          signal: request.signal,
          isolation: 'trusted-local',
          inputDir: request.inputDir,
          outputDir,
          image: request.image,
        });
      } catch (error) {
        const durationMs = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        const result = resultBase(request, definition.id, adapterMetadata, 'error', durationMs, emptyCoverage(inputFileCount, baseLimitations), [], message);
        return { result };
      }
      const rawReport = await readOutputReport(outputPath, execution.stdout);
      const raw: RawScanReport = {
        report: rawReport.value,
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        command: [command, ...args],
        timedOut: execution.timedOut,
        outputTruncated: execution.outputTruncated,
      };
      if (execution.timedOut) {
        const result = resultBase(request, definition.id, adapterMetadata, 'timeout', execution.durationMs, emptyCoverage(inputFileCount, baseLimitations), [], 'scanner timed out');
        return { result, raw };
      }
      if (execution.error || execution.exitCode === null) {
        const result = resultBase(request, definition.id, adapterMetadata, 'error', execution.durationMs, emptyCoverage(inputFileCount, baseLimitations), [], execution.error ?? 'scanner process failed');
        return { result, raw };
      }
      if (execution.outputTruncated) {
        const result = resultBase(request, definition.id, adapterMetadata, 'error', execution.durationMs, emptyCoverage(inputFileCount, [...baseLimitations, 'scanner output was truncated']), [], 'scanner output exceeded the configured limit');
        return { result, raw };
      }
      if (!rawReport.ok) {
        const result = resultBase(request, definition.id, adapterMetadata, 'error', execution.durationMs, emptyCoverage(inputFileCount, [...baseLimitations, 'scanner returned invalid JSON']), [], rawReport.error);
        return { result, raw };
      }

      let parsed: ParsedReport;
      try {
        parsed = definition.parseReport(rawReport.value, inputFileCount);
      } catch (error) {
        parsed = { valid: false, findings: [], coverage: {}, limitations: [], error: `scanner report parser failed: ${String(error)}` };
      }
      const limitations = uniqueLimitations([...baseLimitations, ...parsed.limitations, ...(parsed.coverage.limitations ?? [])]);
      const coverage = reconcileCoverage(parsed.coverage, inputFileCount, limitations);
      if (!parsed.valid) {
        const result = resultBase(request, definition.id, adapterMetadata, 'error', execution.durationMs, coverage, parsed.findings, parsed.error ?? 'scanner report did not contain required evidence');
        return { result, raw };
      }
      const degraded = coverage.filesAnalyzed === 0 || coverage.filesSkipped > 0 || coverage.filesUnsupported > 0 || coverage.limitations.length > 0;
      // A non-zero code means findings for all three pinned engines. Only an
      // invalid report or process failure is an execution error.
      const result = resultBase(request, definition.id, adapterMetadata, degraded ? 'degraded' : 'completed', execution.durationMs, coverage, parsed.findings);
      return { result, raw };
    },
  };
  return adapter;
}

async function readOutputReport(path: string, stdout: string): Promise<{ ok: true; value: unknown } | { ok: false; value: undefined; error: string }> {
  try {
    const output = await readFile(path, 'utf8');
    if (!output.trim()) return { ok: false, value: undefined, error: 'scanner report was empty' };
    return { ok: true, value: parseJsonDocument(output) };
  } catch (fileError) {
    if (!stdout.trim()) return { ok: false, value: undefined, error: `scanner report unavailable: ${String(fileError)}` };
    try {
      return { ok: true, value: parseJsonDocument(stdout) };
    } catch (stdoutError) {
      return { ok: false, value: undefined, error: `scanner returned malformed JSON: ${String(stdoutError)}` };
    }
  }
}

function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some pinned releases print a short progress prefix before the JSON report
    // even in machine mode. Find the first balanced JSON object/array without
    // evaluating any content; malformed/truncated documents still fail closed.
    for (let start = 0; start < trimmed.length; start += 1) {
      if (trimmed[start] !== '{' && trimmed[start] !== '[') continue;
      try {
        return JSON.parse(trimmed.slice(start)) as unknown;
      } catch {
        // Keep searching for a later document start. This is bounded by the
        // executor's output cap, so an attacker cannot create an unbounded loop.
      }
    }
    throw new Error('no complete JSON document in scanner output');
  }
}

export function reconcileCoverage(parsed: ParsedCoverage, inputFileCount: number, limitations: string[]): ParsedCoverage & Required<Pick<ParsedCoverage, 'filesEnumerated' | 'filesAnalyzed' | 'filesSkipped' | 'filesUnsupported' | 'limitations' | 'externalDestinations'>> {
  const enumerated = Math.max(0, Number.isFinite(parsed.filesEnumerated) ? Math.floor(parsed.filesEnumerated as number) : inputFileCount);
  const analyzed = Math.max(0, Math.min(enumerated, Number.isFinite(parsed.filesAnalyzed) ? Math.floor(parsed.filesAnalyzed as number) : 0));
  const skipped = Math.max(0, Math.min(enumerated - analyzed, Number.isFinite(parsed.filesSkipped) ? Math.floor(parsed.filesSkipped as number) : Math.max(0, enumerated - analyzed)));
  const unsupported = Math.max(0, Math.min(enumerated - analyzed - skipped, Number.isFinite(parsed.filesUnsupported) ? Math.floor(parsed.filesUnsupported as number) : 0));
  return {
    filesEnumerated: enumerated,
    filesAnalyzed: analyzed,
    filesSkipped: skipped,
    filesUnsupported: unsupported,
    limitations: uniqueLimitations(limitations),
    externalDestinations: [...new Set((parsed.externalDestinations ?? []).filter((item): item is string => typeof item === 'string').slice(0, 100))],
  };
}

export function reportArray(value: unknown, keys: string[]): unknown[] | undefined {
  if (!isObject(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return undefined;
}

export function reportNumber(value: unknown, keys: string[]): number | undefined {
  if (!isObject(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

export function reportString(value: unknown, keys: string[]): string | undefined {
  if (!isObject(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

export function collectFindings(value: unknown, keys: string[] = ['findings', 'issues', 'results']): ScanFinding[] {
  const values = reportArray(value, keys) ?? [];
  const findings: ScanFinding[] = [];
  for (const item of values) {
    if (!isObject(item)) continue;
    const normalized = normalizeFinding(item);
    if (normalized) findings.push(normalized);
  }
  return findings.slice(0, 10000);
}

/**
 * A skill may contain configuration/baseline files or inline suppression
 * markers. They are inert input and are never loaded as scanner configuration,
 * but the upstream scanners do not all expose proof that every suppression was
 * ignored. Record the limitation so a required policy cannot mistake a clean
 * report for complete coverage.
 */
export async function findPublisherScannerControls(inputDir: string): Promise<string[]> {
  const controls: string[] = [];
  const configNames = new Set([
    '.skill_scannerrc',
    '.skill_scannerrc.json',
    'skill_scanner.json',
    'skillsguard.config.json',
    '.skillspector-baseline.yaml',
    '.skillspector-baseline.yml',
    '.skillspector-baseline.json',
  ]);
  try {
    const { enumerateRegularFiles } = await import('./util.js');
    const files = await enumerateRegularFiles(inputDir);
    for (const file of files) {
      if (configNames.has(file.split('/').at(-1) ?? '') || file.startsWith('.skillsguard/')) {
        controls.push(`artifact contains scanner configuration or baseline: ${file}`);
        continue;
      }
      // Read only small text files and detect explicit suppression markers. The
      // scanner itself still receives the original sealed bytes.
      const absolute = `${inputDir}/${file}`;
      const stat = await import('node:fs/promises').then(({ stat }) => stat(absolute));
      if (stat.size > 1024 * 1024) continue;
      const text = await readFile(absolute, 'utf8').catch(() => undefined);
      if (text && /(?:skill[- ]scanner|skillspector|skillsguard|nosec|nolint|scanner[-_ ]?ignore)[^\n]{0,120}/i.test(text)) {
        controls.push(`artifact contains an inline scanner suppression marker: ${file}`);
      }
    }
  } catch {
    controls.push('scanner-control inspection failed');
  }
  return [...new Set(controls)].slice(0, 100);
}
