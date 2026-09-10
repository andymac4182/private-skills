import { useEffect } from 'react'
// These are optional client-only surfaces. The registry keeps a native
// renderer fallback so a deployment can still inspect files while the Pierre
// packages are loading or unavailable.
// @ts-ignore Optional M6 dependency installed by the application build.
import { File } from '@pierre/diffs/react'
// @ts-ignore Optional M6 dependency installed by the application build.
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { ReleaseFileView } from '../lib/types'

export interface PierreReleaseRendererProps {
  files: ReleaseFileView[]
  selectedPath: string | null
  selectedFile: ReleaseFileView | null
  onSelect: (path: string) => void
}

/**
 * The enhanced read-only surface is deliberately isolated in a lazy module.
 * It keeps the app's first render independent from Shiki workers and the
 * shadow-root file tree, while the parent owns all authorization and loading
 * state.
 */
export function PierreReleaseRenderer({ files, selectedPath, selectedFile, onSelect }: PierreReleaseRendererProps) {
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
      {selectedFile?.previewState === 'text' && typeof selectedFile.contents === 'string' ? <File
        className="release-pierre-file"
        file={{ name: selectedFile.path, contents: selectedFile.contents, cacheKey: selectedFile.contentDigest }}
        options={{ overflow: 'scroll', themeType: 'light', theme: 'github-light', stickyHeader: true }}
        disableWorkerPool
      /> : <div className="release-file-placeholder">Select a text file to inspect its content.</div>}
    </div>
  </div>
}
