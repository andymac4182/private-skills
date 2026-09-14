import { formatDate } from './format'
import type { CatalogSkillVersion, CurrentSkillAdmission } from './types'

export function admissionBadgeValue(skill: CatalogSkillVersion): string {
  if (!skill.currentAdmission) return 'admission unknown'
  if (skill.currentAdmission.allowed) return skill.state
  return skill.currentAdmission.status === 'needs-rescan' ? 'needs rescan' : 'blocked'
}

export function admissionReasonText(admission: CurrentSkillAdmission | undefined): string {
  if (!admission) return 'Current admission status is unavailable. Refresh before opening files, drafting, or installing.'
  if (admission.allowed) return ''
  const scanner = admission.scannerId ? `Required ${admission.scannerId} evidence` : 'Required scanner evidence'
  switch (admission.reason) {
    case 'policy-changed': return 'Current review rules changed after this release was approved. Rescan before opening files, drafting, or installing.'
    case 'evidence-stale': return `${scanner} is stale${admission.expiresAt ? ` (expired ${formatDate(admission.expiresAt)})` : ''}. Rescan before opening files, drafting, or installing.`
    case 'evidence-missing': return `${scanner} is missing. Rescan before opening files, drafting, or installing.`
    case 'evidence-incomplete': return `${scanner} did not cover the complete artifact. Rescan before opening files, drafting, or installing.`
    case 'scan-failed': return `${scanner} did not complete successfully. Rescan before opening files, drafting, or installing.`
    case 'blocking-finding': return `${scanner} reported a blocking finding. Resolve the finding and rescan before opening files or installing.`
    case 'quarantined': return 'This release is quarantined by scanner policy. Files and installation remain unavailable.'
    case 'pending': return 'This release is still waiting for scanner admission. Files and installation remain unavailable.'
    case 'scan-error': return 'Scanner admission failed. Rescan before opening files or installing.'
    case 'revoked': return 'This release was revoked. Files and installation remain unavailable.'
    case 'current': return 'Current admission is unavailable.'
  }
}

export function admissionSummary(admission: CurrentSkillAdmission | undefined): string {
  if (!admission) return 'Unavailable'
  if (!admission.allowed) return admission.status === 'needs-rescan' ? 'Needs rescan' : 'Blocked'
  return admission.expiresAt ? `Current through ${formatDate(admission.expiresAt)}` : 'Current'
}

export function releaseActionsAllowed(skill: CatalogSkillVersion): boolean {
  return skill.currentAdmission?.allowed === true
}

/** Refresh just after the server's strict evidence-expiry boundary. */
export function admissionRefreshDelay(expiresAt: string, now = Date.now()): number | undefined {
  const expiry = Date.parse(expiresAt)
  if (!Number.isFinite(expiry)) return undefined
  return Math.min(2_147_483_647, Math.max(1, expiry - now + 1))
}

export function isDraftCallbackCurrent(
  currentSkillId: string | null,
  currentDraftId: string | undefined,
  originSkillId: string,
  originDraftId: string | undefined,
): boolean {
  return currentSkillId === originSkillId && currentDraftId === originDraftId
}
