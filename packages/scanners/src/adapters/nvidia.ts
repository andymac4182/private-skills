import { createCommandAdapter, reportArray, reportNumber, reportString, type AdapterDefinition, type AdapterOptions, type ParsedReport } from '../adapter-base.js';
import { isObject, normalizeFinding, uniqueLimitations } from '../util.js';
import type { ScannerAdapter, ScanFinding } from '../types.js';

export const NVIDIA_PIN = Object.freeze({
  release: '2.11.1',
  sourceRef: 'v2.11.1',
  sourceRevision: '704bc9544260c2f41222dc0f92982521709496ab',
  source: 'https://github.com/NVIDIA/SkillSpector',
  package: 'skillspector==2.11.1',
  python: '3.12-3.14',
  command: 'skillspector',
});

const definition: AdapterDefinition = {
  id: 'nvidia-skillspector',
  command: NVIDIA_PIN.command,
  metadata: {
    id: 'nvidia-skillspector',
    version: 'adapter-1',
    engineVersion: NVIDIA_PIN.release,
    rulesRevision: NVIDIA_PIN.release,
  },
  outputFileName: 'nvidia.json',
  fixedLimitations: [
    'SkillSpector SC4 sends dependency coordinates to OSV.dev even with --no-llm; network-denied workers use the bundled fallback list',
    'SkillSpector is static analysis and does not observe runtime behavior or encrypted/binary content',
  ],
  degradedLimitations: [
    'SkillSpector SC4 sends dependency coordinates to OSV.dev even with --no-llm; network-denied workers use the bundled fallback list',
  ],
  buildArgs(inputDir, outputPath) {
    // Do not pass a URL or archive supplied by the skill. The runner gives the
    // scanner a fresh local directory and disables network in the container.
    return ['scan', inputDir, '--no-llm', '--format', 'json', '--output', outputPath];
  },
  parseReport(report, inputFileCount): ParsedReport {
    if (!isObject(report)) return { valid: false, findings: [], coverage: {}, limitations: [], error: 'SkillSpector report is not a JSON object' };
    const metadata = isObject(report.metadata) ? report.metadata : undefined;
    const components = reportArray(report, ['components']) ?? [];
    const ledger = metadata && isObject(metadata.inspection_ledger) ? metadata.inspection_ledger : isObject(report.inspection_ledger) ? report.inspection_ledger : undefined;
    const issues = reportArray(report, ['issues', 'findings']) ?? [];
    const findings = issues.flatMap((entry): ScanFinding[] => {
      if (!isObject(entry)) return [];
      const location = isObject(entry.location) ? entry.location : undefined;
      const normalized = normalizeFinding({
        ...entry,
        ruleId: entry.rule_id ?? entry.ruleId ?? entry.id,
        category: entry.category ?? entry.type,
        file: entry.file ?? entry.file_path ?? entry.path ?? location?.file ?? location?.path,
        line: entry.line ?? entry.start_line ?? location?.start_line ?? location?.line,
        message: entry.message ?? entry.description ?? entry.title ?? entry.explanation,
        evidence: entry.evidence ?? entry.snippet ?? entry.matched_text,
      });
      return normalized ? [normalized] : [];
    });
    const filesEnumerated = firstNumber(report, metadata, ledger, ['files_enumerated', 'filesEnumerated', 'files_scanned', 'filesScanned', 'total_files'])
      ?? (components.length > 0 ? components.length : undefined);
    const filesAnalyzed = firstNumber(report, metadata, ledger, ['files_analyzed', 'filesAnalyzed', 'files_scanned', 'filesScanned'])
      ?? (components.length > 0 ? components.filter((component) => isObject(component) && component.type !== 'unsupported' && component.type !== 'binary').length : undefined);
    const filesSkipped = firstNumber(report, metadata, ledger, ['files_skipped', 'filesSkipped', 'skipped_files', 'excluded_files'])
      ?? ledgerCount(ledger, ['skipped', 'excluded']);
    const filesUnsupported = firstNumber(report, metadata, ledger, ['files_unsupported', 'filesUnsupported', 'unsupported_files', 'failed_files'])
      ?? ledgerCount(ledger, ['unsupported', 'failed']);
    const limitations: string[] = [];
    let degraded = false;
    if (filesAnalyzed === undefined) limitations.push('SkillSpector report did not expose analyzed-file coverage');
    if (filesAnalyzed === undefined) degraded = true;
    if (metadata?.llm_requested === true || metadata?.llm_used === true) {
      limitations.push('SkillSpector report indicates LLM analysis was requested; this adapter requires static-only mode');
      degraded = true;
    }
    if (Array.isArray(report.suppressed_findings) && report.suppressed_findings.length > 0) {
      limitations.push('SkillSpector report contains baseline-suppressed findings; suppression completeness is not independently verifiable');
      degraded = true;
    }
    const reportedVersion = reportString(metadata, ['skillspector_version', 'version']);
    if (reportedVersion && reportedVersion !== NVIDIA_PIN.release) {
      limitations.push(`report engine version ${reportedVersion} differs from pinned ${NVIDIA_PIN.release}`);
      degraded = true;
    }
    const destinations = [] as string[];
    // The static adapter never grants external access. This records the actual
    // destination only if a deployment explicitly opts into OSV egress.
    if (metadata?.osv_egress_enabled === true) destinations.push('https://api.osv.dev');
    return {
      valid: Array.isArray(report.issues) || Array.isArray(report.findings),
      findings: findings.slice(0, 10000),
      coverage: { filesEnumerated, filesAnalyzed, filesSkipped, filesUnsupported, externalDestinations: destinations },
      limitations: uniqueLimitations(limitations),
      degraded,
      ...(inputFileCount === 0 ? { error: 'SkillSpector scanner input contains no files' } : {}),
    };
  },
};

export function createNvidiaAdapter(options: AdapterOptions = {}): ScannerAdapter {
  return createCommandAdapter(definition, options);
}

function firstNumber(root: Record<string, unknown>, metadata: Record<string, unknown> | undefined, ledger: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const source of [root, metadata, ledger]) {
    if (!source) continue;
    const value = reportNumber(source, keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function ledgerCount(ledger: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!ledger) return undefined;
  for (const key of keys) {
    const value = ledger[key];
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}
