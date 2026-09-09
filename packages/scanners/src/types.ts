import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export const SCAN_SCHEMA_VERSION = 1 as const;

export type ScannerId =
  | 'cisco-skill-scanner'
  | 'nvidia-skillspector'
  | 'skillsguard';

export type ScannerMode = 'disabled' | 'advisory' | 'required';

export type ScanStatus =
  | 'completed'
  | 'degraded'
  | 'error'
  | 'timeout'
  | 'unsupported';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface ScannerPolicy {
  id: ScannerId;
  mode: ScannerMode;
  blockSeverities: Severity[];
  timeoutSeconds: number;
  configuration?: Record<string, unknown>;
}

export interface Coverage {
  filesEnumerated: number;
  filesAnalyzed: number;
  filesSkipped: number;
  filesUnsupported: number;
  limitations: string[];
  externalDestinations: string[];
}

export interface ScanFinding {
  ruleId: string;
  fingerprint: `sha256:${string}`;
  severity: Severity;
  category: string;
  message: string;
  file?: string;
  line?: number;
  redactedEvidence?: string;
}

export interface AdapterMetadata {
  id: ScannerId;
  version: string;
  engineVersion: string;
  rulesRevision: string;
  configurationHash: `sha256:${string}`;
}

export interface ScanResult {
  schemaVersion: typeof SCAN_SCHEMA_VERSION;
  organizationId: string;
  jobId: string;
  invocationId: string;
  artifactDigest: `sha256:${string}`;
  policyRevision: string;
  adapter: AdapterMetadata;
  status: ScanStatus;
  durationMs: number;
  coverage: Coverage;
  findings: ScanFinding[];
  error?: string;
}

export interface ScanRequest {
  organizationId: string;
  jobId: string;
  invocationId?: string;
  artifactDigest: `sha256:${string}`;
  policyRevision: string;
  inputDir: string;
  mode?: ScannerMode;
  configuration?: Record<string, unknown>;
  /** Trusted worker image selected by the worker for this adapter. */
  image?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface CommandRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  isolation?: 'trusted-local' | 'container';
  inputDir?: string;
  outputDir?: string;
  image?: string;
  memoryBytes?: number;
  cpus?: number;
  pidsLimit?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  error?: string;
}

export interface CommandExecutor {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface RawScanReport {
  report: unknown;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  command: string[];
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface AdapterScan {
  result: ScanResult;
  raw?: RawScanReport;
}

export interface ScannerAdapter {
  readonly id: ScannerId;
  readonly metadata: Omit<AdapterMetadata, 'configurationHash'>;
  readonly command: string;
  scan(
    request: ScanRequest,
    executor?: CommandExecutor,
  ): Promise<AdapterScan>;
}

export interface ScannerRun {
  policy: ScannerPolicy;
  result: ScanResult;
  gate: 'satisfied' | 'blocked' | 'advisory' | 'disabled';
}

export interface PolicyEvaluation {
  allow: boolean;
  unscanned: boolean;
  blockedBy: ScannerId[];
  warnings: string[];
}

export type SpawnedProcess = ChildProcessWithoutNullStreams;
