// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileTree as PierreFileTreeModel } from '@pierre/trees'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftSurfaceEntry } from './PierreDraftSurface'

interface FakeTreeOptions {
  paths: readonly string[]
  initialSelectedPaths?: readonly string[]
  search?: boolean
  onSelectionChange?: (selected: readonly string[]) => void
}

class FakeTreeModel {
  paths: string[]
  selected: string[]
  resets: string[][] = []
  private readonly onSelectionChange?: (selected: readonly string[]) => void
  private readonly listeners = new Set<() => void>()

  constructor(options: FakeTreeOptions) {
    this.paths = [...options.paths]
    this.selected = [...(options.initialSelectedPaths ?? [])].filter((path) => this.paths.includes(path))
    this.onSelectionChange = options.onSelectionChange
  }

  resetPaths(paths: readonly string[]): void {
    this.paths = [...paths]
    this.selected = this.selected.filter((path) => this.paths.includes(path))
    this.resets.push([...paths])
    this.notify()
  }

  getSelectedPaths(): readonly string[] {
    return this.selected
  }

  getItem(path: string): { select: () => void; deselect: () => void } | null {
    if (!this.paths.includes(path)) return null
    return { select: () => this.select(path), deselect: () => this.deselect(path) }
  }

  select(path: string): void {
    if (!this.paths.includes(path)) return
    if (this.selected.includes(path)) return
    this.selected = [...this.selected, path]
    this.onSelectionChange?.(this.selected)
    this.notify()
  }

  selectOnly(path: string): void {
    if (!this.paths.includes(path) || (this.selected.length === 1 && this.selected[0] === path)) return
    this.selected = [path]
    this.onSelectionChange?.(this.selected)
    this.notify()
  }

  deselect(path: string): void {
    if (!this.selected.includes(path)) return
    this.selected = this.selected.filter((selectedPath) => selectedPath !== path)
    this.onSelectionChange?.(this.selected)
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

const treeModels: FakeTreeModel[] = []
const treeOptions: FakeTreeOptions[] = []

vi.mock('@pierre/trees/react', async () => {
  const React = await import('react')
  function useFileTree(options: FakeTreeOptions): { model: FakeTreeModel } {
    const [model] = React.useState(() => {
      treeOptions.push(options)
      const next = new FakeTreeModel(options)
      treeModels.push(next)
      return next
    })
    return { model }
  }
  function FileTree({ model, 'aria-label': ariaLabel }: { model: FakeTreeModel; 'aria-label'?: string }): ReactNode {
    const [, rerender] = React.useState(0)
    React.useEffect(() => model.subscribe(() => rerender((value) => value + 1)), [model])
    return React.createElement('ul', { 'data-testid': 'tree', 'aria-label': ariaLabel }, model.paths.map((path) => React.createElement('li', { key: path }, React.createElement('button', { type: 'button', onClick: () => model.selectOnly(path) }, path))))
  }
  return { FileTree, useFileTree }
})

vi.mock('@pierre/diffs/react', () => ({
  EditProvider: ({ children }: { children: ReactNode }) => children,
  File: ({ file, editStateKey }: { file: { name: string; contents: string }; editStateKey?: string }) => createElement('output', { 'data-testid': 'file', 'data-file-name': file.name, 'data-file-contents': file.contents, 'data-edit-state-key': editStateKey }),
  FileDiff: ({ options }: { options?: { diffStyle?: string } }) => createElement('output', { 'data-testid': 'diff', 'data-diff-style': options?.diffStyle }),
}))
vi.mock('@pierre/diffs/edit', () => ({ Editor: class Editor {} }))
vi.mock('@pierre/diffs', () => ({ parseDiffFromFile: (base: unknown, current: unknown) => base || current ? { name: 'SKILL.md', type: 'change', cacheKey: 'diff' } : null }))
vi.mock('./Primitives', () => ({ Badge: () => null, LoadingState: ({ label }: { label: string }) => createElement('span', null, label) }))
vi.mock('./pierreAccessibility', () => ({ onPierrePostRender: vi.fn(), PIERRE_ACCESSIBLE_CSS: '' }))

const { PierreDraftSurface, pierreEditStateKey } = await import('./PierreDraftSurface')

const digest = `sha256:${'a'.repeat(64)}` as `sha256:${string}`

function entries(paths: readonly string[]): DraftSurfaceEntry[] {
  return paths.map((path) => ({ path, status: 'unchanged' }))
}

function surfaceProps(overrides: Partial<Parameters<typeof PierreDraftSurface>[0]> = {}): Parameters<typeof PierreDraftSurface>[0] {
  const paths = ['SKILL.md']
  return {
    draftId: 'draft-1',
    draftRevision: 1,
    draftDigest: digest,
    entries: entries(paths),
    selectedPath: paths[0]!,
    baseFile: null,
    currentFile: null,
    currentPreviewState: null,
    currentPreviewSize: null,
    basePreviewState: null,
    basePreviewSize: null,
    maxPreviewBytes: 256 * 1024,
    mode: 'diff',
    diffStyle: 'split',
    editable: false,
    busy: false,
    baseLoading: false,
    baseError: null,
    keyboardHelpId: 'draft-keyboard-help',
    onSelect: vi.fn(),
    onEditChange: vi.fn(),
    onContentChange: vi.fn(),
    ...overrides,
  }
}

function mountSurface(container: HTMLElement, props: Parameters<typeof PierreDraftSurface>[0]): Root {
  const root = createRoot(container)
  root.render(createElement(PierreDraftSurface, props))
  return root
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  treeModels.length = 0
  treeOptions.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('Pierre draft editor identity', () => {
  it('isolates edit state across drafts, revisions, and content digests', () => {
    const first = pierreEditStateKey('draft-1', 1, 'sha256:first', 'SKILL.md')
    expect(pierreEditStateKey('draft-2', 1, 'sha256:first', 'SKILL.md')).not.toBe(first)
    expect(pierreEditStateKey('draft-1', 2, 'sha256:first', 'SKILL.md')).not.toBe(first)
    expect(pierreEditStateKey('draft-1', 1, 'sha256:second', 'SKILL.md')).not.toBe(first)
    expect(pierreEditStateKey('draft-1', 1, 'sha256:first', 'README.md')).not.toBe(first)
  })

  it('enables the installed tree search UI and names the tree for assistive technology', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = mountSurface(container, surfaceProps())

    try {
      await act(async () => {})
      expect(treeOptions[0]?.search).toBe(true)
      expect(container.querySelector('[data-testid="tree"]')?.getAttribute('aria-label')).toBe('Draft files')
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})

describe('Pierre draft diff layout', () => {
  it('describes the Escape shortcut while the editable surface is mounted', async () => {
    const currentFile = { path: 'SKILL.md', size: 6, digest, content: btoa('draft\n'), previewState: 'text' as const }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = mountSurface(container, surfaceProps({ currentFile, currentPreviewState: 'text', mode: 'edit', editable: true }))

    try {
      await act(async () => {})
      const codeRegion = container.querySelector('.draft-surface-code')
      expect(codeRegion?.getAttribute('aria-describedby')).toBe('draft-keyboard-help')
      expect(container.querySelector('#draft-keyboard-help')?.textContent).toBe('Press Escape to leave the editor.')
    } finally {
      await act(async () => { root.unmount() })
    }
  })

  it('keeps the editor identity and unsaved contents when the layout preference changes', async () => {
    const currentFile = { path: 'SKILL.md', size: 6, digest, content: btoa('unsaved\n'), previewState: 'text' as const }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = mountSurface(container, surfaceProps({ currentFile, currentPreviewState: 'text', mode: 'edit', editable: true, diffStyle: 'split' }))

    try {
      await act(async () => {})
      const before = container.querySelector('[data-testid="file"]')
      expect(before?.getAttribute('data-file-contents')).toBe('unsaved\n')
      const editStateKey = before?.getAttribute('data-edit-state-key')

      await act(async () => {
        root.render(createElement(PierreDraftSurface, surfaceProps({ currentFile, currentPreviewState: 'text', mode: 'edit', editable: true, diffStyle: 'unified' })))
      })

      const after = container.querySelector('[data-testid="file"]')
      expect(after?.getAttribute('data-file-contents')).toBe('unsaved\n')
      expect(after?.getAttribute('data-edit-state-key')).toBe(editStateKey)
    } finally {
      await act(async () => { root.unmount() })
    }
  })

  it('updates the Diffs layout without changing the selected file payload', async () => {
    const baseFile = { path: 'SKILL.md', content: btoa('before\n') }
    const currentFile = { path: 'SKILL.md', size: 6, digest, content: btoa('after\n'), previewState: 'text' as const }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = mountSurface(container, surfaceProps({ baseFile, currentFile, currentPreviewState: 'text', basePreviewState: 'text', diffStyle: 'split' }))

    try {
      await act(async () => {})
      expect(container.querySelector('[data-testid="diff"]')?.getAttribute('data-diff-style')).toBe('split')

      await act(async () => {
        root.render(createElement(PierreDraftSurface, surfaceProps({ baseFile, currentFile, currentPreviewState: 'text', basePreviewState: 'text', diffStyle: 'unified' })))
      })

      expect(container.querySelector('[data-testid="diff"]')?.getAttribute('data-diff-style')).toBe('unified')
      expect(treeModels[0]?.resets).toEqual([])
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})

describe('Pierre draft file tree updates', () => {
  it('uses the installed tree search model to find nested paths without changing selection', () => {
    const selectedPath = 'packs/000/nested/skill/SKILL.md'
    const addedPath = 'packs/100/nested/skill/deeper/SKILL.md'
    const paths = [selectedPath, ...Array.from({ length: 99 }, (_, index) => `packs/${String(index + 1).padStart(3, '0')}/nested/skill/SKILL.md`), addedPath]
    const model = new PierreFileTreeModel({ paths, initialExpansion: 'open', initialSelectedPaths: [selectedPath], search: true })
    try {
      model.openSearch('deeper')
      expect(model.getSearchMatchingPaths()).toContain(addedPath)
      expect(model.getFocusedPath()).toBe(addedPath)
      expect(model.getSelectedPaths()).toEqual([selectedPath])

      model.setSearch('packs/100/nested/skill')
      expect(model.getSearchMatchingPaths()).toContain(addedPath)
      expect(model.getSelectedPaths()).toEqual([selectedPath])
    } finally {
      model.cleanUp()
    }
  })

  it('uses the tree model reset contract to retain selection while adding paths', () => {
    const model = new PierreFileTreeModel({ paths: ['packs/000/SKILL.md'], initialExpansion: 'open', initialSelectedPaths: ['packs/000/SKILL.md'] })
    try {
      expect(model.getItem('packs/100/nested/SKILL.md')).toBeNull()
      model.resetPaths(['packs/000/SKILL.md', 'packs/100/nested/SKILL.md'])
      expect(model.getItem('packs/100/nested/SKILL.md')).not.toBeNull()
      expect(model.getSelectedPaths()).toEqual(['packs/000/SKILL.md'])
    } finally {
      model.cleanUp()
    }
  })

  it('keeps a newly added deeply nested path selectable after the draft changes', async () => {
    const initialPaths = Array.from({ length: 100 }, (_, index) => `packs/${String(index).padStart(3, '0')}/nested/skill/SKILL.md`)
    const addedPath = 'packs/100/nested/skill/deeper/SKILL.md'
    const initialSelect = vi.fn()
    const resumedSelect = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = mountSurface(container, surfaceProps({ entries: entries(initialPaths), selectedPath: initialPaths[0], onSelect: initialSelect }))

    try {
      await act(async () => {})
      expect(container.querySelectorAll('[data-testid="tree"] li')).toHaveLength(100)

      await act(async () => {
        root.render(createElement(PierreDraftSurface, surfaceProps({ entries: entries([...initialPaths, addedPath]), selectedPath: initialPaths[0], onSelect: resumedSelect })))
      })

      expect(treeModels[0]?.resets).toEqual([[...initialPaths, addedPath]])
      expect(treeModels[0]?.selected).toEqual([initialPaths[0]])
      expect(container.querySelectorAll('[data-testid="tree"] li')).toHaveLength(101)
      const addedButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === addedPath)
      expect(addedButton).toBeDefined()
      await act(async () => { (addedButton as HTMLButtonElement).click() })
      expect(resumedSelect).toHaveBeenLastCalledWith(addedPath)
      expect(initialSelect).not.toHaveBeenCalledWith(addedPath)

      await act(async () => {
        root.render(createElement(PierreDraftSurface, surfaceProps({ entries: entries([...initialPaths, addedPath]), selectedPath: addedPath, onSelect: resumedSelect })))
      })
      await act(async () => {
        root.render(createElement(PierreDraftSurface, surfaceProps({ entries: entries([...initialPaths, addedPath]), selectedPath: initialPaths[0], onSelect: resumedSelect })))
      })
      expect(treeModels[0]?.selected).toEqual([initialPaths[0]])
    } finally {
      await act(async () => { root.unmount() })
    }
  })

  it('clears the tree selection when the parent has no selected path', async () => {
    const onSelect = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = mountSurface(container, surfaceProps({ entries: entries(['SKILL.md', 'README.md']), selectedPath: 'SKILL.md', onSelect }))

    try {
      await act(async () => {})
      expect(treeModels[0]?.selected).toEqual(['SKILL.md'])

      await act(async () => {
        root.render(createElement(PierreDraftSurface, surfaceProps({ entries: entries(['SKILL.md', 'README.md']), selectedPath: null, onSelect })))
      })

      expect(treeModels[0]?.selected).toEqual([])
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})
