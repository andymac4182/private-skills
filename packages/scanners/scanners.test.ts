import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCiscoAdapter,
  createNvidiaAdapter,
  createSkillsGuardAdapter,
  mapDockerScannerArgs,
  TrustedLocalExecutor,
  type CommandExecutor,
  type CommandRequest,
  type CommandResult,
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
