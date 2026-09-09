import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TokenAuthenticator,
  type BootstrapTokenConfig,
} from '../packages/auth/src/index.js';
import {
  createFileStateRepository,
  defaultRegistryState,
  type FileStateRepository,
} from '../packages/database/src/index.js';
import {
  createRegistryHandler,
  type RegistryHandler,
} from '../packages/core/src/index.js';
import { createNodeFilesSdkBlobStore } from '../packages/storage/src/node.js';
import { digestBytes } from '../packages/storage/src/index.js';
import type {
  InstallAuthorization,
  RegistryConfiguration,
  RegistryDependencies,
  Resolution,
  SkillVersion,
  TransferDescriptor,
} from '../packages/contracts/src/index.js';

const ORGANIZATION = 'restore-rehearsal-org';
const NAMESPACE = '@acme';
const SOURCE_ORIGIN = 'http://restore-source.test';
const RESTORED_ORIGIN = 'http://restore-restored.test';
const REVOKED_RESTORED_ORIGIN = 'http://restore-revoked.test';

interface RehearsalHarness {
  readonly handler: RegistryHandler;
  readonly repository: FileStateRepository;
  readonly blobs: Awaited<ReturnType<typeof createNodeFilesSdkBlobStore>>;
  readonly origin: string;
  readonly token: string;
}

async function createHarness(
  origin: string,
  metadataDirectory: string,
  blobDirectory: string,
  token: string,
): Promise<RehearsalHarness> {
  const state = defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: 'restore-rehearsal-policy',
  });
  const repository = createFileStateRepository({
    directory: metadataDirectory,
    stateFactory: () => structuredClone(state),
  });
  const blobs = await createNodeFilesSdkBlobStore({
    provider: 'fs',
    root: blobDirectory,
    prefix: 'private-registry',
  });
  const userToken: BootstrapTokenConfig = {
    id: 'restore-rehearsal-user',
    token,
    organizationId: ORGANIZATION,
    subject: 'restore-rehearsal-user',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: [NAMESPACE],
    scopes: ['registry:*'],
  };
  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: [userToken],
    sessionSecret: 'restore-rehearsal-session-secret',
    publicOrigin: origin,
    allowedOrigins: [origin],
  });
  await auth.ready();
  const config: RegistryConfiguration = {
    publicOrigin: origin,
    maxBodyBytes: 2 * 1024 * 1024,
    organizationId: ORGANIZATION,
    leaseSeconds: 60,
  };
  const dependencies: RegistryDependencies = { repository, blobs, auth, config };
  return {
    handler: createRegistryHandler(dependencies),
    repository,
    blobs,
    origin,
    token,
  };
}

async function createForeignOrganizationHandler(
  source: RehearsalHarness,
  token: string,
): Promise<RegistryHandler> {
  const foreignToken: BootstrapTokenConfig = {
    id: 'restore-rehearsal-foreign-user',
    token,
    organizationId: 'restore-foreign-org',
    subject: 'restore-foreign-user',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: [NAMESPACE],
    scopes: ['registry:*'],
  };
  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: [foreignToken],
    sessionSecret: 'restore-rehearsal-foreign-session-secret',
    publicOrigin: source.origin,
    allowedOrigins: [source.origin],
  });
  await auth.ready();
  const config: RegistryConfiguration = {
    publicOrigin: source.origin,
    maxBodyBytes: 2 * 1024 * 1024,
    organizationId: ORGANIZATION,
    leaseSeconds: 60,
  };
  return createRegistryHandler({
    repository: source.repository,
    blobs: source.blobs,
    auth,
    config,
  });
}

async function request(
  handler: RegistryHandler,
  origin: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  let body = requestInit.body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return handler(new Request(new URL(path, origin), { ...requestInit, body, headers }));
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

describe('filesystem restore rehearsal', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('restores the original digest and keeps revoked transfers fenced', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-restore-rehearsal-'));
    const sourceMetadata = join(root, 'source-metadata');
    const sourceBlobs = join(root, 'source-blobs');
    const restoredMetadata = join(root, 'restored-metadata');
    const restoredBlobs = join(root, 'restored-blobs');
    const revokedRestoredMetadata = join(root, 'revoked-restored-metadata');
    const revokedRestoredBlobs = join(root, 'revoked-restored-blobs');
    await Promise.all([
      mkdir(sourceMetadata, { recursive: true }),
      mkdir(sourceBlobs, { recursive: true }),
      mkdir(restoredMetadata, { recursive: true }),
      mkdir(restoredBlobs, { recursive: true }),
      mkdir(revokedRestoredMetadata, { recursive: true }),
      mkdir(revokedRestoredBlobs, { recursive: true }),
    ]);

    const token = `restore-rehearsal-${randomUUID()}`;
    const source = await createHarness(SOURCE_ORIGIN, sourceMetadata, sourceBlobs, token);
    const sourceHeaders = bearer(source.token);
    const bytes = new TextEncoder().encode('restore rehearsal bytes with a stable digest');
    const stored = await source.blobs.put(bytes);
    const skill: SkillVersion = {
      id: 'restore-rehearsal-skill-1.0.0',
      organizationId: ORGANIZATION,
      name: `${NAMESPACE}/restore-rehearsal`,
      skillName: 'restore-rehearsal',
      version: '1.0.0',
      description: 'Hermetic restore rehearsal fixture',
      artifact: stored,
      state: 'approved',
      policyRevision: 'restore-rehearsal-policy',
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      provenance: { kind: 'native' },
      fileCount: 1,
      scanIds: [],
    };
    await source.repository.transaction(ORGANIZATION, (state) => {
      state.skills.push(skill);
    });

    const sourceResolutionResponse = await request(source.handler, source.origin, '/v1/resolve', {
      method: 'POST',
      headers: sourceHeaders,
      json: { kind: 'skill', ref: skill.name, version: skill.version },
    });
    expect(sourceResolutionResponse.status).toBe(200);
    const sourceResolution = (await json<{ resolution: Resolution }>(sourceResolutionResponse)).resolution;
    expect(sourceResolution.digest).toBe(stored.digest);

    const unauthenticatedResolution = await request(source.handler, source.origin, '/v1/resolve', {
      method: 'POST',
      json: { kind: 'skill', ref: skill.name, version: skill.version },
    });
    expect(unauthenticatedResolution.status).toBe(401);
    const foreignToken = `restore-foreign-${randomUUID()}`;
    const foreignHandler = await createForeignOrganizationHandler(source, foreignToken);
    const foreignHeaders = bearer(foreignToken);
    const foreignResolution = await request(foreignHandler, source.origin, '/v1/resolve', {
      method: 'POST',
      headers: foreignHeaders,
      json: { kind: 'skill', ref: skill.name, version: skill.version },
    });
    expect(foreignResolution.status).toBe(403);
    const foreignAuthorization = await request(
      foreignHandler,
      source.origin,
      '/v1/install-authorizations',
      {
        method: 'POST',
        headers: foreignHeaders,
        json: { resolution: sourceResolution },
      },
    );
    expect(foreignAuthorization.status).toBe(403);

    const authorizationResponse = await request(source.handler, source.origin, '/v1/install-authorizations', {
      method: 'POST',
      headers: sourceHeaders,
      json: { resolution: sourceResolution },
    });
    expect(authorizationResponse.status).toBe(201);
    const authorization = (await json<{ authorization: InstallAuthorization }>(authorizationResponse)).authorization;
    const descriptorResponse = await request(
      source.handler,
      source.origin,
      `/v1/artifacts/${encodeURIComponent(stored.digest)}/download`,
      {
        method: 'POST',
        headers: sourceHeaders,
        json: { resourceId: skill.id, authorizationId: authorization.id },
      },
    );
    expect(descriptorResponse.status).toBe(200);
    const descriptor = await json<TransferDescriptor>(descriptorResponse);
    const transferPath = new URL(descriptor.url).pathname;
    const sourceTransfer = await request(source.handler, source.origin, transferPath, {
      headers: sourceHeaders,
    });
    expect(sourceTransfer.status).toBe(200);
    expect(await digestBytes(new Uint8Array(await sourceTransfer.arrayBuffer()))).toBe(stored.digest);

    // The backup boundary contains only the durable metadata and sealed blob
    // trees. A new process is represented by fresh repository/blob instances.
    await Promise.all([
      cp(sourceMetadata, restoredMetadata, { recursive: true }),
      cp(sourceBlobs, restoredBlobs, { recursive: true }),
    ]);
    const restored = await createHarness(RESTORED_ORIGIN, restoredMetadata, restoredBlobs, token);
    const restoredHeaders = bearer(restored.token);
    const restoredState = await restored.repository.read(ORGANIZATION);
    const restoredSkill = restoredState.skills.find((candidate) => candidate.id === skill.id);
    expect(restoredSkill).toMatchObject({
      id: skill.id,
      organizationId: ORGANIZATION,
      artifact: { key: stored.key, digest: stored.digest, size: stored.size },
      state: 'approved',
    });
    const restoredBytes = await restored.blobs.get(restoredSkill!.artifact.key);
    expect(await digestBytes(restoredBytes)).toBe(stored.digest);

    const restoredResolutionResponse = await request(restored.handler, restored.origin, '/v1/resolve', {
      method: 'POST',
      headers: restoredHeaders,
      json: { kind: 'skill', ref: skill.name, version: skill.version },
    });
    expect(restoredResolutionResponse.status).toBe(200);
    const restoredResolution = (await json<{ resolution: Resolution }>(restoredResolutionResponse)).resolution;
    expect(restoredResolution.digest).toBe(stored.digest);

    const restoredTransfer = await request(restored.handler, restored.origin, transferPath, {
      headers: restoredHeaders,
    });
    expect(restoredTransfer.status).toBe(200);
    expect(await digestBytes(new Uint8Array(await restoredTransfer.arrayBuffer()))).toBe(stored.digest);

    const revokeResponse = await request(
      restored.handler,
      restored.origin,
      `/v1/skills/${encodeURIComponent(skill.id)}/revoke`,
      { method: 'POST', headers: restoredHeaders },
    );
    expect(revokeResponse.status).toBe(200);
    const revokedState = await restored.repository.read(ORGANIZATION);
    expect(revokedState.skills.find((candidate) => candidate.id === skill.id)?.state).toBe('revoked');

    const deniedResolution = await request(restored.handler, restored.origin, '/v1/resolve', {
      method: 'POST',
      headers: restoredHeaders,
      json: { kind: 'skill', ref: skill.name, version: skill.version },
    });
    expect(deniedResolution.status).toBe(404);
    const deniedTransfer = await request(restored.handler, restored.origin, transferPath, {
      headers: restoredHeaders,
    });
    expect(deniedTransfer.status).toBe(409);
    await expect(json<{ error: { code: string } }>(deniedTransfer)).resolves.toMatchObject({
      error: { code: 'POLICY_BLOCKED' },
    });

    // Restoring into isolation must not mutate the source instance.
    const sourceState = await source.repository.read(ORGANIZATION);
    expect(sourceState.skills.find((candidate) => candidate.id === skill.id)?.state).toBe('approved');
    const sourceAfterRestore = await request(source.handler, source.origin, transferPath, {
      headers: sourceHeaders,
    });
    expect(sourceAfterRestore.status).toBe(200);
    expect(await digestBytes(new Uint8Array(await sourceAfterRestore.arrayBuffer()))).toBe(stored.digest);

    // Revoke the source release before taking a second backup. The restored
    // copy must retain this state and deny every fresh capability.
    const sourceRevoke = await request(
      source.handler,
      source.origin,
      `/v1/skills/${encodeURIComponent(skill.id)}/revoke`,
      { method: 'POST', headers: sourceHeaders },
    );
    expect(sourceRevoke.status).toBe(200);
    expect((await source.repository.read(ORGANIZATION)).skills.find((candidate) => candidate.id === skill.id)?.state).toBe('revoked');
    await Promise.all([
      cp(sourceMetadata, revokedRestoredMetadata, { recursive: true }),
      cp(sourceBlobs, revokedRestoredBlobs, { recursive: true }),
    ]);
    const restoredRevoked = await createHarness(
      REVOKED_RESTORED_ORIGIN,
      revokedRestoredMetadata,
      revokedRestoredBlobs,
      token,
    );
    const restoredRevokedHeaders = bearer(restoredRevoked.token);
    const restoredRevokedState = await restoredRevoked.repository.read(ORGANIZATION);
    const restoredRevokedSkill = restoredRevokedState.skills.find((candidate) => candidate.id === skill.id);
    expect(restoredRevokedSkill).toMatchObject({
      id: skill.id,
      artifact: { digest: stored.digest, key: stored.key, size: stored.size },
      state: 'revoked',
    });
    const restoredRevokedBytes = await restoredRevoked.blobs.get(restoredRevokedSkill!.artifact.key);
    expect(await digestBytes(restoredRevokedBytes)).toBe(stored.digest);

    const revokedResolution = await request(restoredRevoked.handler, restoredRevoked.origin, '/v1/resolve', {
      method: 'POST',
      headers: restoredRevokedHeaders,
      json: { kind: 'skill', ref: skill.name, version: skill.version },
    });
    expect(revokedResolution.status).toBe(404);
    const revokedAuthorization = await request(
      restoredRevoked.handler,
      restoredRevoked.origin,
      '/v1/install-authorizations',
      {
        method: 'POST',
        headers: restoredRevokedHeaders,
        json: { resolution: sourceResolution },
      },
    );
    expect(revokedAuthorization.status).toBe(404);
    const revokedTransfer = await request(restoredRevoked.handler, restoredRevoked.origin, transferPath, {
      headers: restoredRevokedHeaders,
    });
    expect(revokedTransfer.status).toBe(409);
    await expect(json<{ error: { code: string } }>(revokedTransfer)).resolves.toMatchObject({
      error: { code: 'POLICY_BLOCKED' },
    });
  });
});
