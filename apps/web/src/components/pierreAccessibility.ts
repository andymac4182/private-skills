const PIERRE_EXPAND_BUTTON_SELECTOR = '[data-expand-button]'
const PIERRE_KEYBOARD_BUTTON_SELECTOR = '[data-expand-button][role="button"]'

// Pierre renders its diff controls inside an open shadow root. Keep the
// interaction fix at that boundary so the app does not depend on internals of
// the outer custom element or on document-level event delegation.
const enhancedRoots = new WeakSet<ShadowRoot>()

function expandButtonLabel(button: HTMLElement): string {
  if (button.hasAttribute('data-expand-all-button')) return 'Expand all unchanged lines'
  if (button.hasAttribute('data-expand-up')) return 'Expand previous unchanged lines'
  if (button.hasAttribute('data-expand-down')) return 'Expand next unchanged lines'
  if (button.hasAttribute('data-expand-both')) return 'Expand unchanged lines above and below'
  return 'Expand unchanged lines above and below'
}

function onPierreKeyDown(event: Event): void {
  if (!(event instanceof KeyboardEvent)) return
  if (event.key !== 'Enter' && event.key !== ' ') return

  const button = event.composedPath().find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement && candidate.matches(PIERRE_KEYBOARD_BUTTON_SELECTOR))
  if (!button) return

  event.preventDefault()
  event.stopPropagation()
  button.click()
}

/**
 * Adds the missing keyboard semantics to Pierre's generated hunk controls.
 * `onPostRender` is called after each render, so attributes are reapplied to
 * newly-created controls while one delegated listener handles every update.
 */
export function onPierrePostRender(node: HTMLElement): void {
  const shadowRoot = node.shadowRoot
  if (!shadowRoot) return

  shadowRoot.querySelectorAll<HTMLElement>(PIERRE_EXPAND_BUTTON_SELECTOR).forEach((button) => {
    button.setAttribute('role', 'button')
    button.tabIndex = 0
    button.setAttribute('aria-label', expandButtonLabel(button))
  })

  if (enhancedRoots.has(shadowRoot)) return
  shadowRoot.addEventListener('keydown', onPierreKeyDown)
  enhancedRoots.add(shadowRoot)
}

/**
 * `github-light` supplies #28a745 for additions. That color is too light for
 * the added-line text and gutter numbers on a light background, so override
 * the theme variable through Pierre's supported unsafeCSS hook. The focus
 * rule is also inside the shadow root because app-level focus selectors cannot
 * reach generated controls.
 */
export const PIERRE_ACCESSIBLE_CSS = `
  :host {
    --diffs-addition-color: #347457;
  }

  [data-expand-button][role="button"]:focus-visible {
    outline: 3px solid #245c43;
    outline-offset: -3px;
  }
`
