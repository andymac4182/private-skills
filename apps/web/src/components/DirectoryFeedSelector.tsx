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
      {error ? <Notice kind="warning">Feed configuration is unavailable. The global view remains unscoped; selected feeds stay blocked until the registry responds.</Notice> : selectedFeed === undefined ? <Notice kind="warning">The selected feed is no longer available. Choose Global/default or a listed feed; no fallback was selected.</Notice> : selectedFeed && !selectedFeed.enabled ? <small>This feed is disabled. Its identity stays selected so the server state is visible, but source actions remain blocked.</small> : selectedFeed ? <small>Requests include the validated <code>{selectedFeed.name}</code> feed. External metadata remains separate from private approval.</small> : <small>Global/default directory. The client does not infer a configured feed.</small>}
    </>}
  </div>
}
