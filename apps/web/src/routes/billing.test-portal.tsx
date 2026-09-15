import { createFileRoute } from '@tanstack/react-router'
import { LocalBillingPortalView } from '../views/LocalBillingDemoViews'

interface LocalBillingDemoSearch {
  session?: string
}

function parseSearch(search: Record<string, unknown>): LocalBillingDemoSearch {
  const session = search.session
  return typeof session === 'string' && session.length > 0 && session.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(session)
    ? { session }
    : {}
}

export const Route = createFileRoute('/billing/test-portal')({
  validateSearch: parseSearch,
  component: LocalBillingPortalRoute,
})

function LocalBillingPortalRoute() {
  const { session } = Route.useSearch()
  return <LocalBillingPortalView sessionId={session} />
}
