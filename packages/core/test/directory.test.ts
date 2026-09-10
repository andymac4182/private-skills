import { describe, expect, it } from 'vitest';

import {
  createEmptyRegistryState,
  createRegistryHandler,
  type RegistryDirectoryClient,
  type RegistryDirectoryPackClient,
} from '../src/index.js';
import { SkillsDirectoryError } from '../../directory/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  SkillBundle,
  StateRepository,
  StoredBlob,
} from '../../contracts/src/index.js';
import type { SkillDetailResponse, SkillsTopicResponse } from '../../directory/src/index.js';

const ORIGIN = 'https://registry.example.test';

class MemoryRepository implements StateRepository {
  state: RegistryState;

  constructor() {
    this.state = createEmptyRegistryState({
      revision: 'directory-test',
      scanners: [],
      allowUnscanned: true,
      evidenceMaxAgeSeconds: 3600,
    });
  }

  async read(): Promise<RegistryState> {
    return structuredClone(this.state);
  }

  async transaction<T>(_organizationId: string, updater: (state: RegistryState) => T): Promise<T> {
    const working = structuredClone(this.state);
    const result = updater(working);
    this.state = working;
    return result;
  }
}

class MemoryBlobs implements BlobStore {
  private nextKey = 0;
  private readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const stored = { key: `directory-${this.nextKey++}`, digest: await digestBytes(copy), size: copy.byteLength };
    this.values.set(stored.key, copy);
    return stored;
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error('missing blob');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function user(): Principal & { scopes: string[] } {
  return { organizationId: 'org-directory', subject: 'publisher', roles: ['owner', 'admin', 'publisher', 'reader'], namespaces: ['@team'], scopes: ['*'] };
}

function worker(): Principal & { identity: 'worker'; scopes: string[] } {
  return { organizationId: 'org-directory', subject: 'worker', roles: ['worker'], identity: 'worker', scopes: ['jobs:claim', 'jobs:complete'] };
}

function bundle(): SkillBundle {
  return {
    format: 'pskills-bundle-v1',
    files: [{
      path: 'SKILL.md',
      content: Buffer.from('---\nname: my-skill\ndescription: Directory fixture\n---\n# my-skill\n', 'utf8').toString('base64'),
    }],
  };
}

function directoryClient(): RegistryDirectoryClient {
  return {
    async list() {
      return { data: [], pagination: { page: 0, perPage: 100, total: 0, hasMore: false } };
    },
    async search() {
      return { data: [], query: 'ab', searchType: 'fuzzy', count: 0, durationMs: 1 };
    },
    async curated() {
      return { data: [], totalOwners: 0, totalSkills: 0, generatedAt: '2026-01-01T00:00:00.000Z' };
    },
    async detail(id: string) {
      return { id, source: 'acme/repo', slug: 'my-skill', installs: 1, hash: 'snapshot-1', files: [{ path: 'SKILL.md', contents: '---\nname: my-skill\ndescription: Directory fixture\n---\n' }] };
    },
    async audit(id: string) {
      return { id, source: 'acme/repo', slug: 'my-skill', audits: [] };
    },
  };
}

describe('skills.sh directory routes', () => {
  function setup(directoryPacks?: RegistryDirectoryPackClient, directory: RegistryDirectoryClient | null = directoryClient()) {
    const repository = new MemoryRepository();
    const blobs = new MemoryBlobs();
    let current: Principal | null = user();
    const auth: Authenticator = { authenticate: async (request) => {
      if (request.headers.get('authorization') === 'Bearer worker') return worker();
      return current;
    } };
    const handler = createRegistryHandler({
      repository,
      blobs,
      auth,
      directory: directory ?? undefined,
      directoryPacks,
      config: { publicOrigin: ORIGIN, maxBodyBytes: 2 * 1024 * 1024, organizationId: 'org-directory', leaseSeconds: 30 },
    });
    return { repository, handler, setPrincipal: (principal: Principal | null) => { current = principal; } };
  }

  it('distinguishes an intentionally disconnected directory from a retryable outage', async () => {
    const test = setup(undefined, null);
    const response = await test.handler(new Request(`${ORIGIN}/v1/directory/skills`, { headers: { authorization: 'Bearer user' } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'DIRECTORY_NOT_CONFIGURED', retryable: false } });
  });

  it('returns validated directory DTOs only to authenticated readers', async () => {
    const test = setup();
    const headers = { authorization: 'Bearer user' };
    const list = await test.handler(new Request(`${ORIGIN}/v1/directory/skills?view=hot&page=2&per_page=20`, { headers }));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ pagination: { page: 0, total: 0 } });
    const detail = await test.handler(new Request(`${ORIGIN}/v1/directory/detail?id=acme%2Frepo%2Fmy-skill`, { headers }));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: 'acme/repo/my-skill', source: 'acme/repo' });
    test.setPrincipal(null);
    expect((await test.handler(new Request(`${ORIGIN}/v1/directory/official`))).status).toBe(401);
  });

  it('projects public detail to metadata while retaining full internal snapshot data for import', async () => {
    const canary = 'PRIVATE_SOURCE_CANARY_MUST_NOT_CROSS_READER_ROUTE';
    const internalDetail = {
      id: 'acme/repo/my-skill',
      source: 'acme/repo',
      slug: 'my-skill',
      installs: 7,
      hash: 'snapshot-1',
      files: [
        { path: 'SKILL.md', contents: canary },
        { path: 'README.md', contents: 'internal supporting text' },
      ],
      sourceType: 'github',
      installUrl: 'https://github.com/acme/repo',
      url: 'https://skills.sh/acme/repo/my-skill',
      unexpected: 'must not be serialized',
    } as SkillDetailResponse & Record<string, unknown>;
    let detailPayload: SkillDetailResponse = internalDetail;
    let detailCalls = 0;
    let importing = false;
    let importSawFullSnapshot = false;
    const directory: RegistryDirectoryClient = {
      ...directoryClient(),
      detail: async () => {
        detailCalls += 1;
        if (importing && detailPayload.files?.[0]?.contents === canary) importSawFullSnapshot = true;
        return detailPayload;
      },
    };
    const test = setup(undefined, directory);
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };

    const publicResponse = await test.handler(new Request(`${ORIGIN}/v1/directory/detail?id=acme%2Frepo%2Fmy-skill`, { headers }));
    expect(publicResponse.status).toBe(200);
    const publicDetail = await publicResponse.json() as Record<string, unknown> & { files?: unknown };
    expect(publicDetail).toEqual({
      id: 'acme/repo/my-skill',
      source: 'acme/repo',
      slug: 'my-skill',
      installs: 7,
      hash: 'snapshot-1',
      files: [{ path: 'SKILL.md' }, { path: 'README.md' }],
    });
    expect(JSON.stringify(publicDetail)).not.toContain(canary);
    expect(publicDetail).not.toHaveProperty('sourceType');
    expect(publicDetail).not.toHaveProperty('installUrl');
    expect(publicDetail).not.toHaveProperty('unexpected');
    expect(publicDetail.files).toEqual([{ path: 'SKILL.md' }, { path: 'README.md' }]);
    expect(internalDetail.files?.[0]?.contents).toBe(canary);

    detailPayload = { ...internalDetail, hash: null, files: null };
    const nullSnapshotResponse = await test.handler(new Request(`${ORIGIN}/v1/directory/detail?id=acme%2Frepo%2Fmy-skill`, { headers }));
    expect(nullSnapshotResponse.status).toBe(200);
    expect(await nullSnapshotResponse.json()).toEqual({
      id: 'acme/repo/my-skill',
      source: 'acme/repo',
      slug: 'my-skill',
      installs: 7,
      hash: null,
      files: null,
    });

    detailPayload = internalDetail;
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'skills-catalog', kind: 'skills-sh', namespace: '@team', repositories: ['acme/repo'], baseUrl: 'https://skills.sh' }),
    }));
    expect(upstreamResponse.status).toBe(201);
    importing = true;
    const importResponse = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'acme/repo/my-skill', name: '@team/my-skill', version: '1.0.0' }),
    }));
    expect(importResponse.status).toBe(202);
    expect(detailCalls).toBe(3);
    expect(await importResponse.json()).toMatchObject({ operation: { import: {
      path: 'acme/repo/my-skill',
      externalSnapshotHash: 'snapshot-1',
    } } });
    expect(importSawFullSnapshot).toBe(true);
    expect(internalDetail.files?.[0]?.contents).toBe(canary);
  });

  it('returns a bounded topic DTO to an authenticated reader', async () => {
    let requestedSlug: string | undefined;
    let receivedSignal: AbortSignal | undefined;
    const topic: SkillsTopicResponse = {
      provider: 'skills.sh',
      slug: 'react',
      status: 'fresh',
      title: 'React',
      description: 'React skills and workflows.',
      capabilities: ['components'],
      compatibleAgents: 'Codex and Claude',
      skills: [{ id: 'acme/repo/react-patterns', name: 'react-patterns', source: 'acme/repo', slug: 'react-patterns', description: 'React patterns.', url: 'https://skills.sh/acme/repo/react-patterns' }],
      faqs: [{ question: 'What is React?', answer: 'A UI library.' }],
      relatedTopics: [{ slug: 'nextjs', name: 'Next.js', url: 'https://skills.sh/topic/nextjs' }],
      sourceUrl: 'https://skills.sh/topic/react',
      fetchedAt: '2026-09-10T00:00:00.000Z',
      parserRevision: 'skills-sh-topic-html-v1',
      reason: null,
    };
    const directory: RegistryDirectoryClient = {
      ...directoryClient(),
      topic: async (slug, options) => {
        requestedSlug = slug;
        receivedSignal = options?.signal;
        return topic;
      },
    };
    const test = setup(undefined, directory);
    const controller = new AbortController();
    const request = new Request(`${ORIGIN}/v1/directory/topic?slug=react`, {
      signal: controller.signal,
      headers: { authorization: 'Bearer user' },
    });
    const response = await test.handler(request);
    expect(response.status).toBe(200);
    expect(requestedSlug).toBe('react');
    expect(receivedSignal).toBe(request.signal);
    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
    expect(await response.json()).toEqual(topic);

    const marketing = await test.handler(new Request(`${ORIGIN}/v1/directory/topic?slug=marketing`, {
      headers: { authorization: 'Bearer user' },
    }));
    expect(marketing.status).toBe(200);
    expect(requestedSlug).toBe('marketing');
  });

  it('bounds topic slugs and keeps topic access tenant and role scoped', async () => {
    let topicCalls = 0;
    const directory: RegistryDirectoryClient = {
      ...directoryClient(),
      topic: async (slug) => {
        topicCalls += 1;
        return {
          provider: 'skills.sh',
          slug,
          status: 'fresh',
          title: null,
          description: null,
          capabilities: [],
          compatibleAgents: null,
          skills: [],
          faqs: [],
          relatedTopics: [],
          sourceUrl: `https://skills.sh/topic/${slug}`,
          fetchedAt: '2026-09-10T00:00:00.000Z',
          parserRevision: 'skills-sh-topic-html-v1',
          reason: null,
        };
      },
    };
    const test = setup(undefined, directory);
    const invalidSlugs = ['', 'React', 'react.other', 'react_topic', 'react~topic', 'react/other', '../react', 'react?x', 'react%2Fother', ' react', 'x'.repeat(129), String.fromCharCode(0xd800)];
    for (const slug of invalidSlugs) {
      const encodedSlug = slug === String.fromCharCode(0xd800) ? '%ED%A0%80' : encodeURIComponent(slug);
      const response = await test.handler(new Request(`${ORIGIN}/v1/directory/topic?slug=${encodedSlug}`, {
        headers: { authorization: 'Bearer user' },
      }));
      expect(response.status, slug).toBe(400);
    }
    expect(topicCalls).toBe(0);

    test.setPrincipal(worker());
    expect((await test.handler(new Request(`${ORIGIN}/v1/directory/topic?slug=react`, {
      headers: { authorization: 'Bearer worker' },
    }))).status).toBe(403);
    test.setPrincipal({ ...user(), organizationId: 'other-tenant' });
    expect((await test.handler(new Request(`${ORIGIN}/v1/directory/topic?slug=react`, {
      headers: { authorization: 'Bearer user' },
    }))).status).toBe(403);
    expect(topicCalls).toBe(0);

    test.setPrincipal(user());
    const duplicate = await test.handler(new Request(`${ORIGIN}/v1/directory/topic?slug=react&slug=marketing`, {
      headers: { authorization: 'Bearer user' },
    }));
    expect(duplicate.status).toBe(400);
    expect(topicCalls).toBe(0);
  });

  it('maps topic client outages through the directory error boundary', async () => {
    const test = setup(undefined, {
      ...directoryClient(),
      topic: async () => {
        throw new SkillsDirectoryError('unavailable', 'credential details must stay private');
      },
    });
    const response = await test.handler(new Request(`${ORIGIN}/v1/directory/topic?slug=react`, {
      headers: { authorization: 'Bearer user' },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'DIRECTORY_UNAVAILABLE', message: 'The skills.sh directory is temporarily unavailable' } });
  });

  it('queues a governed import, retains external identity, and warms by the exact identity', async () => {
    const test = setup();
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'skills-catalog', kind: 'skills-sh', namespace: '@team', repositories: ['acme/repo'], baseUrl: 'https://skills.sh' }),
    }));
    expect(upstreamResponse.status).toBe(201);

    const requestBody = { id: 'acme/repo/my-skill', name: '@team/my-skill', version: '1.0.0' };
    const queued = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST', headers, body: JSON.stringify(requestBody),
    }));
    expect(queued.status).toBe(202);
    const operation = (await queued.json() as { operation: { id: string; import: Record<string, unknown> } }).operation;
    expect(operation.import).toMatchObject({ path: 'acme/repo/my-skill', externalId: 'acme/repo/my-skill', externalSnapshotHash: 'snapshot-1' });

    test.setPrincipal(worker());
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST', headers: { authorization: 'Bearer worker' } }));
    const job = (await claim.json() as { job: { id: string; leaseToken: string } }).job;
    const imported = bundle();
    const artifactDigest = await digestBytes(encodeBundle(imported));
    const complete = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST', headers: { ...headers, authorization: 'Bearer worker' },
      body: JSON.stringify({
        leaseToken: job.leaseToken,
        artifactDigest,
        bundle: imported,
        provenance: {
          kind: 'skills-sh', upstreamId: operation.import.upstreamId, repository: 'acme/repo',
          path: 'acme/repo/my-skill', revision: 'snapshot-1', externalId: 'acme/repo/my-skill',
          externalSourceType: 'github', externalSnapshotHash: 'snapshot-1',
        },
      }),
    }));
    expect(complete.status).toBe(200);

    test.setPrincipal(user());
    const warm = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST', headers, body: JSON.stringify(requestBody),
    }));
    expect(warm.status).toBe(200);
    expect(await warm.json()).toHaveProperty('resolution.digest', artifactDigest);
  });

  it('accepts nested catalog slugs but rejects unsafe identity segments', async () => {
    const id = 'claude-office-skills/skills/facebook/meta-ads';
    let detailCalls = 0;
    const directory: RegistryDirectoryClient = {
      ...directoryClient(),
      detail: async (requestedId) => {
        detailCalls += 1;
        return {
          id: requestedId,
          source: 'claude-office-skills/skills',
          slug: 'facebook/meta-ads',
          installs: 1,
          hash: 'snapshot-nested',
          files: [{ path: 'SKILL.md', contents: '---\nname: meta-ads\ndescription: Nested directory fixture\n---\n' }],
        };
      },
    };
    const test = setup(undefined, directory);
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'nested-catalog', kind: 'skills-sh', namespace: '@team', repositories: ['claude-office-skills/skills'], baseUrl: 'https://skills.sh' }),
    }));
    expect(upstreamResponse.status).toBe(201);

    const queued = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST', headers,
      body: JSON.stringify({ id, name: '@team/meta-ads', version: '1.0.0' }),
    }));
    expect(queued.status).toBe(202);
    expect(detailCalls).toBe(1);
    const { operation } = await queued.json() as { operation: { import: Record<string, unknown> } };
    expect(operation.import).toMatchObject({
      path: id,
      externalId: id,
      repository: 'claude-office-skills/skills',
    });

    const traversal = await test.handler(new Request(`${ORIGIN}/v1/directory/detail?id=claude-office-skills%2Fskills%2Ffacebook%2F..%2Fmeta-ads`, {
      headers,
    }));
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toHaveProperty('error.code', 'INVALID_REQUEST');
  });

  it('preflights generic skills.sh imports with the bounded Unicode-safe ID rules', async () => {
    const test = setup();
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: 'generic-skills-catalog',
        kind: 'skills-sh',
        namespace: '@team',
        repositories: ['claude-office-skills/skills'],
        baseUrl: 'https://skills.sh',
      }),
    }));
    expect(upstreamResponse.status).toBe(201);
    const upstreamId = (await upstreamResponse.json() as { upstream: { id: string } }).upstream.id;
    const valid = {
      upstreamId,
      repository: 'claude-office-skills/skills',
      path: 'claude-office-skills/skills/facebook/meta-ads',
      externalId: 'claude-office-skills/skills/facebook/meta-ads',
      name: '@team/meta-ads',
      version: '1.0.0',
    };
    const queued = await test.handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST', headers, body: JSON.stringify(valid),
    }));
    expect(queued.status).toBe(202);
    expect(await queued.json()).toHaveProperty('operation.import.path', valid.path);
    expect((await test.repository.read()).jobs).toHaveLength(1);

    const invalid = [
      { label: 'traversal', path: 'claude-office-skills/skills/facebook/../meta-ads' },
      { label: 'surrogate', path: `claude-office-skills/skills/facebook/${String.fromCharCode(0xd800)}` },
      { label: 'oversized segment', path: `claude-office-skills/skills/${'x'.repeat(513)}` },
      { label: 'too many segments', path: Array.from({ length: 65 }, () => 'x').join('/') },
      { label: 'oversized ID', path: Array.from({ length: 4 }, () => 'x'.repeat(512)).join('/') },
      { label: 'encoded delimiter', path: 'claude-office-skills/skills/facebook/meta%2Fads' },
    ];
    for (const candidate of invalid) {
      const response = await test.handler(new Request(`${ORIGIN}/v1/imports`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...valid,
          path: candidate.path,
          externalId: candidate.path,
          name: `@team/${candidate.label.replace(/\s+/gu, '-')}`,
        }),
      }));
      expect(response.status, candidate.label).toBe(400);
    }
    expect((await test.repository.read()).jobs).toHaveLength(1);
  });

  it('does not silently choose between multiple authorized source mappings', async () => {
    const test = setup();
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    for (const name of ['first-catalog', 'second-catalog']) {
      const response = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
        method: 'POST', headers,
        body: JSON.stringify({ name, kind: 'skills-sh', namespace: '@team', repositories: ['acme/repo'], baseUrl: 'https://skills.sh' }),
      }));
      expect(response.status).toBe(201);
    }
    const response = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: 'acme/repo/my-skill', name: '@team/my-skill', version: '1.0.0' }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toHaveProperty('error.code', 'UPSTREAM_MAPPING_REQUIRED');
  });

  it('checks the selected source mapping before null-snapshot catalog lookup', async () => {
    const cases = [
      {
        label: 'denied-source',
        repositories: ['other/repo'],
        mappingNames: ['denied-source'],
        status: 404,
        code: 'NOT_AVAILABLE',
      },
      {
        label: 'ambiguous-source',
        repositories: ['acme/repo'],
        mappingNames: ['first-source', 'second-source'],
        status: 409,
        code: 'UPSTREAM_MAPPING_REQUIRED',
      },
    ] as const;

    for (const candidate of cases) {
      const id = `acme/repo/${candidate.label}`;
      let metadataCalls = 0;
      const directory: RegistryDirectoryClient = {
        ...directoryClient(),
        detail: async () => ({ id, source: 'acme/repo', slug: candidate.label, installs: 1, hash: null, files: null }),
        search: async () => {
          metadataCalls += 1;
          return { data: [], query: candidate.label, searchType: 'fuzzy' as const, count: 0, durationMs: 1 };
        },
        list: async () => {
          metadataCalls += 1;
          return { data: [], pagination: { page: 0, perPage: 500, total: 0, hasMore: false } };
        },
      };
      const test = setup(undefined, directory);
      const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
      for (const name of candidate.mappingNames) {
        const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
          method: 'POST', headers,
          body: JSON.stringify({ name, kind: 'skills-sh', namespace: '@team', repositories: candidate.repositories, baseUrl: 'https://skills.sh' }),
        }));
        expect(upstreamResponse.status, candidate.label).toBe(201);
      }

      const response = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
        method: 'POST', headers,
        body: JSON.stringify({ id, name: `@team/${candidate.label}`, version: '1.0.0' }),
      }));
      expect(response.status, candidate.label).toBe(candidate.status);
      expect(await response.json()).toHaveProperty('error.code', candidate.code);
      expect(metadataCalls, candidate.label).toBe(0);
      expect((await test.repository.read()).jobs, candidate.label).toHaveLength(0);
    }
  });

  it('rejects duplicate catalog identities instead of selecting one metadata row', async () => {
    for (const conflicting of [false, true]) {
      const suffix = conflicting ? 'conflicting' : 'exact';
      const id = `acme/repo/duplicate-${suffix}`;
      const row = {
        id,
        slug: `duplicate-${suffix}`,
        name: `duplicate-${suffix}`,
        source: 'acme/repo',
        installs: 1,
        sourceType: 'github' as const,
        installUrl: 'https://github.com/acme/repo',
        url: `https://skills.sh/${id}`,
      };
      const duplicate = conflicting
        ? { ...row, sourceType: 'well-known' as const, installUrl: 'https://example.test/.well-known/agent-skills/duplicate' }
        : { ...row };
      let searchCalls = 0;
      let listCalls = 0;
      const directory: RegistryDirectoryClient = {
        ...directoryClient(),
        detail: async () => ({ id, source: 'acme/repo', slug: `duplicate-${suffix}`, installs: 1, hash: null, files: null }),
        search: async (options) => {
          searchCalls += 1;
          return { data: [row, duplicate], query: options.q, searchType: 'fuzzy' as const, count: 2, durationMs: 1 };
        },
        list: async () => {
          listCalls += 1;
          return { data: [], pagination: { page: 0, perPage: 500, total: 0, hasMore: false } };
        },
      };
      const test = setup(undefined, directory);
      const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
      const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: `duplicate-${suffix}`, kind: 'skills-sh', namespace: '@team', repositories: ['acme/repo'], baseUrl: 'https://skills.sh' }),
      }));
      expect(upstreamResponse.status, suffix).toBe(201);

      const response = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
        method: 'POST', headers,
        body: JSON.stringify({ id, name: `@team/duplicate-${suffix}`, version: '1.0.0' }),
      }));
      expect(response.status, suffix).toBe(502);
      expect(await response.json()).toHaveProperty('error.code', 'DIRECTORY_INTEGRITY');
      expect(searchCalls, suffix).toBe(1);
      expect(listCalls, suffix).toBe(0);
      expect((await test.repository.read()).jobs, suffix).toHaveLength(0);
    }
  });

  it('requires an exact catalog row to trust source type when the snapshot hash is null', async () => {
    const id = 'acme/repo/no-snapshot';
    const trustedRow = {
      id,
      slug: 'no-snapshot',
      name: 'no-snapshot',
      source: 'acme/repo',
      installs: 1,
      sourceType: 'github' as const,
      installUrl: 'https://github.com/acme/repo/tree/main/skills/no-snapshot',
      url: 'https://skills.sh/acme/repo/no-snapshot',
    };
    let searchCalls = 0;
    const directory: RegistryDirectoryClient = {
      ...directoryClient(),
      detail: async () => ({ id, source: 'acme/repo', slug: 'no-snapshot', installs: 1, hash: null, files: null }),
      search: async (options) => {
        searchCalls += 1;
        expect(options.q).toBe('no-snapshot');
        expect(options.owner).toBe('acme');
        return { data: [trustedRow], query: options.q, searchType: 'fuzzy' as const, count: 1, durationMs: 1 };
      },
    };
    const test = setup(undefined, directory);
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'skills-catalog', kind: 'skills-sh', namespace: '@team', repositories: ['acme/repo'], baseUrl: 'https://skills.sh' }),
    }));
    expect(upstreamResponse.status).toBe(201);
    const queued = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST', headers,
      body: JSON.stringify({ id, name: '@team/no-snapshot', version: '1.0.0' }),
    }));
    expect(queued.status).toBe(202);
    expect(searchCalls).toBe(1);
    const { operation } = await queued.json() as { operation: { import: Record<string, unknown> } };
    expect(operation.import).toMatchObject({
      path: id,
      externalId: id,
      externalSnapshotHash: null,
      externalSourceType: 'github',
    });
  });

  it('resolves source type when files are missing and preserves the snapshot hash', async () => {
    const id = 'acme/repo/missing-files';
    const trustedRow = {
      id,
      slug: 'missing-files',
      name: 'missing-files',
      source: 'acme/repo',
      installs: 1,
      sourceType: 'well-known' as const,
      installUrl: 'https://example.test/.well-known/agent-skills/missing-files',
      url: 'https://skills.sh/acme/repo/missing-files',
    };
    let searchCalls = 0;
    const directory: RegistryDirectoryClient = {
      ...directoryClient(),
      detail: async () => ({ id, source: 'acme/repo', slug: 'missing-files', installs: 1, hash: 'snapshot-2', files: null }),
      search: async (options) => {
        searchCalls += 1;
        expect(options.q).toBe('missing-files');
        expect(options.owner).toBe('acme');
        return { data: [trustedRow], query: options.q, searchType: 'fuzzy' as const, count: 1, durationMs: 1 };
      },
      list: async () => { throw new Error('list fallback should not be needed'); },
    };
    const test = setup(undefined, directory);
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'skills-catalog', kind: 'skills-sh', namespace: '@team', repositories: ['acme/repo'], baseUrl: 'https://skills.sh' }),
    }));
    expect(upstreamResponse.status).toBe(201);
    const queued = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST', headers,
      body: JSON.stringify({ id, name: '@team/missing-files', version: '1.0.0' }),
    }));
    expect(queued.status).toBe(202);
    expect(searchCalls).toBe(1);
    const { operation } = await queued.json() as { operation: { import: Record<string, unknown> } };
    expect(operation.import).toMatchObject({
      path: id,
      externalId: id,
      externalSnapshotHash: 'snapshot-2',
      externalSourceType: 'well-known',
    });
  });

  it('fails closed when null-snapshot catalog metadata has no exact source row', async () => {
    const id = 'acme/repo/unknown-source';
    const directory: RegistryDirectoryClient = {
      ...directoryClient(),
      detail: async () => ({ id, source: 'acme/repo', slug: 'unknown-source', installs: 1, hash: null, files: null }),
      search: async () => ({ data: [], query: 'unknown-source', searchType: 'fuzzy', count: 0, durationMs: 1 }),
      list: async () => ({ data: [], pagination: { page: 0, perPage: 500, total: 0, hasMore: false } }),
    };
    const test = setup(undefined, directory);
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'skills-catalog', kind: 'skills-sh', namespace: '@team', repositories: ['acme/repo'], baseUrl: 'https://skills.sh' }),
    }));
    expect(upstreamResponse.status).toBe(201);
    const failed = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST', headers,
      body: JSON.stringify({ id, name: '@team/unknown-source', version: '1.0.0' }),
    }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toHaveProperty('error.code', 'DIRECTORY_INTEGRITY');
    expect((await test.repository.read()).jobs).toHaveLength(0);
  });

  it('walks the bounded catalog pages when search misses a null-snapshot row', async () => {
    const id = 'acme/repo/page-fallback';
    const row = {
      id,
      slug: 'page-fallback',
      name: 'page-fallback',
      source: 'acme/repo',
      installs: 1,
      sourceType: 'well-known' as const,
      installUrl: 'https://example.test/.well-known/agent-skills/page-fallback',
      url: 'https://skills.sh/acme/repo/page-fallback',
    };
    const pages: number[] = [];
    const directory: RegistryDirectoryClient = {
      ...directoryClient(),
      detail: async () => ({ id, source: 'acme/repo', slug: 'page-fallback', installs: 1, hash: null, files: null }),
      search: async () => ({ data: [], query: 'page-fallback', searchType: 'fuzzy', count: 0, durationMs: 1 }),
      list: async (options) => {
        pages.push(options?.page ?? 0);
        const page = options?.page ?? 0;
        return page < 19
          ? { data: [], pagination: { page, perPage: 500, total: 9735, hasMore: true } }
          : { data: [row], pagination: { page, perPage: 500, total: 9735, hasMore: false } };
      },
    };
    const test = setup(undefined, directory);
    const headers = { authorization: 'Bearer user', 'content-type': 'application/json' };
    const upstreamResponse = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'skills-catalog', kind: 'skills-sh', namespace: '@team', repositories: ['acme/repo'], baseUrl: 'https://skills.sh' }),
    }));
    expect(upstreamResponse.status).toBe(201);
    const queued = await test.handler(new Request(`${ORIGIN}/v1/directory/import`, {
      method: 'POST', headers,
      body: JSON.stringify({ id, name: '@team/page-fallback', version: '1.0.0' }),
    }));
    expect(queued.status).toBe(202);
    expect(pages).toEqual(Array.from({ length: 20 }, (_, page) => page));
    const { operation } = await queued.json() as { operation: { import: Record<string, unknown> } };
    expect(operation.import).toMatchObject({ externalSourceType: 'well-known', externalSnapshotHash: null });
  });

  it('previews a scoped skills.sh pack through an injected metadata client', async () => {
    let inspected: string | undefined;
    const pack = {
      packUrl: 'https://skills.sh/p/demo',
      manifestUrl: 'https://skills.sh/p/demo/.well-known/agent-skills/index.json',
      schema: '0.2.0' as const,
      manifestDigest: `sha256:${'1'.repeat(64)}` as `sha256:${string}`,
      members: [],
    };
    const directoryPacks: RegistryDirectoryPackClient = {
      inspect: async (url) => {
        inspected = url.toString();
        return pack;
      },
    };
    const test = setup(directoryPacks);
    const response = await test.handler(new Request(`${ORIGIN}/v1/directory/packs/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer user', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://skills.sh/p/demo' }),
    }));
    expect(response.status).toBe(200);
    expect(inspected).toBe('https://skills.sh/p/demo');
    expect(await response.json()).toEqual(pack);
  });

  it('requires a reader and rejects pack URLs outside the scoped skills.sh origin', async () => {
    let inspected = false;
    const directoryPacks: RegistryDirectoryPackClient = {
      inspect: async () => {
        inspected = true;
        return {
          packUrl: 'https://skills.sh/p/demo',
          manifestUrl: 'https://skills.sh/p/demo/.well-known/agent-skills/index.json',
          schema: '0.2.0',
          manifestDigest: `sha256:${'1'.repeat(64)}`,
          members: [],
        };
      },
    };
    const test = setup(directoryPacks);
    test.setPrincipal(null);
    const unauthenticated = await test.handler(new Request(`${ORIGIN}/v1/directory/packs/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://skills.sh/p/demo' }),
    }));
    expect(unauthenticated.status).toBe(401);

    test.setPrincipal(user());
    const invalid = await test.handler(new Request(`${ORIGIN}/v1/directory/packs/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer user', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://evil.example/p/demo' }),
    }));
    expect(invalid.status).toBe(400);
    expect(inspected).toBe(false);
  });
});
