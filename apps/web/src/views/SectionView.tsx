import { AuditView } from './AuditView'
import { AnalyticsView } from './AnalyticsView'
import { CatalogView } from './CatalogView'
import { OperationsView } from './OperationsView'
import { PacksView } from './PacksView'
import { PolicyView } from './PolicyView'
import { PublishView } from './PublishView'
import { UpstreamsView } from './UpstreamsView'
import { OverviewView } from './OverviewView'
import { ReviewsView } from './ReviewsView'
import { DirectoryView } from './DirectoryView'
import { OfficialView } from './OfficialView'
import { TopicsView } from './TopicsView'
import { DirectoryAuditsView } from './DirectoryAuditsView'

export function SectionView({ section }: { section: string }) {
  switch (section) {
    case 'overview': return <OverviewView />
    case 'catalog': return <CatalogView />
    case 'packs': return <PacksView />
    case 'directory': return <DirectoryView />
    case 'official': return <OfficialView />
    case 'topics': return <TopicsView />
    case 'cloud-audits': return <DirectoryAuditsView />
    case 'analytics': return <AnalyticsView />
    case 'reviews': return <ReviewsView />
    case 'publish': return <PublishView />
    case 'operations': return <OperationsView />
    case 'policy': return <PolicyView />
    case 'upstreams': return <UpstreamsView />
    case 'audit': return <AuditView />
    default: return <div className="view-heading"><div><span className="eyebrow">Registry</span><h1>Section not found</h1><p className="muted">The requested registry section does not exist.</p></div></div>
  }
}
