import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseVercelReleaseArgs,
  runVercelRelease,
  VercelReleaseGuardError,
} from '../scripts/vercel-release.mjs'

const EXPECTED_PROJECT_ID = 'prj_expected'
const EXPECTED_ORG_ID = 'team_expected'
const DEPLOY_ARGS = ['--prebuilt', '--prod', '--yes']

const roots: string[] = []

function linkedRoot(link: { projectId: string; orgId: string } | null = { projectId: EXPECTED_PROJECT_ID, orgId: EXPECTED_ORG_ID }): string {
  const root = mkdtempSync(join(tmpdir(), 'private-skills-vercel-release-'))
  roots.push(root)
  mkdirSync(join(root, '.vercel'))
  if (link !== null) writeFileSync(join(root, '.vercel', 'project.json'), JSON.stringify(link))
  return root
}

function fakeChild() {
  return vi.fn((_command: string, _args: string[], _options: unknown) => ({ status: 0, signal: null }))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Vercel release preflight', () => {
  it('requires an existing regular project link and never starts the child when absent', () => {
    const spawn = fakeChild()
    expect(() => runVercelRelease({
      root: linkedRoot(null),
      expectedProjectId: EXPECTED_PROJECT_ID,
      expectedOrgId: EXPECTED_ORG_ID,
      deployArgs: DEPLOY_ARGS,
      spawn,
    })).toThrow(VercelReleaseGuardError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON and mismatched project or organization links before invocation', () => {
    const invalidRoot = linkedRoot()
    writeFileSync(join(invalidRoot, '.vercel', 'project.json'), '{not-json')
    const invalidSpawn = fakeChild()
    expect(() => runVercelRelease({
      root: invalidRoot,
      expectedProjectId: EXPECTED_PROJECT_ID,
      expectedOrgId: EXPECTED_ORG_ID,
      deployArgs: DEPLOY_ARGS,
      spawn: invalidSpawn,
    })).toThrow('not valid JSON')
    expect(invalidSpawn).not.toHaveBeenCalled()

    const mismatchSpawn = fakeChild()
    expect(() => runVercelRelease({
      root: linkedRoot({ projectId: 'prj_other', orgId: EXPECTED_ORG_ID }),
      expectedProjectId: EXPECTED_PROJECT_ID,
      expectedOrgId: EXPECTED_ORG_ID,
      deployArgs: DEPLOY_ARGS,
      spawn: mismatchSpawn,
    })).toThrow('does not match')
    expect(mismatchSpawn).not.toHaveBeenCalled()

    const orgMismatchSpawn = fakeChild()
    expect(() => runVercelRelease({
      root: linkedRoot({ projectId: EXPECTED_PROJECT_ID, orgId: 'team_other' }),
      expectedProjectId: EXPECTED_PROJECT_ID,
      expectedOrgId: EXPECTED_ORG_ID,
      deployArgs: DEPLOY_ARGS,
      spawn: orgMismatchSpawn,
    })).toThrow('does not match')
    expect(orgMismatchSpawn).not.toHaveBeenCalled()
  })

  it('binds the verified root and explicit IDs while preserving only sanitized release metadata', () => {
    const spawn = fakeChild()
    const root = linkedRoot()
    const status = runVercelRelease({
      root,
      expectedProjectId: EXPECTED_PROJECT_ID,
      expectedOrgId: EXPECTED_ORG_ID,
      deployArgs: ['--prebuilt', '--prod', '--yes', '--meta', 'gitCommit=abc123', '--meta', 'gitBranch=main/verified'],
      environment: {
        PATH: '/usr/bin',
        VERCEL_PROJECT_ID: 'ambient_project',
        VERCEL_ORG_ID: 'ambient_org',
        VERCEL_TEAM_ID: 'ambient_team',
      },
      spawn,
    })

    expect(status).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawn.mock.calls[0]! as [
      string,
      string[],
      { cwd: string; shell: boolean; stdio: string; env: Record<string, string | undefined> },
    ]
    expect(command).toBe('vercel')
    expect(args).toEqual(['deploy', '--prebuilt', '--prod', '--yes', '--meta', 'gitCommit=abc123', '--meta', 'gitBranch=main/verified'])
    expect(options.cwd).toBe(root)
    expect(options.shell).toBe(false)
    expect(options.stdio).toBe('inherit')
    expect(options.env.VERCEL_PROJECT_ID).toBe(EXPECTED_PROJECT_ID)
    expect(options.env.VERCEL_ORG_ID).toBe(EXPECTED_ORG_ID)
    expect(options.env.VERCEL_TEAM_ID).toBeUndefined()
  })

  it.each([
    ['--cwd', '/tmp/other-checkout'],
    ['--scope', 'other-team'],
    ['--team', 'other-team'],
    ['--project', 'other-project'],
    ['--name', 'other-project'],
    ['--local-config', '/tmp/other-project.json'],
    ['--token', 'credential-value'],
    ['--debug'],
    ['/tmp/other-checkout'],
  ])('rejects deploy option attempts to override release context: %s', (...override) => {
    const spawn = fakeChild()
    expect(() => runVercelRelease({
      root: linkedRoot(),
      expectedProjectId: EXPECTED_PROJECT_ID,
      expectedOrgId: EXPECTED_ORG_ID,
      deployArgs: [...DEPLOY_ARGS, ...override],
      spawn,
    })).toThrow(VercelReleaseGuardError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('requires explicit IDs and a deploy separator in the package command', () => {
    expect(parseVercelReleaseArgs([
      '--project-id', EXPECTED_PROJECT_ID,
      '--org-id', EXPECTED_ORG_ID,
      '--', ...DEPLOY_ARGS,
    ])).toEqual({
      expectedProjectId: EXPECTED_PROJECT_ID,
      expectedOrgId: EXPECTED_ORG_ID,
      deployArgs: DEPLOY_ARGS,
    })
    expect(() => parseVercelReleaseArgs(['--org-id', EXPECTED_ORG_ID, '--', ...DEPLOY_ARGS])).toThrow('expected project ID')
    expect(() => parseVercelReleaseArgs([
      '--project-id', EXPECTED_PROJECT_ID,
      '--org-id', EXPECTED_ORG_ID,
      '--', '--prebuilt', '--prod', '--yes', '--scope', 'other-team',
    ])).toThrow('not permitted')
  })
})
