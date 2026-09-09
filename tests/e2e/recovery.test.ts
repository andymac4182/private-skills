import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TokenAuthenticator,
  type BootstrapTokenConfig,
} from '../../packages/auth/src/index.js';
import {
  createFileStateRepository,
  defaultRegistryState,
  type FileStateRepository,
} from '../../packages/database/src/index.js';
import {
  createRegistryHandler,
  type RegistryHandler,
} from '../../packages/core/src/index.js';
import { createNodeFilesSdkBlobStore } from '../../packages/storage/src/node.js';
import { digestBytes } from '../../packages/storage/src/index.js';
import type {
  InstallAuthorization,
  Job,
  PackVersion,
  RegistryConfiguration,
  RegistryDependencies,
  Resolution,
  SkillVersion,
  TransferDescriptor,
} from '../../packages/contracts/src/index.js';
import {
  bearer,
  bundleFor,
  E2E_ORGANIZATION,
  jsonResponse,
  request,
} from './harness.js';

const SOURCE_ORIGIN = 'http://recovery-source.test';
const RESTORED_ORIGIN = 'http://recovery-restored.test';

interface DurableHarness {
  readonly handler: RegistryHandler;
  readonly origin: string;
  readonly repository: FileStateRepository;
  readonly metadataRoot: string;
  readonly blobRoot: string;
  readonly token: string;
  readonly workerToken: string;
}

async function createDurableHarness(
  origin: string,
  metadataRoot: string,
  blobRoot: string,
): Promise<DurableHarness> {
  const token = `${origin}-user-token`;
  const workerToken = `${origin}-worker-token`;
  const developmentState = defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: 'e2e-recovery-unscanned',
  });
  const repository = createFileStateRepository({
    directory: metadataRoot,
    stateFactory: () => structuredClone(developmentState),
  });
  const blobs = await createNodeFilesSdkBlobStore({
    provider: 'fs',
    root: blobRoot,
    prefix: 'private-registry',
  });
  const userConfig: BootstrapTokenConfig = {
    id: 'recovery-user',
    token,
    organizationId: E2E_ORGANIZATION,
    subject: 'recovery-user',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: ['@acme'],
    scopes: ['registry:*'],
  };
  const workerConfig: BootstrapTokenConfig = {
    id: 'recovery-worker',
    token: workerToken,
    organizationId: E2E_ORGANIZATION,
    subject: 'recovery-worker',
    roles: ['worker'],
    kind: 'worker',
    worker: true,
    scopes: ['jobs:*'],
  };
  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: [userConfig],
    workerTokens: [workerConfig],
    sessionSecret: 'recovery-session-secret-that-is-long-enough',
    publicOrigin: origin,
    allowedOrigins: [origin],
  });
  await auth.ready();
  const config: RegistryConfiguration = {
    publicOrigin: origin,
    maxBodyBytes: 2 * 1024 * 1024,
    organizationId: E2E_ORGANIZATION,
    leaseSeconds: 60,
  };
  const dependencies: RegistryDependencies = {
    repository,
    blobs,
    auth,
    config,
  };
  return {
    handler: createRegistryHandler(dependencies),
    origin,
    repository,
    metadataRoot,
    blobRoot,
    token,
    workerToken,
  };
}

type JsonError = { error: { code: string; message: string } };

describe('durable filesystem recovery', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('restores file metadata and sealed Files SDK objects independently', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-recovery-e2e-'));
    const sourceMetadata = join(root, 'source-metadata');
    const sourceBlobs = join(root, 'source-blobs');
    const restoredMetadata = join(root, 'restored-metadata');
    const restoredBlobs = join(root, 'restored-blobs');
    await Promise.all([
      mkdir(sourceMetadata, { recursive: true }),
      mkdir(sourceBlobs, { recursive: true }),
      mkdir(restoredMetadata, { recursive: true }),
      mkdir(restoredBlobs, { recursive: true }),
    ]);

    const source = await createDurableHarness(SOURCE_ORIGIN, sourceMetadata, sourceBlobs);
    const userHeaders = bearer(source.token);
    const workerHeaders = bearer(source.workerToken);
    const bundle = bundleFor('recovery-skill', 'A durable approved recovery fixture');

    const publish = await request(source.handler, source.origin, '/v1/publish', {
      method: 'POST',
      headers: userHeaders,
      json: {
        name: '@acme/recovery-skill',
        version: '1.0.0',
        description: 'A durable approved recovery fixture',
        bundle,
      },
    });
    expect(publish.status).toBe(202);
    const queued = (await jsonResponse<{ operation: Job }>(publish)).operation;
    expect(queued.resourceId).toBeTypeOf('string');

    const claim = await request(source.handler, source.origin, '/internal/jobs/claim', {
      method: 'POST',
      headers: workerHeaders,
    });
    expect(claim.status).toBe(200);
    const claimed = (await jsonResponse<{ job: Job }>(claim)).job;
    const complete = await request(
      source.handler,
      source.origin,
      `/internal/jobs/${encodeURIComponent(claimed.id)}/complete`,
      {
        method: 'POST',
        headers: workerHeaders,
        json: { leaseToken: claimed.leaseToken },
      },
    );
    expect(complete.status).toBe(200);

    const sourceSkillResponse = await request(
      source.handler,
      source.origin,
      `/v1/skills/${encodeURIComponent(queued.resourceId!)}`,
      { headers: userHeaders },
    );
    expect(sourceSkillResponse.status).toBe(200);
    const sourceSkill = (await jsonResponse<{ skill: SkillVersion }>(sourceSkillResponse)).skill;
    expect(sourceSkill.state).toBe('approved');

    const packPublish = await request(source.handler, source.origin, '/v1/packs', {
      method: 'POST',
      headers: userHeaders,
      json: {
        name: '@acme/recovery-pack',
        version: '1.0.0',
        description: 'A durable approved pack fixture',
        skills: [{ ref: '@acme/recovery-skill', version: '1.0.0' }],
      },
    });
    expect(packPublish.status).toBe(201);
    const pack = (await jsonResponse<{ pack: PackVersion }>(packPublish)).pack;
    expect(pack.state).toBe('approved');
    expect(pack.members).toHaveLength(1);

    const sourceResolutionResponse = await request(source.handler, source.origin, '/v1/resolve', {
      method: 'POST',
      headers: userHeaders,
      json: { kind: 'skill', ref: '@acme/recovery-skill', version: '1.0.0' },
    });
    expect(sourceResolutionResponse.status).toBe(200);
    const sourceResolution = (
      await jsonResponse<{ resolution: Resolution }>(sourceResolutionResponse)
    ).resolution;
    expect(sourceResolution.digest).toBe(sourceSkill.artifact.digest);

    const sourceAuthorizationResponse = await request(source.handler, source.origin, '/v1/install-authorizations', {
      method: 'POST',
      headers: userHeaders,
      json: { resolution: sourceResolution },
    });
    expect(sourceAuthorizationResponse.status).toBe(201);
    const sourceAuthorization = (
      await jsonResponse<{ authorization: InstallAuthorization }>(sourceAuthorizationResponse)
    ).authorization;
    const sourceDescriptorResponse = await request(
      source.handler,
      source.origin,
      `/v1/artifacts/${encodeURIComponent(sourceSkill.artifact.digest)}/download`,
      {
        method: 'POST',
        headers: userHeaders,
        json: {
          resourceId: sourceSkill.id,
          authorizationId: sourceAuthorization.id,
        },
      },
    );
    expect(sourceDescriptorResponse.status).toBe(200);
    const sourceDescriptor = await jsonResponse<TransferDescriptor>(sourceDescriptorResponse);
    const sourceTransferPath = new URL(sourceDescriptor.url).pathname;
    const sourceBeforeRestore = await source.repository.read(E2E_ORGANIZATION);

    // Both trees are copied only after all source mutations are complete. The
    // restored process gets no in-memory repository or blob-store state.
    await Promise.all([
      cp(source.metadataRoot, restoredMetadata, { recursive: true }),
      cp(source.blobRoot, restoredBlobs, { recursive: true }),
    ]);
    const restored = await createDurableHarness(RESTORED_ORIGIN, restoredMetadata, restoredBlobs);
    const restoredHeaders = bearer(restored.token);

    const restoredSkillResponse = await request(
      restored.handler,
      restored.origin,
      `/v1/skills/${encodeURIComponent(sourceSkill.id)}`,
      { headers: restoredHeaders },
    );
    expect(restoredSkillResponse.status).toBe(200);
    const restoredSkill = (await jsonResponse<{ skill: SkillVersion }>(restoredSkillResponse)).skill;
    expect(restoredSkill.state).toBe('approved');
    expect(restoredSkill.artifact.digest).toBe(sourceSkill.artifact.digest);

    const restoredResolutionResponse = await request(restored.handler, restored.origin, '/v1/resolve', {
      method: 'POST',
      headers: restoredHeaders,
      json: { kind: 'skill', ref: '@acme/recovery-skill', version: '1.0.0' },
    });
    expect(restoredResolutionResponse.status).toBe(200);
    const restoredResolution = (
      await jsonResponse<{ resolution: Resolution }>(restoredResolutionResponse)
    ).resolution;
    expect(restoredResolution.digest).toBe(sourceSkill.artifact.digest);

    const restoredPackResolutionResponse = await request(restored.handler, restored.origin, '/v1/resolve', {
      method: 'POST',
      headers: restoredHeaders,
      json: { kind: 'pack', ref: '@acme/recovery-pack', version: '1.0.0' },
    });
    expect(restoredPackResolutionResponse.status).toBe(200);
    const restoredPackResolution = (
      await jsonResponse<{ resolution: Resolution }>(restoredPackResolutionResponse)
    ).resolution;
    expect(restoredPackResolution.kind).toBe('pack');
    expect(restoredPackResolution.members).toHaveLength(1);
    expect(restoredPackResolution.members[0]?.artifact.digest).toBe(sourceSkill.artifact.digest);

    const restoredAuthorizationResponse = await request(restored.handler, restored.origin, '/v1/install-authorizations', {
      method: 'POST',
      headers: restoredHeaders,
      json: { resolution: restoredResolution },
    });
    expect(restoredAuthorizationResponse.status).toBe(201);
    const restoredAuthorization = (
      await jsonResponse<{ authorization: InstallAuthorization }>(restoredAuthorizationResponse)
    ).authorization;
    const restoredDescriptorResponse = await request(
      restored.handler,
      restored.origin,
      `/v1/artifacts/${encodeURIComponent(restoredSkill.artifact.digest)}/download`,
      {
        method: 'POST',
        headers: restoredHeaders,
        json: {
          resourceId: restoredSkill.id,
          authorizationId: restoredAuthorization.id,
        },
      },
    );
    expect(restoredDescriptorResponse.status).toBe(200);
    const restoredDescriptor = await jsonResponse<TransferDescriptor>(restoredDescriptorResponse);
    const restoredTransferPath = new URL(restoredDescriptor.url).pathname;
    const restoredTransfer = await request(restored.handler, restored.origin, restoredTransferPath, {
      headers: restoredHeaders,
    });
    expect(restoredTransfer.status).toBe(200);
    const restoredBytes = new Uint8Array(await restoredTransfer.arrayBuffer());
    expect(await digestBytes(restoredBytes)).toBe(sourceSkill.artifact.digest);

    const restoreRevoke = await request(
      restored.handler,
      restored.origin,
      `/v1/skills/${encodeURIComponent(restoredSkill.id)}/revoke`,
      { method: 'POST', headers: restoredHeaders },
    );
    expect(restoreRevoke.status).toBe(200);
    const deniedRestoredTransfer = await request(restored.handler, restored.origin, restoredTransferPath, {
      headers: restoredHeaders,
    });
    expect(deniedRestoredTransfer.status).toBe(409);
    await expect(jsonResponse<JsonError>(deniedRestoredTransfer)).resolves.toMatchObject({
      error: { code: 'POLICY_BLOCKED' },
    });

    expect(await source.repository.read(E2E_ORGANIZATION)).toEqual(sourceBeforeRestore);
    const originalSkillAfterRestoreRevoke = await request(
      source.handler,
      source.origin,
      `/v1/skills/${encodeURIComponent(sourceSkill.id)}`,
      { headers: userHeaders },
    );
    expect(originalSkillAfterRestoreRevoke.status).toBe(200);
    await expect(jsonResponse<{ skill: SkillVersion }>(originalSkillAfterRestoreRevoke)).resolves.toMatchObject({
      skill: { id: sourceSkill.id, state: 'approved' },
    });
    const originalTransfer = await request(source.handler, source.origin, sourceTransferPath, {
      headers: userHeaders,
    });
    expect(originalTransfer.status).toBe(200);
    expect(await digestBytes(new Uint8Array(await originalTransfer.arrayBuffer()))).toBe(
      sourceSkill.artifact.digest,
    );
  });
});
