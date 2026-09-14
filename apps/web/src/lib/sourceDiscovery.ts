import type { SourceDescriptor, SourceSearchResult, SourceSearchStatus, SourceStatus } from './types'

/**
 * Display metadata for the providers the registry can expose.  This map is
 * deliberately descriptive only: availability and capabilities always come
 * from the server's source descriptors.
 */
export const SOURCE_PROVIDER_META: Record<string, { label: string; description: string }> = {
  skillsmp: { label: 'SkillsMP', description: 'Community skill marketplace search.' },
  clawhub: { label: 'ClawHub', description: 'ClawHub skill listings and source revisions.' },
  tessl: { label: 'Tessl', description: 'Tessl public skill catalog.' },
  'skillhub-public': { label: 'SkillHub Public', description: 'SkillHub public catalog.' },
  'skillhub-pro': { label: 'SkillHub Pro', description: 'SkillHub Pro catalog for configured organizations.' },
  polyskill: { label: 'Polyskill', description: 'Polyskill provider search.' },
  'skills-directory': { label: 'Skills Directory', description: 'Community-maintained skills directory.' },
  'github-code-search': { label: 'GitHub code search', description: 'Search public repositories for SKILL.md sources.' },
  'github-openai-skills': { label: 'GitHub · OpenAI skills', description: 'OpenAI skill repositories on GitHub.' },
  'github-anthropics-skills': { label: 'GitHub · Anthropic skills', description: 'Anthropic skill repositories on GitHub.' },
  'github-google-skills': { label: 'GitHub · Google skills', description: 'Google skill repositories on GitHub.' },
  'github-vercel-agent-skills': { label: 'GitHub · Vercel agent skills', description: 'Vercel agent skill repositories on GitHub.' },
  'github-custom': { label: 'GitHub · configured repos', description: 'Organization-configured GitHub skill repositories.' },
}

export const SOURCE_PROVIDER_ORDER = [
  'skills-sh',
  'skillsmp',
  'clawhub',
  'tessl',
  'skillhub-public',
  'skillhub-pro',
  'polyskill',
  'skills-directory',
  'github-code-search',
  'github-openai-skills',
  'github-anthropics-skills',
  'github-google-skills',
  'github-vercel-agent-skills',
  'github-custom',
] as const

export function sourceLabel(source: Pick<SourceDescriptor, 'id' | 'label'> | Pick<SourceSearchStatus, 'id' | 'label'> | string): string {
  if (typeof source === 'string') return SOURCE_PROVIDER_META[source]?.label ?? source
  const id = source.id
  return SOURCE_PROVIDER_META[id]?.label ?? ('label' in source && source.label ? source.label : id)
}

export function sourceDescription(source: Pick<SourceDescriptor, 'id' | 'label'>): string {
  return SOURCE_PROVIDER_META[source.id]?.description || `${source.label} provider-backed skill discovery.`
}

export function normalizeSourceStatus(value: unknown): SourceStatus {
  if (value && typeof value === 'object' && 'state' in value) {
    const state = (value as { state?: unknown }).state
    if (state === 'available' || state === 'disabled' || state === 'unavailable') return state
  }
  if (typeof value !== 'string') return 'unavailable'
  switch (value.trim().toLowerCase()) {
    case 'available':
    case 'ready':
    case 'ok':
    case 'configured':
      return 'available'
    case 'disabled':
    case 'off':
      return 'disabled'
    case 'checking':
    case 'pending':
      return 'unavailable'
    case 'unavailable':
    case 'offline':
    default:
      return 'unavailable'
  }
}

export function sourceStatusLabel(value: unknown): string {
  if (value && typeof value === 'object' && 'state' in value) {
    const availability = value as { state?: unknown; code?: unknown; reason?: unknown }
    if (availability.state === 'unavailable' && typeof availability.code === 'string' && /credential|auth|token|secret/iu.test(availability.code)) return 'Credentials required'
    if (availability.state === 'unavailable' && typeof availability.reason === 'string' && /credential|auth|token|secret/iu.test(availability.reason)) return 'Credentials required'
  }
  switch (normalizeSourceStatus(value)) {
    case 'available': return 'Available'
    case 'disabled': return 'Disabled'
    case 'unavailable': return 'Unavailable'
  }
}

export function sourceStatusTone(value: unknown): 'good' | 'warn' | 'bad' | 'muted' {
  switch (normalizeSourceStatus(value)) {
    case 'available': return 'good'
    case 'disabled': return 'muted'
    case 'unavailable': return 'warn'
  }
}

export function sourceStatusReason(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { reason?: unknown; error?: { message?: unknown } }
  if (record.error && typeof record.error.message === 'string') return record.error.message
  return typeof record.reason === 'string' ? record.reason : undefined
}

export function sourceCanSearch(source: Pick<SourceDescriptor, 'availability' | 'capabilities'> | undefined): boolean {
  return source?.availability.state === 'available' && source.capabilities.includes('search')
}

export function sourceCanResolve(source: Pick<SourceDescriptor, 'availability' | 'capabilities'> | undefined): boolean {
  return source?.availability.state === 'available' && source.capabilities.includes('resolve')
}

export function normalizeSourceQuery(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

export function sourceResultLabel(result: Pick<SourceSearchResult, 'title' | 'externalId'>): string {
  return result.title.trim() || result.externalId
}

/**
 * `reference` is a registry locator returned after source resolution.  The
 * browser may display it and pass it to a client command, but it must never
 * accept a direct upstream URL as a download link.
 */
export function verifiedSourceLocator(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > 2_048) return null
  if (/[\u0000-\u001f\u007f]/u.test(value) || /^(?:https?|ftp):\/\//iu.test(value)) return null
  if (!value.startsWith('@')) return null
  const parts = value.slice(1).split('/')
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')) return null
  return value
}

export function matchesSourceIdentity(value: { sourceId?: unknown; externalId?: unknown }, sourceId: string, externalId: string): boolean {
  return value.sourceId === sourceId && value.externalId === externalId
}
