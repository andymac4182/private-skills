import { createCommandAdapter, reportArray, reportNumber, type AdapterDefinition, type AdapterOptions, type ParsedReport } from '../adapter-base.js';
import { isObject, normalizeFinding, uniqueLimitations } from '../util.js';
import type { ScannerAdapter, ScanFinding } from '../types.js';

export const SKILLSGUARD_PIN = Object.freeze({
  release: '1.1.1',
  sourceRef: 'main',
  sourceKind: 'source-build',
  sourceRevision: '7badb5157f8f9e4dd9ee2acb6e0129636e3147e3',
  source: 'https://github.com/Teycir/SkillsGuard',
  package: 'source build (not published to npm)',
  node: '>=18.3',
  command: 'skillsguard',
});

const definition: AdapterDefinition = {
  id: 'skillsguard',
  command: SKILLSGUARD_PIN.command,
  metadata: {
    id: 'skillsguard',
    version: 'adapter-1',
    engineVersion: SKILLSGUARD_PIN.release,
    rulesRevision: SKILLSGUARD_PIN.sourceRevision,
  },
  outputFileName: 'skillsguard.json',
  fixedLimitations: [
    'SkillsGuard --no-config disables automatic config loading but inline markdown-context suppression behavior remains upstream-controlled',
    'SkillsGuard is pattern/decode-based static analysis and does not observe runtime behavior',
  ],
  buildArgs(inputDir) {
    // --exit-zero keeps the JSON report available when findings are present;
    // the adapter gates on normalized findings and coverage, never on exit 1.
    return [inputDir, '--json', '--no-color', '--no-config', '--exit-zero'];
  },
  parseReport(report, inputFileCount): ParsedReport {
    if (!isObject(report)) return { valid: false, findings: [], coverage: {}, limitations: [], error: 'SkillsGuard report is not a JSON object' };
    const rawFindings = reportArray(report, ['findings', 'issues']) ?? [];
    const findings: ScanFinding[] = rawFindings.flatMap((entry): ScanFinding[] => {
      if (!isObject(entry)) return [];
      const normalized = normalizeFinding({
        ...entry,
        ruleId: entry.ruleId ?? entry.rule_id ?? entry.id,
        file: entry.file ?? entry.file_path ?? entry.path,
        line: entry.line ?? entry.line_number,
        message: entry.message ?? entry.description ?? entry.title,
        evidence: entry.evidence ?? entry.snippet,
      });
      return normalized ? [normalized] : [];
    });
    const filesScanned = reportNumber(report, ['filesScanned', 'files_scanned', 'files_scanned_count']);
    const filesSkipped = reportNumber(report, ['filesSkipped', 'files_skipped', 'skippedFiles']) ?? 0;
    const filesUnsupported = reportNumber(report, ['filesUnsupported', 'files_unsupported', 'unsupportedFiles']) ?? 0;
    const limitations: string[] = [];
    let degraded = false;
    if (filesScanned === undefined) {
      limitations.push('SkillsGuard report did not expose filesScanned coverage');
      degraded = true;
    }
    if (report.safe === true && findings.length > 0) {
      // A stale/false-clean report must never erase normalized findings.
      limitations.push('SkillsGuard report marked safe while returning findings; adapter preserves the findings');
      degraded = true;
    }
    if (report.suppressedCount || report.suppressed_findings) {
      limitations.push('SkillsGuard report indicates suppressed findings; suppression completeness is not independently verifiable');
      degraded = true;
    }
    return {
      valid: Array.isArray(report.findings) || Array.isArray(report.issues),
      findings: findings.slice(0, 10000),
      coverage: {
        filesEnumerated: filesScanned,
        filesAnalyzed: filesScanned,
        filesSkipped,
        filesUnsupported,
        externalDestinations: [],
      },
      limitations: uniqueLimitations(limitations),
      degraded,
      ...(inputFileCount === 0 ? { error: 'SkillsGuard scanner input contains no files' } : {}),
    };
  },
};

export function createSkillsGuardAdapter(options: AdapterOptions = {}): ScannerAdapter {
  return createCommandAdapter(definition, options);
}
