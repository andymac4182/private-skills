import type { DirectoryFeed } from '../lib/types'
import { resolveSelectedDirectoryFeed } from '../lib/directoryFeed'
import { Notice } from './Primitives'

export function DirectoryFeedSelector({ feeds, loading, error, selectedFeedName, onChange }: {
  feeds: DirectoryFeed[] | null
  loading: boolean
  error: string | null
  selectedFeedName: string
  onChange: (feedName: string) => void
}) {
  const selectedFeed = resolveSelectedDirectoryFeed(selectedFeedName, feeds)
  return <div className="directory-feed-control">
    <label className="directory-search-label" htmlFor="directory-feed">Source discovery feed</label>
    {loading ? <small>Loading discovery feed configuration…</small> : <>
      <select id="directory-feed" onChange={(event) => onChange(event.target.value)} value={selectedFeedName}>
        <option value="">Global/default directory</option>
        {selectedFeed === undefined && <option disabled hidden value={selectedFeedName}>{selectedFeedName} · unavailable</option>}
        {feeds?.map((feed) => <option disabled={!feed.enabled} key={feed.id} value={feed.name}>{feed.name}{feed.enabled ? '' : ' · disabled'}</option>)}
      </select>
      {error ? <Notice kind="warning">Feed configuration is unavailable. The global view is still available without a selected feed; selected feeds stay blocked until configuration responds.</Notice> : selectedFeed === undefined ? <Notice kind="warning">The selected feed is no longer available. Choose Global/default or a listed feed to continue.</Notice> : selectedFeed && !selectedFeed.enabled ? <small>This feed is disabled for source requests. Choose another feed or Global/default.</small> : selectedFeed ? <small>Browsing is scoped to <code>{selectedFeed.name}</code>. External metadata remains separate from private approval.</small> : <small>Global/default directory. No discovery feed is selected.</small>}
    </>}
  </div>
}
