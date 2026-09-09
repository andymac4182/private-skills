import type { ScanResult as ScannerScanResult, ScannerPolicy } from '../../../packages/scanners/src/types.js';
import type { HookConfiguration, ScanResult as ContractScanResult } from '../../../packages/contracts/src/index.js';

export interface Policy {
  revision: string;
  allowUnscanned?: boolean;
  scanners: ScannerPolicy[] | Record<string, Omit<ScannerPolicy, 'id'> & { id?: string }>;
  hooks?: HookConfiguration[];
}

export function normalizePolicies(policy: Policy | undefined): ScannerPolicy[] {
  if (!policy) return [];
  if (Array.isArray(policy.scanners)) return policy.scanners;
  return Object.entries(policy.scanners).map(([id, value]) => ({
    ...(value as Omit<ScannerPolicy, 'id'>),
    id: (value as { id?: string }).id ?? id,
  })) as ScannerPolicy[];
}

/** The HTTP completion route uses the frozen contracts package shape. */
export type ScanResult = ContractScanResult;
export type { ScannerPolicy };

/**
 * Convert the scanner package's richer internal evidence into the exact
 * persisted contract. Raw reports stay worker-local and are never sent to the
 * registry API.
 */
export function toContractScanResult(result: ScannerScanResult): ContractScanResult {
  return {
    id: result.invocationId,
    organizationId: result.organizationId,
    jobId: result.jobId,
    artifactDigest: result.artifactDigest,
    policyRevision: result.policyRevision,
    scannerId: result.adapter.id,
    engineVersion: result.adapter.engineVersion,
    rulesRevision: result.adapter.rulesRevision,
    configurationHash: result.adapter.configurationHash,
    status: result.status,
    findings: result.findings,
    coverage: result.coverage,
    createdAt: new Date().toISOString(),
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error } : {}),
  };
}
