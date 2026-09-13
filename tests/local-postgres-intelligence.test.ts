import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import {
  PostgresStateRepository,
  defaultRegistryState,
  type PgPoolLike,
} from '../packages/database/src/index.js';
import { StateSemanticIndex } from '../packages/search/src/index.js';
import {
  decodeBundle,
  digestBytes,
} from '../packages/storage/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import type { SearchDocument } from '../packages/search/src/types.js';
import {
  bearer,
  bundleFor,
  createLocalRegistryHarness,
  jsonResponse,
  request,
  type LocalRegistryHarness,
} from './e2e/harness.js';
import {
  runLocalCli,
  startLocalRegistry,
  withLocalTempDirectory,
  type LocalCliRun,
} from './local-postgres-cli-helper.js';

const databaseUrl = process.env.PSKILLS_TEST_POSTGRES_URL?.trim();
const cliPath = process.env.PSKILLS_TEST_CLI_PATH?.trim();
const enabled = databaseUrl !== undefined && databaseUrl.length > 0;
const cliEnabled = enabled && cliPath !== undefined && cliPath.length > 0;
const local = describe.skipIf(!enabled);
const ORIGIN = 'http://127.0.0.1:5199';
const ORGANIZATION = 'org-postgres-local';
const TOKEN = 'postgres-local-user-token';
const WORKER_TOKEN = 'postgres-local-worker-token';
const PROFILE = { id: 'local-deterministic-v1', model: 'local-deterministic', dimensions: 3 } as const;

type SqlClient = ReturnType<typeof postgres>;

function vectorFor(text: string): number[] {
  return /\b(?:alpha|durable|first)\b/iu.test(text) ? [1, 0, 0] : [0, 1, 0];
}

function pgPool(sql: SqlClient): PgPoolLike {
  const query = async (
    connection: SqlClient,
    text: string,
    parameters: readonly unknown[] = [],
  ) => {
    const result = await connection.unsafe(text, [...parameters] as never[]);
    return { rows: [...result], rowCount: result.count };
  };
  return {
    query: (text, parameters) => query(sql, text, parameters),
    connect: async () => {
      const connection = await sql.reserve();
      return {
        query: (text, parameters) => query(connection as unknown as SqlClient, text, parameters),
        release: () => connection.release(),
      };
    },
  } as PgPoolLike;
}

type PublishedSkill = {
  id: string;
  name: string;
  version: string;
  artifact: { key: string; digest: `sha256:${string}` };
  bundle: ReturnType<typeof bundleFor>;
};

async function publishAndApprove(
  harness: LocalRegistryHarness,
  options: {
    skillName?: string;
    packageName?: string;
    description?: string;
  } = {},
): Promise<PublishedSkill> {
  const skillName = options.skillName ?? 'postgres-alpha';
  const packageName = options.packageName ?? `@acme/${skillName}`;
  const description = options.description ?? 'alpha durable local search skill';
  const bundle = bundleFor(skillName, description);
  const publish = await request(harness.handler, harness.origin, '/v1/publish', {
    method: 'POST',
    headers: bearer(harness.token),
    json: {
      name: packageName,
      version: '1.0.0',
      description,
      bundle,
    },
  });
  expect(publish.status).toBe(202);
  const queued = await jsonResponse<{ operation: { id: string; resourceId?: string } }>(publish);

  const claim = await request(harness.handler, harness.origin, '/internal/jobs/claim', {
    method: 'POST',
    headers: bearer(harness.workerToken),
  });
  expect(claim.status).toBe(200);
  const claimed = await jsonResponse<{ job: { id: string; leaseToken: string } }>(claim);
  expect(claimed.job.id).toBe(queued.operation.id);

  const complete = await request(
    harness.handler,
    harness.origin,
    `/internal/jobs/${encodeURIComponent(queued.operation.id)}/complete`,
    {
      method: 'POST',
      headers: bearer(harness.workerToken),
      json: { leaseToken: claimed.job.leaseToken },
    },
  );
  expect(complete.status).toBe(200);

  const skillResponse = await request(
    harness.handler,
    harness.origin,
    `/v1/skills/${encodeURIComponent(queued.operation.resourceId!)}`,
    { headers: bearer(harness.token) },
  );
  expect(skillResponse.status).toBe(200);
  const body = await jsonResponse<{ skill: { id: string; name: string; version: string; artifact: { key: string; digest: `sha256:${string}` } } }>(skillResponse);
  expect(body.skill.name).toBe(packageName);
  return { ...body.skill, bundle };
}

function cliJson<T>(run: LocalCliRun, label: string): T {
  if (run.timedOut || run.code !== 0) {
    const signal = run.signal ? ` (${run.signal})` : '';
    throw new Error(`${label} failed with exit ${run.code}${signal}: ${run.stderr.slice(0, 2_000)}`);
  }
  try {
    return JSON.parse(run.stdout) as T;
  } catch (error) {
    throw new Error(`${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

local('durable PostgreSQL state, Files SDK storage, persisted exact search, and install analytics', () => {
  let sql: SqlClient;
  let tableName: string;
  let repository: PostgresStateRepository;
  let harness: LocalRegistryHarness;
  let blobs: Awaited<ReturnType<typeof createNodeFilesSdkBlobStore>>;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('PSKILLS_TEST_POSTGRES_URL is required');
    sql = postgres(databaseUrl, { max: 4, prepare: false });
    tableName = `private_skills_local_${crypto.randomUUID().replaceAll('-', '')}`;
    repository = new PostgresStateRepository(pgPool(sql), {
      tableName,
      autoMigrate: true,
      stateFactory: () => defaultRegistryState({
        production: false,
        allowUnscanned: true,
        policyRevision: 'local-postgres-unscanned',
      }),
    });
    harness = await createLocalRegistryHarness({
      origin: ORIGIN,
      organizationId: ORGANIZATION,
      token: TOKEN,
      workerToken: WORKER_TOKEN,
      repository,
    });
    blobs = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root: harness.root,
      prefix: 'private-registry',
    });
  });

  afterAll(async () => {
    await harness?.close();
    if (sql && tableName) {
      await sql.unsafe(`DROP TABLE "${tableName}"`);
      await sql.end({ timeout: 1 });
    }
  });

  it('survives repository reload, records warm analytics, and removes revoked search rows', async () => {
    const { bundle, ...skill } = await publishAndApprove(harness);

    // Verify the same sealed artifact through a second Files SDK client,
    // proving that the index document can be rehydrated from provider bytes.
    const artifact = await blobs.getVerified(skill.artifact.key, skill.artifact.digest);
    const decoded = decodeBundle(artifact);
    const skillFile = decoded.files.find((file) => file.path === 'SKILL.md');
    expect(skillFile).toBeDefined();
    const text = new TextDecoder().decode(Buffer.from(skillFile!.content, 'base64'));
    const contentDigest = await digestBytes(new TextEncoder().encode(text));
    const document: SearchDocument = {
      organizationId: ORGANIZATION,
      resourceId: skill.id,
      artifactDigest: skill.artifact.digest,
      contentDigest,
      text,
      vector: vectorFor(text),
      profileId: PROFILE.id,
      indexedAt: new Date().toISOString(),
    };

    const index = new StateSemanticIndex({ repository, profile: PROFILE });
    await index.upsert([document]);
    await expect(index.search({
      organizationId: ORGANIZATION,
      allowedResourceIds: [skill.id],
      profileId: PROFILE.id,
      vector: [1, 0, 0],
      limit: 5,
    })).resolves.toEqual([expect.objectContaining({ resourceId: skill.id, score: 1 })]);

    // A fresh repository/index instance reads the persisted search extension
    // from PostgreSQL JSONB instead of relying on process memory.
    const reloadedRepository = new PostgresStateRepository(pgPool(sql), {
      tableName,
      autoMigrate: true,
    });
    const reloadedIndex = new StateSemanticIndex({ repository: reloadedRepository, profile: PROFILE });
    await expect(reloadedIndex.health(ORGANIZATION)).resolves.toEqual({
      status: 'ok',
      provider: 'state-exact-cosine',
    });
    await expect(reloadedIndex.search({
      organizationId: ORGANIZATION,
      allowedResourceIds: [skill.id],
      profileId: PROFILE.id,
      vector: [1, 0, 0],
      limit: 5,
    })).resolves.toEqual([expect.objectContaining({ resourceId: skill.id, contentDigest, score: 1 })]);

    // Install receipts are posted directly here to keep this provider test
    // focused on durable analytics storage. The CLI install/warm path is
    // covered separately by the local published-binary smoke evidence.
    const resolutionResponse = await request(harness.handler, harness.origin, '/v1/resolve', {
      method: 'POST',
      headers: bearer(harness.token),
      json: { kind: 'skill', ref: skill.name, version: skill.version },
    });
    expect(resolutionResponse.status).toBe(200);
    const resolution = await jsonResponse<{ resolution: Record<string, unknown> }>(resolutionResponse);

    for (const changed of [true, false]) {
      const authorizationResponse = await request(harness.handler, harness.origin, '/v1/install-authorizations', {
        method: 'POST',
        headers: bearer(harness.token),
        json: { resolution: resolution.resolution },
      });
      expect(authorizationResponse.status).toBe(201);
      const authorization = await jsonResponse<{ authorization: { id: string } }>(authorizationResponse);
      const receipt = await request(harness.handler, harness.origin, '/v1/install-receipts', {
        method: 'POST',
        headers: bearer(harness.token),
        json: {
          authorizationId: authorization.authorization.id,
          changed,
          agent: 'universal',
          platform: 'other',
          clientVersion: 'local-postgres-flow',
        },
      });
      expect(receipt.status).toBe(201);
    }

    const analytics = await request(harness.handler, harness.origin, '/v1/analytics?days=1', {
      headers: bearer(harness.token),
    });
    expect(analytics.status).toBe(200);
    await expect(jsonResponse<{ totals: Record<string, number> }>(analytics)).resolves.toMatchObject({
      totals: { installOperations: 2, skillInstalls: 1, upToDateChecks: 1 },
    });

    const revoke = await request(
      harness.handler,
      harness.origin,
      `/v1/skills/${encodeURIComponent(skill.id)}/revoke`,
      { method: 'POST', headers: bearer(harness.token) },
    );
    expect(revoke.status).toBe(200);
    // Reindex/revocation authorization filtering is covered by the existing
    // intelligence E2E suite; this test verifies the durable index mutation.
    await reloadedIndex.remove(ORGANIZATION, [skill.id]);
    await expect(reloadedIndex.search({
      organizationId: ORGANIZATION,
      allowedResourceIds: [skill.id],
      profileId: PROFILE.id,
      vector: [1, 0, 0],
      limit: 5,
    })).resolves.toEqual([]);
  });

  it.skipIf(!cliEnabled)('installs and verifies through a configured Rust CLI binary', async () => {
    if (!databaseUrl || !cliPath) {
      throw new Error('PSKILLS_TEST_POSTGRES_URL and PSKILLS_TEST_CLI_PATH are required');
    }

    const cliTableName = `private_skills_cli_${crypto.randomUUID().replaceAll('-', '')}`;
    const cliOrganization = `org-postgres-cli-${crypto.randomUUID()}`;
    const cliToken = `postgres-cli-${crypto.randomUUID()}`;
    const cliWorkerToken = `postgres-cli-worker-${crypto.randomUUID()}`;
    const cliRepository = new PostgresStateRepository(pgPool(sql), {
      tableName: cliTableName,
      autoMigrate: true,
      stateFactory: () => defaultRegistryState({
        production: false,
        allowUnscanned: true,
        policyRevision: 'local-postgres-cli-unscanned',
      }),
    });
    let server: Awaited<ReturnType<typeof startLocalRegistry<LocalRegistryHarness>>> | undefined;

    try {
      server = await startLocalRegistry((origin) => createLocalRegistryHarness({
        origin,
        organizationId: cliOrganization,
        token: cliToken,
        workerToken: cliWorkerToken,
        repository: cliRepository,
      }));

      await withLocalTempDirectory('private-skills-cli-install-', async (installRoot) => {
        const published = await publishAndApprove(server!.registry, {
          skillName: 'postgres-cli-alpha',
          packageName: '@acme/postgres-cli-alpha',
          description: 'alpha durable local CLI skill',
        });
        const installArgs = [
          '--registry', server!.origin,
          '--directory', installRoot,
          '--agent', 'universal',
          '--json',
          'install', `${published.name}@${published.version}`,
        ] as const;
        const first = cliJson<{
          ok: boolean;
          changed: boolean;
          version: string;
          digest: string;
          destination: string;
        }>(await runLocalCli({
          binaryPath: cliPath,
          registryOrigin: server!.origin,
          token: cliToken,
          cwd: installRoot,
          args: installArgs,
        }), 'first CLI install');
        expect(first).toMatchObject({
          ok: true,
          changed: true,
          version: published.version,
          digest: published.artifact.digest,
        });

        const second = cliJson<{ ok: boolean; changed: boolean; version: string; digest: string }>(
          await runLocalCli({
            binaryPath: cliPath,
            registryOrigin: server!.origin,
            token: cliToken,
            cwd: installRoot,
            args: installArgs,
          }),
          'warm CLI reinstall',
        );
        expect(second).toMatchObject({
          ok: true,
          changed: false,
          version: published.version,
          digest: published.artifact.digest,
        });

        const expectedSkill = Buffer.from(
          published.bundle.files.find((file) => file.path === 'SKILL.md')!.content,
          'base64',
        );
        const installedSkill = await readFile(join(installRoot, 'postgres-cli-alpha', 'SKILL.md'));
        expect(installedSkill).toEqual(expectedSkill);

        const list = cliJson<Array<{ skill_name: string; digest: string }>>(
          await runLocalCli({
            binaryPath: cliPath,
            registryOrigin: server!.origin,
            token: cliToken,
            cwd: installRoot,
            args: [
              '--registry', server!.origin,
              '--directory', installRoot,
              '--agent', 'universal',
              '--json',
              'list',
            ],
          }),
          'CLI list',
        );
        expect(list).toEqual([
          expect.objectContaining({
            skill_name: 'postgres-cli-alpha',
            digest: published.artifact.digest,
          }),
        ]);

        const verify = cliJson<{ ok: boolean; entries: Array<{ ok: boolean }> }>(
          await runLocalCli({
            binaryPath: cliPath,
            registryOrigin: server!.origin,
            token: cliToken,
            cwd: installRoot,
            args: [
              '--registry', server!.origin,
              '--directory', installRoot,
              '--agent', 'universal',
              '--json',
              'verify',
            ],
          }),
          'CLI verify',
        );
        expect(verify.ok).toBe(true);
        expect(verify.entries).toEqual([expect.objectContaining({ ok: true })]);

        const analytics = await request(server!.registry.handler, server!.origin, '/v1/analytics?days=1', {
          headers: bearer(cliToken),
        });
        expect(analytics.status).toBe(200);
        const analyticsBody = await jsonResponse<{ totals: Record<string, number> }>(analytics);
        expect(analyticsBody.totals).toEqual({
          installOperations: 2,
          skillInstalls: 1,
          packInstalls: 0,
          upToDateChecks: 1,
        });
      });
    } finally {
      await server?.close();
      await sql.unsafe(`DROP TABLE IF EXISTS "${cliTableName}"`);
    }
  });
});
