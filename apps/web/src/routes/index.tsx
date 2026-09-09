import { Link, createFileRoute } from '@tanstack/react-router'
import { useAuth } from '../lib/auth'
import { LoginForm } from '../components/LoginForm'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const { status } = useAuth()
  if (status === 'signed-in') {
    return (
      <main className="public-shell">
        <div className="public-nav"><span className="brand-mark">PS</span><strong>Private Skills</strong><Link className="button button-primary" to="/app">Open registry</Link></div>
        <div className="public-center"><span className="eyebrow">Private Skills Registry</span><h1>Your trusted entry point for agent skills.</h1><p className="lede">Browse approved releases, manage packs, and keep policy decisions visible to the team.</p><Link className="button button-primary" to="/app">Open registry</Link></div>
      </main>
    )
  }
  return <main className="public-shell"><div className="public-nav"><span className="brand-mark">PS</span><strong>Private Skills</strong><span className="public-nav-label">Team registry</span></div><LoginForm /></main>
}
