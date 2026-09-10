import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createMemoryStateRepository,
  defaultRegistryState,
} from '../packages/database/src/index.js';
import {
  createRegistryHandler,
} from '../packages/core/src/index.js';
import {
  createSkillsDirectoryClientResolver,
  resolveSkillsDirectoryGateways,
  type SkillsFetch,
} from '../packages/directory/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import type {
  Authenticator,
  Feed,
  Job,
  Policy,
  Principal,
  RegistryConfiguration,
  Resolution,
} from '../packages/contracts/src/index.js';
import type { ScannerAdapter } from '../packages/scanners/src/types.js';
import { workerAcquisitionOptionsFromEnv } from '../workers/runner/src/acquisition.js';
import { WorkerRunner } from '../workers/runner/src/worker.js';

const ORIGIN = 'https://registry.multi-feed.test';
const ORGANIZATION_ID = 'org-multi-feed-e2e';
// HTTPS-shaped loopback fixtures keep the acquisition SSRF guard active while
// the injected fetch prevents any socket or external-provider request.
const BASE_A = 'https://127.0.0.1:34101/catalog-a';
const BASE_B = 'https://127.0.0.1:34102/catalog-b';
const EXTERNAL_ID = 'example/skills/greeting';
const TOKEN_A = 'fixture-catalog-token-a';
const TOKEN_B = 'fixture-catalog-token-b';
const USER_TOKEN = 'fixture-user-token';
const WORKER_TOKEN = 'fixture-worker-token';

const policy: Policy = {
  revision: 'multi-feed-e2e-required',
  scanners: [{
    id: 'skillsguard',
    mode: 'required',
    blockSeverities: ['high', 'critical'],
    timeoutSeconds: 5,
  }],
  allowUnscanned: false,
  evidenceMaxAgeSeconds: 3600,
  hooks: [],
};

const snapshots = {
  [BASE_A]: {
    hash: 'snapshot-a',
    contents: '---\nname: greeting\ndescription: catalog A\n---\n\nSay hello from A.\n',
  },
  [BASE_B]: {
    hash: 'snapshot-b',
    contents: '---\nname: greeting\ndescription: catalog B\n---\n\nSay hello from B.\n',
  },
} as const;

type CatalogCall = { base: string; path: string; authorization: string | null };

function scanner(): ScannerAdapter {
  return {
    id: 'skillsguard',
    command: 'fixture-deterministic-scanner',
    metadata: {
      id: 'skillsguard',
      version: 'fixture',
      engineVersion: 'fixture',
      rulesRevision: 'fixture',
    },
    scan: async (input) => ({ result: {
      schemaVersion: 1,
      organizationId: input.organizationId,
      jobId: input.jobId,
      invocationId: 'fixture-invocation',
      artifactDigest: input.artifactDigest,
      policyRevision: input.policyRevision,
      adapter: {
        id: 'skillsguard',
        version: 'fixture',
        engineVersion: 'fixture',
        rulesRevision: 'fixture',
        configurationHash: `sha256:${'1'.repeat(64)}`,
      },
      status: 'completed',
      durationMs: 1,
      coverage: {
        filesEnumerated: 1,
        filesAnalyzed: 1,
        filesSkipped: 0,
        filesUnsupported: 0,
        limitations: [],
        externalDestinations: [],
      },
      findings: [],
    } }),
  };
}

function headers(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

describe('multi-feed directory admission across core, worker, and Files SDK', () => {
  let blobRoot: string | undefined;

  afterEach(async () => {
    if (blobRoot !== undefined) await rm(blobRoot, { recursive: true, force: true });
    blobRoot = undefined;
  });

  it('keeps same-id feeds origin-bound through cold admission, scanning, and warm resolution', async () => {
    const catalogCalls: CatalogCall[] = [];
    const catalogFetch: SkillsFetch = async (input, init) => {
      const url = new URL(String(input));
      const base = [BASE_A, BASE_B].find((candidate) => {
        const configured = new URL(candidate);
        return configured.origin === url.origin && (
          url.pathname === configured.pathname || url.pathname.startsWith(`${configured.pathname}/`)
        );
      });
      if (base === undefined) throw new Error(`unexpected catalog URL ${url.origin}${url.pathname}`);

      const snapshot = snapshots[base as keyof typeof snapshots];
      const authorization = new Headers(init?.headers).get('authorization');
      const expectedPath = `${new URL(base).pathname}/api/v1/skills/${EXTERNAL_ID.split('/').map(encodeURIComponent).join('/')}`;
      expect(url.pathname).toBe(expectedPath);
      expect(authorization).toBe(`Bearer ${base === BASE_A ? TOKEN_A : TOKEN_B}`);
      catalogCalls.push({ base, path: url.pathname, authorization });
      return Response.json({
        id: EXTERNAL_ID,
        source: 'example/skills',
        slug: 'greeting',
        name: 'greeting',
        installs: 1,
        hash: snapshot.hash,
        files: [{ path: 'SKILL.md', contents: snapshot.contents }],
      });
    };

    const gatewayEnv = {
      PSKILLS_DIRECTORY_ENABLED: 'true',
      PSKILLS_DIRECTORY_GATEWAYS_JSON: JSON.stringify([
        { baseUrl: BASE_A, tokenEnv: 'PSKILLS_FEED_A_TOKEN' },
        { baseUrl: BASE_B, tokenEnv: 'PSKILLS_FEED_B_TOKEN' },
      ]),
      PSKILLS_FEED_A_TOKEN: TOKEN_A,
      PSKILLS_FEED_B_TOKEN: TOKEN_B,
    };
    const gateways = resolveSkillsDirectoryGateways(gatewayEnv);
    expect(gateways.kind).toBe('ready');
    if (gateways.kind !== 'ready') throw new Error('fixture gateway profiles did not resolve');
    const directoryForBase = createSkillsDirectoryClientResolver({
      gateways,
      officialAvailable: false,
      fetch: catalogFetch,
    });

    const owner: Principal & { identity: 'user' } = {
      organizationId: ORGANIZATION_ID,
      subject: 'fixture-owner',
      identity: 'user',
      roles: ['owner', 'admin', 'publisher', 'reader'],
      namespaces: ['@acme'],
      scopes: ['*'],
    };
    const worker: Principal & { identity: 'worker' } = {
      organizationId: ORGANIZATION_ID,
      subject: 'fixture-worker',
      identity: 'worker',
      roles: ['worker'],
      scopes: ['*'],
    };
    const principals = new Map<string, Principal>([
      [`Bearer ${USER_TOKEN}`, owner],
      [`Bearer ${WORKER_TOKEN}`, worker],
    ]);
    const auth: Authenticator = {
      authenticate: async (request) => principals.get(request.headers.get('authorization') ?? '') ?? null,
    };

    const repository = createMemoryStateRepository({
      stateFactory: () => ({
        ...defaultRegistryState({ production: false, allowUnscanned: false, policyRevision: policy.revision }),
        policy: structuredClone(policy),
      }),
    });
    blobRoot = await mkdtemp(join(tmpdir(), 'private-skills-multifeed-e2e-'));
    const blobs = await createNodeFilesSdkBlobStore({ provider: 'fs', root: blobRoot, prefix: 'private-registry' });
    const config: RegistryConfiguration = {
      publicOrigin: ORIGIN,
      maxBodyBytes: 2 * 1024 * 1024,
      organizationId: ORGANIZATION_ID,
      leaseSeconds: 60,
      allowLoopbackUpstreams: true,
      trustedSkillsShBaseUrls: [BASE_A, BASE_B],
    };
    const handler = createRegistryHandler({
      repository,
      blobs,
      auth,
      config,
      directoryForBase,
    });

    const request = (path: string, token: string, init: RequestInit = {}) => handler(new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        ...headers(token),
        ...(init.headers ?? {}),
      },
    }));
    const createFeed = async (name: string, baseUrl: string): Promise<Feed> => {
      const response = await request('/v1/feeds', USER_TOKEN, {
        method: 'POST',
        body: JSON.stringify({
          name,
          kind: 'skills-sh',
          namespace: '@acme',
          repositories: ['example/skills'],
          baseUrl,
        }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await json<{ feed: Feed }>(response)).feed;
    };

    const feedA = await createFeed('feed-a', BASE_A);
    const feedB = await createFeed('feed-b', BASE_B);
    const resolveFeed = async (feed: Feed) => request('/v1/proxy/resolve', USER_TOKEN, {
      method: 'POST',
      body: JSON.stringify({ feed: feed.name, externalId: EXTERNAL_ID }),
    });

    const queuedA = await resolveFeed(feedA);
    const queuedB = await resolveFeed(feedB);
    expect(queuedA.status, await queuedA.clone().text()).toBe(202);
    expect(queuedB.status, await queuedB.clone().text()).toBe(202);
    const operationA = (await json<{ operation: Job }>(queuedA)).operation;
    const operationB = (await json<{ operation: Job }>(queuedB)).operation;
    expect(operationA.upstream?.baseUrl).toBe(BASE_A);
    expect(operationB.upstream?.baseUrl).toBe(BASE_B);
    expect(operationA.import?.externalSnapshotHash).toBe(snapshots[BASE_A].hash);
    expect(operationB.import?.externalSnapshotHash).toBe(snapshots[BASE_B].hash);
    expect(JSON.stringify({ operationA, operationB })).not.toContain(TOKEN_A);
    expect(JSON.stringify({ operationA, operationB })).not.toContain(TOKEN_B);

    const acquisition = {
      ...workerAcquisitionOptionsFromEnv(gatewayEnv),
      fetchImpl: catalogFetch,
      allowLoopbackForTests: true,
    };
    expect(acquisition.skillsShGatewayCredentials).toHaveLength(2);
    const runner = new WorkerRunner({
      baseUrl: ORIGIN,
      workerToken: WORKER_TOKEN,
      workerId: 'multi-feed-fixture-worker',
      fetch: async (input, init) => handler(new Request(String(input), init)),
      acquisition,
      adapters: [scanner()],
      executor: { run: async () => { throw new Error('deterministic adapter should bypass command execution'); } },
    });

    const resultA = await runner.runOnce();
    const resultB = await runner.runOnce();
    expect(resultA, JSON.stringify({ resultA, resultB })).toMatchObject({ claimed: true, allow: true });
    expect(resultB, JSON.stringify({ resultA, resultB })).toMatchObject({ claimed: true, allow: true });
    expect(catalogCalls).toHaveLength(4);
    expect(catalogCalls.map((call) => call.base)).toEqual([BASE_A, BASE_B, BASE_A, BASE_B]);
    expect(catalogCalls.every((call) => call.path.endsWith('/api/v1/skills/example/skills/greeting'))).toBe(true);
    expect(catalogCalls.map((call) => call.authorization)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
    ]);

    const resolvedAResponse = await resolveFeed(feedA);
    const resolvedBResponse = await resolveFeed(feedB);
    expect(resolvedAResponse.status, await resolvedAResponse.clone().text()).toBe(200);
    expect(resolvedBResponse.status, await resolvedBResponse.clone().text()).toBe(200);
    const resolvedA = (await json<{ resolution: Resolution }>(resolvedAResponse)).resolution;
    const resolvedB = (await json<{ resolution: Resolution }>(resolvedBResponse)).resolution;
    expect(resolvedA.digest).not.toBe(resolvedB.digest);
    expect(resolvedA.members[0]?.artifact.digest).toBe(resolvedA.digest);
    expect(resolvedB.members[0]?.artifact.digest).toBe(resolvedB.digest);
    expect(resolvedA.members[0]?.provenance).toMatchObject({
      feedId: feedA.id,
      feedName: feedA.name,
      externalSnapshotHash: snapshots[BASE_A].hash,
      sourceResolutionKind: 'snapshot',
    });
    expect(resolvedB.members[0]?.provenance).toMatchObject({
      feedId: feedB.id,
      feedName: feedB.name,
      externalSnapshotHash: snapshots[BASE_B].hash,
      sourceResolutionKind: 'snapshot',
    });

    const state = await repository.read(ORGANIZATION_ID);
    expect(state.skills).toHaveLength(2);
    const persistedState = JSON.stringify(state);
    expect(persistedState).not.toContain(TOKEN_A);
    expect(persistedState).not.toContain(TOKEN_B);

    // Catalog snapshots avoid source-provider requests altogether, and the
    // private artifact route still requires a registry principal/capability.
    const unauthorizedArtifact = await handler(new Request(
      `${ORIGIN}/v1/artifacts/${encodeURIComponent(resolvedA.digest)}/download`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
    ));
    expect(unauthorizedArtifact.status).toBe(401);
    expect(catalogCalls).toHaveLength(4);

    const beforeWarm = catalogCalls.length;
    const warmA = await resolveFeed(feedA);
    const warmB = await resolveFeed(feedB);
    expect(warmA.status).toBe(200);
    expect(warmB.status).toBe(200);
    expect(catalogCalls).toHaveLength(beforeWarm);
  });
});
