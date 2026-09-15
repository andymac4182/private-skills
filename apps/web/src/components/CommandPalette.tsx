import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'

export interface RegistrySection {
  id: string
  label: string
  hint: string
  glyph: string
}

export const registrySections = [
  { id: 'overview', label: 'Overview', hint: 'Registry pulse', glyph: '⌂' },
  { id: 'catalog', label: 'Skills', hint: 'Browse releases', glyph: '⌕' },
  { id: 'packs', label: 'Skill packs', hint: 'Curated installs', glyph: '▦' },
  { id: 'directory', label: 'Cloud directory', hint: 'All / trending / hot', glyph: '◌' },
  { id: 'source-discovery', label: 'Find skills', hint: 'Search configured sources', glyph: '⌕' },
  { id: 'official', label: 'Official makers', hint: 'Maker-curated', glyph: '✦' },
  { id: 'topics', label: 'Topics', hint: 'Source taxonomy', glyph: '⌘' },
  { id: 'cloud-audits', label: 'External audits', hint: 'Partner evidence', glyph: '◉' },
  { id: 'analytics', label: 'Analytics', hint: 'Confirmed installs', glyph: '▥' },
  { id: 'reviews', label: 'Eve reviews', hint: 'Daily suggestions', glyph: '✦' },
  { id: 'publish', label: 'Publish', hint: 'Add a skill', glyph: '+' },
  { id: 'operations', label: 'Activity', hint: 'Imports and reviews', glyph: '↗' },
  { id: 'policy', label: 'Settings', hint: 'Review rules', glyph: '⚙' },
  { id: 'upstreams', label: 'Sources', hint: 'Approved sources', glyph: '⌘' },
  { id: 'audit', label: 'Audit', hint: 'Change history', glyph: '◷' },
  { id: 'company', label: 'Company', hint: 'Team and access', glyph: '◍' },
  { id: 'company-sso', label: 'SSO settings', hint: 'Company sign-in', glyph: '⌁' },
  { id: 'company-tokens', label: 'CLI tokens', hint: 'Scoped access', glyph: '⌘' },
] as const satisfies readonly RegistrySection[]

export interface RegistryNavGroup {
  id: string
  label: string
  hint: string
  glyph: string
  defaultSectionId: string
  sections: readonly RegistrySection[]
  admin?: boolean
}

const registrySectionsById: Record<string, RegistrySection> = Object.fromEntries(
  registrySections.map((section) => [section.id, section]),
)

/**
 * The shell shows one contextual group at a time. The palette still receives
 * `registrySections` above so every route remains directly searchable.
 */
export const registryNavGroups = [
  {
    id: 'overview',
    label: 'Overview',
    hint: 'Registry pulse',
    glyph: '⌂',
    defaultSectionId: 'overview',
    admin: false,
    sections: [registrySectionsById.overview],
  },
  {
    id: 'skills',
    label: 'Skills',
    hint: 'Build and publish',
    glyph: '⌕',
    defaultSectionId: 'catalog',
    admin: false,
    sections: [registrySectionsById.catalog, registrySectionsById.publish],
  },
  {
    id: 'packs',
    label: 'Packs',
    hint: 'Curated installs',
    glyph: '▦',
    defaultSectionId: 'packs',
    admin: false,
    sections: [registrySectionsById.packs],
  },
  {
    id: 'discover',
    label: 'Discover',
    hint: 'External sources',
    glyph: '◌',
    defaultSectionId: 'directory',
    admin: false,
    sections: [
      registrySectionsById.directory,
      registrySectionsById['source-discovery'],
      registrySectionsById.official,
      registrySectionsById.topics,
      registrySectionsById['cloud-audits'],
    ],
  },
  {
    id: 'activity',
    label: 'Activity',
    hint: 'Reviews and installs',
    glyph: '↗',
    defaultSectionId: 'operations',
    admin: false,
    sections: [registrySectionsById.operations, registrySectionsById.analytics, registrySectionsById.reviews],
  },
  {
    id: 'company-admin',
    label: 'Company admin',
    hint: 'Team and controls',
    glyph: '◍',
    defaultSectionId: 'company',
    admin: true,
    sections: [
      registrySectionsById.company,
      registrySectionsById['company-sso'],
      registrySectionsById['company-tokens'],
      registrySectionsById.policy,
      registrySectionsById.upstreams,
      registrySectionsById.audit,
    ],
  },
] as const satisfies readonly RegistryNavGroup[]

interface CommandPaletteProps {
  sections: readonly RegistrySection[]
}

export function CommandPalette({ sections }: CommandPaletteProps) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const openerRef = useRef<HTMLElement | null>(null)
  const hasOpenedRef = useRef(false)
  const instanceId = useId().replace(/:/g, '')
  const listId = `command-palette-list-${instanceId}`

  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return sections
    return sections.filter((section) => `${section.label} ${section.hint} ${section.id}`.toLocaleLowerCase().includes(normalized))
  }, [query, sections])

  const openPalette = useCallback(() => {
    const focused = document.activeElement
    openerRef.current = focused instanceof HTMLElement && focused !== document.body ? focused : triggerRef.current
    setOpen(true)
  }, [])

  const closePalette = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open) {
      hasOpenedRef.current = true
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal()
        else dialog.setAttribute('open', '')
      }
      inputRef.current?.focus()
      return
    }

    if (dialog.open) dialog.close()
    if (!hasOpenedRef.current) return
    const opener = openerRef.current
    openerRef.current = null
    if (opener?.isConnected) opener.focus()
    else triggerRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
  }, [open])

  useEffect(() => {
    const onGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
      if (isShortcut) {
        event.preventDefault()
        if (open) closePalette()
        else openPalette()
        return
      }

      // Native dialog cancel handles Escape in supporting browsers; this
      // fallback keeps the same behavior for older dialog implementations.
      if (open && event.key === 'Escape') {
        event.preventDefault()
        closePalette()
      }
    }

    window.addEventListener('keydown', onGlobalKeyDown)
    return () => window.removeEventListener('keydown', onGlobalKeyDown)
  }, [closePalette, open, openPalette])

  const selectedIndex = matches.length ? Math.min(activeIndex, matches.length - 1) : 0

  useEffect(() => {
    const active = matches[selectedIndex]
    const node = active ? optionRefs.current[active.id] : null
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [matches, selectedIndex])

  const choose = (section: RegistrySection) => {
    closePalette()
    void navigate({ to: '/app/$section', params: { section: section.id } })
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => (matches.length ? (current + 1) % matches.length : 0))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => (matches.length ? (current - 1 + matches.length) % matches.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const section = matches[selectedIndex]
      if (section) choose(section)
    }
  }

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')).filter((element) => element.tabIndex >= 0)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="command-trigger"
        title="Jump to a registry section (Command or Control K)"
        type="button"
        onClick={openPalette}
      >
        <span aria-hidden="true" className="command-trigger-icon">⌕</span>
        <span className="command-trigger-label">Jump to…</span>
        <span aria-hidden="true" className="command-trigger-shortcut"><kbd>⌘</kbd><kbd>K</kbd></span>
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="command-palette-title"
        aria-modal="true"
        className="command-palette-dialog"
        onCancel={(event) => {
          event.preventDefault()
          closePalette()
        }}
        onClose={() => {
          // Keep React state in sync if the platform closes the dialog (for
          // example, through an implicit Escape cancel event).
          if (open) closePalette()
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closePalette()
        }}
        onKeyDown={onDialogKeyDown}
      >
        <section className="command-palette">
          <div className="command-palette-heading">
            <div>
              <span className="eyebrow">Quick switcher</span>
              <h2 id="command-palette-title">Go somewhere</h2>
            </div>
            <button aria-label="Close command palette" className="command-palette-close" type="button" onClick={closePalette}>
              <span aria-hidden="true">×</span>
            </button>
          </div>

          <div className="command-palette-input-wrap">
            <span aria-hidden="true" className="command-palette-input-icon">⌕</span>
            <input
              ref={inputRef}
              aria-activedescendant={matches[selectedIndex] ? `${listId}-option-${matches[selectedIndex].id}` : undefined}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded={open}
              aria-label="Filter registry sections"
              className="command-palette-input"
              placeholder="Filter sections…"
              role="combobox"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={onInputKeyDown}
            />
            <kbd className="command-palette-escape">esc</kbd>
          </div>

          <div aria-label="Registry section results" className="command-palette-results" id={listId} role="listbox">
            {matches.length > 0 ? matches.map((section, index) => (
              <button
                ref={(node) => { optionRefs.current[section.id] = node }}
                aria-selected={index === selectedIndex}
                className={`command-palette-option${index === selectedIndex ? ' command-palette-option-active' : ''}`}
                id={`${listId}-option-${section.id}`}
                key={section.id}
                role="option"
                tabIndex={-1}
                type="button"
                onClick={() => choose(section)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span aria-hidden="true" className="command-palette-option-glyph">{section.glyph}</span>
                <span className="command-palette-option-copy">
                  <strong>{section.label}</strong>
                  <small>{section.hint}</small>
                </span>
                {index === selectedIndex && <span aria-hidden="true" className="command-palette-option-enter">↵</span>}
              </button>
            )) : (
              <div className="command-palette-empty" role="status">
                <span aria-hidden="true">⌕</span>
                <strong>No sections found</strong>
                <small>Try a different name or hint.</small>
              </div>
            )}
          </div>

          <footer className="command-palette-footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
            <span><kbd>↵</kbd> to open</span>
            <span><kbd>esc</kbd> to close</span>
          </footer>
        </section>
      </dialog>
    </>
  )
}
