import { useEffect } from 'react'
import { File } from '@pierre/diffs/react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { ReleaseFileView } from '../lib/types'
import { Badge, LoadingState } from './Primitives'
import { onPierrePostRender, PIERRE_ACCESSIBLE_CSS } from './pierreAccessibility'

export interface PierreReleaseRendererProps {
  files: ReleaseFileView[]
  selectedPath: string | null
  selectedFile: ReleaseFileView | null
  fileLoading: boolean
  onSelect: (path: string) => void
}

/**
 * The enhanced read-only surface is deliberately isolated in a lazy module.
 * It keeps the app's first render independent from Shiki workers and the
 * shadow-root file tree, while the parent owns all authorization and loading
 * state.
 */
export function PierreReleaseRenderer({ files, selectedPath, selectedFile, fileLoading, onSelect }: PierreReleaseRendererProps) {
  const paths = files.map((file) => file.path)
  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    onSelectionChange: (selected: readonly string[]) => {
      const candidate = selected[selected.length - 1]
      if (candidate && files.some((file) => file.path === candidate)) onSelect(candidate)
    },
  })

  useEffect(() => {
    if (!selectedPath) return
    model.getItem(selectedPath)?.select()
  }, [model, selectedPath])

  return <div className="release-viewer-enhanced">
    <div className="release-viewer-tree" aria-label="Release files">
      <FileTree header={<strong>Files</strong>} model={model} style={{ height: '100%', minHeight: 220 }} />
    </div>
    <div className="release-viewer-code">
      {fileLoading ? <LoadingState label="Loading file…" /> : selectedFile?.previewState === 'text' && typeof selectedFile.contents === 'string' ? <File
        className="release-pierre-file"
        file={{ name: selectedFile.path, contents: selectedFile.contents, cacheKey: selectedFile.contentDigest }}
        options={{ overflow: 'scroll', themeType: 'light', theme: 'github-light', stickyHeader: true, unsafeCSS: PIERRE_ACCESSIBLE_CSS, onPostRender: onPierrePostRender }}
        disableWorkerPool
      /> : selectedFile && selectedFile.previewState !== 'text' ? <div className="release-file-placeholder"><Badge tone="muted" value={previewLabel(selectedFile)} /><p>This file is available, but this preview type exposes metadata only.</p></div> : <div className="release-file-placeholder">Select a file to inspect its contents.</div>}
    </div>
  </div>
}

function previewLabel(file: ReleaseFileView): string {
  if (file.previewState === 'binary') return 'Binary file'
  if (file.previewState === 'oversize') return 'Too large to preview'
  if (file.previewState === 'unsupported') return 'Unsupported preview'
  return 'Text file'
}
