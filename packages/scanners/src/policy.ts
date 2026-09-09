import type {
  PolicyEvaluation,
  ScanResult,
  ScannerAdapter,
  ScannerId,
  ScannerMode,
  ScannerPolicy,
  ScannerRun,
  ScanRequest,
} from './types.js';
import { resultBase, emptyCoverage } from './util.js';

export interface RunConfiguredScannersOptions {
  adapters: Map<ScannerId, ScannerAdapter> | ScannerAdapter[];
  executor?: import('./types.js').CommandExecutor;
  imageForScanner?: (id: ScannerId) => string | undefined;
}

function adapterMap(adapters: Map<ScannerId, ScannerAdapter> | ScannerAdapter[]): Map<ScannerId, ScannerAdapter> {
  return adapters instanceof Map ? adapters : new Map(adapters.map((adapter) => [adapter.id, adapter]));
}

export async function runConfiguredScanners(
  request: ScanRequest,
  policies: ScannerPolicy[],
  options: RunConfiguredScannersOptions,
): Promise<ScannerRun[]> {
  const lookup = adapterMap(options.adapters);
  const runs: ScannerRun[] = [];
  for (const policy of policies) {
    const adapter = lookup.get(policy.id);
    if (policy.mode === 'disabled') {
      const result = disabledResult(request, policy, adapter);
      runs.push({ policy, result, gate: 'disabled' });
      continue;
    }
    if (!adapter) {
      const result = unavailableResult(request, policy);
      runs.push({ policy, result, gate: policy.mode === 'required' ? 'blocked' : 'advisory' });
      continue;
    }
    const run = await adapter.scan({
      ...request,
      mode: policy.mode,
      configuration: policy.configuration,
      image: options.imageForScanner?.(policy.id),
      timeoutMs: Math.max(1, policy.timeoutSeconds) * 1000,
    }, options.executor);
    const gate = policy.mode === 'required' && !requiredResultSatisfies(run.result, policy) ? 'blocked' : policy.mode === 'required' ? 'satisfied' : 'advisory';
    runs.push({ policy, result: run.result, gate });
  }
  return runs;
}

export function evaluatePolicy(
  runs: ScannerRun[],
  options: { allowUnscanned?: boolean } = {},
): PolicyEvaluation {
  const blockedBy: ScannerId[] = [];
  const warnings: string[] = [];
  let enabled = 0;
  let unscanned = false;
  for (const run of runs) {
    if (run.policy.mode === 'disabled') {
      unscanned = true;
      warnings.push(`${run.policy.id} disabled by policy`);
      continue;
    }
    enabled += 1;
    if (run.policy.mode === 'required' && run.gate === 'blocked') blockedBy.push(run.policy.id);
    if (run.policy.mode === 'advisory' && run.result.status !== 'completed') {
      warnings.push(`${run.policy.id} ${run.result.status}: ${run.result.error ?? run.result.coverage.limitations.join('; ')}`);
    }
    if (run.result.coverage.limitations.length > 0) {
      warnings.push(`${run.policy.id} coverage limitation: ${run.result.coverage.limitations.join('; ')}`);
    }
  }
  if (enabled === 0 && options.allowUnscanned !== true) {
    blockedBy.push(...runs.filter((run) => run.policy.mode === 'disabled').map((run) => run.policy.id));
  }
  return { allow: blockedBy.length === 0, unscanned, blockedBy: [...new Set(blockedBy)], warnings: [...new Set(warnings)] };
}

export function requiredResultSatisfies(result: ScanResult, policy: ScannerPolicy): boolean {
  if (result.status !== 'completed') return false;
  if (result.coverage.filesAnalyzed <= 0) return false;
  if (result.coverage.filesSkipped > 0 || result.coverage.filesUnsupported > 0) {
    // Administrators may explicitly accept a named limitation via configuration.
    const accepted = new Set(
      Array.isArray(policy.configuration?.acceptedCoverageLimitations)
        ? policy.configuration.acceptedCoverageLimitations.filter((value): value is string => typeof value === 'string')
        : [],
    );
    if (result.coverage.limitations.some((limitation) => !accepted.has(limitation))) return false;
  }
  const blocking = new Set(policy.blockSeverities);
  return !result.findings.some((finding) => blocking.has(finding.severity));
}

function disabledResult(request: ScanRequest, policy: ScannerPolicy, adapter?: ScannerAdapter): ScanResult {
  // Keep the result schema exact while carrying disabled state as an explicit
  // unsupported/error result. Policy state is stored next to this evidence and
  // is never represented as a successful scan.
  const adapterMetadata = adapter?.metadata ?? {
    id: policy.id,
    version: 'unavailable',
    engineVersion: 'unavailable',
    rulesRevision: 'unavailable',
  };
  return resultBase(request, policy.id, {
    ...adapterMetadata,
    configurationHash: `sha256:${'0'.repeat(64)}`,
  }, 'unsupported', 0, emptyCoverage(0, ['scanner disabled by policy']), [], 'scanner disabled by policy');
}

function unavailableResult(request: ScanRequest, policy: ScannerPolicy): ScanResult {
  return resultBase(request, policy.id, {
    id: policy.id,
    version: 'unavailable',
    engineVersion: 'not-installed',
    rulesRevision: 'unavailable',
    configurationHash: `sha256:${'0'.repeat(64)}`,
  }, 'unsupported', 0, emptyCoverage(0, ['scanner adapter is not installed']), [], `engine not installed: ${policy.id}`);
}
