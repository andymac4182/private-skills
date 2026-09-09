import { Link } from '@tanstack/react-router'
import { Notice, Panel } from '../components/Primitives'

const topicLinks = [
  { name: 'React', description: 'Frontend components and application patterns.', href: 'https://www.skills.sh/topic/react' },
  { name: 'Next.js', description: 'Web application workflows and framework tooling.', href: 'https://www.skills.sh/topic/nextjs' },
  { name: 'Design & UI', description: 'Interface, visual design, and product craft.', href: 'https://www.skills.sh/topic/design-ui' },
  { name: 'Mobile', description: 'Mobile application and device workflows.', href: 'https://www.skills.sh/topic/mobile' },
  { name: 'Agent workflows', description: 'Skills for planning, agents, and automation.', href: 'https://www.skills.sh/topic/agent-workflows' },
  { name: 'Databases', description: 'Data stores, schemas, and persistence workflows.', href: 'https://www.skills.sh/topic/databases' },
  { name: 'Testing', description: 'Testing, verification, and quality workflows.', href: 'https://www.skills.sh/topic/testing' },
  { name: 'Marketing', description: 'Content, growth, and marketing workflows.', href: 'https://www.skills.sh/topic/marketing' },
]

export function TopicsView() {
  function findTopic(topic: string) {
    if (typeof window !== 'undefined') window.sessionStorage.setItem('pskills.directory.topic.query', topic)
  }

  return <div className="view-heading topics-view"><div className="page-intro"><div><span className="eyebrow eyebrow-cloud">Cloud directory</span><h1>Topics</h1><p className="muted">A source-backed set of links to the current skills.sh topic taxonomy. Topic membership is maintained upstream and is not copied into private registry metadata.</p></div><Link className="button button-primary" params={{ section: 'directory' }} to="/app/$section">Browse cloud skills</Link></div><Notice kind="info">skills.sh does not document a topic-membership JSON endpoint. Open a topic page to see its current explanatory copy, skill links, compatible agents, and related topics. Internal searches below are directory matches, not curated topic membership.</Notice><Panel title="Current topic links" description="Curated from the skills.sh topic index documented in the cloud review. Counts and membership are intentionally omitted until the source exposes a stable API."><div className="topics-grid">{topicLinks.map((topic) => <article className="topic-card" key={topic.name}><span className="topic-card-icon" aria-hidden="true">↗</span><span><strong>{topic.name}</strong><small>{topic.description}</small></span><span className="topic-card-source">skills.sh topic</span><div className="topic-card-actions"><Link className="button button-secondary" params={{ section: 'directory' }} to="/app/$section" onClick={() => findTopic(topic.name)}>Find skills for this topic</Link><a href={topic.href} rel="noreferrer" target="_blank">Open upstream topic ↗</a></div></article>)}</div></Panel></div>
}
