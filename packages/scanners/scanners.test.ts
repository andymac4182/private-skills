import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCiscoAdapter,
  createNvidiaAdapter,
  createSkillsGuardAdapter,
  mapDockerScannerArgs,
  requiredResultSatisfies,
  TrustedLocalExecutor,
  type CommandExecutor,
  type CommandRequest,
  type CommandResult,
  type ScannerAdapter,
  type ScannerPolicy,
} from './src/index.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

async function withInput<T>(callback: (inputDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'private-skills-scanner-test-'));
  const inputDir = join(root, 'input');
  await mkdir(inputDir, { recursive: true });
  await writeFile(join(inputDir, 'SKILL.md'), '# fixture\n');
  await writeFile(join(inputDir, 'scripts.py'), 'print("fixture")\n');
  try {
    return await callback(inputDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function reportExecutor(report: unknown, exitCode = 0, mutate?: (request: CommandRequest) => void): CommandExecutor & { last?: CommandRequest } {
  const executor: CommandExecutor & { last?: CommandRequest } = {
    async run(request: CommandRequest): Promise<CommandResult> {
      executor.last = request;
      mutate?.(request);
      if (request.outputDir) {
        await mkdir(request.outputDir, { recursive: true });
        const outputName = request.command.includes('skillsguard')
          ? 'skillsguard.json'
          : request.command.includes('skillspector')
            ? 'nvidia.json'
            : 'cisco.json';
        await writeFile(join(request.outputDir, outputName), JSON.stringify(report));
      }
      return { exitCode, signal: null, stdout: '', stderr: '', durationMs: 4, timedOut: false, outputTruncated: false };
    },
  };
  return executor;
}

function request(inputDir: string, id: string) {
  return {
    organizationId: 'org-fixture',
    jobId: `job-${id}`,
    invocationId: `scan-${id}`,
    artifactDigest: DIGEST,
    policyRevision: 'policy-fixture',
    inputDir,
    configuration: { behavioral: true },
  };
}

describe('pinned scanner adapters', () => {
  it('maps adapter host paths to the scanner container mounts without prefix collisions', () => {
    const inputDir = '/private/tmp/worker/input';
    const outputDir = '/private/tmp/worker/output';
    expect(mapDockerScannerArgs([
      inputDir,
      '--output',
      `${outputDir}/cisco.json`,
      `--input=${inputDir}/nested/SKILL.md`,
      `${inputDir}-copy`,
      '/private/tmp/worker',
      'relative/SKILL.md',
    ], inputDir, outputDir)).toEqual([
      '/input',
      '--output',
      '/output/cisco.json',
      '--input=/input/nested/SKILL.md',
      `${inputDir}-copy`,
      '/private/tmp/worker',
      'relative/SKILL.md',
    ]);
  });

  it('runs Cisco in static JSON mode and preserves findings from the real report shape', async () => {
    const report = await fixture('cisco-findings.json');
    await withInput(async (inputDir) => {
      const executor = reportExecutor(report);
      const scan = await createCiscoAdapter().scan(request(inputDir, 'cisco'), executor);
      expect(scan.result.adapter.engineVersion).toBe('2.1.0');
      expect(scan.result.findings).toHaveLength(1);
      expect(scan.result.findings[0]?.ruleId).toBe('DATA_EXFIL_HTTP_POST');
      expect(scan.result.findings[0]?.severity).toBe('high');
      expect(scan.result.findings[0]?.redactedEvidence).not.toContain('secret-token');
      expect(scan.result.coverage.limitations).toContain('Cisco JSON report does not expose analyzed-file coverage for this release');
      expect(executor.last?.args).toContain('--compact');
      expect(executor.last?.args).not.toContain('--use-behavioral');
    });
  });

  it('runs SkillSpector with --no-llm and records static/OSV coverage limits', async () => {
    const report = await fixture('skillspector-static.json');
    await withInput(async (inputDir) => {
      const executor = reportExecutor(report);
      const scan = await createNvidiaAdapter().scan(request(inputDir, 'nvidia'), executor);
      expect(scan.result.findings[0]?.ruleId).toBe('SC2_COMMAND_EXECUTION');
      expect(scan.result.coverage.filesAnalyzed).toBe(1);
      expect(scan.result.status).toBe('degraded');
      expect(scan.result.coverage.limitations.join(' ')).toContain('OSV.dev');
      expect(executor.last?.args).toEqual(expect.arrayContaining(['--no-llm', '--format', 'json']));
    });
  });

  it('does not trust a SkillsGuard clean flag over findings or suppressions', async () => {
    const report = await fixture('skillsguard-false-clean.json');
    await withInput(async (inputDir) => {
      const scan = await createSkillsGuardAdapter().scan(request(inputDir, 'skillsguard'), reportExecutor(report));
      expect(scan.result.status).toBe('degraded');
      expect(scan.result.findings).toHaveLength(1);
      expect(scan.result.findings[0]?.severity).toBe('critical');
      expect(scan.result.coverage.limitations.join(' ')).toContain('marked safe');
      expect(scan.result.coverage.limitations.join(' ')).toContain('suppressed');
    });
  });

  it('keeps a complete static SkillsGuard pass completed despite scope notes', async () => {
    await withInput(async (inputDir) => {
      const scan = await createSkillsGuardAdapter().scan(
        request(inputDir, 'skillsguard-clean'),
        reportExecutor({ filesScanned: 2, findings: [] }),
      );
      expect(scan.result.status).toBe('completed');
      expect(scan.result.coverage.filesAnalyzed).toBe(2);
      expect(scan.result.coverage.limitations.join(' ')).toContain('does not observe runtime behavior');
    });
  });

  it('uses the worker file set as the coverage denominator for every pinned adapter', async () => {
    const cases: Array<{ name: string; adapter: () => ScannerAdapter; report: unknown }> = [
      {
        name: 'cisco-underreported',
        adapter: createCiscoAdapter,
        report: { findings: [], files_enumerated: 1, files_analyzed: 1, files_skipped: 0, files_unsupported: 0 },
      },
      {
        name: 'nvidia-underreported',
        adapter: createNvidiaAdapter,
        report: { issues: [], files_enumerated: 1, files_analyzed: 1, files_skipped: 0, files_unsupported: 0 },
      },
      {
        name: 'skillsguard-underreported',
        adapter: createSkillsGuardAdapter,
        report: { findings: [], filesScanned: 1, filesSkipped: 0, filesUnsupported: 0 },
      },
    ];

    await withInput(async (inputDir) => {
      for (const testCase of cases) {
        const scan = await testCase.adapter().scan(request(inputDir, testCase.name), reportExecutor(testCase.report));
        expect(scan.result.coverage.filesEnumerated, testCase.name).toBe(2);
        expect(scan.result.coverage.filesAnalyzed, testCase.name).toBe(1);
        expect(scan.result.status, testCase.name).toBe('degraded');
        expect(scan.result.coverage.limitations, testCase.name).toContain(
          'scanner coverage mismatch: report enumerated 1 file but worker observed 2',
        );
      }
    });
  });

  it('counts regular signature and binary files in the worker denominator', async () => {
    await withInput(async (inputDir) => {
      await writeFile(join(inputDir, 'artifact.sig'), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      const scan = await createSkillsGuardAdapter().scan(
        request(inputDir, 'skillsguard-signature'),
        reportExecutor({ findings: [], filesScanned: 2, filesSkipped: 0, filesUnsupported: 0 }),
      );
      expect(scan.result.coverage).toMatchObject({ filesEnumerated: 3, filesAnalyzed: 2, filesSkipped: 0, filesUnsupported: 0 });
      expect(scan.result.status).toBe('degraded');
      expect(scan.result.coverage.limitations).toContain(
        'scanner coverage mismatch: report enumerated 2 files but worker observed 3',
      );
      expect(requiredResultSatisfies(scan.result, {
        id: 'skillsguard',
        mode: 'required',
        blockSeverities: ['high', 'critical'],
        timeoutSeconds: 2,
      })).toBe(false);
    });
  });

  it('does not approve overreported or incomplete coverage when report partitions look clean', async () => {
    const requiredPolicy = (id: ScannerPolicy['id']): ScannerPolicy => ({
      id,
      mode: 'required',
      blockSeverities: ['high', 'critical'],
      timeoutSeconds: 2,
    });
    await withInput(async (inputDir) => {
      const overreported = await createSkillsGuardAdapter().scan(
        request(inputDir, 'skillsguard-overreported'),
        reportExecutor({ findings: [], filesScanned: 99, filesSkipped: 0, filesUnsupported: 0 }),
      );
      expect(overreported.result.coverage).toMatchObject({ filesEnumerated: 2, filesAnalyzed: 2, filesSkipped: 0, filesUnsupported: 0 });
      expect(overreported.result.status).toBe('degraded');
      expect(overreported.result.coverage.limitations).toContain(
        'scanner coverage mismatch: report enumerated 99 files but worker observed 2',
      );
      expect(requiredResultSatisfies(overreported.result, requiredPolicy('skillsguard'))).toBe(false);

      const sameTotalIncomplete = await createCiscoAdapter().scan(
        request(inputDir, 'cisco-incomplete'),
        reportExecutor({ findings: [], files_enumerated: 2, files_analyzed: 1, files_skipped: 0, files_unsupported: 0 }),
      );
      expect(sameTotalIncomplete.result.coverage).toMatchObject({ filesEnumerated: 2, filesAnalyzed: 1, filesSkipped: 0, filesUnsupported: 0 });
      expect(sameTotalIncomplete.result.status).toBe('degraded');
      expect(sameTotalIncomplete.result.coverage.limitations).toContain(
        'scanner coverage mismatch: report accounts for 1 of 2 input files',
      );
      expect(requiredResultSatisfies(sameTotalIncomplete.result, requiredPolicy('cisco-skill-scanner'))).toBe(false);

      const missingAnalyzed = await createCiscoAdapter().scan(
        request(inputDir, 'cisco-missing-analyzed'),
        reportExecutor({ findings: [], files_enumerated: 2 }),
      );
      expect(missingAnalyzed.result.coverage).toMatchObject({ filesEnumerated: 2, filesAnalyzed: 0 });
      expect(missingAnalyzed.result.status).toBe('degraded');
      expect(requiredResultSatisfies(missingAnalyzed.result, requiredPolicy('cisco-skill-scanner'))).toBe(false);
    });
  });

  it('surfaces a missing executable as an explicit engine error', async () => {
    await withInput(async (inputDir) => {
      const scan = await createCiscoAdapter({ command: 'private-skills-engine-does-not-exist' }).scan(
        { ...request(inputDir, 'missing'), timeoutMs: 1_000 },
        new TrustedLocalExecutor(),
      );
      expect(scan.result.status).toBe('error');
      expect(scan.result.error).toContain('engine not installed');
    });
  });
});
