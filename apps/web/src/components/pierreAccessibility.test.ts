import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onPierrePostRender, PIERRE_ACCESSIBLE_CSS } from './pierreAccessibility'

class FixtureElement {
  readonly attributes = new Map<string, string>()
  readonly clicks: string[] = []
  tabIndex = -1
  shadowRoot?: FixtureShadowRoot

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  matches(selector: string): boolean {
    return selector === '[data-expand-button]' || (selector === '[data-expand-button][role="button"]' && this.hasAttribute('data-expand-button') && this.getAttribute('role') === 'button')
  }

  click(): void {
    this.clicks.push('click')
  }
}

class FixtureShadowRoot {
  readonly listeners = new Map<string, EventListener[]>()

  constructor(readonly controls: FixtureElement[]) {}

  querySelectorAll<T extends FixtureElement>(selector: string): T[] {
    return selector === '[data-expand-button]' ? this.controls as T[] : []
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatch(type: string, event: FixtureKeyboardEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as unknown as Event)
  }
}

class FixtureKeyboardEvent {
  defaultPrevented = false
  propagationStopped = false

  constructor(readonly key: string, private readonly target: FixtureElement) {}

  composedPath(): FixtureElement[] {
    return [this.target]
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }
}

describe('Pierre accessibility bridge', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('decorates regenerated shadow-root controls and activates Enter and Space once', () => {
    vi.stubGlobal('HTMLElement', FixtureElement)
    vi.stubGlobal('KeyboardEvent', FixtureKeyboardEvent)

    const first = new FixtureElement()
    first.setAttribute('data-expand-button', '')
    first.setAttribute('data-expand-up', '')
    const second = new FixtureElement()
    second.setAttribute('data-expand-button', '')
    second.setAttribute('data-expand-all-button', '')
    const shadowRoot = new FixtureShadowRoot([first, second])
    const host = new FixtureElement()
    host.shadowRoot = shadowRoot

    onPierrePostRender(host as unknown as HTMLElement)
    onPierrePostRender(host as unknown as HTMLElement)

    expect(shadowRoot.listeners.get('keydown')).toHaveLength(1)
    expect(first.getAttribute('role')).toBe('button')
    expect(first.getAttribute('aria-label')).toBe('Expand previous unchanged lines')
    expect(first.tabIndex).toBe(0)
    expect(second.getAttribute('aria-label')).toBe('Expand all unchanged lines')

    const enter = new FixtureKeyboardEvent('Enter', first)
    shadowRoot.dispatch('keydown', enter)
    expect(first.clicks).toHaveLength(1)
    expect(enter.defaultPrevented).toBe(true)
    expect(enter.propagationStopped).toBe(true)

    const space = new FixtureKeyboardEvent(' ', first)
    shadowRoot.dispatch('keydown', space)
    expect(first.clicks).toHaveLength(2)
    expect(space.defaultPrevented).toBe(true)
  })

  it('leaves a host without an open shadow root untouched', () => {
    vi.stubGlobal('HTMLElement', FixtureElement)
    vi.stubGlobal('KeyboardEvent', FixtureKeyboardEvent)

    expect(() => onPierrePostRender(new FixtureElement() as unknown as HTMLElement)).not.toThrow()
  })

  it('keeps Pierre focus and addition overrides inside its unsafe stylesheet', () => {
    expect(PIERRE_ACCESSIBLE_CSS).toContain('--diffs-addition-color: #347457')
    expect(PIERRE_ACCESSIBLE_CSS).toContain('[data-expand-button][role="button"]:focus-visible')
  })

  it('keeps the reduced-motion rule enabled for every application shell', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toMatch(/animation-duration:\s*\.01ms\s*!important/)
    expect(css).toMatch(/transition-duration:\s*\.01ms\s*!important/)
    expect(css).toContain('.app-shell *, .public-shell *, .login-layout *')
  })
})
