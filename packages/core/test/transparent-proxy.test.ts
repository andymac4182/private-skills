import { describe, expect, it } from 'vitest';

import {
  createMemoryStateRepository,
  defaultRegistryState,
} from '../../database/src/index.js';
import {
  createRegistryHandler,
  type RegistryDirectoryClient,
} from '../src/index.js';
import type {
  SkillDetailResponse,
  SkillListResponse,
  SkillSearchResponse,
} from '../../directory/src/index.js';
import { SkillsDirectoryError } from '../../directory/src/index.js';
import {
  digestBytes,
  encodeBundle,
} from '../../storage/src/index.js';
import type {
  Authenticator,
  Feed,
  Principal,
  RecoverableBlobStore,
  RegistryConfiguration,
  SkillBundle,
  StorageObjectInspection,
  StoredBlob,
  UpstreamRequestObserver,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION_ID = 'org-transparent';
const EXTERNAL_ID = 'acme/repo/my-skill';
const SOURCE = 'acme/repo';
const CUSTOM_BASE = 'https://gateway.example.test/catalog';

const OWNER: Principal & { scopes: string[] } = {
  organizationId: ORGANIZATION_ID,
  subject: 'owner',
  roles: ['owner', 'admin', 'publisher', 'reader'],
  namespaces: ['@team', '@other'],
  scopes: ['*'],
};

const READER: Principal & { scopes: string[] } = {
  organizationId: ORGANIZATION_ID,
  subject: 'reader',
  roles: ['reader'],
  namespaces: ['@team'],
  scopes: ['registry:read', 'proxy:resolve'],
};

const ADMIN_WITHOUT_DIAGNOSTICS: Principal & { scopes: string[] } = {
  organizationId: ORGANIZATION_ID,
  subject: 'admin-without-diagnostics',
  roles: ['admin', 'reader'],
  namespaces: ['@team'],
  scopes: ['registry:read', 'proxy:resolve'],
};

const READ_ONLY_READER: Principal & { scopes: string[] } = {
  organizationId: ORGANIZATION_ID,
  subject: 'read-only',
  roles: ['reader'],
  namespaces: ['@team'],
  scopes: ['registry:read'],
};

const PUBLISHER: Principal & { scopes: string[] } = {
  organizationId: ORGANIZATION_ID,
  subject: 'publisher',
  roles: ['publisher', 'reader'],
  namespaces: ['@team'],
  scopes: ['registry:read', 'proxy:resolve', 'imports:create', 'skills:publish'],
};

const WORKER: Principal & { identity: 'worker'; scopes: string[] } = {
  organizationId: ORGANIZATION_ID,
  subject: 'worker',
  roles: ['worker'],
  identity: 'worker',
  scopes: ['jobs:claim', 'jobs:complete'],
};

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function fixtureBundle(): SkillBundle {
  return {
    format: 'pskills-bundle-v1',
    files: [{
      path: 'SKILL.md',
      content: Buffer.from(
        '---\nname: my-skill\ndescription: transparent proxy fixture\n---\n# my-skill\n',
        'utf8',
      ).toString('base64'),
    }],
  };
}

class MemoryBlobs implements RecoverableBlobStore {
  private sequence = 0;
  private readonly values = new Map<string, Uint8Array>();
  // The fixture writes synchronously; retain an explicit terminal fact rather
  // than inferring provider finality from the object's current presence.
  private readonly terminatedWrites = new Set<string>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.putAtKey(this.allocateObjectKey(), bytes);
  }

  allocateObjectKey(): string {
    return `transparent-${this.sequence++}`;
  }

  async putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const stored: StoredBlob = {
      key,
      digest: await digestBytes(copy),
      size: copy.byteLength,
    };
    this.values.set(stored.key, copy);
    this.terminatedWrites.add(stored.key);
    return stored;
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error(`missing blob ${key}`);
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    const bytes = this.values.get(key);
    if (!bytes) return { state: 'absent', key };
    return { state: 'present', key, digest: await digestBytes(bytes), size: bytes.byteLength };
  }

  async confirmWriteTerminated(key: string): Promise<boolean> {
    return this.terminatedWrites.has(key);
  }
}

class DirectoryFixture implements RegistryDirectoryClient {
  detailCalls = 0;
  listCalls = 0;
  searchCalls = 0;
  source = SOURCE;
  slug = 'my-skill';
  sourceType: 'github' | 'well-known' = 'github';
  hash: string | null = 'snapshot-1';
  files: SkillDetailResponse['files'] = [{
    path: 'SKILL.md',
    contents: '---\nname: my-skill\ndescription: directory snapshot\n---\n',
  }];

  constructor(options: { source?: string; slug?: string; sourceType?: 'github' | 'well-known' } = {}) {
    if (options.source !== undefined) this.source = options.source;
    if (options.slug !== undefined) this.slug = options.slug;
    if (options.sourceType !== undefined) this.sourceType = options.sourceType;
  }

  get externalId(): string {
    return `${this.source}/${this.slug}`;
  }

  private row() {
    return {
      id: this.externalId,
      slug: this.slug,
      name: this.slug,
      source: this.source,
      installs: 1,
      sourceType: this.sourceType,
      installUrl: 'https://github.com/acme/repo/tree/main/skills/my-skill',
      url: `https://skills.sh/site/${this.externalId}`,
    };
  }

  async list(options: { upstreamObserver?: UpstreamRequestObserver } = {}): Promise<SkillListResponse> {
    this.listCalls += 1;
    options.upstreamObserver?.record('catalog');
    return {
      data: [this.row()],
      pagination: { page: 0, perPage: 100, total: 1, hasMore: false },
    };
  }

  async search(options: { q: string; upstreamObserver?: UpstreamRequestObserver }): Promise<SkillSearchResponse> {
    this.searchCalls += 1;
    options.upstreamObserver?.record('catalog');
    return {
      data: [this.row()],
      query: options.q,
      searchType: 'fuzzy',
      count: 1,
      durationMs: 1,
    };
  }

  async curated() {
    return { data: [], totalOwners: 0, totalSkills: 0, generatedAt: '2026-01-01T00:00:00.000Z' };
  }

  async detail(id: string, options: { upstreamObserver?: UpstreamRequestObserver } = {}): Promise<SkillDetailResponse> {
    this.detailCalls += 1;
    options.upstreamObserver?.record('catalog');
    return {
      id,
      source: this.source,
      slug: this.slug,
      installs: 1,
      hash: this.hash,
      files: this.files,
    };
  }

  async audit(id: string) {
    return { id, source: SOURCE, slug: 'my-skill', audits: [] };
  }
}

function setup(options: {
  source?: string;
  slug?: string;
  sourceType?: 'github' | 'well-known';
  allowLoopbackUpstreams?: boolean;
  trustedSkillsShBaseUrls?: readonly string[];
  directoryBindings?: ReadonlyMap<string, RegistryDirectoryClient>;
} = {}) {
  const repository = createMemoryStateRepository({
    stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true }),
  });
  const blobs = new MemoryBlobs();
  const directory = new DirectoryFixture(options);
  const principals = new Map<string, Principal>([
    ['owner', OWNER],
    ['reader', READER],
    ['admin-without-diagnostics', ADMIN_WITHOUT_DIAGNOSTICS],
    ['read-only', READ_ONLY_READER],
    ['publisher', PUBLISHER],
    ['worker', WORKER],
  ]);
  const auth: Authenticator = {
    authenticate: async (request) => principals.get((request.headers.get('authorization') ?? '').replace('Bearer ', '')) ?? null,
  };
  const config: RegistryConfiguration = {
    publicOrigin: ORIGIN,
    maxBodyBytes: 2 * 1024 * 1024,
    organizationId: ORGANIZATION_ID,
    leaseSeconds: 60,
    ...(options.allowLoopbackUpstreams === undefined ? {} : { allowLoopbackUpstreams: options.allowLoopbackUpstreams }),
    ...(options.trustedSkillsShBaseUrls === undefined ? {} : { trustedSkillsShBaseUrls: options.trustedSkillsShBaseUrls }),
  };
  const directoryForBaseCalls: string[] = [];
  const directoryForBase = (baseUrl: string): RegistryDirectoryClient | undefined => {
    directoryForBaseCalls.push(baseUrl);
    if (options.directoryBindings?.has(baseUrl)) return options.directoryBindings.get(baseUrl);
    if (baseUrl === 'https://skills.sh') return directory;
    if (options.allowLoopbackUpstreams && baseUrl === 'http://127.0.0.1:4317/catalog') return directory;
    return undefined;
  };
  const handler = createRegistryHandler({ repository, blobs, auth, directory, directoryForBase, config });
  return { repository, blobs, directory, directoryForBaseCalls, auth, config, handler };
}

async function createFeed(
  test: ReturnType<typeof setup>,
  overrides: Record<string, unknown> = {},
): Promise<Feed> {
  const response = await test.handler(new Request(`${ORIGIN}/v1/feeds`, {
    method: 'POST',
    headers: headers('owner'),
    body: JSON.stringify({
      name: 'catalog',
      kind: 'skills-sh',
      namespace: '@team',
      repositories: [test.directory.source],
      baseUrl: 'https://skills.sh',
      ...overrides,
    }),
  }));
  expect(response.status).toBe(201);
  return (await response.json() as { feed: Feed }).feed;
}

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function claimJob(test: ReturnType<typeof setup>): Promise<{ id: string; leaseToken: string }> {
  const response = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, {
    method: 'POST',
    headers: headers('worker'),
  }));
  expect(response.status).toBe(200);
  return (await responseJson<{ job: { id: string; leaseToken: string } }>(response)).job;
}

async function completeSnapshot(
  test: ReturnType<typeof setup>,
  job: { id: string; leaseToken: string },
  options: {
    revision?: string;
    sourceResolutionKind?: 'snapshot' | 'github' | 'well-known';
    sourceProviderOrigin?: string;
    sourceUrl?: string;
    wellKnownIndexUrl?: string;
    skillPath?: string;
    wellKnownEntryName?: string;
    resolvedCommit?: string;
    externalDigest?: string;
    externalSourceType?: 'github' | 'well-known';
  } = {},
): Promise<Response> {
  const imported = fixtureBundle();
  const artifactDigest = await digestBytes(encodeBundle(imported));
  const response = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
    method: 'POST',
    headers: headers('worker'),
    body: JSON.stringify({
      leaseToken: job.leaseToken,
      artifactDigest,
      bundle: imported,
      provenance: {
        kind: 'skills-sh',
        upstreamId: (await test.repository.read(ORGANIZATION_ID)).jobs.find((candidate) => candidate.id === job.id)?.import?.upstreamId,
        repository: test.directory.source,
        path: test.directory.externalId,
        revision: options.revision ?? 'snapshot-1',
        externalId: test.directory.externalId,
        source: test.directory.source,
        slug: test.directory.slug,
        externalSourceType: options.externalSourceType ?? 'github',
        externalSnapshotHash: test.directory.hash,
        sourceResolutionKind: options.sourceResolutionKind ?? 'snapshot',
        sourceProviderOrigin: options.sourceProviderOrigin ?? 'https://skills.sh',
        ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
        ...(options.wellKnownIndexUrl ? { wellKnownIndexUrl: options.wellKnownIndexUrl } : {}),
        ...(options.skillPath === undefined ? {} : { skillPath: options.skillPath }),
        ...(options.wellKnownEntryName ? { wellKnownEntryName: options.wellKnownEntryName } : {}),
        ...(options.resolvedCommit ? { resolvedCommit: options.resolvedCommit } : {}),
        ...(options.externalDigest ? { externalDigest: options.externalDigest } : {}),
        sourceDigest: artifactDigest,
      },
    }),
  }));
  return response;
}

describe('transparent directory pull-through', () => {
  it('keeps metadata reads side-effect free and requires proxy scope for a reader install', async () => {
    const test = setup();
    await createFeed(test);

    const denied = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('read-only'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(denied.status).toBe(403);
    expect(test.directory.detailCalls).toBe(0);
    expect((await test.repository.read(ORGANIZATION_ID)).jobs).toHaveLength(0);

    const queued = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(queued.status).toBe(202);
    expect(test.directory.detailCalls).toBe(1);
    expect(await queued.json()).toMatchObject({
      feed: 'catalog',
      externalId: EXTERNAL_ID,
      operation: { id: expect.any(String) },
    });
    expect((await test.repository.read(ORGANIZATION_ID)).jobs).toHaveLength(1);
  });

  it('recovers a nested detail route for transparent resolve from a fresh exact row', async () => {
    const nested = new DirectoryFixture({
      source: 'claude-office-skills/skills',
      slug: 'facebook/meta-ads',
    });
    const nestedClient = nested as RegistryDirectoryClient;
    let detailCalls = 0;
    let exactCalls = 0;
    nestedClient.detail = async () => {
      detailCalls += 1;
      // This is the adapter's signal for a validated detail body whose full
      // identity differed from the requested nested ID.
      throw new SkillsDirectoryError('invalid_response', 'normalized detail identity mismatch', {
        detailIdentityMismatch: true,
      });
    };
    nestedClient.findExact = async (id) => {
      exactCalls += 1;
      return {
        id,
        slug: 'facebook/meta-ads',
        name: 'meta-ads',
        source: 'claude-office-skills/skills',
        installs: 1,
        sourceType: 'github',
        installUrl: 'https://github.com/claude-office-skills/skills',
        url: `https://skills.sh/${id}`,
      };
    };
    const test = setup({
      directoryBindings: new Map([['https://skills.sh', nestedClient]]),
    });
    await createFeed(test, {
      repositories: ['claude-office-skills/skills'],
    });

    const response = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: nested.externalId }),
    }));
    expect(response.status).toBe(202);
    expect(detailCalls).toBe(1);
    expect(exactCalls).toBe(1);
    expect((await test.repository.read(ORGANIZATION_ID)).jobs[0]?.import).toMatchObject({
      path: nested.externalId,
      externalId: nested.externalId,
      repository: 'claude-office-skills/skills',
      externalSourceType: 'github',
      externalSnapshotHash: null,
    });
  });

  it('keeps legacy explicit imports publisher-only', async () => {
    const test = setup();
    const upstream = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers: headers('owner'),
      body: JSON.stringify({ name: 'legacy', kind: 'registry', namespace: '@team', baseUrl: 'https://offline.example' }),
    }));
    expect(upstream.status).toBe(201);
    const upstreamId = (await responseJson<{ upstream: { id: string } }>(upstream)).upstream.id;
    const body = {
      upstreamId,
      repository: 'https://offline.example',
      path: 'skills/my-skill',
      name: '@team/my-skill',
      version: '1.0.0',
    };

    const readerAttempt = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify(body),
    }));
    expect(readerAttempt.status).toBe(403);
    expect(test.directory.detailCalls).toBe(0);

    const publisherAttempt = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('publisher'),
      body: JSON.stringify(body),
    }));
    expect(publisherAttempt.status).toBe(202);
  });

  it('rejects disabled and unknown feeds before contacting the directory', async () => {
    const test = setup();
    await createFeed(test, { name: 'disabled', enabled: false });
    await createFeed(test, { name: 'catalog' });

    const disabled = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'disabled', externalId: EXTERNAL_ID }),
    }));
    expect(disabled.status).toBe(409);
    expect(await responseJson<{ error: { code: string } }>(disabled)).toHaveProperty('error.code', 'FEED_DISABLED');
    expect(test.directory.detailCalls).toBe(0);

    const unknown = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'missing', externalId: EXTERNAL_ID }),
    }));
    expect(unknown.status).toBe(404);
    expect(await responseJson<{ error: { code: string } }>(unknown)).toHaveProperty('error.code', 'FEED_NOT_FOUND');
    expect(test.directory.detailCalls).toBe(0);
    expect(test.directoryForBaseCalls).toEqual([]);

    await createFeed(test, { name: 'private', namespace: '@other' });
    const crossFeed = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'private', externalId: EXTERNAL_ID }),
    }));
    expect(crossFeed.status).toBe(403);
    expect(await responseJson<{ error: { code: string } }>(crossFeed)).toHaveProperty('error.code', 'FORBIDDEN');
    expect(test.directoryForBaseCalls).toEqual([]);
  });

  it('coalesces cold requests with isolated diagnostics and serves a warm snapshot without a directory call', async () => {
    const test = setup();
    await createFeed(test);
    const body = JSON.stringify({ externalId: EXTERNAL_ID });
    const [first, second] = await Promise.all([
      test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, { method: 'POST', headers: headers('owner'), body })),
      test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, { method: 'POST', headers: headers('owner'), body })),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await responseJson<{ operation: { id: string }; diagnostics: { upstreamRequests: { catalog: number; source: number }; queuedJobsCreated: number; overflow: boolean } }>(first);
    const secondBody = await responseJson<{ operation: { id: string }; diagnostics: { upstreamRequests: { catalog: number; source: number }; queuedJobsCreated: number; overflow: boolean } }>(second);
    const firstOperation = firstBody.operation.id;
    const secondOperation = secondBody.operation.id;
    expect(secondOperation).toBe(firstOperation);
    expect(firstBody.diagnostics).toMatchObject({
      upstreamRequests: { catalog: 1, source: 0 },
      overflow: false,
    });
    expect(secondBody.diagnostics).toMatchObject({
      upstreamRequests: { catalog: 1, source: 0 },
      overflow: false,
    });
    expect(firstBody.diagnostics.queuedJobsCreated + secondBody.diagnostics.queuedJobsCreated).toBe(1);
    expect([firstBody.diagnostics.queuedJobsCreated, secondBody.diagnostics.queuedJobsCreated].sort()).toEqual([0, 1]);
    expect((await test.repository.read(ORGANIZATION_ID)).jobs.filter((job) => job.kind === 'import')).toHaveLength(1);

    const job = await claimJob(test);
    expect((await completeSnapshot(test, job)).status).toBe(200);
    test.directory.detailCalls = 0;
    const warm = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body,
    }));
    expect(warm.status).toBe(200);
    expect(test.directory.detailCalls).toBe(0);
    expect(test.directoryForBaseCalls).toHaveLength(2);
    expect(await warm.json()).toHaveProperty('resolution.digest');
  });

  it('returns request-local upstream diagnostics only to an authorized admin', async () => {
    const test = setup();
    await createFeed(test);

    const cold = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('owner'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(cold.status).toBe(202);
    expect(await responseJson<{ diagnostics: unknown }>(cold)).toMatchObject({
      diagnostics: {
        version: 1,
        upstreamRequests: { catalog: 1, source: 0 },
        queuedJobsCreated: 1,
        overflow: false,
      },
    });

    const job = await claimJob(test);
    expect((await completeSnapshot(test, job)).status).toBe(200);
    test.directory.detailCalls = 0;

    const warm = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('owner'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(warm.status).toBe(200);
    expect(test.directory.detailCalls).toBe(0);
    expect(await responseJson<{ diagnostics: unknown }>(warm)).toMatchObject({
      diagnostics: {
        version: 1,
        upstreamRequests: { catalog: 0, source: 0 },
        queuedJobsCreated: 0,
        overflow: false,
      },
    });

    const readerWarm = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(readerWarm.status).toBe(200);
    expect(await responseJson<Record<string, unknown>>(readerWarm)).not.toHaveProperty('diagnostics');

    const scopedAdminWarm = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('admin-without-diagnostics'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(scopedAdminWarm.status).toBe(200);
    expect(await responseJson<Record<string, unknown>>(scopedAdminWarm)).not.toHaveProperty('diagnostics');
  });

  it('binds cold and refresh metadata to the selected feed origin', async () => {
    const custom = new DirectoryFixture();
    custom.hash = 'custom-snapshot';
    custom.files = [{
      path: 'SKILL.md',
      contents: '---\nname: my-skill\ndescription: custom catalog\n---\n',
    }];
    const test = setup({
      trustedSkillsShBaseUrls: ['https://skills.sh', CUSTOM_BASE],
      directoryBindings: new Map([[CUSTOM_BASE, custom]]),
    });
    await createFeed(test, { name: 'canonical' });
    await createFeed(test, { name: 'custom', baseUrl: CUSTOM_BASE });

    const cold = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'custom', externalId: EXTERNAL_ID }),
    }));
    expect(cold.status).toBe(202);
    expect(custom.detailCalls).toBe(1);
    expect(test.directory.detailCalls).toBe(0);
    expect(test.directoryForBaseCalls).toEqual([CUSTOM_BASE]);
    expect((await test.repository.read(ORGANIZATION_ID)).jobs[0]?.import).toMatchObject({
      feedName: 'custom',
      externalSnapshotHash: 'custom-snapshot',
    });

    const canonical = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'canonical', externalId: EXTERNAL_ID }),
    }));
    expect(canonical.status).toBe(202);
    expect(test.directory.detailCalls).toBe(1);
    expect(test.directoryForBaseCalls).toEqual([CUSTOM_BASE, 'https://skills.sh']);
    expect((await test.repository.read(ORGANIZATION_ID)).jobs[1]?.import).toMatchObject({
      feedName: 'canonical',
      externalSnapshotHash: 'snapshot-1',
    });

    const refreshed = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'custom', externalId: EXTERNAL_ID, refresh: true }),
    }));
    expect(refreshed.status).toBe(202);
    expect(custom.detailCalls).toBe(2);
    expect(test.directory.detailCalls).toBe(1);
    expect(test.directoryForBaseCalls).toEqual([CUSTOM_BASE, 'https://skills.sh', CUSTOM_BASE]);
  });

  it('uses the selected feed for null-snapshot search hydration', async () => {
    const custom = new DirectoryFixture({ sourceType: 'well-known' });
    custom.hash = null;
    custom.files = null;
    const test = setup({
      trustedSkillsShBaseUrls: ['https://skills.sh', CUSTOM_BASE],
      directoryBindings: new Map([[CUSTOM_BASE, custom]]),
    });
    await createFeed(test, { name: 'canonical' });
    await createFeed(test, { name: 'custom', baseUrl: CUSTOM_BASE });

    const response = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'custom', externalId: EXTERNAL_ID }),
    }));
    expect(response.status).toBe(202);
    expect(custom.detailCalls).toBe(1);
    expect(custom.searchCalls).toBe(1);
    expect(custom.listCalls).toBe(0);
    expect(test.directory.detailCalls).toBe(0);
    expect(test.directory.searchCalls).toBe(0);
    expect((await test.repository.read(ORGANIZATION_ID)).jobs[0]?.import).toMatchObject({
      externalSnapshotHash: null,
      externalSourceType: 'well-known',
    });
  });

  it('uses the selected feed for one-character null-snapshot list hydration', async () => {
    const custom = new DirectoryFixture({ slug: 'x', sourceType: 'well-known' });
    custom.hash = null;
    custom.files = null;
    const test = setup({
      trustedSkillsShBaseUrls: ['https://skills.sh', CUSTOM_BASE],
      directoryBindings: new Map([[CUSTOM_BASE, custom]]),
    });
    await createFeed(test, { name: 'canonical' });
    await createFeed(test, { name: 'custom', baseUrl: CUSTOM_BASE });

    const response = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'custom', externalId: custom.externalId }),
    }));
    expect(response.status).toBe(202);
    expect(custom.detailCalls).toBe(1);
    expect(custom.searchCalls).toBe(0);
    expect(custom.listCalls).toBe(1);
    expect(test.directory.detailCalls).toBe(0);
    expect(test.directory.listCalls).toBe(0);
    expect((await test.repository.read(ORGANIZATION_ID)).jobs[0]?.import).toMatchObject({
      externalSnapshotHash: null,
      externalSourceType: 'well-known',
    });
  });

  it('fails closed when the selected feed has no exact directory binding', async () => {
    const test = setup({
      trustedSkillsShBaseUrls: ['https://skills.sh', CUSTOM_BASE],
    });
    await createFeed(test, { name: 'canonical' });
    await createFeed(test, { name: 'custom', baseUrl: CUSTOM_BASE });

    const response = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ feed: 'custom', externalId: EXTERNAL_ID }),
    }));
    expect(response.status).toBe(503);
    expect(await responseJson<{ error: { code: string } }>(response)).toHaveProperty('error.code', 'DIRECTORY_NOT_CONFIGURED');
    expect(test.directory.detailCalls).toBe(0);
    expect(test.directoryForBaseCalls).toEqual([CUSTOM_BASE]);
  });

  it('forces a new import for an explicit refresh when the catalog hash is null', async () => {
    const test = setup();
    await createFeed(test);
    test.directory.hash = null;
    const row = (await test.directory.list()).data[0]!;
    test.directory.search = async (options: { q: string }) => {
      test.directory.searchCalls += 1;
      return { data: [row], query: options.q, searchType: 'fuzzy', count: 1, durationMs: 1 };
    };

    const first = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(first.status).toBe(202);
    const firstJob = await claimJob(test);
    expect((await completeSnapshot(test, firstJob, { revision: 'sha256:' + '1'.repeat(64) })).status).toBe(200);

    const refreshed = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID, refresh: true }),
    }));
    expect(refreshed.status).toBe(202);
    const jobs = (await test.repository.read(ORGANIZATION_ID)).jobs.filter((job) => job.kind === 'import');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.id).not.toBe(jobs[1]?.id);
  });

  it('preserves known snapshot pin failures and returns a truthful snapshot reference after completion', async () => {
    const test = setup();
    await createFeed(test);
    const queued = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(queued.status).toBe(202);
    const job = await claimJob(test);
    const changed = await completeSnapshot(test, job, { revision: 'snapshot-2' });
    expect(changed.status).toBe(409);
    expect(await responseJson<{ error: { code: string } }>(changed)).toHaveProperty('error.code', 'PROVENANCE_CONFLICT');

    const completed = await completeSnapshot(test, job);
    expect(completed.status).toBe(200);
    const warm = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(warm.status).toBe(200);
    expect(await warm.json()).toMatchObject({
      reference: `@snapshot/skills-sh/${EXTERNAL_ID}`,
      source: { provider: 'snapshot', host: 'skills.sh', path: EXTERNAL_ID },
    });
  });

  it('returns a verified GitHub source reference instead of the catalog identity', async () => {
    const test = setup();
    await createFeed(test);
    test.directory.hash = null;
    const queued = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(queued.status).toBe(202);
    const job = await claimJob(test);
    const commit = 'a'.repeat(40);
    expect((await completeSnapshot(test, job, {
      revision: commit,
      sourceResolutionKind: 'github',
      sourceProviderOrigin: 'https://github.com',
      sourceUrl: 'https://github.com/acme/repo/tree/main/skills/my-skill',
      skillPath: 'skills/my-skill',
      resolvedCommit: commit,
    })).status).toBe(200);

    const warm = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(warm.status).toBe(200);
    const body = await responseJson<{ reference: string; source: { host: string; repository: string; path: string } }>(warm);
    expect(body.reference).toBe('@github/acme/repo/skills/my-skill');
    expect(body.reference).not.toContain('skills.sh');
    expect(body.source).toMatchObject({ host: 'github.com', repository: SOURCE, path: 'skills/my-skill' });
  });

  it('accepts an empty skillPath only for a verified GitHub repository root', async () => {
    const test = setup({ slug: 'root-skill' });
    await createFeed(test);
    test.directory.hash = null;
    const queued = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: test.directory.externalId }),
    }));
    expect(queued.status).toBe(202);
    const job = await claimJob(test);
    const commit = 'b'.repeat(40);
    expect((await completeSnapshot(test, job, {
      revision: commit,
      sourceResolutionKind: 'github',
      sourceProviderOrigin: 'https://github.com',
      sourceUrl: 'https://github.com/acme/repo',
      skillPath: '',
      resolvedCommit: commit,
    })).status).toBe(200);

    const warm = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: test.directory.externalId }),
    }));
    expect(warm.status).toBe(200);
    expect(await responseJson<{ reference: string }>(warm)).toMatchObject({ reference: '@github/acme/repo' });
  });

  it('rejects an empty skillPath without immutable GitHub proof', async () => {
    const test = setup({ slug: 'root-skill' });
    await createFeed(test);
    test.directory.hash = null;
    const queued = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: test.directory.externalId }),
    }));
    expect(queued.status).toBe(202);
    const job = await claimJob(test);
    const response = await completeSnapshot(test, job, {
      revision: 'snapshot-1',
      sourceResolutionKind: 'snapshot',
      sourceProviderOrigin: 'https://github.com',
      sourceUrl: 'https://github.com/acme/repo',
      skillPath: '',
    });
    expect(response.status).toBe(409);
    expect(await responseJson<{ error: { code: string } }>(response)).toMatchObject({ error: { code: 'PROVENANCE_CONFLICT' } });
  });

  it('returns a scoped well-known v2 source reference with its verified entry origin', async () => {
    const test = setup({ source: 'docs.example', slug: 'demo', sourceType: 'well-known' });
    await createFeed(test, { repositories: ['docs.example'] });
    test.directory.hash = null;
    const queued = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: 'docs.example/demo' }),
    }));
    expect(queued.status).toBe(202);
    const job = await claimJob(test);
    const externalDigest = `sha256:${'b'.repeat(64)}`;
    expect((await completeSnapshot(test, job, {
      revision: externalDigest,
      sourceResolutionKind: 'well-known',
      externalSourceType: 'well-known',
      sourceProviderOrigin: 'https://docs.example',
      sourceUrl: 'https://docs.example/published/demo/',
      wellKnownIndexUrl: 'https://docs.example/published/.well-known/agent-skills/index.json',
      wellKnownEntryName: 'demo',
      externalDigest,
    })).status).toBe(200);

    const warm = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: 'docs.example/demo' }),
    }));
    expect(warm.status).toBe(200);
    const body = await responseJson<{ reference: string; source: { host: string; path: string; repository: string } }>(warm);
    expect(body.reference).toBe('@web/docs.example/published/.well-known/agent-skills/demo');
    expect(body.reference).not.toContain('skills.sh');
    expect(body.source).toMatchObject({ host: 'docs.example', path: 'demo' });
    expect(body.source.repository).not.toBe(SOURCE);

    const alternate = setup({ source: 'docs.example', slug: 'demo', sourceType: 'well-known' });
    await createFeed(alternate, { repositories: ['docs.example'] });
    alternate.directory.hash = null;
    const alternateQueued = await alternate.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: 'docs.example/demo' }),
    }));
    expect(alternateQueued.status).toBe(202);
    const alternateJob = await claimJob(alternate);
    expect((await completeSnapshot(alternate, alternateJob, {
      revision: externalDigest,
      sourceResolutionKind: 'well-known',
      externalSourceType: 'well-known',
      sourceProviderOrigin: 'https://docs.example',
      sourceUrl: 'https://docs.example/alternate/demo/',
      wellKnownIndexUrl: 'https://docs.example/alternate/.well-known/skills/index.json',
      wellKnownEntryName: 'demo',
      externalDigest,
    })).status).toBe(200);
    const alternateWarm = await alternate.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: 'docs.example/demo' }),
    }));
    expect(alternateWarm.status).toBe(200);
    const alternateBody = await responseJson<{ reference: string }>(alternateWarm);
    expect(alternateBody.reference).toBe('@web/docs.example/alternate/.well-known/skills/demo');
    expect(alternateBody.reference).not.toBe(body.reference);
  });

  it('rejects an arbitrary feed origin before accepting a catalog credential reference', async () => {
    const test = setup();
    const response = await test.handler(new Request(`${ORIGIN}/v1/feeds`, {
      method: 'POST',
      headers: headers('owner'),
      body: JSON.stringify({
        name: 'evil',
        kind: 'skills-sh',
        namespace: '@team',
        baseUrl: 'https://evil.example.test/catalog',
        credentialEnv: 'SKILLS_SH_TOKEN',
      }),
    }));
    expect(response.status).toBe(400);
    expect(await responseJson<{ error: { code: string } }>(response)).toHaveProperty('error.code', 'INVALID_FEED');
  });

  it('persists loopback feeds only in the explicit test mode and rechecks the runtime gate', async () => {
    const test = setup({ allowLoopbackUpstreams: true });
    const feed = await createFeed(test, { baseUrl: 'http://127.0.0.1:4317/catalog' });

    const listed = await test.handler(new Request(`${ORIGIN}/v1/feeds/${encodeURIComponent(feed.id)}`, {
      method: 'GET',
      headers: headers('reader'),
    }));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ feed: { baseUrl: 'http://127.0.0.1:4317/catalog' } });

    const queued = await test.handler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID }),
    }));
    expect(queued.status).toBe(202);
    expect(test.directory.detailCalls).toBe(1);

    const productionHandler = createRegistryHandler({
      repository: test.repository,
      blobs: test.blobs,
      auth: test.auth,
      directory: test.directory,
      config: { ...test.config, allowLoopbackUpstreams: false },
    });
    test.directory.detailCalls = 0;
    const blocked = await productionHandler(new Request(`${ORIGIN}/v1/proxy/resolve`, {
      method: 'POST',
      headers: headers('reader'),
      body: JSON.stringify({ externalId: EXTERNAL_ID, refresh: true }),
    }));
    expect(blocked.status).toBe(503);
    expect(await responseJson<{ error: { code: string } }>(blocked)).toHaveProperty('error.code', 'FEED_UNTRUSTED');
    expect(test.directory.detailCalls).toBe(0);
  });

  it('rejects loopback feed creation before persistence when test mode is disabled', async () => {
    const test = setup();
    const response = await test.handler(new Request(`${ORIGIN}/v1/feeds`, {
      method: 'POST',
      headers: headers('owner'),
      body: JSON.stringify({
        name: 'local',
        kind: 'skills-sh',
        namespace: '@team',
        repositories: [test.directory.source],
        baseUrl: 'http://127.0.0.1:4317/catalog',
      }),
    }));
    expect(response.status).toBe(400);
    expect(await responseJson<{ error: { code: string } }>(response)).toHaveProperty('error.code', 'INVALID_FEED');
    expect((await test.repository.read(ORGANIZATION_ID)).feeds ?? []).toHaveLength(0);
    expect(test.directory.detailCalls).toBe(0);
  });
});
