import { createFileRoute } from '@tanstack/react-router'
import { SectionView } from '../views/SectionView'

export interface AppSectionSearch {
  draft?: string
  skill?: string
  version?: string
  digest?: `sha256:${string}`
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  return value
}

function parseSearch(search: Record<string, unknown>): AppSectionSearch {
  const digest = boundedString(search.digest, 256)
  return {
    ...(boundedString(search.draft, 256) ? { draft: boundedString(search.draft, 256) } : {}),
    ...(boundedString(search.skill, 256) ? { skill: boundedString(search.skill, 256) } : {}),
    ...(boundedString(search.version, 128) ? { version: boundedString(search.version, 128) } : {}),
    ...(digest?.startsWith('sha256:') ? { digest: digest as `sha256:${string}` } : {}),
  }
}

export const Route = createFileRoute('/app/$section')({ validateSearch: parseSearch, component: SectionRoute })

function SectionRoute() {
  const { section } = Route.useParams()
  const search = Route.useSearch()
  return <SectionView section={section} draftSearch={search} />
}
