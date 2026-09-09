import { createFileRoute } from '@tanstack/react-router'
import { TopicDetailView } from '../views/TopicDetailView'

export const Route = createFileRoute('/app/topic/$slug')({ component: TopicRoute })

function TopicRoute() {
  const { slug } = Route.useParams()
  return <TopicDetailView slug={slug} />
}
