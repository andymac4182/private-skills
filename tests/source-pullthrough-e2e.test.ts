import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Feed, Job, Policy, Resolution, SkillVersion, TransferDescriptor } from '../packages/contracts/src/index.js';
import type { RegistryDirectoryClient } from '../packages/core/src/index.js';
import {
  createFileStateRepository,
  defaultRegistryState,
  type StateRepository,
} from '../packages/database/src/index.js';
import type { SkillDetailResponse, V1Skill } from '../packages/directory/src/types.js';
import { digestBytes, decodeBundle } from '../packages/storage/src/index.js';
import type { ScannerAdapter } from '../packages/scanners/src/types.js';
import type { FetchLike } from '../packages/upstreams/src/index.js';
import { WorkerRunner } from '../workers/runner/src/index.js';
import {
  bearer,
  createLocalRegistryHarness,
  jsonResponse,
  request,
  type LocalRegistryHarness,
} from './e2e/harness.js';

// The source fixture uses the canonical GitHub API URL but injects all HTTP
// requests into the local fixture below. Keep the production DNS/SSRF checks
// active while resolving that canonical name to the fixture loopback address.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
}));

/**
 * This fixture intentionally exercises the no-snapshot source path. The
 * injected fetch is a bounded local provider fixture; it never executes a
 * downloaded skill and it does not claim that a third-party scanner ran.
 */
const CATALOG_BASE = 'http://127.0.0.1:55101/catalog';
const CATALOG_ORIGIN = new URL(CATALOG_BASE).origin;
const REGISTRY_ORIGIN = 'http://source-pullthrough.test';
const ORGANIZATION_ID = 'org-e2e';
const POLICY: Policy = {
  revision: 'source-pullthrough-required',
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

function durableFixtureState(): ReturnType<typeof defaultRegistryState> {
  const base = defaultRegistryState({ production: false, allowUnscanned: false });
  return { ...base, policy: structuredClone(POLICY) };
}

type SourceKind = 'github' | 'well-known';

interface SourceFixture {
  kind: SourceKind;
  externalId: string;
  source: string;
  slug: string;
  name: string;
  installUrl: string;
  detail: SkillDetailResponse;
  row: V1Skill;
  files: ReadonlyMap<string, string>;
  sourceFetch: ReturnType<typeof vi.fn>;
}

interface DirectoryCallCounts {
  detail: number;
  search: number;
  list: number;
}

function deterministicScanner(): ScannerAdapter {
  return {
    id: 'skillsguard',
    command: 'fixture-deterministic-scanner',
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
          invocationId: `fixture-${input.jobId}`,
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
            filesEnumerated: fileCount,
            filesAnalyzed: fileCount,
            filesSkipped: 0,
            filesUnsupported: 0,
            limitations: ['deterministic local fixture scanner'],
            externalDestinations: [],
          },
          findings: [],
        },
      };
    },
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(value: string): Response {
  return new Response(value, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function githubBlobSha(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest('hex');
}

function sha256Digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;
}

function githubTree(fixture: Pick<SourceFixture, 'kind' | 'slug'>): {
  commit: string;
  entries: Array<Record<string, unknown>>;
  blobs: Map<string, string>;
} {
  const commit = 'a'.repeat(40);
  const skillPath = fixture.slug === 'root-skill' ? 'SKILL.md' : `skills/${fixture.slug}/SKILL.md`;
  const readmePath = fixture.slug === 'root-skill' ? 'README.md' : `skills/${fixture.slug}/README.md`;
  const skillContents = `---\nname: ${fixture.slug}\ndescription: A deterministic source fixture.\n---\n\nNever execute this fixture.\n`;
  const readmeContents = `# ${fixture.slug}\n`;
  const skillSha = githubBlobSha(skillContents);
  const readmeSha = githubBlobSha(readmeContents);
  const blobs = new Map<string, string>([
    [skillSha, skillContents],
    [readmeSha, readmeContents],
  ]);
  return {
    commit,
    entries: [
      { path: skillPath, type: 'blob', mode: '100644', sha: skillSha, size: Buffer.byteLength(skillContents) },
      { path: readmePath, type: 'blob', mode: '100644', sha: readmeSha, size: Buffer.byteLength(readmeContents) },
    ],
    blobs,
  };
}

function makeFixture(kind: SourceKind, slug: string): SourceFixture {
  const source = kind === 'github'
    ? slug === 'root-skill' ? 'acme/root-repo' : 'acme/nested-repo'
    : 'docs.example';
  const externalId = `${source}/${slug}`;
  const installUrl = kind === 'github'
    ? `https://github.com/${source}`
    : 'https://docs.example/published';
  const sourceOrigin = new URL(installUrl).origin;
  const files = kind === 'github'
    ? new Map<string, string>([
      ['SKILL.md', `---\nname: ${slug}\ndescription: A deterministic source fixture.\n---\n\nNever execute this fixture.\n`],
      ['README.md', `# ${slug}\n`],
    ])
    : new Map<string, string>([
      ['SKILL.md', `---\nname: ${slug}\ndescription: A deterministic well-known fixture.\n---\n\nNever execute this fixture.\n`],
    ]);
  const detail: SkillDetailResponse = {
    id: externalId,
    source,
    slug,
    installs: 1,
    hash: null,
    files: null,
  };
  const row: V1Skill = {
    id: externalId,
    source,
    slug,
    name: slug,
    installs: 1,
    sourceType: kind,
    installUrl,
    url: `https://skills.sh/${externalId}`,
  };
  const catalogPath = `/catalog/api/v1/skills/${externalId.split('/').map(encodeURIComponent).join('/')}`;
  const tree = kind === 'github' ? githubTree({ kind, slug }) : undefined;
  const sourceFetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin === CATALOG_ORIGIN && url.pathname === catalogPath) {
      return responseJson({
        ...detail,
        name: slug,
        sourceType: kind,
        installUrl,
        url: row.url,
      });
    }

    if (kind === 'github' && url.origin === 'https://api.github.com') {
      const repository = source;
      if (url.pathname === `/repos/${repository}`) return responseJson({ default_branch: 'main' });
      if (url.pathname === `/repos/${repository}/commits/main`) return responseJson({ sha: tree!.commit });
      if (url.pathname === `/repos/${repository}/git/trees/${tree!.commit}` && url.searchParams.get('recursive') === '1') {
        return responseJson({ sha: tree!.commit, truncated: false, tree: tree!.entries });
      }
      const blobPrefix = `/repos/${repository}/git/blobs/`;
      if (url.pathname.startsWith(blobPrefix)) {
        const sha = url.pathname.slice(blobPrefix.length);
        const contents = tree!.blobs.get(sha);
        if (contents === undefined) return responseJson({ error: 'missing fixture blob' }, 404);
        const bytes = Buffer.from(contents, 'utf8');
        return responseJson({ content: bytes.toString('base64'), encoding: 'base64', size: bytes.byteLength, sha });
      }
    }

    if (kind === 'well-known') {
      if (url.origin === sourceOrigin && url.pathname === '/published/.well-known/agent-skills/index.json') {
        return responseJson({
          $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
          skills: [{
            name: slug,
            type: 'skill-md',
            description: 'A deterministic well-known fixture.',
            url: `/published/${slug}/SKILL.md`,
            digest: sha256Digest(files.get('SKILL.md')!),
          }],
        });
      }
      if (url.origin === sourceOrigin && url.pathname === `/published/${slug}/SKILL.md`) {
        return textResponse(files.get('SKILL.md')!);
      }
    }

    const method = init?.method ?? 'GET';
    throw new Error(`unexpected source fixture request ${method} ${url.origin}${url.pathname}${url.search}`);
  });
  return { kind, externalId, source, slug, name: slug, installUrl, detail, row, files, sourceFetch };
}

interface FixtureHarnessOptions {
  readonly organizationId?: string;
  readonly repository?: StateRepository;
  readonly storageRoot?: string;
  readonly feed?: Feed;
  readonly feedName?: string;
}

async function createFixtureHarness(fixture: SourceFixture, options: FixtureHarnessOptions = {}): Promise<{
  harness: LocalRegistryHarness;
  feed: Feed;
  runner: WorkerRunner;
  workerFailures: string[];
  directoryCalls: DirectoryCallCounts;
}> {
  const directoryCalls: DirectoryCallCounts = { detail: 0, search: 0, list: 0 };
  const directory: RegistryDirectoryClient = {
    detail: async () => {
      directoryCalls.detail += 1;
      return structuredClone(fixture.detail);
    },
    search: async () => {
      directoryCalls.search += 1;
      return { data: [fixture.row], query: fixture.slug, searchType: 'fuzzy', count: 1, durationMs: 1 };
    },
    list: async () => {
      directoryCalls.list += 1;
      return { data: [fixture.row], pagination: { page: 0, perPage: 500, total: 1, hasMore: false } };
    },
    curated: async () => ({ data: [], totalOwners: 0, totalSkills: 0, generatedAt: new Date(0).toISOString() }),
    audit: async () => ({ id: fixture.externalId, source: fixture.source, slug: fixture.slug, audits: [] }),
  };
  const harness = await createLocalRegistryHarness({
    origin: REGISTRY_ORIGIN,
    organizationId: options.organizationId ?? ORGANIZATION_ID,
    policy: POLICY,
    directory,
    directoryBaseUrl: CATALOG_BASE,
    allowLoopbackUpstreams: true,
    repository: options.repository,
    storageRoot: options.storageRoot,
  });
  let feed = options.feed;
  if (!feed) {
    const feedResponse = await request(harness.handler, harness.origin, '/v1/feeds', {
      method: 'POST',
      headers: bearer(harness.token),
      json: {
        name: options.feedName ?? `fixture-${fixture.kind}-${fixture.slug}`,
        kind: 'skills-sh',
        namespace: '@acme',
        repositories: [fixture.source],
        baseUrl: CATALOG_BASE,
      },
    });
    expect(feedResponse.status, await feedResponse.clone().text()).toBe(201);
    feed = (await jsonResponse<{ feed: Feed }>(feedResponse)).feed;
  }
  if (!feed) throw new Error('source fixture feed was not created');
  const workerFailures: string[] = [];
  const runner = new WorkerRunner({
    baseUrl: harness.origin,
    workerToken: harness.workerToken,
    workerId: `source-pullthrough-${fixture.kind}-${options.organizationId ?? ORGANIZATION_ID}`,
    fetch: async (input, init) => {
      const response = await harness.handler(new Request(String(input), init));
      if (!response.ok) workerFailures.push(await response.clone().text());
      return response;
    },
    acquisition: {
      fetchImpl: fixture.sourceFetch as unknown as FetchLike,
      allowLoopbackForTests: true,
    },
    adapters: [deterministicScanner()],
    executor: { run: async () => { throw new Error('fixture scanner must bypass command execution'); } },
  });
  return { harness, feed, runner, workerFailures, directoryCalls };
}

async function resolveRequest(harness: LocalRegistryHarness, feed: Feed, externalId: string): Promise<Response> {
  return request(harness.handler, harness.origin, '/v1/proxy/resolve', {
    method: 'POST',
    headers: bearer(harness.token),
    json: { feed: feed.name, externalId },
  });
}

async function approveAndTransfer(
  harness: LocalRegistryHarness,
  resolution: Resolution,
): Promise<{ skill: SkillVersion; bytes: Uint8Array }> {
  const skill = resolution.members[0];
  if (!skill) throw new Error('approved resolution omitted its skill member');
  const authorizationResponse = await request(harness.handler, harness.origin, '/v1/install-authorizations', {
    method: 'POST',
    headers: bearer(harness.token),
    json: { resolution },
  });
  expect(authorizationResponse.status, await authorizationResponse.clone().text()).toBe(201);
  const authorization = (await jsonResponse<{ authorization: { id: string } }>(authorizationResponse)).authorization;
  const descriptorResponse = await request(
    harness.handler,
    harness.origin,
    `/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`,
    {
      method: 'POST',
      headers: bearer(harness.token),
      json: { resourceId: skill.id, authorizationId: authorization.id },
    },
  );
  expect(descriptorResponse.status, await descriptorResponse.clone().text()).toBe(200);
  const descriptor = await jsonResponse<TransferDescriptor>(descriptorResponse);
  expect(descriptor.digest).toBe(skill.artifact.digest);
  expect(descriptor.headers.authorization).toBeUndefined();
  const transferred = await request(harness.handler, harness.origin, new URL(descriptor.url).pathname, {
    headers: bearer(harness.token),
  });
  expect(transferred.status, await transferred.clone().text()).toBe(200);
  const bytes = new Uint8Array(await transferred.arrayBuffer());
  expect(await digestBytes(bytes)).toBe(skill.artifact.digest);
  return { skill, bytes };
}

function assertStoredFixtureBytes(fixture: SourceFixture, bytes: Uint8Array): void {
  const bundle = decodeBundle(bytes);
  expect(bundle.files.map((file) => file.path)).toEqual([...fixture.files.keys()].sort());
  for (const file of bundle.files) {
    expect(Buffer.from(file.content, 'base64').toString('utf8')).toBe(fixture.files.get(file.path));
  }
}

describe('source pull-through across core, WorkerRunner, fetcher, scanner, and transfer', () => {
  const harnesses: LocalRegistryHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()!.close();
  });

  it('deduplicates concurrent no-snapshot GitHub root resolves and transfers the approved root bytes', async () => {
    const fixture = makeFixture('github', 'root-skill');
    const { harness, feed, runner, workerFailures, directoryCalls } = await createFixtureHarness(fixture);
    harnesses.push(harness);

    const queued = await Promise.all([
      resolveRequest(harness, feed, fixture.externalId),
      resolveRequest(harness, feed, fixture.externalId),
      resolveRequest(harness, feed, fixture.externalId),
    ]);
    expect(queued.map((response) => response.status)).toEqual([202, 202, 202]);
    const operations = await Promise.all(queued.map((response) => jsonResponse<{ operation: Job }>(response)));
    expect(new Set(operations.map(({ operation }) => operation.id)).size).toBe(1);

    const pendingState = await harness.repository.read(ORGANIZATION_ID);
    expect(pendingState.jobs.filter((job) => job.kind === 'import')).toHaveLength(1);
    expect(pendingState.jobs[0]?.import?.externalSnapshotHash).toBeNull();

    const run = await runner.runOnce();
    expect(run.error, JSON.stringify(workerFailures)).toBeUndefined();
    expect(run.allow).toBe(true);
    expect(run.scannerResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ scannerId: 'skillsguard', status: 'completed' }),
    ]));
    expect(fixture.sourceFetch.mock.calls.length).toBeGreaterThan(0);
    const catalogDetailPath = `/catalog/api/v1/skills/${fixture.externalId.split('/').map(encodeURIComponent).join('/')}`;
    expect(fixture.sourceFetch.mock.calls.filter(([input]) => {
      const url = new URL(String(input));
      return url.origin === CATALOG_ORIGIN && url.pathname === catalogDetailPath;
    })).toHaveLength(1);
    const sourceFetchesAfterApproval = fixture.sourceFetch.mock.calls.length;
    const directoryCallsAfterApproval = { ...directoryCalls };

    const warm = await resolveRequest(harness, feed, fixture.externalId);
    expect(warm.status, await warm.clone().text()).toBe(200);
    const warmBody = await jsonResponse<{ resolution: Resolution; reference?: string }>(warm);
    const resolution = warmBody.resolution;
    const skill = resolution.members[0];
    expect(skill?.state).toBe('approved');
    expect(skill?.provenance).toMatchObject({
      kind: 'skills-sh',
      externalId: fixture.externalId,
      externalSnapshotHash: null,
      sourceResolutionKind: 'github',
      sourceProviderOrigin: 'https://github.com',
      repository: fixture.source,
      skillPath: '',
      requestedRef: 'main',
      resolvedCommit: 'a'.repeat(40),
      resolvedTree: 'a'.repeat(40),
    });
    expect(warmBody.reference).toBe(`@github/${fixture.source}`);
    expect(fixture.sourceFetch.mock.calls.length).toBe(sourceFetchesAfterApproval);
    expect(directoryCalls).toEqual(directoryCallsAfterApproval);

    const transferred = await approveAndTransfer(harness, resolution);
    expect(transferred.skill.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    assertStoredFixtureBytes(fixture, transferred.bytes);
  });

  it('acquires a no-snapshot nested GitHub directory, preserving its verified commit and path', async () => {
    const fixture = makeFixture('github', 'nested-skill');
    const { harness, feed, runner, directoryCalls } = await createFixtureHarness(fixture);
    harnesses.push(harness);

    const queued = await resolveRequest(harness, feed, fixture.externalId);
    expect(queued.status, await queued.clone().text()).toBe(202);
    const operation = (await jsonResponse<{ operation: Job }>(queued)).operation;
    expect(operation.import?.externalSnapshotHash).toBeNull();

    const run = await runner.runOnce();
    expect(run.error).toBeUndefined();
    expect(run.allow).toBe(true);
    const directoryCallsAfterApproval = { ...directoryCalls };
    const warm = await resolveRequest(harness, feed, fixture.externalId);
    expect(warm.status, await warm.clone().text()).toBe(200);
    const { resolution } = await jsonResponse<{ resolution: Resolution }>(warm);
    const skill = resolution.members[0];
    expect(skill?.provenance).toMatchObject({
      sourceResolutionKind: 'github',
      repository: fixture.source,
      skillPath: 'skills/nested-skill',
      resolvedCommit: 'a'.repeat(40),
    });
    expect(directoryCalls).toEqual(directoryCallsAfterApproval);
    const transferred = await approveAndTransfer(harness, resolution);
    assertStoredFixtureBytes(fixture, transferred.bytes);
  });

  it('acquires a no-snapshot well-known source through its discovery index and transfers only after scanning', async () => {
    const fixture = makeFixture('well-known', 'well-known-guide');
    const { harness, feed, runner, directoryCalls } = await createFixtureHarness(fixture);
    harnesses.push(harness);

    const queued = await resolveRequest(harness, feed, fixture.externalId);
    expect(queued.status, await queued.clone().text()).toBe(202);
    const run = await runner.runOnce();
    expect(run.error).toBeUndefined();
    expect(run.allow).toBe(true);
    expect(run.scannerResults).toEqual([expect.objectContaining({
      scannerId: 'skillsguard',
      status: 'completed',
      coverage: expect.objectContaining({
        filesEnumerated: 1,
        filesAnalyzed: 1,
        filesSkipped: 0,
        filesUnsupported: 0,
      }),
    })]);
    const sourceFetchesAfterApproval = fixture.sourceFetch.mock.calls.length;
    const directoryCallsAfterApproval = { ...directoryCalls };
    const expectedDigest = sha256Digest(fixture.files.get('SKILL.md')!);

    const warm = await resolveRequest(harness, feed, fixture.externalId);
    expect(warm.status, await warm.clone().text()).toBe(200);
    const warmBody = await jsonResponse<{ resolution: Resolution; reference?: string }>(warm);
    const { resolution } = warmBody;
    const skill = resolution.members[0];
    expect(skill?.provenance).toMatchObject({
      kind: 'skills-sh',
      externalId: fixture.externalId,
      externalSnapshotHash: null,
      sourceResolutionKind: 'well-known',
      sourceProviderOrigin: 'https://docs.example',
      wellKnownEntryName: fixture.slug,
      wellKnownIndexUrl: 'https://docs.example/published/.well-known/agent-skills/index.json',
      artifactUrl: `https://docs.example/published/${fixture.slug}/SKILL.md`,
      externalDigest: expectedDigest,
      revision: expectedDigest,
    });
    expect(warmBody.reference).toBe(`@web/${fixture.source}/published/.well-known/agent-skills/${fixture.slug}`);
    expect(fixture.sourceFetch.mock.calls.length).toBe(sourceFetchesAfterApproval);
    expect(directoryCalls).toEqual(directoryCallsAfterApproval);
    const transferred = await approveAndTransfer(harness, resolution);
    assertStoredFixtureBytes(fixture, transferred.bytes);
  });

  it('composes durable file state and Files SDK storage across tenants, restart, and policy re-evaluation', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'private-skills-c1-durable-state-'));
    const fixture = makeFixture('github', 'root-skill');
    const stateRepository = createFileStateRepository({
      directory: stateRoot,
      stateFactory: durableFixtureState,
    });
    const tenantA = 'org-source-durable-a';
    const tenantB = 'org-source-durable-b';

    try {
      const first = await createFixtureHarness(fixture, {
        organizationId: tenantA,
        repository: stateRepository,
        feedName: 'durable-a',
      });
      harnesses.push(first.harness);

      const coldA = await Promise.all([
        resolveRequest(first.harness, first.feed, fixture.externalId),
        resolveRequest(first.harness, first.feed, fixture.externalId),
        resolveRequest(first.harness, first.feed, fixture.externalId),
      ]);
      expect(coldA.map((response) => response.status)).toEqual([202, 202, 202]);
      const coldOperations = await Promise.all(coldA.map((response) => jsonResponse<{ operation: Job }>(response)));
      expect(new Set(coldOperations.map(({ operation }) => operation.id)).size).toBe(1);
      expect((await stateRepository.read(tenantA)).jobs.filter((job) => job.kind === 'import')).toHaveLength(1);

      const firstRun = await first.runner.runOnce();
      expect(firstRun.error, JSON.stringify(first.workerFailures)).toBeUndefined();
      expect(firstRun.allow).toBe(true);
      expect(firstRun.scannerResults).toEqual([expect.objectContaining({
        scannerId: 'skillsguard',
        status: 'completed',
        coverage: expect.objectContaining({ filesAnalyzed: 2, filesUnsupported: 0, filesSkipped: 0 }),
      })]);
      const sourceFetchesAfterA = fixture.sourceFetch.mock.calls.length;
      const durableFiles = await readdir(stateRoot);
      expect(durableFiles.some((file) => file.endsWith('.json'))).toBe(true);

      const secondTenant = await createFixtureHarness(fixture, {
        organizationId: tenantB,
        repository: stateRepository,
        feedName: 'durable-b',
      });
      harnesses.push(secondTenant.harness);

      const sourceFetchesBeforeForeignFeed = fixture.sourceFetch.mock.calls.length;
      const foreignFeed = await resolveRequest(secondTenant.harness, first.feed, fixture.externalId);
      expect(foreignFeed.status, await foreignFeed.clone().text()).toBe(404);
      expect(secondTenant.directoryCalls).toEqual({ detail: 0, search: 0, list: 0 });
      expect(fixture.sourceFetch.mock.calls.length).toBe(sourceFetchesBeforeForeignFeed);

      const coldB = await resolveRequest(secondTenant.harness, secondTenant.feed, fixture.externalId);
      expect(coldB.status, await coldB.clone().text()).toBe(202);
      const secondRun = await secondTenant.runner.runOnce();
      expect(secondRun.error, JSON.stringify(secondTenant.workerFailures)).toBeUndefined();
      expect(secondRun.allow).toBe(true);
      expect(fixture.sourceFetch.mock.calls.length).toBeGreaterThan(sourceFetchesAfterA);
      const tenantAState = await stateRepository.read(tenantA);
      const tenantBState = await stateRepository.read(tenantB);
      expect(tenantAState.jobs.filter((job) => job.kind === 'import')).toHaveLength(1);
      expect(tenantBState.jobs.filter((job) => job.kind === 'import')).toHaveLength(1);
      expect(tenantAState.skills.every((skill) => skill.organizationId === tenantA)).toBe(true);
      expect(tenantBState.skills.every((skill) => skill.organizationId === tenantB)).toBe(true);

      const tenantBWarm = await resolveRequest(secondTenant.harness, secondTenant.feed, fixture.externalId);
      expect(tenantBWarm.status, await tenantBWarm.clone().text()).toBe(200);
      const tenantBWarmBody = await jsonResponse<{ diagnostics: { upstreamRequests: { catalog: number; source: number }; queuedJobsCreated: number; overflow: boolean }; resolution: Resolution }>(tenantBWarm);
      expect(tenantBWarmBody.diagnostics).toEqual({
        version: 1,
        upstreamRequests: { catalog: 0, source: 0 },
        queuedJobsCreated: 0,
        overflow: false,
      });
      expect(tenantBWarmBody.resolution.resourceId).not.toBe(tenantAState.skills[0]?.id);

      // Recreate both durable adapters from disk while keeping the sealed
      // Files SDK root. This is the restart boundary for the local proof.
      const reloadedRepository = createFileStateRepository({
        directory: stateRoot,
        stateFactory: durableFixtureState,
      });
      const restarted = await createFixtureHarness(fixture, {
        organizationId: tenantA,
        repository: reloadedRepository,
        storageRoot: first.harness.root,
        feed: first.feed,
      });
      harnesses.push(restarted.harness);

      const sourceFetchesBeforeRestartWarm = fixture.sourceFetch.mock.calls.length;
      const restartWarm = await resolveRequest(restarted.harness, restarted.feed, fixture.externalId);
      expect(restartWarm.status, await restartWarm.clone().text()).toBe(200);
      const restartWarmBody = await jsonResponse<{ diagnostics: { upstreamRequests: { catalog: number; source: number }; queuedJobsCreated: number; overflow: boolean }; resolution: Resolution }>(restartWarm);
      expect(restartWarmBody.diagnostics).toEqual({
        version: 1,
        upstreamRequests: { catalog: 0, source: 0 },
        queuedJobsCreated: 0,
        overflow: false,
      });
      expect(restarted.directoryCalls).toEqual({ detail: 0, search: 0, list: 0 });
      expect(fixture.sourceFetch.mock.calls.length).toBe(sourceFetchesBeforeRestartWarm);
      const transferred = await approveAndTransfer(restarted.harness, restartWarmBody.resolution);
      assertStoredFixtureBytes(fixture, transferred.bytes);

      const policyResponse = await request(restarted.harness.handler, restarted.harness.origin, '/v1/policy', {
        method: 'PUT',
        headers: bearer(restarted.harness.token),
        json: {
          scanners: POLICY.scanners,
          allowUnscanned: false,
          evidenceMaxAgeSeconds: POLICY.evidenceMaxAgeSeconds,
          hooks: [],
        },
      });
      expect(policyResponse.status, await policyResponse.clone().text()).toBe(200);
      const nextPolicy = (await jsonResponse<{ policy: Policy }>(policyResponse)).policy;
      expect(nextPolicy.revision).not.toBe(POLICY.revision);

      const detailCallsBeforeStale = restarted.directoryCalls.detail;
      const sourceFetchesBeforeStale = fixture.sourceFetch.mock.calls.length;
      const originalSkillId = restartWarmBody.resolution.resourceId;
      const stale = await resolveRequest(restarted.harness, restarted.feed, fixture.externalId);
      expect(stale.status, await stale.clone().text()).toBe(202);
      const staleOperation = (await jsonResponse<{ operation: Job }>(stale)).operation;
      expect(staleOperation.policyRevision).toBe(nextPolicy.revision);
      expect(staleOperation.id).not.toBe(coldOperations[0]!.operation.id);
      // A changed policy invalidates the old release before catalog/source
      // work is repeated. The queued job captures the new policy revision.
      expect(restarted.directoryCalls.detail).toBe(detailCallsBeforeStale + 1);
      expect(fixture.sourceFetch.mock.calls.length).toBe(sourceFetchesBeforeStale);

      const staleRun = await restarted.runner.runOnce();
      expect(staleRun.error, JSON.stringify(restarted.workerFailures)).toBeUndefined();
      expect(staleRun.allow).toBe(true);
      expect(fixture.sourceFetch.mock.calls.length).toBeGreaterThan(sourceFetchesBeforeStale);
      const reevaluatedState = await reloadedRepository.read(tenantA);
      const originalSkill = reevaluatedState.skills.find((skill) => skill.id === originalSkillId);
      const replacementSkill = reevaluatedState.skills.find((skill) => skill.id !== originalSkillId && skill.policyRevision === nextPolicy.revision);
      expect(originalSkill).toMatchObject({ state: 'approved', policyRevision: POLICY.revision });
      expect(replacementSkill).toMatchObject({ state: 'approved', policyRevision: nextPolicy.revision });

      const afterStale = await resolveRequest(restarted.harness, restarted.feed, fixture.externalId);
      expect(afterStale.status, await afterStale.clone().text()).toBe(200);
      const afterStaleBody = await jsonResponse<{ diagnostics: { upstreamRequests: { catalog: number; source: number }; queuedJobsCreated: number; overflow: boolean }; resolution: Resolution }>(afterStale);
      expect(afterStaleBody.diagnostics).toEqual({
        version: 1,
        upstreamRequests: { catalog: 0, source: 0 },
        queuedJobsCreated: 0,
        overflow: false,
      });
      expect(afterStaleBody.resolution.resourceId).not.toBe(restartWarmBody.resolution.resourceId);
      expect(restarted.directoryCalls.detail).toBe(detailCallsBeforeStale + 1);
      expect(fixture.sourceFetch.mock.calls.length).toBeGreaterThan(sourceFetchesBeforeStale);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
