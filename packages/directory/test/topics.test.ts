import { describe, expect, it, vi } from 'vitest';

import {
  SKILLS_TOPIC_PARSER_REVISION,
  SkillsDirectoryClient,
  parseSkillsTopicPage,
} from '../src/index.js';

function topicHtml(input: {
  slug: string;
  title: string;
  description: string;
  capability: string;
  skillName: string;
  skillSource: string;
  skillSlug: string;
  skillDescription: string;
  agents: string;
  relatedSlug: string;
  relatedName: string;
}): string {
  return `<!doctype html>
    <html><head><script>window.secret = "do not retain"</script></head><body>
      <main>
        <header><h1>${input.title}</h1><p>${input.description}</p></header>
        <section>
          <h2>What your agent can do with <!-- -->${input.slug}<!-- --> skills installed</h2>
          <ul><li>${input.capability}</li><li>Keep the workflow maintainable</li></ul>
        </section>
        <section>
          <h2>Skills in this category</h2>
          <div class="divide-y">
            <a href="/${input.skillSource}/${input.skillSlug}">
              <div><h3>${input.skillName}</h3><p>${input.skillSource}</p></div>
              <p>${input.skillDescription}</p>
            </a>
          </div>
        </section>
        <section><h2>Works with your agent</h2><p>${input.agents}</p></section>
        <section><h2>Frequently asked questions</h2><details><summary>Can I use this?</summary><p>Yes, use the listed skills.</p></details></section>
        <section><h2>Related topics</h2><a href="/topic/${input.relatedSlug}">${input.relatedName}</a></section>
      </main>
    </body></html>`;
}

describe('skills.sh topic metadata parser', () => {
  it('parses the recognized React page sections and provenance fields', () => {
    const topic = parseSkillsTopicPage(topicHtml({
      slug: 'react',
      title: 'Frontend &amp; React skills',
      description: 'React skills for production-quality frontend code.',
      capability: 'Identify and eliminate data-fetching waterfalls',
      skillName: 'vercel-react-best-practices',
      skillSource: 'vercel-labs/agent-skills',
      skillSlug: 'vercel-react-best-practices',
      skillDescription: 'Performance rules covering waterfalls and re-renders',
      agents: 'React skills are compatible with Codex and other agents.',
      relatedSlug: 'nextjs',
      relatedName: 'Next.js',
    }), { slug: 'react', sourceUrl: 'https://www.skills.sh/topic/react', fetchedAt: '2026-09-10T00:00:00.000Z' });

    expect(topic).toMatchObject({
      provider: 'skills.sh',
      slug: 'react',
      status: 'fresh',
      title: 'Frontend & React skills',
      description: 'React skills for production-quality frontend code.',
      compatibleAgents: 'React skills are compatible with Codex and other agents.',
      sourceUrl: 'https://www.skills.sh/topic/react',
      fetchedAt: '2026-09-10T00:00:00.000Z',
      parserRevision: SKILLS_TOPIC_PARSER_REVISION,
      reason: null,
    });
    expect(topic.capabilities).toEqual([
      'Identify and eliminate data-fetching waterfalls',
      'Keep the workflow maintainable',
    ]);
    expect(topic.skills).toEqual([{
      id: 'vercel-labs/agent-skills/vercel-react-best-practices',
      name: 'vercel-react-best-practices',
      source: 'vercel-labs/agent-skills',
      slug: 'vercel-react-best-practices',
      description: 'Performance rules covering waterfalls and re-renders',
      url: 'https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
    }]);
    expect(topic.faqs).toEqual([{ question: 'Can I use this?', answer: 'Yes, use the listed skills.' }]);
    expect(topic.relatedTopics).toEqual([{ slug: 'nextjs', name: 'Next.js', url: 'https://www.skills.sh/topic/nextjs' }]);
  });

  it('parses the Marketing fixture and ignores script contents', () => {
    const topic = parseSkillsTopicPage(topicHtml({
      slug: 'marketing',
      title: 'Marketing skills',
      description: 'Marketing skills for SEO, copywriting, CRO, and growth.',
      capability: 'Audit a landing page for SEO issues',
      skillName: 'seo-audit',
      skillSource: 'coreyhaines31/marketingskills',
      skillSlug: 'seo-audit',
      skillDescription: 'Technical and on-page SEO audit with a prioritized action plan',
      agents: 'Marketing skills work with Claude Code, Cursor, Codex, and the skills CLI.',
      relatedSlug: 'agent-workflows',
      relatedName: 'Agent workflows',
    }), { slug: 'marketing', sourceUrl: 'https://www.skills.sh/topic/marketing' });

    expect(topic.status).toBe('fresh');
    expect(topic.title).toBe('Marketing skills');
    expect(topic.skills[0]?.source).toBe('coreyhaines31/marketingskills');
    expect(topic.compatibleAgents).not.toContain('do not retain');
    expect(topic.relatedTopics[0]?.slug).toBe('agent-workflows');
  });

  it('preserves nested source and skill slug identity', () => {
    const topic = parseSkillsTopicPage(topicHtml({
      slug: 'react',
      title: 'React skills',
      description: 'Description',
      capability: 'Capability',
      skillName: 'nested-skill',
      skillSource: 'vercel-labs/agent-skills',
      skillSlug: 'nested/skill',
      skillDescription: 'Description',
      agents: 'Compatible agents',
      relatedSlug: 'nextjs',
      relatedName: 'Next.js',
    }), { slug: 'react', sourceUrl: 'https://www.skills.sh/topic/react' });

    expect(topic.skills[0]).toMatchObject({
      id: 'vercel-labs/agent-skills/nested/skill',
      source: 'vercel-labs/agent-skills',
      slug: 'nested/skill',
    });
  });

  it('normalizes presentation spacing around the source slash', () => {
    const html = topicHtml({
      slug: 'react',
      title: 'React skills',
      description: 'Description',
      capability: 'Capability',
      skillName: 'skill',
      skillSource: 'vercel-labs/agent-skills',
      skillSlug: 'skill',
      skillDescription: 'Description',
      agents: 'Compatible agents',
      relatedSlug: 'nextjs',
      relatedName: 'Next.js',
    }).replace('<p>vercel-labs/agent-skills</p>', '<p>vercel-labs / agent-skills</p>');

    const topic = parseSkillsTopicPage(html, { slug: 'react', sourceUrl: 'https://www.skills.sh/topic/react' });
    expect(topic.skills[0]).toMatchObject({ source: 'vercel-labs/agent-skills', slug: 'skill' });
  });

  it('rejects changed page structure instead of inventing topic membership', () => {
    expect(() => parseSkillsTopicPage('<main><header><h1>Marketing skills</h1><p>Description</p></header></main>', {
      slug: 'marketing',
      sourceUrl: 'https://www.skills.sh/topic/marketing',
    })).toThrowError(/skills-section/u);
  });

  it('rejects cross-origin links and unsafe source URLs', () => {
    const html = topicHtml({
      slug: 'react',
      title: 'React skills',
      description: 'Description',
      capability: 'Capability',
      skillName: 'skill',
      skillSource: 'evil.invalid',
      skillSlug: 'skill',
      skillDescription: 'Description',
      agents: 'Compatible agents',
      relatedSlug: 'nextjs',
      relatedName: 'Next.js',
    }).replace('href="/evil.invalid/skill"', 'href="https://evil.invalid/skill"');
    expect(() => parseSkillsTopicPage(html, { slug: 'react', sourceUrl: 'https://www.skills.sh/topic/react' })).toThrowError(/skill\.href/u);
    expect(() => parseSkillsTopicPage('<main></main>', { slug: 'react', sourceUrl: 'http://www.skills.sh/topic/react' })).toThrowError(/source-url/u);
    for (const sourceUrl of [
      'https://evil.example/topic/react',
      'https://www.skills.sh:444/topic/react',
      'https://user:pass@www.skills.sh/topic/react',
    ]) {
      expect(() => parseSkillsTopicPage('<main></main>', { slug: 'react', sourceUrl })).toThrowError(/source-url/u);
    }
  });

  it('canonicalizes the bare skills.sh topic host for provenance', () => {
    const topic = parseSkillsTopicPage(topicHtml({
      slug: 'react',
      title: 'React skills',
      description: 'Description',
      capability: 'Capability',
      skillName: 'skill',
      skillSource: 'vercel-labs/agent-skills',
      skillSlug: 'skill',
      skillDescription: 'Description',
      agents: 'Compatible agents',
      relatedSlug: 'nextjs',
      relatedName: 'Next.js',
    }), { slug: 'react', sourceUrl: 'https://skills.sh/topic/react/' });

    expect(topic.sourceUrl).toBe('https://www.skills.sh/topic/react');
  });

  it('fails closed on deeply nested or inconsistent markup', () => {
    const deep = `<main>${'<div>'.repeat(130)}<h1>React</h1>${'</div>'.repeat(130)}</main>`;
    expect(() => parseSkillsTopicPage(deep, { slug: 'react', sourceUrl: 'https://www.skills.sh/topic/react' })).toThrowError(/document\.depth/u);

    const mismatched = topicHtml({
      slug: 'react',
      title: 'React skills',
      description: 'Description',
      capability: 'Capability',
      skillName: 'skill',
      skillSource: 'vercel-labs/agent-skills',
      skillSlug: 'skill',
      skillDescription: 'Description',
      agents: 'Compatible agents',
      relatedSlug: 'nextjs',
      relatedName: 'Next.js',
    }).replace('vercel-labs/agent-skills</p>', 'other-owner/other-repo</p>');
    expect(() => parseSkillsTopicPage(mismatched, { slug: 'react', sourceUrl: 'https://www.skills.sh/topic/react' })).toThrowError(/skills\.identity/u);
  });
});

describe('SkillsDirectoryClient.topic', () => {
  it('fetches canonical public HTML without forwarding the API bearer', async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://www.skills.sh/topic/react');
      expect(init?.redirect).toBe('manual');
      expect(init?.headers).toEqual({ accept: 'text/html, application/xhtml+xml' });
      return new Response(topicHtml({
        slug: 'react',
        title: 'React skills',
        description: 'Description',
        capability: 'Capability',
        skillName: 'skill',
        skillSource: 'vercel-labs/agent-skills',
        skillSlug: 'skill',
        skillDescription: 'Description',
        agents: 'Compatible agents',
        relatedSlug: 'nextjs',
        relatedName: 'Next.js',
      }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    const getToken = vi.fn(async () => 'secret-token');
    const client = new SkillsDirectoryClient({ fetch, getToken, maxAttempts: 1 });
    const topic = await client.topic('react');
    expect(topic.status).toBe('fresh');
    expect(getToken).not.toHaveBeenCalled();
  });

  it('keeps topic HTML on the public host while JSON methods use a custom gateway', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://www.skills.sh/topic/react') {
        return new Response(topicHtml({
          slug: 'react',
          title: 'React skills',
          description: 'Description',
          capability: 'Capability',
          skillName: 'skill',
          skillSource: 'vercel-labs/agent-skills',
          skillSlug: 'skill',
          skillDescription: 'Description',
          agents: 'Compatible agents',
          relatedSlug: 'nextjs',
          relatedName: 'Next.js',
        }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response(JSON.stringify({ data: [], pagination: { page: 0, perPage: 1, total: 0, hasMore: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new SkillsDirectoryClient({ baseURL: 'https://gateway.example/registry', fetch, maxAttempts: 1 });

    await expect(client.topic('react')).resolves.toMatchObject({ status: 'fresh', sourceUrl: 'https://www.skills.sh/topic/react' });
    await expect(client.list({ perPage: 1 })).resolves.toMatchObject({ pagination: { page: 0, perPage: 1 } });
    expect(calls).toEqual([
      'https://www.skills.sh/topic/react',
      'https://gateway.example/registry/api/v1/skills?view=all-time&page=0&per_page=1',
    ]);
  });

  it('returns stale metadata when a successful document no longer matches the parser', async () => {
    const client = new SkillsDirectoryClient({
      fetch: vi.fn(async () => new Response('<main><h1>Changed</h1></main>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })),
      maxAttempts: 1,
    });
    await expect(client.topic('marketing')).resolves.toMatchObject({
      status: 'stale',
      slug: 'marketing',
      title: null,
      skills: [],
      sourceUrl: 'https://www.skills.sh/topic/marketing',
      parserRevision: SKILLS_TOPIC_PARSER_REVISION,
    });
  });

  it('returns unavailable metadata for a missing topic page', async () => {
    const client = new SkillsDirectoryClient({
      fetch: vi.fn(async () => new Response('', { status: 404, headers: { 'content-type': 'text/html' } })),
      maxAttempts: 1,
    });
    await expect(client.topic('missing')).resolves.toMatchObject({
      status: 'unavailable',
      slug: 'missing',
      title: null,
      sourceUrl: 'https://www.skills.sh/topic/missing',
    });
  });
});
