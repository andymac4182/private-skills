import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { api, ApiError, isApiErrorCode } from '../lib/api'
import { formatDate } from '../lib/format'
import type { CuratedSkillsResponse, CuratedOwner, V1Skill } from '../lib/types'
import { Badge, DisconnectedState, EmptyState, ErrorState, LoadingState, Panel } from '../components/Primitives'

export function OfficialView() {
  const [curated, setCurated] = useState<CuratedSkillsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const loadGeneration = useRef(0)

  async function load() {
    const generation = ++loadGeneration.current
    setError(null)
    setDisconnected(false)
    setCurated(null)
    try {
      const response = await api.directoryOfficial()
      if (generation !== loadGeneration.current) return
      setCurated(response)
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      if (isApiErrorCode(cause, 'DIRECTORY_NOT_CONFIGURED')) {
        setDisconnected(true)
        setError(null)
      } else {
        setDisconnected(false)
        setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load maker-curated skills.')
      }
    }
  }

  useEffect(() => { void load() }, [])

  return <div className="view-heading official-view"><div className="page-intro"><div><span className="eyebrow eyebrow-cloud">Cloud directory</span><h1>Official makers</h1><p className="muted">Maker-curated groups from skills.sh. Official describes the upstream curation; it does not mean privately approved or safe to install.</p></div><Link className="button button-primary" params={{ section: 'directory' }} to="/app/$section">Browse all skills</Link></div>{disconnected ? <DisconnectedState title="Official makers are disconnected" message="The public skills.sh connection is not configured for this registry. Private releases and review settings remain available." action={<a className="button button-secondary" href="https://skills.sh" rel="noreferrer" target="_blank">Open skills.sh ↗</a>} /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : curated === null ? <Panel><LoadingState label="Loading official groups…" /></Panel> : <><div className="directory-summary"><span><strong>{formatNumber(curated.totalOwners)}</strong> makers</span><span><strong>{formatNumber(curated.totalSkills)}</strong> listed skills</span><span>Updated {formatDate(curated.generatedAt)}</span></div>{curated.data.length === 0 ? <Panel><EmptyState title="No official groups available" description="skills.sh did not return a maker-curated group for this request." /></Panel> : <div className="official-grid">{curated.data.map((owner) => <OfficialOwnerCard key={owner.owner} owner={owner} />)}</div>}</>}</div>
}

function OfficialOwnerCard({ owner }: { owner: CuratedOwner }) {
  return <Panel className="official-owner"><div className="official-owner-heading"><div><span className="eyebrow eyebrow-cloud">Maker-curated</span><h2>{owner.owner}</h2><p className="muted">{formatNumber(owner.totalInstalls)} skills.sh installs across this group.</p></div><Badge tone="muted" value="external" /></div><div className="official-feature"><span className="helper">Featured repository</span><strong>{owner.featuredRepo}</strong><span className="helper">Featured skill</span><strong>{owner.featuredSkill}</strong></div><div className="official-skill-list">{owner.skills.map((skill) => <OfficialSkillRow key={skill.id} skill={skill} />)}</div></Panel>
}

function OfficialSkillRow({ skill }: { skill: V1Skill }) {
  return <div className="official-skill-row"><div><strong>{skill.name}</strong><span>{skill.source}/{skill.slug}</span></div><div className="official-skill-meta"><span>{formatNumber(skill.installs)} installs</span><a href={skill.url} rel="noreferrer" target="_blank">Open ↗</a></div></div>
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}
