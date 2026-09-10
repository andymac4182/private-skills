import type { DirectoryFeed, Job, SkillVersion } from './types'

export interface ProxyOperationPin {
  rootOperationId: string
  activeOperationId: string
  resourceId: string | null
  externalId: string
  feedId: string
  feedName: string
  name: string
  version: string
  sourceReference: string | null
}

interface ProxyImportFields {
  externalId?: unknown
  feedId?: unknown
  feedName?: unknown
  name?: unknown
  version?: unknown
  sourceReference?: unknown
}

interface ProxyMemberProvenance {
  externalId?: unknown
  feedId?: unknown
  feedName?: unknown
  sourceReference?: unknown
}

export function verifiedSourceReference(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 4 || value.length > 2_048 || !value.startsWith('@') || /[\u0000-\u001f\u007f\\?#%\s]/u.test(value)) return null
  const parts = value.slice(1).split('/')
  if (parts.length < 2 || !['github', 'web', 'snapshot'].includes(parts[0] ?? '') || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._~-]+$/u.test(part))) return null
  return value
}

function matchesFeed(provenance: ProxyMemberProvenance, feed: DirectoryFeed): boolean {
  if (provenance.feedId === undefined && provenance.feedName === undefined) return false
  if (provenance.feedId !== undefined && provenance.feedId !== feed.id) return false
  if (provenance.feedName !== undefined && provenance.feedName !== feed.name) return false
  return true
}

function pinFromFields(job: Job, fields: ProxyImportFields, feed: DirectoryFeed, externalId: string, responseReference?: string): ProxyOperationPin | null {
  if (fields.externalId !== externalId || typeof fields.name !== 'string' || fields.name.length === 0 || typeof fields.version !== 'string' || fields.version.length === 0) return null
  if (fields.feedId === undefined && fields.feedName === undefined) return null
  if (fields.feedId !== undefined && fields.feedId !== feed.id) return null
  if (fields.feedName !== undefined && fields.feedName !== feed.name) return null
  return {
    rootOperationId: job.id,
    activeOperationId: job.id,
    resourceId: job.resourceId ?? null,
    externalId,
    feedId: feed.id,
    feedName: feed.name,
    name: fields.name,
    version: fields.version,
    sourceReference: verifiedSourceReference(responseReference) ?? verifiedSourceReference(fields.sourceReference),
  }
}

/** Pin either an import operation or a pending scan operation to one source. */
export function pinProxyOperation(job: Job, feed: DirectoryFeed, externalId: string, responseReference?: string, resolvedSkill?: SkillVersion): ProxyOperationPin | null {
  if (job.kind === 'import') return pinFromFields(job, (job.import ?? {}) as ProxyImportFields, feed, externalId, responseReference)
  if (job.kind !== 'scan' || !job.resourceId || !resolvedSkill || resolvedSkill.id !== job.resourceId) return null
  const provenance = resolvedSkill.provenance as ProxyMemberProvenance
  if (provenance.externalId !== externalId || !matchesFeed(provenance, feed)) return null
  return {
    rootOperationId: job.id,
    activeOperationId: job.id,
    resourceId: job.resourceId,
    externalId,
    feedId: feed.id,
    feedName: feed.name,
    name: resolvedSkill.name,
    version: resolvedSkill.version,
    sourceReference: verifiedSourceReference(responseReference) ?? verifiedSourceReference(provenance.sourceReference),
  }
}
