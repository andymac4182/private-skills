import { describe, expect, it } from 'vitest';

import {
  createEmptyRegistryState,
  createRegistryHandler,
  type RegistryOpenClawCandidate,
} from '../src/index.js';
import {
  MemoryOpenClawPublicationStore,
  OpenClawPublicationManager,
} from '../../openclaw-adapter/src/index.ts';
import { serializeOpenClawFeed } from '../../openclaw/src/index.ts';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryDependencies,
  RegistryState,
  SkillVersion,
  StateRepository,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION_ID = 'org-openclaw';
const REGISTRY_DIGEST = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
const SOURCE_DIGEST = `sha256:${'b'.repeat(64)}` as `sha256:${string}`;

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
    return { key: 'openclaw-memory', digest: REGISTRY_DIGEST, size: bytes.byteLength };
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
  trustedPreview?: boolean;
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

describe('core OpenClaw feed composition', () => {
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
