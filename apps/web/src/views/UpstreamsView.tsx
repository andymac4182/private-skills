import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { Button, EmptyState, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'
import type { Upstream } from '../lib/types'

export function UpstreamsView() {
  const [upstreams, setUpstreams] = useState<Upstream[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'github' | 'registry'>('github')
  const [namespace, setNamespace] = useState('@vendor')
  const [baseUrl, setBaseUrl] = useState('')
  const [repositories, setRepositories] = useState('')
  const [credentialEnv, setCredentialEnv] = useState('')
  const [importUpstreamId, setImportUpstreamId] = useState('')
  const [repository, setRepository] = useState('')
  const [path, setPath] = useState('')
  const [ref, setRef] = useState('')
  const [importName, setImportName] = useState('')
  const [importVersion, setImportVersion] = useState('')
  const [busy, setBusy] = useState<'create' | 'import' | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  async function load() {
    setError(null)
    try {
      const response = await api.upstreams()
      setUpstreams(response.upstreams ?? [])
      setImportUpstreamId((current) => current || response.upstreams?.[0]?.id || '')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load upstreams.')
    }
  }
  useEffect(() => { void load() }, [])

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('create'); setMessage(null)
    try {
      const response = await api.createUpstream({ name: name.trim(), kind, namespace: namespace.trim(), baseUrl: baseUrl.trim() || undefined, repositories: repositories.split('\n').map((line) => line.trim()).filter(Boolean), credentialEnv: credentialEnv.trim() || undefined })
      setMessage({ kind: 'success', text: `Source ${response.upstream.name} added. Credentials stay with the registry.` })
      setName(''); setRepositories(''); await load()
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : 'Upstream creation failed.' })
    } finally { setBusy(null) }
  }

  async function submitImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('import'); setMessage(null)
    if (!importUpstreamId || !path.trim() || !importName.trim() || !importVersion.trim()) {
      setMessage({ kind: 'error', text: 'Select a source and provide a path, private name, and version.' }); setBusy(null); return
    }
    try {
      const response = await api.importUpstream({ upstreamId: importUpstreamId, repository: repository.trim() || undefined, path: path.trim(), ref: ref.trim() || undefined, name: importName.trim(), version: importVersion.trim() })
      setMessage({ kind: 'success', text: 'Import requested. The registry will review it before publishing.' })
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof ApiError ? cause.message : 'Import request failed.' })
    } finally { setBusy(null) }
  }

  return <div className="view-heading"><div><span className="eyebrow">Source management</span><h1>Sources</h1><p className="muted">Connect approved GitHub repositories or registries to private namespaces. Credentials stay with the registry.</p></div>{error && <ErrorState message={error} onRetry={() => void load()} />}<div className="grid-2"><Panel title="Add source" description="Only administrators can add sources. Credentials stay with the registry."><form className="form-grid" onSubmit={create}><Field label="Display name"><input onChange={(event) => setName(event.target.value)} placeholder="Vendor skills" value={name} /></Field><Field label="Kind"><select onChange={(event) => setKind(event.target.value as 'github' | 'registry')} value={kind}><option value="github">GitHub</option><option value="registry">Private registry</option></select></Field><Field label="Namespace"><input onChange={(event) => setNamespace(event.target.value)} placeholder="@vendor" value={namespace} /></Field><Field label="Base URL" hint="Required for registry sources; optional for GitHub."><input onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://registry.example" value={baseUrl} /></Field><Field label="Allowed repositories" hint="One owner/repo per line."><textarea onChange={(event) => setRepositories(event.target.value)} placeholder="vendor/skills" value={repositories} /></Field><Field label="Credential reference" hint="Name the configured credential; never paste it here."><input onChange={(event) => setCredentialEnv(event.target.value)} placeholder="GITHUB_APP_TOKEN_REF" value={credentialEnv} /></Field><div className="form-actions"><Button busy={busy === 'create'} type="submit">Add source</Button></div></form></Panel><Panel title="Import a skill" description="Request a skill from one approved source.">{upstreams === null ? <LoadingState /> : upstreams.length === 0 ? <EmptyState title="No approved sources" description="Add a source before requesting an import." /> : <form className="form-grid" onSubmit={submitImport}><Field label="Source"><select onChange={(event) => setImportUpstreamId(event.target.value)} value={importUpstreamId}>{upstreams.map((upstream) => <option key={upstream.id} value={upstream.id}>{upstream.name} · {upstream.namespace}</option>)}</select></Field><Field label="Repository"><input onChange={(event) => setRepository(event.target.value)} placeholder="owner/repository" value={repository} /></Field><Field label="Skill path"><input onChange={(event) => setPath(event.target.value)} placeholder="skills/review" value={path} /></Field><Field label="Version or commit"><input onChange={(event) => setRef(event.target.value)} placeholder="main or a commit" value={ref} /></Field><Field label="Private name"><input onChange={(event) => setImportName(event.target.value)} placeholder="@vendor/review" value={importName} /></Field><Field label="Version"><input onChange={(event) => setImportVersion(event.target.value)} placeholder="1.0.0" value={importVersion} /></Field><div className="form-actions"><Button busy={busy === 'import'} type="submit">Request import</Button></div></form>}</Panel></div>{message && <Notice kind={message.kind}>{message.text}</Notice>}<Panel title="Configured sources" description="Sources currently available in this registry.">{upstreams === null ? <LoadingState /> : upstreams.length === 0 ? <EmptyState title="No sources yet" description="This registry has no approved source routes yet." /> : <div className="table-wrap"><table><thead><tr><th>Name</th><th>Kind</th><th>Namespace</th><th>Repositories</th><th>Status</th></tr></thead><tbody>{upstreams.map((upstream) => <tr key={upstream.id}><td><strong>{upstream.name}</strong><span className="cell-sub">{upstream.id}</span></td><td>{upstream.kind}</td><td>{upstream.namespace}</td><td>{upstream.repositories?.length ? upstream.repositories.join(', ') : '—'}</td><td><span className={`badge ${upstream.enabled ? 'badge-good' : 'badge-muted'}`}>{upstream.enabled ? 'enabled' : 'disabled'}</span></td></tr>)}</tbody></table></div>}</Panel></div>
}
