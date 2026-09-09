import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { Policy } from '../lib/types'
import { Button, ErrorState, Field, LoadingState, Notice, Panel } from '../components/Primitives'

const scannerNames: Record<string, string> = {
  'cisco-skill-scanner': 'Cisco Skill Scanner',
  'nvidia-skillspector': 'NVIDIA Skillspector',
  skillsguard: 'SkillsGuard',
}

export function PolicyView() {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    setError(null)
    try {
      const response = await api.policy()
      setPolicy(response.policy)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Could not load scanner policy.')
    }
  }
  useEffect(() => { void load() }, [])

  function setScannerMode(id: string, mode: 'disabled' | 'advisory' | 'required') {
    setPolicy((current) => current ? { ...current, scanners: current.scanners.map((scanner) => scanner.id === id ? { ...scanner, mode } : scanner) } : current)
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!policy) return
    setSaving(true); setMessage(null); setError(null)
    try {
      const response = await api.updatePolicy(policy)
      setPolicy(response.policy)
      setMessage('Review rules saved. Releases will be checked against the new requirements.')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : 'Policy update failed.')
    } finally {
      setSaving(false)
    }
  }

  if (error && !policy) return <div className="view-heading"><div><span className="eyebrow">Administration</span><h1>Scanner policy</h1></div><ErrorState message={error} onRetry={() => void load()} /></div>
  if (!policy) return <div className="view-heading"><div><span className="eyebrow">Administration</span><h1>Scanner policy</h1></div><Panel><LoadingState /></Panel></div>

  return <div className="view-heading"><div><span className="eyebrow">Administration</span><h1>Scanner policy</h1><p className="muted">Choose how each security check affects a release. Required checks must pass before installation.</p></div><form onSubmit={save} className="stack"><Panel title="Review rules" description="Changes create a new set of requirements for affected releases.">{policy.scanners.map((scanner) => <div className="toggle-row" key={scanner.id}><div><strong>{scannerNames[scanner.id] ?? scanner.id}</strong><p>{scanner.mode === 'required' ? 'A missing, failed, or incomplete check blocks installation.' : scanner.mode === 'advisory' ? 'Findings are visible to reviewers while installation remains possible.' : 'This check does not run; releases remain visibly unreviewed.'}</p></div><select aria-label={`${scanner.id} mode`} onChange={(event) => setScannerMode(scanner.id, event.target.value as 'disabled' | 'advisory' | 'required')} value={scanner.mode}><option value="disabled">Disabled</option><option value="advisory">Advisory</option><option value="required">Required</option></select></div>)}</Panel><Panel title="Distribution guardrails" description="These controls apply to every release."><div className="form-grid"><Field label="Evidence max age (seconds)"><input min="0" onChange={(event) => setPolicy({ ...policy, evidenceMaxAgeSeconds: Number(event.target.value) || 0 })} type="number" value={policy.evidenceMaxAgeSeconds} /></Field><label className="checkbox-field"><input checked={policy.allowUnscanned} onChange={(event) => setPolicy({ ...policy, allowUnscanned: event.target.checked })} type="checkbox" /><span><strong>Allow explicitly unreviewed releases</strong><small>Use only for development profiles. Required checks still block installation.</small></span></label>{policy.allowUnscanned && <div className="full"><Notice kind="warning">Unreviewed releases may be installed under these rules. Keep this setting intentional and visible to operators.</Notice></div>}</div></Panel>{error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}<div className="form-actions"><Button busy={saving} type="submit">Save review rules</Button><Button kind="quiet" type="button" onClick={() => void load()}>Discard changes</Button></div></form></div>
}
