// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => harness.navigate }))

import { CommandPalette, registryNavGroups, registrySections } from './CommandPalette'

const sections = [
  { id: 'overview', label: 'Discover', hint: 'Registry pulse', glyph: '⌂' },
  { id: 'catalog', label: 'Skills', hint: 'Browse releases', glyph: '⌕' },
] as const

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

describe('CommandPalette', () => {
  let root: Root | null = null
  let container: HTMLDivElement
  let originalShowModal: typeof HTMLDialogElement.prototype.showModal | undefined
  let originalClose: typeof HTMLDialogElement.prototype.close | undefined

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    harness.navigate.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)

    const dialogPrototype = window.HTMLDialogElement?.prototype
    originalShowModal = dialogPrototype?.showModal
    originalClose = dialogPrototype?.close
    if (dialogPrototype) {
      dialogPrototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', '') }
      dialogPrototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open') }
    }
  })

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount() })
    root = null
    document.body.replaceChildren()
    const dialogPrototype = window.HTMLDialogElement?.prototype
    if (dialogPrototype && originalShowModal) dialogPrototype.showModal = originalShowModal
    if (dialogPrototype && originalClose) dialogPrototype.close = originalClose
    vi.unstubAllGlobals()
  })

  it('keeps every registry route in the palette while grouping the shell navigation', () => {
    expect(registryNavGroups.map((group) => group.label)).toEqual([
      'Overview',
      'Skills',
      'Packs',
      'Discover',
      'Activity',
      'Company admin',
    ])
    expect(registryNavGroups.at(-1)?.admin).toBe(true)

    const groupedIds = registryNavGroups.flatMap((group) => group.sections.map((section) => section.id)).sort()
    const paletteIds = registrySections.map((section) => section.id).sort()
    expect(groupedIds).toEqual(paletteIds)
    expect(registrySections.find((section) => section.id === 'overview')?.label).toBe('Overview')
    expect(registryNavGroups.at(-1)?.sections.map((section) => section.id)).toContain('company-sso')
  })

  it('traps Tab within the modal and restores the element that opened it after Escape', async () => {
    const opener = document.createElement('textarea')
    document.body.appendChild(opener)
    opener.focus()
    root = createRoot(container)
    await act(async () => { root?.render(createElement(CommandPalette, { sections })) })
    await flushEffects()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    })
    await flushEffects()

    const dialog = container.querySelector('dialog')
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close command palette"]')
    expect(dialog?.hasAttribute('open')).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input).not.toBeNull()
    expect(close).not.toBeNull()

    await act(async () => {
      input?.focus()
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(close)

    await act(async () => {
      close?.focus()
      close?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    })
    expect(document.activeElement).toBe(input)

    await act(async () => {
      dialog?.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }))
    })
    await flushEffects()
    expect(dialog?.hasAttribute('open')).toBe(false)
    expect(document.activeElement).toBe(opener)
  })
})
