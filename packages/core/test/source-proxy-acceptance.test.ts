import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryStateRepository,
  defaultRegistryState,
  type MemoryStateRepository,
} from '../../database/src/index.js';
import { createRegistryHandler, type RegistryHandler } from '../src/index.js';
import { SourceCatalogClient } from '../../source-catalog/src/client.js';
import type {
  SourceCatalogAdapter,
  SourceCatalogConfiguration,
  SourceResolveRequest,
  SourceResolution,
  SourceSearchRequest,
  SourceSearchResult,
  SourceAvailability,
  SourceId,
} from '../../source-catalog/src/types.js';
import {
  decodeBundle,
  digestBytes,
} from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Digest,
  Job,
  Policy,
  Principal,
  RegistryConfiguration,
  SkillBundle,
  StoredBlob,
  TransferDescriptor,
} from '../../contracts/src/index.js';
import type { ScannerAdapter } from '../../scanners/src/types.js';
import type { FetchLike } from '../../upstreams/src/index.js';
import { WorkerRunner } from '../../../workers/runner/src/index.js';

// The worker keeps the production DNS/SSRF checks enabled. All requests still
// terminate in the local fixture fetcher below.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
}));

const ORIGIN = 'https://source-proxy-acceptance.test';
const TENANT_A = 'source-api-tenant-a';
const TENANT_B = 'source-api-tenant-b';
const USER_A = 'source-api-user-a';
const USER_B = 'source-api-user-b';
const WORKER_A = 'source-api-worker-a';
const WORKER_B = 'source-api-worker-b';

const GITHUB_SOURCE = 'github-fixture';
const GITHUB_ALIAS_SOURCE = 'github-catalog-alias';
const TESSL_SOURCE = 'tessl';
const GITHUB_EXTERNAL_ID = 'acme/github-source/github-skill';
const TESSL_EXTERNAL_ID = 'workspace/tessl-skill';
const GITHUB_REPOSITORY = 'acme/github-source';
const GITHUB_PATH = 'skills/github-skill';
const GITHUB_COMMIT = 'a'.repeat(40);
const TESSL_WORKSPACE = 'workspace';
const TESSL_TILE = 'tessl-tile';
const TESSL_VERSION = '2.0.0';
const TESSL_SKILL_PATH = 'skills/tessl-skill';
const TESSL_FINGERPRINT = 'b'.repeat(64);

const REQUIRED_POLICY: Policy = {
  revision: 'source-proxy-required-v1',
  scanners: [{
    id: 'skillsguard',
    mode: 'required',
    blockSeverities: ['high', 'critical'],
    timeoutSeconds: 5,
  }],
  allowUnscanned: false,
  evidenceMaxAgeSeconds: 3_600,
  hooks: [],
};

type JsonObject = Record<string, unknown>;

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function fixtureBundle(name: string, description: string): SkillBundle {
  return {
    format: 'pskills-bundle-v1',
    files: [
      {
        path: 'SKILL.md',
        content: base64(`---\nname: ${name}\ndescription: ${description}\n---\n\nNever execute this fixture.\n`),
      },
      { path: 'README.md', content: base64(`# ${name}\n`) },
    ],
  };
}

function responseJson(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function blobSha(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]))
    .digest('hex');
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii').copy(header, offset);
}

function gzipTar(entries: readonly { path: string; bytes: Uint8Array }[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    Buffer.from(entry.path, 'utf8').copy(header, 0, 0, 100);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.bytes.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header[156] = 0;
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const value of header) checksum += value;
    Buffer.from(`${checksum.toString(8).padStart(6, '0')} \0`, 'ascii').copy(header, 148);
    chunks.push(header);
    if (entry.bytes.byteLength > 0) {
      const padded = Buffer.alloc(Math.ceil(entry.bytes.byteLength / 512) * 512);
      Buffer.from(entry.bytes).copy(padded);
      chunks.push(padded);
    }
  }
  chunks.push(Buffer.alloc(1_024));
  return Uint8Array.from(gzipSync(Buffer.concat(chunks)));
}

function headers(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function call(
  handler: RegistryHandler,
  path: string,
  token: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json: value, ...requestInit } = init;
  const requestHeaders = new Headers(requestInit.headers ?? headers(token));
  if (!requestHeaders.has('authorization')) requestHeaders.set('authorization', `Bearer ${token}`);
  if (value !== undefined) {
    requestInit.body = JSON.stringify(value);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
  }
  return handler(new Request(new URL(path, ORIGIN), { ...requestInit, headers: requestHeaders }));
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  putCalls = 0;
  private nextKey = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    this.putCalls += 1;
    const copy = bytes.slice();
    const stored = {
      key: `source-proxy-${this.nextKey++}`,
      digest: await digestBytes(copy),
      size: copy.byteLength,
    } satisfies StoredBlob;
    this.values.set(stored.key, copy);
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
}

class FixtureSourceAdapter implements SourceCatalogAdapter {
  readonly capabilities = ['search', 'resolve'] as const;
  enabled = true;
  configRevision: string;
  readonly searchInputs: SourceSearchRequest[] = [];
  readonly resolveInputs: SourceResolveRequest[] = [];
  readonly availabilityTenants: string[] = [];

  constructor(
    readonly id: SourceId,
    readonly label: string,
    private readonly row: SourceSearchResult,
    private readonly acquisition: SourceResolution['acquisition'],
    revision: string,
  ) {
    this.configRevision = revision;
  }

  availability(input: { organizationId: string }): SourceAvailability {
    this.availabilityTenants.push(input.organizationId);
    return this.enabled
      ? { state: 'available' }
      : { state: 'disabled', reason: 'fixture source disabled' };
  }

  async search(input: SourceSearchRequest): Promise<readonly SourceSearchResult[]> {
    this.searchInputs.push({ ...input });
    return [this.row];
  }

  async resolve(input: SourceResolveRequest): Promise<SourceResolution> {
    this.resolveInputs.push({ ...input });
    if (input.externalId !== this.row.externalId) {
      throw new Error(`unknown fixture external id ${input.externalId}`);
    }
    return {
      sourceId: this.id,
      externalId: this.row.externalId,
      row: this.row,
      reference: this.id === TESSL_SOURCE
        ? `@tessl/${TESSL_WORKSPACE}/${TESSL_TILE}/${TESSL_SKILL_PATH}@${TESSL_VERSION}`
        : `@github/${GITHUB_REPOSITORY}/${GITHUB_PATH}`,
      title: this.row.title,
      description: this.row.description,
      version: this.row.version ?? '1.0.0',
      sourceType: this.row.sourceType,
      sourceUrl: this.row.sourceUrl,
      metadata: this.row.metadata,
      acquisition: this.acquisition,
      configRevision: this.configRevision,
      resolvedAt: '2026-09-14T00:00:00.000Z',
    };
  }
}

interface CatalogFixture {
  github: FixtureSourceAdapter;
  githubAlias: FixtureSourceAdapter;
  tessl: FixtureSourceAdapter;
  configuration: SourceCatalogConfiguration;
  client: SourceCatalogClient;
}

function createCatalogFixture(tesslDigest: Digest): CatalogFixture {
  const githubRow: SourceSearchResult = {
    sourceId: GITHUB_SOURCE,
    externalId: GITHUB_EXTERNAL_ID,
    title: 'GitHub fixture skill',
    description: 'A complete GitHub source fixture.',
    version: '1.0.0',
    sourceUrl: `https://github.com/${GITHUB_REPOSITORY}/tree/main/${GITHUB_PATH}`,
    repository: GITHUB_REPOSITORY,
    path: GITHUB_PATH,
    ref: GITHUB_COMMIT,
    installable: true,
    sourceType: 'github',
    metadata: { fixture: true },
  };
  const tesslRow: SourceSearchResult = {
    sourceId: TESSL_SOURCE,
    externalId: TESSL_EXTERNAL_ID,
    title: 'Tessl fixture skill',
    description: 'A complete Tessl source fixture.',
    version: '2.0.0',
    sourceUrl: 'https://api.tessl.io/catalog/workspace/tessl-skill',
    path: 'workspace/tessl-skill',
    ref: '2.0.0',
    installable: true,
    sourceType: 'tessl',
    snapshotDigest: tesslDigest,
    metadata: { fixture: true },
  };
  const github = new FixtureSourceAdapter(
    GITHUB_SOURCE,
    'GitHub fixture',
    githubRow,
    {
      kind: 'github',
      repository: GITHUB_REPOSITORY,
      path: GITHUB_PATH,
      ref: GITHUB_COMMIT,
      sourceProviderOrigin: 'https://github.com',
    },
    'github-revision-1',
  );
  const githubAlias = new FixtureSourceAdapter(
    GITHUB_ALIAS_SOURCE,
    'GitHub catalog alias fixture',
    { ...githubRow, sourceId: GITHUB_ALIAS_SOURCE },
    {
      kind: 'github',
      repository: GITHUB_REPOSITORY,
      path: GITHUB_PATH,
      ref: GITHUB_COMMIT,
      sourceProviderOrigin: 'https://github.com',
    },
    'github-revision-1',
  );
  const tessl = new FixtureSourceAdapter(
    TESSL_SOURCE,
    'Tessl fixture',
    tesslRow,
    {
      kind: 'tessl',
      workspace: TESSL_WORKSPACE,
      tile: TESSL_TILE,
      version: TESSL_VERSION,
      fingerprint: TESSL_FINGERPRINT,
      skillPath: TESSL_SKILL_PATH,
      sourceProviderOrigin: 'https://api.tessl.io',
      artifactDigest: tesslDigest,
    },
    'tessl-revision-1',
  );
  const configuration: SourceCatalogConfiguration = {
    sources: {
      [GITHUB_SOURCE]: { enabled: true, trustedOrigins: ['https://github.com'] },
      [GITHUB_ALIAS_SOURCE]: { enabled: true, trustedOrigins: ['https://github.com'] },
      [TESSL_SOURCE]: { enabled: true, trustedOrigins: ['https://api.tessl.io'] },
    },
  };
  return {
    github,
    githubAlias,
    tessl,
    configuration,
    client: new SourceCatalogClient({ adapters: [github, githubAlias, tessl], configuration }),
  };
}

interface SourceFixture {
  githubBundle: SkillBundle;
  tesslBundle: SkillBundle;
  tesslDigest: Digest;
  calls: Array<{ url: string; method: string }>;
  fetch: FetchLike;
}

async function createSourceFixture(): Promise<SourceFixture> {
  const githubBundle = fixtureBundle('github-skill', 'GitHub source fixture');
  const tesslBundle = fixtureBundle('tessl-skill', 'Tessl source fixture');
  const tesslBytes = gzipTar(tesslBundle.files.map((file) => ({
    path: `${TESSL_SKILL_PATH}/${file.path}`,
    bytes: Uint8Array.from(Buffer.from(file.content, 'base64')),
  })));
  const tesslDigest = await digestBytes(tesslBytes);
  const githubSkill = Buffer.from(githubBundle.files.find((file) => file.path === 'SKILL.md')!.content, 'base64').toString('utf8');
  const githubReadme = Buffer.from(githubBundle.files.find((file) => file.path === 'README.md')!.content, 'base64').toString('utf8');
  const githubSkillSha = blobSha(githubSkill);
  const githubReadmeSha = blobSha(githubReadme);
  const calls: Array<{ url: string; method: string }> = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url: url.href, method });

    if (url.origin === 'https://api.github.com') {
      if (url.pathname === `/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_COMMIT}`) {
        return responseJson({ sha: GITHUB_COMMIT });
      }
      if (url.pathname === `/repos/${GITHUB_REPOSITORY}/git/trees/${GITHUB_COMMIT}` && url.searchParams.get('recursive') === '1') {
        return responseJson({
          sha: GITHUB_COMMIT,
          truncated: false,
          tree: [
            { path: `${GITHUB_PATH}/SKILL.md`, type: 'blob', mode: '100644', sha: githubSkillSha, size: Buffer.byteLength(githubSkill) },
            { path: `${GITHUB_PATH}/README.md`, type: 'blob', mode: '100644', sha: githubReadmeSha, size: Buffer.byteLength(githubReadme) },
          ],
        });
      }
      if (url.pathname === `/repos/${GITHUB_REPOSITORY}/git/blobs/${githubSkillSha}`) {
        return responseJson({ content: Buffer.from(githubSkill).toString('base64'), encoding: 'base64', sha: githubSkillSha, size: Buffer.byteLength(githubSkill) });
      }
      if (url.pathname === `/repos/${GITHUB_REPOSITORY}/git/blobs/${githubReadmeSha}`) {
        return responseJson({ content: Buffer.from(githubReadme).toString('base64'), encoding: 'base64', sha: githubReadmeSha, size: Buffer.byteLength(githubReadme) });
      }
    }

    if (url.origin === 'https://api.tessl.io') {
      if (url.pathname === `/v1/tiles/${TESSL_WORKSPACE}/${TESSL_TILE}/versions/${TESSL_VERSION}` && method === 'GET') {
        return responseJson({ data: { attributes: { fingerprint: TESSL_FINGERPRINT } } });
      }
      if (url.pathname === `/v1/tiles/${TESSL_WORKSPACE}/${TESSL_TILE}/versions/${TESSL_VERSION}/files` && method === 'GET') {
        return new Response(tesslBytes as BodyInit, {
          status: 200,
          headers: { 'content-type': 'application/gzip', 'content-length': String(tesslBytes.byteLength) },
        });
      }
    }

    throw new Error(`unexpected fixture source request ${method} ${url.href}`);
  }) as unknown as FetchLike;
  return { githubBundle, tesslBundle, tesslDigest, calls, fetch };
}

function deterministicScanner(options: { fail?: boolean } = {}): ScannerAdapter {
  return {
    id: 'skillsguard',
    command: 'source-proxy-deterministic-scanner',
    metadata: {
      id: 'skillsguard',
      version: 'fixture',
      engineVersion: 'fixture',
      rulesRevision: 'fixture',
    },
    scan: async (input) => {
      const entries = await readdir(input.inputDir, { withFileTypes: true });
      const fileCount = entries.filter((entry) => entry.isFile()).length;
      return {
        result: {
          schemaVersion: 1,
          organizationId: input.organizationId,
          jobId: input.jobId,
          invocationId: `source-proxy-${input.jobId}`,
          artifactDigest: input.artifactDigest,
          policyRevision: input.policyRevision,
          adapter: {
            id: 'skillsguard',
            version: 'fixture',
            engineVersion: 'fixture',
            rulesRevision: 'fixture',
            configurationHash: `sha256:${'1'.repeat(64)}`,
          },
          status: options.fail ? 'error' : 'completed',
          durationMs: 1,
          coverage: {
            filesEnumerated: fileCount,
            filesAnalyzed: fileCount,
            filesSkipped: 0,
            filesUnsupported: 0,
            limitations: ['deterministic local source-proxy fixture scanner'],
            externalDestinations: [],
          },
          findings: [],
          ...(options.fail ? { error: 'required fixture scanner failure' } : {}),
        },
      };
    },
  };
}

interface Harness {
  organizationId: string;
  token: string;
  workerToken: string;
  repository: MemoryStateRepository;
  blobs: MemoryBlobs;
  handler: RegistryHandler;
  runner: WorkerRunner;
}

function createHarness(input: {
  organizationId: string;
  token: string;
  workerToken: string;
  repository: MemoryStateRepository;
  catalog: CatalogFixture;
  sourceFetch: FetchLike;
  scannerFails?: boolean;
}): Harness {
  const user: Principal & { scopes: string[] } = {
    organizationId: input.organizationId,
    subject: input.token,
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: ['@team', '@github', '@tessl'],
    scopes: ['*'],
  };
  const worker: Principal & { identity: 'worker'; scopes: string[] } = {
    organizationId: input.organizationId,
    subject: input.workerToken,
    roles: ['worker'],
    identity: 'worker',
    scopes: ['*'],
  };
  const principals = new Map<string, Principal>([
    [input.token, user],
    [input.workerToken, worker],
  ]);
  const auth: Authenticator = {
    authenticate: async (request) => principals.get((request.headers.get('authorization') ?? '').replace('Bearer ', '')) ?? null,
  };
  const blobs = new MemoryBlobs();
  const config: RegistryConfiguration = {
    publicOrigin: ORIGIN,
    maxBodyBytes: 2 * 1024 * 1024,
    organizationId: input.organizationId,
    leaseSeconds: 60,
  };
  const handler = createRegistryHandler({
    repository: input.repository,
    blobs,
    auth,
    config,
    // This is the server-side source seam. The browser only supplies the
    // external identity; acquisition comes from the injected adapter result.
    sourceCatalog: input.catalog.client,
  } as unknown as Parameters<typeof createRegistryHandler>[0]);
  const runner = new WorkerRunner({
    baseUrl: ORIGIN,
    workerToken: input.workerToken,
    workerId: `source-proxy-${input.organizationId}`,
    fetch: async (request, init) => handler(new Request(String(request), init)),
    acquisition: {
      fetchImpl: input.sourceFetch,
      allowLoopbackForTests: true,
      tessl: { apiBaseUrl: 'https://api.tessl.io' },
    },
    adapters: [deterministicScanner({ fail: input.scannerFails })],
    executor: { run: async () => { throw new Error('fixture scanner must use its deterministic adapter'); } },
  });
  return {
    organizationId: input.organizationId,
    token: input.token,
    workerToken: input.workerToken,
    repository: input.repository,
    blobs,
    handler,
    runner,
  };
}

async function createRepository(): Promise<MemoryStateRepository> {
  return createMemoryStateRepository({
    stateFactory: () => {
      const state = defaultRegistryState({ production: false, allowUnscanned: false });
      state.policy = structuredClone(REQUIRED_POLICY);
      return state;
    },
  });
}

async function transferBundle(
  harness: Harness,
  resolution: JsonObject,
): Promise<SkillBundle> {
  const authorizationResponse = await call(harness.handler, '/v1/install-authorizations', harness.token, {
    method: 'POST',
    json: { resolution },
  });
  expect(authorizationResponse.status, await authorizationResponse.clone().text()).toBe(201);
  const authorization = await json<{ authorization: { id: string } }>(authorizationResponse);
  const member = Array.isArray(resolution.members) ? resolution.members[0] as JsonObject | undefined : undefined;
  const memberId = typeof member?.id === 'string' ? member.id : member?.resourceId;
  const memberDigest = typeof member?.artifact === 'object' && member.artifact !== null
    ? (member.artifact as JsonObject).digest
    : member?.digest;
  if (!member || typeof memberId !== 'string' || typeof memberDigest !== 'string') throw new Error('resolution has no transferable member');
  const descriptorResponse = await call(harness.handler, `/v1/artifacts/${encodeURIComponent(memberDigest)}/download`, harness.token, {
    method: 'POST',
    json: { resourceId: memberId, authorizationId: authorization.authorization.id },
  });
  expect(descriptorResponse.status, await descriptorResponse.clone().text()).toBe(200);
  const descriptorBody = await json<{ descriptor?: TransferDescriptor } & TransferDescriptor>(descriptorResponse);
  const descriptor = descriptorBody.descriptor ?? descriptorBody;
  const transferURL = new URL(descriptor.url);
  const transferred = await call(harness.handler, `${transferURL.pathname}${transferURL.search}`, harness.token);
  expect(transferred.status, await transferred.clone().text()).toBe(200);
  const bytes = new Uint8Array(await transferred.arrayBuffer());
  expect(await digestBytes(bytes)).toBe(memberDigest);
  return decodeBundle(bytes);
}

function importJobs(state: Awaited<ReturnType<MemoryStateRepository['read']>>): Job[] {
  return state.jobs.filter((job) => job.kind === 'import');
}

describe('multi-source proxy API acceptance', () => {
  it('lists and searches source metadata, queues one cold import, scans the complete bundle, and serves a warm cache hit', async () => {
    const source = await createSourceFixture();
    const catalog = createCatalogFixture(source.tesslDigest);
    const repository = await createRepository();
    const harness = createHarness({
      organizationId: TENANT_A,
      token: USER_A,
      workerToken: WORKER_A,
      repository,
      catalog,
      sourceFetch: source.fetch,
    });

    const listed = await call(harness.handler, '/v1/sources', harness.token);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const listedBody = await json<{ sources: Array<{ id: string; capabilities: string[]; availability: { state: string }; configRevision: string }> }>(listed);
    expect(listedBody.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: GITHUB_SOURCE, capabilities: ['search', 'resolve'], availability: { state: 'available' } }),
      expect.objectContaining({ id: GITHUB_ALIAS_SOURCE, capabilities: ['search', 'resolve'], availability: { state: 'available' } }),
      expect.objectContaining({ id: TESSL_SOURCE, capabilities: ['search', 'resolve'], availability: { state: 'available' } }),
    ]));

    const searched = await call(harness.handler, '/v1/sources/search?q=fixture&limit=10', harness.token);
    expect(searched.status, await searched.clone().text()).toBe(200);
    const searchedBody = await json<{ data: SourceSearchResult[]; sources: Array<{ id: string; resultCount: number }> }>(searched);
    expect(searchedBody.data.map((row) => row.sourceId)).toEqual([GITHUB_SOURCE, GITHUB_ALIAS_SOURCE, TESSL_SOURCE]);
    expect(searchedBody.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: GITHUB_SOURCE, resultCount: 1 }),
      expect.objectContaining({ id: GITHUB_ALIAS_SOURCE, resultCount: 1 }),
      expect.objectContaining({ id: TESSL_SOURCE, resultCount: 1 }),
    ]));
    const tesslSearch = await call(harness.handler, `/v1/sources/search?q=fixture&source=${encodeURIComponent(TESSL_SOURCE)}&limit=1`, harness.token);
    expect(tesslSearch.status).toBe(200);
    expect((await json<{ data: SourceSearchResult[] }>(tesslSearch)).data.map((row) => row.sourceId)).toEqual([TESSL_SOURCE]);
    expect(source.calls).toHaveLength(0);

    const maliciousBody = {
      externalId: GITHUB_EXTERNAL_ID,
      refresh: false,
      url: 'https://attacker.invalid/payload.zip',
      acquisition: { kind: 'registry', baseUrl: 'https://attacker.invalid', package: 'attacker', version: '9.9.9' },
      name: '@attacker/injected-name',
    };
    const maliciousResponse = await call(harness.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, harness.token, { method: 'POST', json: maliciousBody });
    expect(maliciousResponse.status).toBe(400);
    expect(await json<JsonObject>(maliciousResponse)).not.toHaveProperty('operation');
    expect(catalog.github.resolveInputs).toHaveLength(0);
    expect(importJobs(await repository.read(TENANT_A))).toHaveLength(0);

    const coldResponses = await Promise.all([
      call(harness.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, harness.token, { method: 'POST', json: { externalId: GITHUB_EXTERNAL_ID } }),
      call(harness.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, harness.token, { method: 'POST', json: { externalId: GITHUB_EXTERNAL_ID } }),
    ]);
    expect(coldResponses.map((response) => response.status)).toEqual([202, 202]);
    const coldBodies = await Promise.all(coldResponses.map((response) => json<{ sourceId: string; externalId: string; reference?: string; operation: { id: string; state: string } }>(response)));
    expect(new Set(coldBodies.map((body) => body.operation.id)).size).toBe(1);
    expect(coldBodies[0]).toMatchObject({ sourceId: GITHUB_SOURCE, externalId: GITHUB_EXTERNAL_ID, reference: `@github/${GITHUB_REPOSITORY}/${GITHUB_PATH}` });
    expect(coldBodies[0]?.operation).toMatchObject({ id: expect.any(String), state: 'queued' });
    expect(coldBodies[0]?.operation).not.toHaveProperty('upstream');
    expect(coldBodies[0]?.operation).not.toHaveProperty('import');
    expect(coldBodies[0]?.operation).not.toHaveProperty('sourceAcquisition');
    expect(coldBodies[0]?.operation).not.toHaveProperty('baseUrl');
    expect(coldBodies[0]).not.toHaveProperty('acquisition');
    expect(coldBodies[0]).not.toHaveProperty('url');
    expect(catalog.github.resolveInputs.every((input) => input.sourceId === GITHUB_SOURCE && input.externalId === GITHUB_EXTERNAL_ID && input.organizationId === TENANT_A)).toBe(true);

    const pending = await repository.read(TENANT_A);
    expect(importJobs(pending)).toHaveLength(1);
    expect(pending.skills).toHaveLength(0);
    expect(harness.blobs.putCalls).toBe(0);
    expect(source.calls).toHaveLength(0);
    const queuedJob = importJobs(pending)[0]!;
    expect(queuedJob.import?.path).toBe(GITHUB_PATH);
    expect(queuedJob.import?.repository).toBe(GITHUB_REPOSITORY);
    expect(queuedJob.import?.path).not.toContain('attacker');
    expect(queuedJob.upstream?.baseUrl).not.toContain('attacker');

    const run = await harness.runner.runOnce();
    expect(run.error).toBeUndefined();
    expect(run.allow).toBe(true);
    expect(run.scannerResults).toEqual([expect.objectContaining({
      scannerId: 'skillsguard',
      status: 'completed',
      coverage: expect.objectContaining({ filesEnumerated: 2, filesAnalyzed: 2, filesSkipped: 0, filesUnsupported: 0 }),
    })]);
    expect(source.calls.some((entry) => entry.url.includes('api.github.com'))).toBe(true);
    const sourceCallsAfterApproval = source.calls.length;
    const providerResolveCallsAfterApproval = catalog.github.resolveInputs.length;
    const blobsAfterApproval = harness.blobs.putCalls;

    const warm = await call(harness.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, harness.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect(warm.status, await warm.clone().text()).toBe(200);
    const warmBody = await json<{ sourceId: string; externalId: string; reference: string; resolution: JsonObject }>(warm);
    expect(warmBody).toMatchObject({ sourceId: GITHUB_SOURCE, externalId: GITHUB_EXTERNAL_ID, reference: `@github/${GITHUB_REPOSITORY}/${GITHUB_PATH}` });
    expect(warmBody.resolution).not.toHaveProperty('acquisition');
    expect(source.calls).toHaveLength(sourceCallsAfterApproval);
    expect(catalog.github.resolveInputs.length).toBe(providerResolveCallsAfterApproval);
    expect(harness.blobs.putCalls).toBe(blobsAfterApproval);

    const resolution = warmBody.resolution;
    const aliasWarm = await call(harness.handler, `/v1/sources/${GITHUB_ALIAS_SOURCE}/resolve`, harness.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect(aliasWarm.status, await aliasWarm.clone().text()).toBe(200);
    const aliasWarmBody = await json<{ sourceId: string; reference: string; resolution: JsonObject }>(aliasWarm);
    expect(aliasWarmBody).toMatchObject({ sourceId: GITHUB_ALIAS_SOURCE, reference: `@github/${GITHUB_REPOSITORY}/${GITHUB_PATH}` });
    expect(aliasWarmBody.resolution).toEqual(resolution);
    expect(catalog.githubAlias.resolveInputs).toHaveLength(1);
    expect(catalog.githubAlias.resolveInputs[0]).toMatchObject({
      sourceId: GITHUB_ALIAS_SOURCE,
      externalId: GITHUB_EXTERNAL_ID,
      organizationId: TENANT_A,
    });
    const aliasWarmAgain = await call(harness.handler, `/v1/sources/${GITHUB_ALIAS_SOURCE}/resolve`, harness.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect(aliasWarmAgain.status).toBe(200);
    expect((await json<{ resolution: JsonObject }>(aliasWarmAgain)).resolution).toEqual(resolution);
    expect(catalog.githubAlias.resolveInputs).toHaveLength(1);
    expect(source.calls).toHaveLength(sourceCallsAfterApproval);
    expect(harness.blobs.putCalls).toBe(blobsAfterApproval);
    const aliasedJob = importJobs(await repository.read(TENANT_A))[0]!;
    expect(aliasedJob.sourceCatalogAliases).toEqual([{
      sourceId: GITHUB_ALIAS_SOURCE,
      externalId: GITHUB_EXTERNAL_ID,
      configRevision: expect.stringContaining('github-revision-1'),
    }]);
    const member = (resolution.members as Array<JsonObject>)[0]!;
    expect(member.state).toBe('approved');
    expect(member.name).not.toBe('@attacker/injected-name');
    expect(member.fileCount).toBe(2);
    const stored = await harness.blobs.get(String((member.artifact as JsonObject).key));
    expect(decodeBundle(stored).files.map((file) => file.path)).toEqual(['README.md', 'SKILL.md']);
    const transferred = await transferBundle(harness, resolution);
    expect(transferred.files.map((file) => file.path)).toEqual(['README.md', 'SKILL.md']);
    expect(Buffer.from(transferred.files.find((file) => file.path === 'SKILL.md')!.content, 'base64').toString('utf8')).toContain('Never execute this fixture.');
  });

  it('keeps source cache and operations tenant-scoped, requeues on config revision changes, and denies disabled warm resolves', async () => {
    const source = await createSourceFixture();
    const catalog = createCatalogFixture(source.tesslDigest);
    const repository = await createRepository();
    const tenantA = createHarness({ organizationId: TENANT_A, token: USER_A, workerToken: WORKER_A, repository, catalog, sourceFetch: source.fetch });
    const tenantB = createHarness({ organizationId: TENANT_B, token: USER_B, workerToken: WORKER_B, repository, catalog, sourceFetch: source.fetch });

    const coldA = await call(tenantA.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, tenantA.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect(coldA.status).toBe(202);
    const operationA = (await json<{ operation: { id: string } }>(coldA)).operation.id;
    const runA = await tenantA.runner.runOnce();
    expect(runA.allow, JSON.stringify(runA)).toBe(true);
    const stateA = await repository.read(TENANT_A);
    const sourceCallsAfterA = source.calls.length;
    expect(stateA.skills).toHaveLength(1);

    const wrongHandlerTenant = await call(tenantA.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, tenantB.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect([401, 403]).toContain(wrongHandlerTenant.status);

    const coldB = await call(tenantB.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, tenantB.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect(coldB.status).toBe(202);
    const operationB = (await json<{ operation: { id: string } }>(coldB)).operation.id;
    expect(operationB).not.toBe(operationA);
    expect((await repository.read(TENANT_B)).skills).toHaveLength(0);
    const runB = await tenantB.runner.runOnce();
    expect(runB.allow, JSON.stringify(runB)).toBe(true);
    const stateB = await repository.read(TENANT_B);
    expect(stateB.skills).toHaveLength(1);
    expect(stateB.skills[0]!.id).not.toBe(stateA.skills[0]!.id);
    expect(stateA.skills.every((skill) => skill.organizationId === TENANT_A)).toBe(true);
    expect(stateB.skills.every((skill) => skill.organizationId === TENANT_B)).toBe(true);
    expect(source.calls.length).toBeGreaterThan(sourceCallsAfterA);

    const warmB = await call(tenantB.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, tenantB.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect(warmB.status).toBe(200);
    const warmBBody = await json<{ resolution: JsonObject }>(warmB);
    expect((warmBBody.resolution.members as Array<JsonObject>)[0]!.id).toBe(stateB.skills[0]!.id);
    const sourceCallsBeforeRevision = source.calls.length;

    catalog.github.configRevision = 'github-revision-2';
    const changedDescriptor = await call(tenantA.handler, '/v1/sources', tenantA.token);
    expect(changedDescriptor.status).toBe(200);
    const changedDescriptorBody = await json<{ sources: Array<{ id: string; configRevision: string }> }>(changedDescriptor);
    expect(changedDescriptorBody.sources.find((entry) => entry.id === GITHUB_SOURCE)?.configRevision).toContain('github-revision-2');
    const changedResolve = await call(tenantA.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, tenantA.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect(changedResolve.status).toBe(202);
    expect(source.calls.length).toBe(sourceCallsBeforeRevision);

    const providerResolveCallsBeforeDisabled = catalog.github.resolveInputs.length;
    catalog.configuration.sources![GITHUB_SOURCE]!.enabled = false;
    const disabledList = await call(tenantA.handler, '/v1/sources', tenantA.token);
    expect(disabledList.status).toBe(200);
    const disabledListBody = await json<{ sources: Array<{ id: string; availability: { state: string } }> }>(disabledList);
    expect(disabledListBody.sources.find((entry) => entry.id === GITHUB_SOURCE)?.availability.state).toBe('disabled');
    const disabledWarm = await call(tenantA.handler, `/v1/sources/${GITHUB_SOURCE}/resolve`, tenantA.token, {
      method: 'POST',
      json: { externalId: GITHUB_EXTERNAL_ID },
    });
    expect(disabledWarm.status).toBe(403);
    expect(source.calls.length).toBe(sourceCallsBeforeRevision);
    expect(catalog.github.resolveInputs.length).toBe(providerResolveCallsBeforeDisabled);
  });

  it('keeps a required scanner failure out of the approved cache and distribution path', async () => {
    const source = await createSourceFixture();
    const catalog = createCatalogFixture(source.tesslDigest);
    const repository = await createRepository();
    const harness = createHarness({
      organizationId: TENANT_A,
      token: USER_A,
      workerToken: WORKER_A,
      repository,
      catalog,
      sourceFetch: source.fetch,
      scannerFails: true,
    });
    const queued = await call(harness.handler, `/v1/sources/${TESSL_SOURCE}/resolve`, harness.token, {
      method: 'POST',
      json: { externalId: TESSL_EXTERNAL_ID },
    });
    expect(queued.status).toBe(202);
    const run = await harness.runner.runOnce();
    expect(run.allow, JSON.stringify(run)).toBe(false);
    const failedState = await repository.read(TENANT_A);
    expect(failedState.skills).toHaveLength(1);
    expect(failedState.skills[0]!.state).toBe('scan-error');
    expect(failedState.skills[0]!.approvedAt).toBeUndefined();
    expect(failedState.scans).toEqual([expect.objectContaining({
      scannerId: 'skillsguard',
      status: 'error',
      policyRevision: REQUIRED_POLICY.revision,
      coverage: expect.objectContaining({ filesEnumerated: 2, filesAnalyzed: 2 }),
    })]);
    const failedSkill = failedState.skills[0]!;
    const rejectedAuthorization = await call(harness.handler, '/v1/install-authorizations', harness.token, {
      method: 'POST',
      json: { resolution: { kind: 'skill', resourceId: failedSkill.id, version: failedSkill.version } },
    });
    expect([404, 409]).toContain(rejectedAuthorization.status);

    const retry = await call(harness.handler, `/v1/sources/${TESSL_SOURCE}/resolve`, harness.token, {
      method: 'POST',
      json: { externalId: TESSL_EXTERNAL_ID },
    });
    expect(retry.status).toBe(202);
    const retryBody = await json<{ operation: { id: string } }>(retry);
    const firstJob = importJobs(failedState)[0]!;
    expect(retryBody.operation.id).not.toBe(firstJob.id);
  });
});
