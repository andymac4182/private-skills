import { createFileRoute } from '@tanstack/react-router'
import { InvitationAcceptanceView } from '../views/InvitationAcceptanceView'
import { normalizeInvitationId } from '../lib/invitations'

export interface InvitationAcceptanceSearch {
  id?: string
}
function parseSearch(search: Record<string, unknown>): InvitationAcceptanceSearch {
  const id = normalizeInvitationId(search.id)
  return id ? { id } : {}
}

export const Route = createFileRoute('/organization/accept-invitation')({
  validateSearch: parseSearch,
  component: InvitationAcceptanceRoute,
})

function InvitationAcceptanceRoute() {
  const { id } = Route.useSearch()
  return <InvitationAcceptanceView invitationId={id} />
}
