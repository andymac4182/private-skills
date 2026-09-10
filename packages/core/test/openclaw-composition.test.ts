import { describe, expect, it } from 'vitest';

import {
  createEmptyRegistryState,
  createRegistryHandler,
  createOpenClawImportQueue,
  type RegistryOpenClawConsumerDependencies,
  type RegistryOpenClawSourceProofCompletion,
  type RegistryOpenClawCandidate,
} from '../src/index.js';
import {
  MemoryOpenClawPublicationStore,
  OpenClawPublicationManager,
  OpenClawTrustedSnapshotImportService,
  StateRepositoryOpenClawConsumerSnapshotStore,
} from '../../openclaw-adapter/src/index.ts';
import { parseOpenClawFeed, serializeOpenClawFeed, sha256 } from '../../openclaw/src/index.ts';
import type { OpenClawCacheSnapshot } from '../../openclaw/src/index.ts';
import type {
  Authenticator,
  BlobStore,
  Job,
  Principal,
  RegistryDependencies,
  RegistryState,
  SkillVersion,
  StateRepository,
} from '../../contracts/src/index.js';
import type { OpenClawMetadataSnapshot } from '../../openclaw-adapter/src/index.ts';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION_ID = 'org-openclaw';
const REGISTRY_DIGEST = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
const SOURCE_DIGEST = `sha256:${'b'.repeat(64)}` as `sha256:${string}`;
const FEED_DIGEST = `sha256:${'c'.repeat(64)}` as `sha256:${string}`;

class MemoryRepository implements StateRepository {
  state: RegistryState;

  constructor() {
    this.state = createEmptyRegistryState({
      revision: 'policy-openclaw',
      scanners: [],
      allowUnscanned: true,
      evidenceMaxAgeSeconds: 3_600,
    });
  }

  async read(): Promise<RegistryState> {
    return structuredClone(this.state);
  }

  async transaction<T>(_organizationId: string, update: (state: RegistryState) => T): Promise<T> {
    const working = structuredClone(this.state);
    const result = update(working);
    this.state = working;
    return result;
  }
}

class MemoryBlobs implements BlobStore {
  async put(bytes: Uint8Array) {
    return { key: 'openclaw-memory', digest: await digestBytes(bytes), size: bytes.byteLength };
  }

  async get(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async remove(): Promise<void> {}
}

function principal(subject: string, roles: Principal['roles'], namespaces?: string[], scopes?: string[]): Principal {
  return { organizationId: ORGANIZATION_ID, subject, roles, namespaces, scopes };
}

function skill(): SkillVersion {
  return {
    id: 'skill-internal-1',
    organizationId: ORGANIZATION_ID,
    name: '@team/private-demo',
    skillName: 'private-demo',
    version: '1.0.0',
    description: 'Verified OpenClaw source fixture',
    artifact: { key: 'openclaw-memory', digest: REGISTRY_DIGEST, size: 32 },
    state: 'approved',
    policyRevision: 'policy-openclaw',
    createdAt: '2030-01-01T00:00:00.000Z',
    approvedAt: '2030-01-01T00:00:00.000Z',
    provenance: {
      kind: 'registry',
      externalId: '@acme/demo',
      revision: '1.0.0',
      externalSnapshotHash: null,
      externalDigest: SOURCE_DIGEST,
      sourceDigest: REGISTRY_DIGEST,
      sourceResolutionKind: 'snapshot',
      sourceProviderOrigin: 'https://clawhub.example',
    },
    fileCount: 1,
    scanIds: [],
  };
}

function candidate(): RegistryOpenClawCandidate {
  return {
    skillId: 'skill-internal-1',
    skill: {
      state: 'approved',
      version: '1.0.0',
      policyRevision: 'policy-openclaw',
      artifact: { key: 'openclaw-memory', digest: REGISTRY_DIGEST, size: 32 },
    },
    entry: {
      type: 'skill',
      id: '@acme/demo',
      title: 'Demo',
      description: 'Verified OpenClaw source fixture',
      version: '1.0.0',
      state: 'available',
      publisher: { id: 'acme', trust: 'community' },
      install: {
        candidates: [{
          sourceRef: 'public-clawhub',
          package: '@acme/demo',
          version: '1.0.0',
          integrity: SOURCE_DIGEST,
        }],
      },
    },
    sourceArtifact: {
      verified: true,
      digest: SOURCE_DIGEST,
      format: 'clawhub-skill-v1',
      identity: '@acme/demo@1.0.0',
    },
  };
}

function setup(options: {
  principal?: Principal | null;
  candidates?: (input: { metadata?: unknown }) => readonly RegistryOpenClawCandidate[];
  recordSourceProof?: (input: RegistryOpenClawSourceProofCompletion) => Promise<unknown> | unknown;
  trustedPreview?: boolean;
  consumer?: RegistryOpenClawConsumerDependencies;
  namespace?: string;
  currentTrustedMetadata?: () => Promise<OpenClawMetadataSnapshot | undefined> | OpenClawMetadataSnapshot | undefined;
} = {}) {
  const repository = new MemoryRepository();
  repository.state.skills.push(skill());
  let current = options.principal === undefined
    ? principal('owner', ['owner', 'admin', 'reader'], ['@team'], ['registry:*'])
    : options.principal;
  const auth: Authenticator = { authenticate: async () => current };
  const store = new MemoryOpenClawPublicationStore();
  const manager = new OpenClawPublicationManager(store);
  const sourceCandidate = candidate();
  const trustedFeed = options.trustedPreview
    ? {
      url: 'https://clawhub.example/v1/feeds/skills',
      expectedFeedId: 'clawhub-official',
      allowedOrigins: ['https://clawhub.example'],
      fetcher: async () => {
        const body = serializeOpenClawFeed({
          schemaVersion: 1,
          id: 'clawhub-official',
          generatedAt: '2030-01-01T00:00:00.000Z',
          sequence: 5,
          expiresAt: '2030-01-02T00:00:00.000Z',
          entries: [sourceCandidate.entry],
        });
        return new Response(body, { status: 200 });
      },
    }
    : undefined;
  const deps: RegistryDependencies & {
    openClaw: NonNullable<Parameters<typeof createRegistryHandler>[0]>['openClaw'];
  } = {
    repository,
    blobs: new MemoryBlobs(),
    auth,
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: 1024 * 1024,
      organizationId: ORGANIZATION_ID,
      leaseSeconds: 30,
    },
    openClaw: {
      feedId: 'private/openclaw',
      feedUrl: `${ORIGIN}/v1/feeds/skills`,
      publicationManager: manager,
      ...(trustedFeed === undefined ? {} : { trustedFeed }),
      ...(options.candidates === undefined
        ? { candidatesForTenant: async () => [sourceCandidate] }
        : { candidatesForTenant: async (input) => options.candidates!({ metadata: input.metadata }) }),
      ...(options.recordSourceProof === undefined ? {} : { recordSourceProof: options.recordSourceProof }),
      ...(options.consumer === undefined ? {} : { consumer: options.consumer }),
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
      ...(trustedFeed === undefined ? {} : {
        currentTrustedMetadata: options.currentTrustedMetadata ?? (() => metadataSnapshot(sourceCandidate.entry)),
      }),
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    },
  };
  return {
    repository,
    handler: createRegistryHandler(deps),
    setPrincipal(value: Principal | null) { current = value; },
  };
}

function post(url: string): Request {
  return new Request(url, { method: 'POST' });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

function metadataSnapshot(entry: RegistryOpenClawCandidate['entry']): OpenClawMetadataSnapshot {
  return {
    feed: {
      schemaVersion: 1,
      id: 'clawhub-official',
      generatedAt: '2025-01-01T00:00:00.000Z',
      sequence: 5,
      expiresAt: '2030-01-02T00:00:00.000Z',
      entries: [entry],
    },
    sha256: FEED_DIGEST,
    etag: `"${FEED_DIGEST}"`,
    acceptedAt: Date.now(),
    sourceUrl: 'https://clawhub.example/v1/feeds/skills',
  };
}

describe('core OpenClaw feed composition', () => {
  it('previews trusted catalog metadata and queues an exact entry through the durable import path', async () => {
    const entry = candidate().entry;
    const generatedAt = new Date(Date.now() - 1_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const body = serializeOpenClawFeed({
      schemaVersion: 1,
      id: 'clawhub-official',
      generatedAt,
      sequence: 5,
      expiresAt,
      entries: [entry],
    });
    const bytes = new TextEncoder().encode(body);
    const snapshot: OpenClawCacheSnapshot = {
      feed: parseOpenClawFeed(body, { checkExpiry: false }),
      body,
      bytes,
      sha256: await sha256(bytes),
      etag: `"${await sha256(bytes)}"`,
      acceptedAt: Date.now(),
      sourceUrl: 'https://clawhub.example/v1/feeds/skills',
    };
    const withConsumer = setup({ trustedPreview: true, namespace: '@team' });
    // Seed the exact validated feed bytes in the same repository used by the
    // handler; the consumer service never trusts the route body for metadata.
    const consumerStore = new StateRepositoryOpenClawConsumerSnapshotStore(withConsumer.repository);
    await consumerStore.put({
      tenantId: ORGANIZATION_ID,
      feedId: 'clawhub-official',
      sourceUrl: snapshot.sourceUrl,
    }, snapshot);
    const consumerQueue = createOpenClawImportQueue({
      repository: withConsumer.repository,
      organizationId: ORGANIZATION_ID,
      namespace: '@team',
      sourceProviderOrigin: 'https://clawhub.example',
      now: () => Date.now(),
    });
    const consumerService = new OpenClawTrustedSnapshotImportService({
      store: consumerStore,
      queue: consumerQueue,
      authorize: () => true,
      now: () => Date.now(),
    });
    let currentPrincipal = principal('reader', ['reader'], ['@team'], ['registry:read', 'proxy:resolve']);
    const handler = createRegistryHandler({
      repository: withConsumer.repository,
      blobs: new MemoryBlobs(),
      auth: { authenticate: async () => currentPrincipal },
      config: { publicOrigin: ORIGIN, maxBodyBytes: 1024 * 1024, organizationId: ORGANIZATION_ID, leaseSeconds: 30 },
      openClaw: {
        feedId: 'private/openclaw',
        feedUrl: `${ORIGIN}/v1/feeds/skills`,
        publicationManager: new OpenClawPublicationManager(new MemoryOpenClawPublicationStore()),
        trustedFeed: {
          url: snapshot.sourceUrl,
          expectedFeedId: 'clawhub-official',
          allowedOrigins: ['https://clawhub.example'],
        },
        namespace: '@team',
        consumer: {
          refresh: async () => ({ kind: 'not-modified', snapshot: metadataSnapshot(entry) }),
          selectAndQueue: consumerService.selectAndQueue.bind(consumerService),
        },
      },
    });
    const catalog = await handler(new Request(`${ORIGIN}/v1/feeds/skills/catalog`));
    expect(catalog.status).toBe(200);
    expect(await json(catalog)).toMatchObject({ feed: { id: 'clawhub-official', entries: [{ id: '@acme/demo' }] } });

    const queued = await handler(new Request(`${ORIGIN}/v1/feeds/skills/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: '@acme/demo' }),
    }));
    expect(queued.status).toBe(202);
    const queuedBody = await json(queued);
    expect(queuedBody).toMatchObject({ feed: 'clawhub-official', externalId: '@acme/demo', operation: { state: 'queued' } });
    const queuedJob = withConsumer.repository.state.jobs.find((job) => job.id === queuedBody.operation.operationId);
    expect(queuedJob).toMatchObject({
      kind: 'import',
      import: { externalId: '@acme/demo', name: expect.stringMatching(/^@team\/openclaw-/u) },
      openclawSource: { source: { kind: 'public-clawhub' }, feed: { id: 'clawhub-official', sequence: 5 } },
    });

    const beforeDenied = withConsumer.repository.state.jobs.length;
    currentPrincipal = principal('reader', ['reader'], ['@team'], ['registry:read']);
    const actuallyDenied = await handler(new Request(`${ORIGIN}/v1/feeds/skills/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: '@acme/demo' }),
    }));
    expect(actuallyDenied.status).toBe(403);
    expect(withConsumer.repository.state.jobs.length).toBe(beforeDenied);
  });

  it('does not queue an import when the trusted metadata refresh is stale', async () => {
    let queueCalls = 0;
    const test = setup({
      trustedPreview: true,
      namespace: '@team',
      consumer: {
        refresh: async () => ({
          kind: 'stale',
          snapshot: metadataSnapshot(candidate().entry),
        }),
        selectAndQueue: async () => {
          queueCalls += 1;
          return { operationId: 'unexpected', state: 'queued' };
        },
      },
    });

    const response = await test.handler(new Request(`${ORIGIN}/v1/feeds/skills/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: '@acme/demo' }),
    }));

    expect(response.status).toBe(503);
    expect(queueCalls).toBe(0);
    expect(test.repository.state.jobs).toHaveLength(0);
  });

  it('refreshes from verifier-backed approved evidence and serves an authenticated feed', async () => {
    const test = setup({ trustedPreview: true });
    const capabilities = await test.handler(new Request(`${ORIGIN}/v1/capabilities`));
    expect(capabilities.status).toBe(200);
    expect(await json(capabilities)).toMatchObject({
      features: {
        openClaw: {
          enabled: true,
          trustedFeedPreview: true,
          refresh: true,
          advertisement: {
            feedId: 'private/openclaw',
            feedUrl: `${ORIGIN}/v1/feeds/skills`,
          },
        },
      },
    });

    const refreshed = await test.handler(post(`${ORIGIN}/v1/feeds/skills/refresh`));
    expect(refreshed.status).toBe(200);
    expect(await json(refreshed)).toMatchObject({
      feed: { id: 'private/openclaw', sequence: 1, entryCount: 1 },
      source: { feedId: 'clawhub-official', sequence: 5, entryCount: 1 },
    });

    test.setPrincipal(principal('reader', ['reader'], ['@team'], ['registry:read']));
    const response = await test.handler(new Request(`${ORIGIN}/v1/feeds/skills`));
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toMatchObject({
      id: 'private/openclaw',
      entries: [{ id: '@acme/demo', install: { candidates: [{ integrity: SOURCE_DIGEST }] } }],
    });
  });

  it('rechecks the latest persisted trusted metadata before serving a publication', async () => {
    let current = metadataSnapshot(candidate().entry);
    const test = setup({
      trustedPreview: true,
      currentTrustedMetadata: () => current,
    });

    expect((await test.handler(post(`${ORIGIN}/v1/feeds/skills/refresh`))).status).toBe(200);
    expect((await test.handler(new Request(`${ORIGIN}/v1/feeds/skills`))).status).toBe(200);

    current = {
      ...current,
      feed: {
        ...current.feed,
        entries: [{ ...candidate().entry, state: 'blocked' }],
      },
    };
    const response = await test.handler(new Request(`${ORIGIN}/v1/feeds/skills`));
    expect(response.status).toBe(403);
  });

  it('does not record a source proof when completion omits the canonical artifact digest', async () => {
    const recorded: Array<{
      tenantId: string;
      completionJobId: string;
      skillId: string;
      entry: RegistryOpenClawCandidate['entry'];
      sourceArtifact: RegistryOpenClawCandidate['sourceArtifact'];
    }> = [];
    const test = setup({
      recordSourceProof: async (input) => { recorded.push(input); },
    });
    const source = {
      kind: 'public-clawhub',
      sourceRef: 'public-clawhub',
      packageName: '@acme/demo',
      version: '1.0.0',
      artifactDigest: SOURCE_DIGEST,
    } as const;
    await test.repository.transaction(ORGANIZATION_ID, (state) => {
      const now = new Date().toISOString();
      const job: Job = {
        id: 'job-openclaw-proof',
        organizationId: ORGANIZATION_ID,
        kind: 'import',
        state: 'queued',
        policyRevision: state.policy.revision,
        policy: structuredClone(state.policy),
        import: {
          upstreamId: 'upstream-openclaw',
          path: '@acme/demo',
          externalId: '@acme/demo',
          name: '@team/demo',
          version: '1.0.0',
        },
        upstream: {
          id: 'upstream-openclaw',
          organizationId: ORGANIZATION_ID,
          name: 'OpenClaw fixture',
          kind: 'registry',
          enabled: true,
          baseUrl: 'https://clawhub.example',
          namespace: '@team',
        },
        openclawSource: { source, entry: candidate().entry },
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      };
      state.jobs.push(job);
    });

    const worker = { ...principal('worker', ['worker']), identity: 'worker' as const, scopes: ['jobs:claim', 'jobs:complete'] };
    test.setPrincipal(worker);
    const claimed = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    expect(claimed.status).toBe(200);
    const claimedJob = (await json(claimed)).job as Job & { leaseToken: string };
    const bundle = {
      format: 'pskills-bundle-v1' as const,
      files: [{
        path: 'SKILL.md',
        content: Buffer.from('---\nname: demo\ndescription: proof fixture\n---\n# Demo\n', 'utf8').toString('base64'),
      }],
    };
    const artifactDigest = await digestBytes(encodeBundle(bundle));
    const completed = await test.handler(new Request(`${ORIGIN}/internal/jobs/${claimedJob.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-fencing-token': claimedJob.leaseToken },
      body: JSON.stringify({
        leaseToken: claimedJob.leaseToken,
        artifactDigest,
        bundle,
        provenance: {
          kind: 'registry',
          upstreamId: 'upstream-openclaw',
          repository: 'https://clawhub.example',
          path: '@acme/demo',
          revision: '1.0.0',
          externalId: '@acme/demo',
          externalDigest: SOURCE_DIGEST,
          sourceResolutionKind: 'snapshot',
          sourceProviderOrigin: 'https://clawhub.example',
        },
      }),
    }));
    expect(completed.status).toBe(200);
    expect(recorded).toEqual([]);
  });

  it('requires admin refresh and current namespace/policy admission on every read', async () => {
    const test = setup();
    test.setPrincipal(principal('reader', ['reader'], ['@team'], ['registry:read']));
    expect((await test.handler(post(`${ORIGIN}/v1/feeds/skills/refresh`))).status).toBe(403);

    test.setPrincipal(principal('owner', ['owner', 'admin', 'reader'], ['@team'], ['registry:*']));
    expect((await test.handler(post(`${ORIGIN}/v1/feeds/skills/refresh`))).status).toBe(200);

    test.setPrincipal(principal('other-namespace', ['reader'], ['@other'], ['registry:read']));
    expect((await test.handler(new Request(`${ORIGIN}/v1/feeds/skills`))).status).toBe(403);
  });

  it('publishes an empty verified feed when evidence is stale and never invents a record', async () => {
    const test = setup({
      candidates: () => [{
        ...candidate(),
        sourceArtifact: { ...candidate().sourceArtifact, digest: `sha256:${'c'.repeat(64)}` as `sha256:${string}` },
      }],
    });
    const refreshed = await test.handler(post(`${ORIGIN}/v1/feeds/skills/refresh`));
    expect(refreshed.status).toBe(200);
    expect(await json(refreshed)).toMatchObject({ feed: { entryCount: 0 } });
    const feedResponse = await test.handler(new Request(`${ORIGIN}/v1/feeds/skills`));
    expect(feedResponse.status).toBe(200);
    expect(JSON.parse(await feedResponse.text()).entries).toEqual([]);
  });

  it('is explicitly disabled when no OpenClaw configuration is injected', async () => {
    const repository = new MemoryRepository();
    const auth: Authenticator = { authenticate: async () => principal('reader', ['reader'], undefined, ['registry:read']) };
    const deps: RegistryDependencies = {
      repository,
      blobs: new MemoryBlobs(),
      auth,
      config: { publicOrigin: ORIGIN, maxBodyBytes: 1024 * 1024, organizationId: ORGANIZATION_ID, leaseSeconds: 30 },
    };
    const handler = createRegistryHandler(deps);
    expect((await handler(new Request(`${ORIGIN}/v1/feeds/skills`))).status).toBe(503);
    expect(await json(await handler(new Request(`${ORIGIN}/v1/capabilities`)))).toMatchObject({ features: { openClaw: { enabled: false } } });
  });
});
