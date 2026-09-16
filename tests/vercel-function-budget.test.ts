import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyVercelFunctionBudget,
  resolveVercelFunctionBudget,
  verifyVercelFunctionBudget,
} from '../scripts/vercel-function-budget.mjs';
import { assertVercelRuntimeDuration } from '../apps/web/server/vercel-function-budget';

describe('Vercel function duration budget', () => {
  it('accounts for both dispatcher defaults and emits bounded headroom', () => {
    expect(resolveVercelFunctionBudget({})).toMatchObject({
      workerDurationMs: 240_000,
      reviewerDurationMs: 600_000,
      runtimeDurationMs: 600_000,
      runtimeDurationSeconds: 600,
      headroomSeconds: 15,
      planMaxDurationSeconds: 800,
      maxDurationSeconds: 615,
    });
  });

  it('honors explicit lower budgets so a Hobby plan can fit with headroom', () => {
    const budget = resolveVercelFunctionBudget({
      PSKILLS_HOSTED_WORKER_DISPATCH_MAX_DURATION_MS: '240000',
      PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS: '240000',
      PSKILLS_VERCEL_PLAN_MAX_DURATION_SECONDS: '300',
    });
    expect(budget).toMatchObject({
      runtimeDurationMs: 240_000,
      runtimeDurationSeconds: 240,
      planMaxDurationSeconds: 300,
      maxDurationSeconds: 255,
    });
  });

  it('accepts a larger declared platform limit and rejects the stable limit when needed', () => {
    expect(() => resolveVercelFunctionBudget({
      PSKILLS_HOSTED_WORKER_DISPATCH_MAX_DURATION_MS: '900000',
      PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS: '840000',
    })).toThrow(/declared plan limit 800s/u);

    expect(resolveVercelFunctionBudget({
      PSKILLS_HOSTED_WORKER_DISPATCH_MAX_DURATION_MS: '900000',
      PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS: '840000',
      PSKILLS_VERCEL_PLAN_MAX_DURATION_SECONDS: '1800',
    })).toMatchObject({ runtimeDurationSeconds: 900, maxDurationSeconds: 915 });
  });

  it('rejects a platform cap that cannot accommodate the reviewer default', () => {
    expect(() => resolveVercelFunctionBudget({
      PSKILLS_VERCEL_PLAN_MAX_DURATION_SECONDS: '300',
    })).toThrow(/duration 615s exceeds the declared plan limit 300s/u);
    expect(() => resolveVercelFunctionBudget({
      PSKILLS_VERCEL_FUNCTION_HEADROOM_SECONDS: '4',
    })).toThrow(/PSKILLS_VERCEL_FUNCTION_HEADROOM_SECONDS/u);
  });

  it('updates and verifies the generated Build Output API function config', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'private-skills-vercel-budget-'));
    try {
      const functionDirectory = join(outputDirectory, 'functions', '__server.func');
      mkdirSync(functionDirectory, { recursive: true });
      writeFileSync(join(functionDirectory, '.vc-config.json'), JSON.stringify({
        handler: 'index.mjs',
        runtime: 'nodejs24.x',
      }));

      const budget = resolveVercelFunctionBudget({});
      expect(applyVercelFunctionBudget(outputDirectory, budget)).toHaveLength(1);
      verifyVercelFunctionBudget(outputDirectory, budget);
      expect(JSON.parse(readFileSync(join(functionDirectory, '.vc-config.json'), 'utf8'))).toMatchObject({
        runtime: 'nodejs24.x',
        maxDuration: 615,
      });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});

describe('Vercel runtime duration guard', () => {
  it('rejects runtime values that exceed the generated duration after headroom', () => {
    expect(assertVercelRuntimeDuration(undefined, 600_000, 'reviewer', 615, 15)).toBeUndefined();
    expect(assertVercelRuntimeDuration(600_000, 600_000, 'reviewer', 615, 15)).toBe(600_000);
    expect(() => assertVercelRuntimeDuration(600_001, 600_000, 'reviewer', 615, 15)).toThrow(/after headroom/u);
    expect(assertVercelRuntimeDuration(240_000, 600_000, 'reviewer', 255, 15)).toBe(240_000);
    expect(() => assertVercelRuntimeDuration(undefined, 600_000, 'reviewer', 255, 15)).toThrow(/after headroom/u);
    expect(assertVercelRuntimeDuration(900_000, 240_000, 'worker', undefined, undefined)).toBe(900_000);
  });
});
