import { createFileRoute } from '@tanstack/react-router'
import { SectionView } from '../views/SectionView'

export const Route = createFileRoute('/app/$section')({ component: SectionRoute })

function SectionRoute() {
  const { section } = Route.useParams()
  return <SectionView section={section} />
}

