import { createContext, useContext, useState, type PropsWithChildren } from 'react'
import type { DirectoryFeed } from './types'

interface DirectoryFeedSelectionValue {
  /** Empty string is the explicit global/default directory view. */
  selectedFeedName: string
  setSelectedFeedName: (feedName: string) => void
}

const DirectoryFeedSelectionContext = createContext<DirectoryFeedSelectionValue | null>(null)

export function DirectoryFeedProvider({ children }: PropsWithChildren) {
  const [selectedFeedName, setSelectedFeedName] = useState('')
  return <DirectoryFeedSelectionContext.Provider value={{ selectedFeedName, setSelectedFeedName }}>{children}</DirectoryFeedSelectionContext.Provider>
}

export function useDirectoryFeedSelection() {
  const value = useContext(DirectoryFeedSelectionContext)
  if (!value) throw new Error('useDirectoryFeedSelection must be used inside DirectoryFeedProvider')
  return value
}

/**
 * Resolve a UI selection against the server-provided feed list.  `null` is
 * the explicit global view, while `undefined` means the selected name is not
 * currently present in the server response and must not be sent to the API.
 */
export function resolveSelectedDirectoryFeed(selectedFeedName: string, feeds: DirectoryFeed[] | null): DirectoryFeed | null | undefined {
  if (!selectedFeedName) return null
  return feeds?.find((feed) => feed.name === selectedFeedName)
}

export function selectedDirectoryFeedQuery(selectedFeedName: string, feeds: DirectoryFeed[] | null): string | undefined {
  const feed = resolveSelectedDirectoryFeed(selectedFeedName, feeds)
  return feed ? feed.name : undefined
}
