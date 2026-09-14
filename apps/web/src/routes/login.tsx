import { Link, createFileRoute } from '@tanstack/react-router'
import { LoginForm } from '../components/LoginForm'
import { safeAppReturnTo, useAuth } from '../lib/auth'

export interface LoginSearch {
  returnTo?: string
}

function parseSearch(search: Record<string, unknown>): LoginSearch {
  const returnTo = safeAppReturnTo(search.returnTo)
  return returnTo ? { returnTo } : {}
}

export const Route = createFileRoute('/login')({ validateSearch: parseSearch, component: LoginPage })

function LoginPage() {
  const { status } = useAuth()
  const { returnTo } = Route.useSearch()
  if (status === 'signed-in') return <div className="public-shell"><div className="public-nav"><Link className="brand" to="/"><span className="brand-mark">PS</span><strong>Private Skills</strong></Link></div><div className="public-center"><h1>Already signed in</h1><a className="button button-primary" href={returnTo ?? '/app'}>Open registry</a></div></div>
  return <main className="public-shell"><div className="public-nav"><Link className="brand" to="/"><span className="brand-mark">PS</span><strong>Private Skills</strong></Link><span className="public-nav-label">Secure session</span></div><LoginForm returnTo={returnTo} /></main>
}
