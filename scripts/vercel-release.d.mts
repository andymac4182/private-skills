export class VercelReleaseGuardError extends Error {}

export interface VercelReleaseLinkOptions {
  root: string
  expectedProjectId: string
  expectedOrgId: string
}

export interface VercelReleaseOptions extends VercelReleaseLinkOptions {
  deployArgs: string[]
  environment?: Record<string, string | undefined>
  spawn?: (
    command: string,
    args: string[],
    options: {
      cwd: string
      env: Record<string, string | undefined>
      shell: false
      stdio: 'inherit'
    },
  ) => { status: number | null; error?: unknown }
}

export function verifyVercelReleaseLink(options: VercelReleaseLinkOptions): Readonly<{
  root: string
  projectId: string
  orgId: string
}>

export function validateVercelDeployArgs(args: string[]): string[]

export function runVercelRelease(options: VercelReleaseOptions): number

export function parseVercelReleaseArgs(argv: string[]): Readonly<{
  expectedProjectId: string
  expectedOrgId: string
  deployArgs: string[]
}>
