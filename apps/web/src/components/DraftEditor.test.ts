import { describe, expect, it } from 'vitest'
import { canonicalDraftFiles, draftPayloadFingerprint, operationKey } from './DraftEditor'
import type { DraftView } from '../lib/types'

const draft: DraftView = {
  id: 'draft-1',
  origin: 'release',
  name: 'demo-skill',
  skillName: 'demo-skill',
  baseResourceId: 'resource-1',
  baseDigest: 'sha256:release',
  revision: 3,
  digest: 'sha256:draft',
  size: 4,
  files: [{ path: 'SKILL.md', content: 'I2F2ZQ==' }],
  status: 'open',
  actor: 'owner',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const firstFiles = [
  { path: 'z.txt', content: 'eg==' },
  { path: 'a.txt', content: 'YQ==' },
]

describe('draft editor persistence identities', () => {
  it('canonicalizes the same file payload independent of file order', () => {
    expect(canonicalDraftFiles(firstFiles)).toBe(canonicalDraftFiles([...firstFiles].reverse()))
  })

  it('keeps exact save retries idempotent while changing the key for changed bytes', async () => {
    const ref = { current: null } as Parameters<typeof operationKey>[0]
    const firstFingerprint = await draftPayloadFingerprint(firstFiles)
    const sameFingerprint = await draftPayloadFingerprint([...firstFiles].reverse())
    const changedFingerprint = await draftPayloadFingerprint([{ ...firstFiles[0], content: 'Yg==' }, firstFiles[1]])
    const firstKey = operationKey(ref, 'draft-save', draft, firstFingerprint)
    expect(operationKey(ref, 'draft-save', draft, sameFingerprint)).toBe(firstKey)
    expect(operationKey(ref, 'draft-save', draft, changedFingerprint)).not.toBe(firstKey)
  })
})
