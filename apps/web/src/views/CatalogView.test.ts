import { describe, expect, it } from 'vitest'
import { admissionBadgeValue, admissionReasonText, admissionRefreshDelay, admissionSummary, isDraftCallbackCurrent, releaseActionsAllowed } from '../lib/catalogAdmission'
import type { CatalogSkillVersion, CurrentSkillAdmission } from '../lib/types'

const skill = {
  id: 'skill-1',
  organizationId: 'org-test',
  name: '@team/demo',
  skillName: 'demo',
  version: '1.0.0',
  description: 'Demo',
  artifact: { key: 'blob-1', digest: `sha256:${'0'.repeat(64)}` as `sha256:${string}`, size: 1 },
  state: 'approved' as const,
  policyRevision: 'policy-1',
  createdAt: '2026-09-10T00:00:00.000Z',
  provenance: { kind: 'native' as const },
  fileCount: 1,
  scanIds: [],
} satisfies CatalogSkillVersion

describe('catalog current admission presentation', () => {
  it('fails closed when an older backend omits current admission metadata', () => {
    expect(releaseActionsAllowed(skill)).toBe(false)
    expect(admissionBadgeValue(skill)).toBe('admission unknown')
    expect(admissionReasonText(undefined)).toContain('status is unavailable')
    expect(admissionSummary(undefined)).toBe('Unavailable')
  })

  it('explains stale evidence and exposes the server-provided expiry', () => {
    const admission: CurrentSkillAdmission = {
      allowed: false,
      status: 'needs-rescan',
      reason: 'evidence-stale',
      policyRevision: 'policy-1',
      scannerId: 'skillsguard',
      expiresAt: '2026-09-10T01:00:00.000Z',
    }
    const staleSkill = { ...skill, currentAdmission: admission }
    expect(releaseActionsAllowed(staleSkill)).toBe(false)
    expect(admissionBadgeValue(staleSkill)).toBe('needs rescan')
    expect(admissionReasonText(admission)).toContain('Required skillsguard evidence is stale')
    expect(admissionReasonText(admission)).toContain('Rescan before opening files')
    expect(admissionSummary(admission)).toBe('Needs rescan')
  })

  it('allows release controls only for explicit current admission', () => {
    const admission: CurrentSkillAdmission = {
      allowed: true,
      status: 'current',
      reason: 'current',
      policyRevision: 'policy-1',
      expiresAt: '2026-09-10T01:00:00.000Z',
    }
    const currentSkill = { ...skill, currentAdmission: admission }
    expect(releaseActionsAllowed(currentSkill)).toBe(true)
    expect(admissionBadgeValue(currentSkill)).toBe('approved')
    expect(admissionSummary(admission)).toContain('Current through')
  })

  it('refreshes one millisecond after the strict expiry boundary', () => {
    const expiresAt = '2026-09-10T01:00:00.000Z'
    expect(admissionRefreshDelay(expiresAt, Date.parse(expiresAt))).toBe(1)
    expect(admissionRefreshDelay(expiresAt, Date.parse(expiresAt) - 1)).toBe(2)
  })

  it('rejects a late draft callback from a previous selection and draft', () => {
    expect(isDraftCallbackCurrent('skill-new', undefined, 'skill-old', 'draft-old')).toBe(false)
    expect(isDraftCallbackCurrent('skill-old', 'draft-old', 'skill-old', 'draft-old')).toBe(true)
  })
})
