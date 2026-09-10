import { describe, expect, it } from 'vitest'
import type { DirectoryFeed, Job, SkillVersion } from './types'
import { pinProxyOperation } from './proxy'

const feed: DirectoryFeed = {
  id: 'feed-community',
  name: 'community',
  kind: 'skills-sh',
  enabled: true,
  configRevision: 'config-1',
  baseUrl: 'https://skills.sh',
}

function job(partial: Partial<Job>): Job {
  return { id: 'job-1', organizationId: 'org-1', kind: 'scan', state: 'running', policyRevision: 'policy-1', policy: {} as Job['policy'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', attempts: 1, ...partial }
}

function skill(partial: Partial<SkillVersion> = {}): SkillVersion {
  return { id: 'skill-1', organizationId: 'org-1', name: '@community/source-1', skillName: '@community/source-1', version: '0.0.0+skills-sh.1', description: '', artifact: { key: 'blob-1', digest: 'sha256:artifact', size: 1 }, state: 'pending', policyRevision: 'policy-1', createdAt: '2026-01-01T00:00:00.000Z', provenance: { kind: 'skills-sh', externalId: 'owner/repo/skill', feedId: feed.id, feedName: feed.name } as SkillVersion['provenance'], fileCount: 1, scanIds: [], ...partial }
}

describe('pinProxyOperation', () => {
  it('pins a pending scan job by its authenticated skill provenance', () => {
    const pinned = pinProxyOperation(job({ resourceId: 'skill-1' }), feed, 'owner/repo/skill', '@github/owner/repo/skill', skill())
    expect(pinned).toMatchObject({ resourceId: 'skill-1', name: '@community/source-1', version: '0.0.0+skills-sh.1', externalId: 'owner/repo/skill', feedName: 'community', sourceReference: '@github/owner/repo/skill' })
  })

  it('rejects a scan job when source or feed provenance does not match', () => {
    expect(pinProxyOperation(job({ resourceId: 'skill-1' }), feed, 'other/repo/skill', undefined, skill())).toBeNull()
    expect(pinProxyOperation(job({ resourceId: 'skill-1' }), feed, 'owner/repo/skill', undefined, skill({ provenance: { kind: 'skills-sh', externalId: 'owner/repo/skill', feedId: 'feed-other', feedName: feed.name } as SkillVersion['provenance'] }))).toBeNull()
  })
})
