import { Link, createFileRoute } from '@tanstack/react-router'
import { LoginForm } from '../components/LoginForm'
import { needsCompanySetup, safeAppReturnTo, useAuth } from '../lib/auth'

export interface LoginSearch {
  returnTo?: string
}

function parseSearch(search: Record<string, unknown>): LoginSearch {
  const returnTo = safeAppReturnTo(search.returnTo)
  return returnTo ? { returnTo } : {}
}

export const Route = createFileRoute('/login')({ validateSearch: parseSearch, component: LoginPage })

function LoginPage() {
  const { session, status } = useAuth()
  const { returnTo } = Route.useSearch()
  if (status === 'signed-in') {
    const needsCompany = needsCompanySetup(session)
    return <div className="public-shell"><div className="public-nav"><Link className="brand" to="/"><span className="brand-mark">PS</span><strong>Private Skills</strong></Link></div><div className="public-center"><h1>{needsCompany ? 'Set up your company' : 'Already signed in'}</h1><p className="lede">{needsCompany ? 'Your identity is ready. Create or choose a company to open the registry.' : 'Your private registry session is active.'}</p>{needsCompany ? <Link className="button button-primary" params={{ section: 'company' }} to="/app/$section">Set up company</Link> : <a className="button button-primary" href={returnTo ?? '/app'}>Open registry</a>}</div></div>
  }
  return <main className="public-shell"><div className="public-nav"><Link className="brand" to="/"><span className="brand-mark">PS</span><strong>Private Skills</strong></Link><span className="public-nav-label">Secure session</span></div><LoginForm returnTo={returnTo} /></main>
}
