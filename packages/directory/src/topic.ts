/**
 * Bounded metadata extracted from one official skills.sh topic page.
 *
 * Topic pages are HTML rather than part of the documented JSON API.  This
 * parser intentionally keeps only plain text and same-origin links.  It does
 * not expose HTML, JSON-LD, scripts, inline event handlers, or file bytes to a
 * caller, and it never executes anything from the remote page.
 */

export const SKILLS_TOPIC_PARSER_REVISION = 'skills-sh-topic-html-v1' as const;

export type SkillsTopicStatus = 'fresh' | 'stale' | 'unavailable';

export interface SkillsTopicSkill {
  id: string;
  name: string;
  source: string;
  slug: string;
  description: string;
  url: string;
}

export interface SkillsTopicLink {
  slug: string;
  name: string;
  url: string;
}

export interface SkillsTopicFaq {
  question: string;
  answer: string;
}

export interface SkillsTopicResponse {
  provider: 'skills.sh';
  slug: string;
  status: SkillsTopicStatus;
  title: string | null;
  description: string | null;
  capabilities: string[];
  skills: SkillsTopicSkill[];
  compatibleAgents: string | null;
  faqs: SkillsTopicFaq[];
  relatedTopics: SkillsTopicLink[];
  sourceUrl: string;
  fetchedAt: string;
  parserRevision: string;
  reason: string | null;
}

export interface ParseSkillsTopicOptions {
  slug: string;
  sourceUrl: string | URL;
  fetchedAt?: string;
  parserRevision?: string;
}

export class SkillsTopicParseError extends Error {
  readonly field: string;

  constructor(field: string, message = 'skills.sh topic page shape changed') {
    super(`${message}: ${field}`);
    this.name = 'SkillsTopicParseError';
    this.field = field;
  }
}

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 128;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_LIST_ITEMS = 128;
const MAX_SKILLS = 500;
const MAX_RELATED_TOPICS = 64;
const MAX_FAQS = 64;
const MAX_URL_BYTES = 2_048;

const ignoredTags = new Set(['canvas', 'iframe', 'noscript', 'script', 'style', 'svg', 'template']);
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

interface TopicNode {
  tag: string;
  attributes: Record<string, string>;
  children: Array<TopicNode | string>;
}

interface TopicDocument {
  root: TopicNode;
  nodeCount: number;
}

/** Parse the recognized semantic sections of a skills.sh topic HTML page. */
export function parseSkillsTopicPage(html: string, options: ParseSkillsTopicOptions): SkillsTopicResponse {
  const sourceUrl = normalizeTopicSourceUrl(options.sourceUrl, options.slug);
  const slug = normalizeSlug(options.slug);
  if (utf8Bytes(html) > MAX_HTML_BYTES) throw new SkillsTopicParseError('document.size');

  const document = parseHtml(html);
  const main = firstDescendant(document.root, (node) => node.tag === 'main');
  if (!main) throw new SkillsTopicParseError('main');

  const titleNode = firstDescendant(main, (node) => node.tag === 'h1');
  const title = requiredText(titleNode, 'title');
  const header = firstDescendant(main, (node) => node.tag === 'header');
  const description = requiredText(
    header ? firstDescendant(header, (node) => node.tag === 'p') : undefined,
    'description',
  );

  const capabilitiesSection = findSectionByHeading(main, (value) => value.startsWith('what your agent can do with ') && value.endsWith(' skills installed'));
  const capabilityNodes = capabilitiesSection ? descendants(capabilitiesSection, (node) => node.tag === 'li') : [];
  const capabilities = boundedTextList(capabilityNodes, MAX_LIST_ITEMS, 'capabilities');

  const skillsSection = findSectionByHeading(main, (value) => value === 'skills in this category');
  if (!skillsSection) throw new SkillsTopicParseError('skills-section');
  const skills = parseSkillLinks(skillsSection, sourceUrl);
  if (skills.length > MAX_SKILLS) throw new SkillsTopicParseError('skills');

  const compatibleSection = findSectionByHeading(main, (value) => value === 'works with your agent');
  const compatibleAgents = requiredText(
    compatibleSection ? firstDescendant(compatibleSection, (node) => node.tag === 'p') : undefined,
    'compatible-agents',
  );

  const faqSection = findSectionByHeading(main, (value) => value === 'frequently asked questions');
  const faqs = faqSection ? parseFaqs(faqSection) : [];

  const relatedSection = findSectionByHeading(main, (value) => value === 'related topics');
  if (!relatedSection) throw new SkillsTopicParseError('related-topics');
  const relatedTopics = parseRelatedTopics(relatedSection, sourceUrl, slug);
  if (relatedTopics.length > MAX_RELATED_TOPICS) throw new SkillsTopicParseError('related-topics');

  return {
    provider: 'skills.sh',
    slug,
    status: 'fresh',
    title,
    description,
    capabilities,
    skills,
    compatibleAgents,
    faqs,
    relatedTopics,
    sourceUrl: sourceUrl.toString(),
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    parserRevision: options.parserRevision ?? SKILLS_TOPIC_PARSER_REVISION,
    reason: null,
  };
}

/** Build a response that preserves provenance while exposing no stale content. */
export function topicUnavailable(
  options: Pick<ParseSkillsTopicOptions, 'slug' | 'sourceUrl'> & { fetchedAt?: string; reason: string; status?: 'stale' | 'unavailable'; parserRevision?: string },
): SkillsTopicResponse {
  return {
    provider: 'skills.sh',
    slug: normalizeSlug(options.slug),
    status: options.status ?? 'unavailable',
    title: null,
    description: null,
    capabilities: [],
    skills: [],
    compatibleAgents: null,
    faqs: [],
    relatedTopics: [],
    sourceUrl: normalizeTopicSourceUrl(options.sourceUrl, options.slug).toString(),
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    parserRevision: options.parserRevision ?? SKILLS_TOPIC_PARSER_REVISION,
    reason: boundedReason(options.reason),
  };
}

function parseSkillLinks(section: TopicNode, sourceUrl: URL): SkillsTopicSkill[] {
  const result: SkillsTopicSkill[] = [];
  for (const anchor of descendants(section, (node) => node.tag === 'a')) {
    const href = safeSameOriginPath(anchor.attributes.href, sourceUrl, 'skill.href');
    if (!href || href.pathname.startsWith('/topic')) continue;
    const path = pathSegments(href.pathname);
    if (path.length < 2 || path.length > 64) continue;
    const heading = firstDescendant(anchor, (node) => node.tag === 'h3');
    const name = textContent(heading);
    if (!name) continue;
    const paragraphs = descendants(anchor, (node) => node.tag === 'p').map(textContent).filter(Boolean);
    const source = paragraphs[0] ?? path.slice(0, -1).join('/');
    const description = paragraphs.at(-1) ?? '';
    if (!source || !description) throw new SkillsTopicParseError('skills.entry');
    const sourceParts = safeIdentityParts(source);
    if (sourceParts.length >= path.length || path.slice(0, sourceParts.length).join('/') !== sourceParts.join('/')) {
      throw new SkillsTopicParseError('skills.identity');
    }
    const slug = path.slice(sourceParts.length).join('/');
    result.push({
      id: path.join('/'),
      name,
      source: sourceParts.join('/'),
      slug,
      description,
      url: href.toString(),
    });
  }
  return deduplicateBy(result, (skill) => skill.id);
}

function parseRelatedTopics(section: TopicNode, sourceUrl: URL, currentSlug: string): SkillsTopicLink[] {
  const result: SkillsTopicLink[] = [];
  for (const anchor of descendants(section, (node) => node.tag === 'a')) {
    const href = safeSameOriginPath(anchor.attributes.href, sourceUrl, 'related.href');
    if (!href) continue;
    const path = pathSegments(href.pathname);
    if (path.length !== 2 || path[0] !== 'topic') continue;
    const slug = path[1];
    if (!slug || slug === currentSlug) continue;
    const name = textContent(anchor);
    if (!name) throw new SkillsTopicParseError('related.entry');
    result.push({ slug, name, url: href.toString() });
  }
  return deduplicateBy(result, (topic) => topic.slug);
}

function parseFaqs(section: TopicNode): SkillsTopicFaq[] {
  const result: SkillsTopicFaq[] = [];
  for (const details of descendants(section, (node) => node.tag === 'details')) {
    const question = textContent(firstDescendant(details, (node) => node.tag === 'summary'));
    const answer = textContent(firstDescendant(details, (node) => node.tag === 'p'));
    if (!question || !answer) throw new SkillsTopicParseError('faq.entry');
    result.push({ question, answer });
  }
  if (result.length > MAX_FAQS) throw new SkillsTopicParseError('faqs');
  return result;
}

function findSectionByHeading(root: TopicNode, predicate: (heading: string) => boolean): TopicNode | undefined {
  for (const section of descendants(root, (node) => node.tag === 'section')) {
    const heading = firstDescendant(section, (node) => node.tag === 'h2');
    if (heading && predicate(textContent(heading).toLocaleLowerCase('en-US'))) return section;
  }
  return undefined;
}

function boundedTextList(nodes: TopicNode[], maximum: number, field: string): string[] {
  if (nodes.length > maximum) throw new SkillsTopicParseError(field);
  return nodes.map((node) => requiredText(node, `${field}.entry`));
}

function parseHtml(html: string): TopicDocument {
  const root: TopicNode = { tag: '#document', attributes: {}, children: [] };
  const stack: TopicNode[] = [root];
  let nodeCount = 0;
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/gu;
  for (const match of html.matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (!token.startsWith('<')) {
      if (stack.length > 1 && !isIgnoredAncestor(stack)) stack.at(-1)?.children.push(token);
      continue;
    }
    if (/^<\//u.test(token)) {
      const closeName = token.slice(2, -1).trim().toLocaleLowerCase('en-US');
      let index = -1;
      for (let candidate = stack.length - 1; candidate >= 0; candidate -= 1) {
        if (stack[candidate]?.tag === closeName) {
          index = candidate;
          break;
        }
      }
      if (index > 0) stack.length = index;
      continue;
    }
    const open = /^<\s*([A-Za-z][A-Za-z0-9:-]*)([^>]*)>$/u.exec(token);
    if (!open) continue;
    const tag = open[1].toLocaleLowerCase('en-US');
    const node: TopicNode = { tag, attributes: parseAttributes(open[2] ?? ''), children: [] };
    nodeCount += 1;
    if (nodeCount > MAX_NODES) throw new SkillsTopicParseError('document.nodes');
    if (stack.length > 0 && !isIgnoredAncestor(stack)) stack.at(-1)?.children.push(node);
    if (!voidTags.has(tag)) {
      if (stack.length >= MAX_DEPTH) throw new SkillsTopicParseError('document.depth');
      stack.push(node);
    }
  }
  return { root, nodeCount };
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([A-Za-z_:][A-Za-z0-9:._-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of value.matchAll(attributePattern)) {
    const name = match[1].toLocaleLowerCase('en-US');
    if (attributes[name] !== undefined) continue;
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function isIgnoredAncestor(stack: TopicNode[]): boolean {
  return stack.some((node) => ignoredTags.has(node.tag));
}

function descendants(root: TopicNode, predicate: (node: TopicNode) => boolean): TopicNode[] {
  const result: TopicNode[] = [];
  const pending = [...root.children].reverse();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value === 'string') continue;
    if (predicate(value)) result.push(value);
    for (let index = value.children.length - 1; index >= 0; index -= 1) pending.push(value.children[index]);
  }
  return result;
}

function firstDescendant(root: TopicNode, predicate: (node: TopicNode) => boolean): TopicNode | undefined {
  return descendants(root, predicate)[0];
}

function textContent(root: TopicNode | undefined): string {
  if (!root) return '';
  const pieces: string[] = [];
  const pending: Array<TopicNode | string> = [...root.children].reverse();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined) continue;
    if (typeof value === 'string') {
      pieces.push(decodeEntities(value));
    } else if (!ignoredTags.has(value.tag)) {
      for (let index = value.children.length - 1; index >= 0; index -= 1) pending.push(value.children[index]);
    }
  }
  return normalizeText(pieces.join(' '));
}

function requiredText(node: TopicNode | undefined, field: string): string {
  const value = textContent(node);
  if (!value || utf8Bytes(value) > MAX_TEXT_BYTES) throw new SkillsTopicParseError(field);
  return value;
}

function safeSameOriginPath(value: string | undefined, sourceUrl: URL, field: string): URL | undefined {
  if (!value || utf8Bytes(value) > MAX_URL_BYTES || /[\u0000-\u001f\u007f%]/u.test(value)) throw new SkillsTopicParseError(field);
  let url: URL;
  try {
    url = new URL(value, sourceUrl);
  } catch {
    throw new SkillsTopicParseError(field);
  }
  if (url.origin !== sourceUrl.origin || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new SkillsTopicParseError(field);
  }
  return url;
}

function pathSegments(pathname: string): string[] {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..' || /[\u0000-\u001f\u007f%\\]/u.test(part))) return [];
  return parts;
}

function safeIdentityParts(value: string): string[] {
  const parts = value.split('/');
  if (parts.length === 0 || parts.some((part) => part.length === 0 || part === '.' || part === '..' || /[\u0000-\u001f\u007f%\\]/u.test(part))) {
    throw new SkillsTopicParseError('skills.identity');
  }
  return parts;
}

function normalizeTopicSourceUrl(value: string | URL, slug: string): URL {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(value.toString());
  } catch {
    throw new SkillsTopicParseError('source-url');
  }
  const normalizedSlug = normalizeSlug(slug);
  if (
    sourceUrl.protocol !== 'https:' ||
    (sourceUrl.hostname !== 'skills.sh' && sourceUrl.hostname !== 'www.skills.sh') ||
    sourceUrl.port !== '' ||
    sourceUrl.username ||
    sourceUrl.password ||
    sourceUrl.search ||
    sourceUrl.hash
  ) {
    throw new SkillsTopicParseError('source-url');
  }
  if (sourceUrl.pathname.replace(/\/+$/u, '') !== `/topic/${normalizedSlug}`) throw new SkillsTopicParseError('source-url');
  sourceUrl.hostname = 'www.skills.sh';
  sourceUrl.pathname = `/topic/${normalizedSlug}`;
  return sourceUrl;
}

function normalizeSlug(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 128) {
    throw new SkillsTopicParseError('slug');
  }
  return value;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#[0-9]+);/giu, (entity) => {
    const lower = entity.toLocaleLowerCase('en-US');
    if (lower === '&amp;') return '&';
    if (lower === '&lt;') return '<';
    if (lower === '&gt;') return '>';
    if (lower === '&quot;') return '"';
    if (lower === '&apos;' || lower === '&#39;') return "'";
    const hex = lower.startsWith('&#x') ? Number.parseInt(lower.slice(3, -1), 16) : Number.parseInt(lower.slice(2, -1), 10);
    return Number.isSafeInteger(hex) && hex >= 0 && hex <= 0x10ffff ? String.fromCodePoint(hex) : '';
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedReason(value: string): string {
  const normalized = normalizeText(value);
  return normalized.slice(0, 512) || 'Topic metadata is unavailable.';
}

function deduplicateBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}
