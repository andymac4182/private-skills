// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./DraftEditor', () => ({
  DraftEditor: ({ onClose }: { onClose?: () => void }) => createElement('div', { 'data-testid': 'draft-editor' },
    createElement('button', { type: 'button', onClick: onClose }, 'Close editor')),
}))

import { ReleaseViewer } from './ReleaseViewer'

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

describe('ReleaseViewer draft deep links', () => {
  let root: Root | null = null
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('keeps a valid draft deep link open after the resource reset and does not reopen after close', async () => {
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(ReleaseViewer, {
        resourceId: 'skill-1',
        baseDigest: `sha256:${'0'.repeat(64)}`,
        baseVersion: '1.0.0',
        canEdit: true,
        resumeDraftId: 'draft-1',
      }))
    })
    await flushEffects()
    expect(container.querySelector('[data-testid="draft-editor"]')).not.toBeNull()

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Close editor')?.click()
    })
    expect(container.querySelector('[data-testid="draft-editor"]')).toBeNull()

    await act(async () => {
      root?.render(createElement(ReleaseViewer, {
        resourceId: 'skill-1',
        baseDigest: `sha256:${'0'.repeat(64)}`,
        baseVersion: '1.0.0',
        canEdit: true,
        resumeDraftId: 'draft-1',
      }))
    })
    await flushEffects()
    expect(container.querySelector('[data-testid="draft-editor"]')).toBeNull()

    await act(async () => {
      root?.render(createElement(ReleaseViewer, {
        resourceId: 'skill-2',
        baseDigest: `sha256:${'1'.repeat(64)}`,
        baseVersion: '2.0.0',
        canEdit: true,
        resumeDraftId: 'draft-1',
      }))
    })
    await flushEffects()
    expect(container.querySelector('[data-testid="draft-editor"]')).not.toBeNull()
  })
})
