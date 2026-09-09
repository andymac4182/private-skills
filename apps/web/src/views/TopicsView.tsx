import { Link } from '@tanstack/react-router'
import { Notice, Panel } from '../components/Primitives'

const topicLinks = [
  { slug: 'react', name: 'Frontend & React', description: 'Performance rules, component patterns, and ecosystem knowledge for production-quality React.', href: 'https://www.skills.sh/topic/react' },
  { slug: 'nextjs', name: 'Next.js', description: 'App Router, server components, caching APIs, and Vercel deployment patterns kept current.', href: 'https://www.skills.sh/topic/nextjs' },
  { slug: 'design', name: 'Design & UI', description: 'Taste and frameworks for polished interfaces, from critique to design tokens.', href: 'https://www.skills.sh/topic/design' },
  { slug: 'mobile', name: 'Mobile', description: 'Expo, React Native, and native platform conventions for real iOS and Android.', href: 'https://www.skills.sh/topic/mobile' },
  { slug: 'agent-workflows', name: 'Agent workflows', description: 'How agents plan, debug, dispatch parallel work, and run autonomous loops.', href: 'https://www.skills.sh/topic/agent-workflows' },
  { slug: 'databases', name: 'Databases', description: 'Postgres, Supabase, Firebase, Neon, and Convex for correct queries and migrations.', href: 'https://www.skills.sh/topic/databases' },
  { slug: 'testing', name: 'Testing', description: 'TDD loops, Playwright automation, and verification passes that value meaningful tests.', href: 'https://www.skills.sh/topic/testing' },
  { slug: 'marketing', name: 'Marketing', description: 'SEO, copywriting, CRO, and growth expertise carried into every session.', href: 'https://www.skills.sh/topic/marketing' },
] as const

export function TopicsView() {
  function findTopic(topic: string) {
    if (typeof window !== 'undefined') window.sessionStorage.setItem('pskills.directory.topic.query', topic)
  }

  return <div className="view-heading topics-view">
    <div className="page-intro"><div><span className="eyebrow eyebrow-cloud">Cloud directory</span><h1>Topics</h1><p className="muted">Explore the current skills.sh taxonomy, then inspect the source page that defines each topic. Topic links and membership remain upstream metadata, separate from private approval.</p></div><Link className="button button-primary" params={{ section: 'directory' }} to="/app/$section">Browse cloud skills</Link></div>
    <Notice kind="info">skills.sh does not document a topic-membership JSON endpoint. A recognized topic page can show its explanatory copy, linked skills, compatible-agent text, FAQs, and related topics with fetch provenance. Internal searches are directory matches, not curated topic membership.</Notice>
    <Panel title="Current topic links" description="These links mirror the official skills.sh topic index. Open a topic to load its current metadata snapshot; linked skills are shown when the page shape is recognized.">
      <div className="topics-grid">{topicLinks.map((topic) => <article className="topic-card" key={topic.slug}>
        <span className="topic-card-icon" aria-hidden="true">↗</span>
        <span><strong>{topic.name}</strong><small>{topic.description}</small></span>
        <span className="topic-card-source">skills.sh topic</span>
        <div className="topic-card-actions">
          <Link className="button button-secondary" params={{ slug: topic.slug }} to="/app/topic/$slug">Open topic</Link>
          <Link className="button button-quiet" params={{ section: 'directory' }} to="/app/$section" onClick={() => findTopic(topic.name)}>Find matching skills</Link>
          <a href={topic.href} rel="noreferrer" target="_blank">Open upstream ↗</a>
        </div>
      </article>)}</div>
    </Panel>
  </div>
}
