import { Outlet, createFileRoute } from '@tanstack/react-router'
import { PublicLayout } from '../components/PublicLayout'

export const Route = createFileRoute('/docs')({ component: DocsLayout })

function DocsLayout() {
  return <PublicLayout current="docs"><Outlet /></PublicLayout>
}
