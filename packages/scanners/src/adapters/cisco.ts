import { normalizeFinding } from '../util.js';
import { reportArray, reportNumber } from '../adapter-base.js';
import { createCommandAdapter, type AdapterDefinition, type AdapterOptions, type ParsedReport } from '../adapter-base.js';
import type { ScannerAdapter, ScanFinding } from '../types.js';
import { isObject, uniqueLimitations } from '../util.js';

export const CISCO_PIN = Object.freeze({
  release: '2.1.0',
  sourceRef: '2.1.0',
  sourceRevision: 'a24df340ca6056a6446a239f4a7b114b11c6073a',
  source: 'https://github.com/cisco-ai-defense/skill-scanner',
  package: 'cisco-ai-skill-scanner==2.1.0',
  python: '3.11-3.14',
  command: 'skill-scanner',
});

const definition: AdapterDefinition = {
  id: 'cisco-skill-scanner',
  command: CISCO_PIN.command,
  metadata: {
    id: 'cisco-skill-scanner',
    version: 'adapter-1',
    engineVersion: CISCO_PIN.release,
    rulesRevision: CISCO_PIN.release,
  },
  outputFileName: 'cisco.json',
  buildArgs(inputDir, outputPath, request) {
    const args = ['scan', inputDir, '--format', 'json', '--output', outputPath, '--compact'];
    const config = request.configuration ?? {};
    // Never enable Cisco's behavioral analyzer: scanning is static-only and
    // must not execute publisher-provided scripts or commands.
    if (typeof config.policy === 'string' && /^(strict|balanced|permissive)$/.test(config.policy)) {
      args.push('--policy', config.policy);
    }
    return args;
  },
  parseReport(report, inputFileCount): ParsedReport {
    if (!isObject(report)) return { valid: false, findings: [], coverage: {}, limitations: [], error: 'Cisco report is not a JSON object' };
    const findings = collectCiscoFindings(report);
    const summary = isObject(report.summary) ? report.summary : undefined;
    const coverageRoot = isObject(report.coverage) ? report.coverage : undefined;
    const filesEnumerated = firstNumber(report, summary, coverageRoot, ['files_enumerated', 'filesEnumerated', 'files_scanned', 'filesScanned', 'total_files']);
    const filesAnalyzed = firstNumber(report, summary, coverageRoot, ['files_analyzed', 'filesAnalyzed', 'files_scanned', 'filesScanned']);
    const filesSkipped = firstNumber(report, summary, coverageRoot, ['files_skipped', 'filesSkipped', 'skipped_files']);
    const filesUnsupported = firstNumber(report, summary, coverageRoot, ['files_unsupported', 'filesUnsupported', 'unsupported_files', 'unanalysable_files']);
    const limitations: string[] = [];
    let degraded = false;
    if (filesAnalyzed === undefined) limitations.push('Cisco JSON report does not expose analyzed-file coverage for this release');
    if (filesAnalyzed === undefined) degraded = true;
    if (Array.isArray(report.suppressed_findings) && report.suppressed_findings.length > 0) {
      limitations.push('Cisco report contains suppressed findings; suppression completeness is not independently verifiable');
      degraded = true;
    }
    const destinations = Array.isArray(report.external_destinations)
      ? report.external_destinations.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      valid: Array.isArray(report.findings) || Array.isArray(report.results) || Array.isArray(report.issues),
      findings,
      coverage: { filesEnumerated, filesAnalyzed, filesSkipped, filesUnsupported, externalDestinations: destinations },
      limitations: uniqueLimitations(limitations),
      degraded,
      ...(inputFileCount === 0 ? { error: 'Cisco scanner input contains no files' } : {}),
    };
  },
};

export function createCiscoAdapter(options: AdapterOptions = {}): ScannerAdapter {
  return createCommandAdapter(definition, options);
}

function firstNumber(root: Record<string, unknown>, summary: Record<string, unknown> | undefined, coverage: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const source of [root, summary, coverage]) {
    if (!source) continue;
    const value = reportNumber(source, keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function collectCiscoFindings(report: Record<string, unknown>): ScanFinding[] {
  const candidates: unknown[] = [];
  for (const key of ['findings', 'results', 'issues']) {
    const values = reportArray(report, [key]);
    if (values) candidates.push(...values);
  }
  const output: ScanFinding[] = [];
  for (const value of candidates) {
    if (!isObject(value)) continue;
    const normalized = normalizeFinding({
      ...value,
      ruleId: value.rule_id ?? value.ruleId ?? value.id,
      file: value.file_path ?? value.file ?? value.path,
      line: value.line_number ?? value.line ?? value.start_line,
      message: value.description ?? value.message ?? value.title,
      evidence: value.snippet ?? value.evidence,
    });
    if (normalized) output.push(normalized);
  }
  return output.slice(0, 10000);
}
