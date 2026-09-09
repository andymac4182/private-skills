import { createFileRoute } from '@tanstack/react-router'
import { RegistryShell } from '../components/RegistryShell'

export const Route = createFileRoute('/app')({ component: AppLayout })

function AppLayout() {
  return <RegistryShell />
}
