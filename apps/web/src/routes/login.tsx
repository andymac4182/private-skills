import { Link, createFileRoute } from '@tanstack/react-router'
import { LoginForm } from '../components/LoginForm'
import { useAuth } from '../lib/auth'

export const Route = createFileRoute('/login')({ component: LoginPage })

function LoginPage() {
  const { status } = useAuth()
  if (status === 'signed-in') return <div className="public-shell"><div className="public-nav"><Link className="brand" to="/"><span className="brand-mark">PS</span><strong>Private Skills</strong></Link></div><div className="public-center"><h1>Already signed in</h1><Link className="button button-primary" to="/app">Open registry</Link></div></div>
  return <main className="public-shell"><div className="public-nav"><Link className="brand" to="/"><span className="brand-mark">PS</span><strong>Private Skills</strong></Link><span className="public-nav-label">Secure session</span></div><LoginForm /></main>
}
