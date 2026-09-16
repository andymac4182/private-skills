import { createFileRoute } from '@tanstack/react-router'
import { LocalBillingCheckoutView } from '../views/LocalBillingDemoViews'

interface LocalBillingDemoSearch {
  session?: string
}

function parseSearch(search: Record<string, unknown>): LocalBillingDemoSearch {
  const session = search.session
  return typeof session === 'string' && session.length > 0 && session.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(session)
    ? { session }
    : {}
}

export const Route = createFileRoute('/billing/test-checkout')({
  validateSearch: parseSearch,
  component: LocalBillingCheckoutRoute,
})

function LocalBillingCheckoutRoute() {
  const { session } = Route.useSearch()
  return <LocalBillingCheckoutView sessionId={session} />
}
