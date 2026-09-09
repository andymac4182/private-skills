/**
 * Convert browser directory-selection paths into paths rooted at the skill
 * itself. Browsers commonly include the selected folder name in
 * `webkitRelativePath` (for example `hello/SKILL.md`); the registry expects
 * `SKILL.md` and keeps any deeper folders.
 */
export function normalizeSelectedPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) return []

  const normalized = paths.map((rawPath) => {
    const path = rawPath.replaceAll('\\', '/')
    const segments = path.split('/')
    if (
      path.length === 0 ||
      path.startsWith('/') ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw new UploadPathError('One of the selected file paths is not safe.')
    }
    return path
  })

  const hasFolderPaths = normalized.some((path) => path.includes('/'))
  if (!hasFolderPaths) return uniquePaths(normalized)

  const roots = new Set(normalized.map((path) => path.split('/')[0]))
  if (roots.size !== 1 || normalized.some((path) => !path.includes('/'))) {
    throw new UploadPathError('Choose one skill folder at a time. The selected files come from multiple folders.')
  }

  const root = normalized[0]!.split('/')[0]!
  return uniquePaths(normalized.map((path) => path.slice(root.length + 1)))
}

export class UploadPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadPathError'
  }
}

function uniquePaths(paths: string[]): string[] {
  if (new Set(paths).size !== paths.length) {
    throw new UploadPathError('The selected files contain duplicate paths. Choose the folder again.')
  }
  return paths
}
