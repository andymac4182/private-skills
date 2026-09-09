import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
import {
  createLogicalBackup,
  createFileStateSeed,
  readLogicalBackup,
  restoreLogicalBackup,
} from '../scripts/restore-backup.js';
import type {
  BlobStore,
  InstallAuthorization,
  RegistryConfiguration,
  RegistryDependencies,
  Resolution,
  SkillVersion,
  TransferDescriptor,
} from '../packages/contracts/src/index.js';

const execFileAsync = promisify(execFile);

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
      mkdir(sourceMetadata, { recursive: true, mode: 0o700 }),
      mkdir(sourceBlobs, { recursive: true, mode: 0o700 }),
      mkdir(restoredMetadata, { recursive: true, mode: 0o700 }),
      mkdir(restoredBlobs, { recursive: true, mode: 0o700 }),
      mkdir(revokedRestoredMetadata, { recursive: true, mode: 0o700 }),
      mkdir(revokedRestoredBlobs, { recursive: true, mode: 0o700 }),
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

describe('logical backup utility', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function sourceFixture() {
    root = await mkdtemp(join(tmpdir(), 'private-skills-logical-backup-'));
    const sourceMetadata = join(root, 'source-metadata');
    const sourceBlobs = join(root, 'source-blobs');
    const backup = join(root, 'backup');
    const targetMetadata = join(root, 'target-metadata');
    const targetBlobs = join(root, 'target-blobs');
    await mkdir(sourceMetadata, { recursive: true, mode: 0o700 });
    await mkdir(sourceBlobs, { recursive: true, mode: 0o700 });
    await mkdir(targetMetadata, { recursive: true, mode: 0o700 });
    await mkdir(targetBlobs, { recursive: true, mode: 0o700 });
    const initial = defaultRegistryState({
      production: false,
      allowUnscanned: true,
      policyRevision: 'logical-backup-policy',
    });
    const sourceRepository = createFileStateRepository({
      directory: sourceMetadata,
      stateFactory: () => structuredClone(initial),
    });
    const sourceBlobStore = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root: sourceBlobs,
      prefix: 'source-registry',
    });
    const bytes = new TextEncoder().encode('logical backup exact bytes');
    const stored = await sourceBlobStore.put(bytes);
    await sourceRepository.transaction(ORGANIZATION, (state) => {
      state.skills.push({
        id: 'logical-backup-skill',
        organizationId: ORGANIZATION,
        name: `${NAMESPACE}/logical-backup`,
        skillName: 'logical-backup',
        version: '1.0.0',
        description: 'logical backup fixture',
        artifact: stored,
        state: 'revoked',
        policyRevision: state.policy.revision,
        createdAt: '2026-01-01T00:00:00.000Z',
        provenance: { kind: 'native' },
        fileCount: 1,
        scanIds: [],
      });
      state.audit.push({
        id: 'logical-backup-revocation',
        organizationId: ORGANIZATION,
        subject: 'logical-backup-admin',
        action: 'skill.revoke',
        resourceId: 'logical-backup-skill',
        createdAt: '2026-01-01T00:01:00.000Z',
      });
    });
    // A restore must preserve a realistic revision greater than the first
    // write; the generic transaction API cannot fake this by assigning a
    // revision inside its updater.
    await sourceRepository.transaction(ORGANIZATION, (state) => {
      state.audit.push({
        id: 'logical-backup-checkpoint',
        organizationId: ORGANIZATION,
        subject: 'logical-backup-admin',
        action: 'backup.checkpoint',
        createdAt: '2026-01-01T00:02:00.000Z',
      });
    });
    return {
      sourceMetadata,
      sourceBlobs,
      backup,
      targetMetadata,
      targetBlobs,
      sourceRepository,
      sourceBlobStore,
      stored,
      bytes,
    };
  }

  it('captures exact references and restores policy, revision, revocation, and digest', async () => {
    const fixture = await sourceFixture();
    const sourceLocation = {
      kind: 'filesystem' as const,
      identity: 'offline-source-registry',
      roots: [fixture.sourceMetadata, fixture.sourceBlobs],
    };
    const backup = await createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation,
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: {
        scope: 'offline',
        kind: 'offline-test',
        evidenceRef: 'vitest-isolated-source-and-target',
        observedAt: '2026-01-01T00:02:00.000Z',
      },
      now: () => new Date('2026-01-01T00:02:00.000Z'),
    });
    expect(backup.manifest.metadataRevision).toBe(2);
    expect(backup.manifest.objects).toHaveLength(1);
    expect(backup.manifest.objects[0]).toMatchObject({
      key: fixture.stored.key,
      digest: fixture.stored.digest,
      size: fixture.stored.size,
      references: ['state.skills[0].artifact'],
    });
    expect((await stat(join(fixture.backup, 'manifest.json'))).mode & 0o077).toBe(0);

    const targetRepository = createFileStateRepository({ directory: fixture.targetMetadata });
    const targetBlobStore = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root: fixture.targetBlobs,
      prefix: 'target-registry',
    });
    const restored = await restoreLogicalBackup({
      targetRepository,
      targetBlobs: targetBlobStore,
      organizationId: ORGANIZATION,
      targetIdentity: 'offline-target-registry',
      targetLocation: {
        kind: 'filesystem',
        identity: 'offline-target-registry',
        roots: [fixture.targetMetadata, fixture.targetBlobs],
      },
      backupDirectory: fixture.backup,
      targetIsolated: true,
      targetSeed: createFileStateSeed(fixture.targetMetadata),
    });
    expect(restored).toMatchObject({
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      targetIdentity: 'offline-target-registry',
      metadataRevision: 2,
      objectCount: 1,
      remappedObjectCount: 1,
    });
    const restoredState = await targetRepository.read(ORGANIZATION);
    expect(restoredState.metadataRevision).toBe(2);
    expect(restoredState.policy).toEqual((await fixture.sourceRepository.read(ORGANIZATION)).policy);
    expect(restoredState.skills[0]).toMatchObject({
      organizationId: ORGANIZATION,
      state: 'revoked',
      artifact: { digest: fixture.stored.digest, size: fixture.stored.size },
    });
    expect(restoredState.skills[0]!.artifact.key).not.toBe(fixture.stored.key);
    await expect(targetBlobStore.get(restoredState.skills[0]!.artifact.key)).resolves.toEqual(fixture.bytes);
    expect(restoredState.audit).toHaveLength(2);
  });

  it('requires explicit fence evidence and refuses source or non-isolated targets', async () => {
    const fixture = await sourceFixture();
    const sourceLocation = {
      kind: 'filesystem' as const,
      identity: 'offline-source-registry',
      roots: [fixture.sourceMetadata, fixture.sourceBlobs],
    };
    await expect(createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation,
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: undefined as never,
    })).rejects.toMatchObject({ code: 'FENCE_REQUIRED' });

    await createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation,
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: {
        scope: 'offline',
        kind: 'offline-test',
        evidenceRef: 'vitest-fence',
        observedAt: '2026-01-01T00:02:00.000Z',
      },
    });
    const targetRepository = createFileStateRepository({ directory: fixture.targetMetadata });
    const targetBlobStore = await createNodeFilesSdkBlobStore({ provider: 'fs', root: fixture.targetBlobs, prefix: 'target-registry' });
    await expect(restoreLogicalBackup({
      targetRepository,
      targetBlobs: targetBlobStore,
      organizationId: ORGANIZATION,
      targetIdentity: 'offline-source-registry',
      targetLocation: {
        kind: 'filesystem',
        identity: 'offline-source-registry',
        roots: [fixture.sourceMetadata, fixture.sourceBlobs],
      },
      backupDirectory: fixture.backup,
      targetIsolated: true,
      targetSeed: createFileStateSeed(fixture.targetMetadata),
    })).rejects.toMatchObject({ code: 'SOURCE_TARGET_SAME' });
    await expect(restoreLogicalBackup({
      targetRepository,
      targetBlobs: targetBlobStore,
      organizationId: ORGANIZATION,
      targetIdentity: 'offline-target-registry',
      targetLocation: {
        kind: 'filesystem',
        identity: 'offline-target-registry',
        roots: [fixture.targetMetadata, fixture.targetBlobs],
      },
      backupDirectory: fixture.backup,
      targetIsolated: false as never,
      targetSeed: createFileStateSeed(fixture.targetMetadata),
    })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it('enforces the aggregate object budget before copying or mutating the target', async () => {
    const fixture = await sourceFixture();
    const sourceLocation = {
      kind: 'filesystem' as const,
      identity: 'offline-source-registry',
      roots: [fixture.sourceMetadata, fixture.sourceBlobs],
    };
    const fence = {
      scope: 'offline' as const,
      kind: 'offline-test' as const,
      evidenceRef: 'vitest-fence',
      observedAt: '2026-01-01T00:02:00.000Z',
    };
    await expect(createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation,
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: fence,
      maxTotalObjectBytes: fixture.bytes.byteLength - 1,
    })).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(readdir(fixture.backup)).resolves.toEqual([]);

    const backup = await createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation,
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: fence,
    });
    await expect(readLogicalBackup(fixture.backup, {
      maxTotalObjectBytes: fixture.bytes.byteLength - 1,
    })).rejects.toMatchObject({ code: 'SIZE_LIMIT' });

    const targetRepository = createFileStateRepository({ directory: fixture.targetMetadata });
    const targetBlobStore = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root: fixture.targetBlobs,
      prefix: 'target-registry',
    });
    await expect(restoreLogicalBackup({
      targetRepository,
      targetBlobs: targetBlobStore,
      organizationId: ORGANIZATION,
      targetIdentity: 'offline-target-registry',
      targetLocation: {
        kind: 'filesystem',
        identity: 'offline-target-registry',
        roots: [fixture.targetMetadata, fixture.targetBlobs],
      },
      backupDirectory: fixture.backup,
      targetIsolated: true,
      targetSeed: createFileStateSeed(fixture.targetMetadata),
      maxTotalObjectBytes: fixture.bytes.byteLength - 1,
    })).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(readdir(fixture.targetMetadata)).resolves.toEqual([]);
    await expect(readdir(fixture.targetBlobs)).resolves.toEqual([]);
    expect(backup.manifest.objects).toHaveLength(1);
  });

  it('rejects tampered or world-readable backup files before metadata commit', async () => {
    const fixture = await sourceFixture();
    const sourceLocation = {
      kind: 'filesystem' as const,
      identity: 'offline-source-registry',
      roots: [fixture.sourceMetadata, fixture.sourceBlobs],
    };
    const backup = await createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation,
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: {
        scope: 'offline',
        kind: 'offline-test',
        evidenceRef: 'vitest-fence',
        observedAt: '2026-01-01T00:02:00.000Z',
      },
    });
    const objectPath = join(fixture.backup, backup.manifest.objects[0]!.archivePath);
    await writeFile(objectPath, 'tampered bytes');
    const targetRepository = createFileStateRepository({ directory: fixture.targetMetadata });
    const targetBlobStore = await createNodeFilesSdkBlobStore({ provider: 'fs', root: fixture.targetBlobs, prefix: 'target-registry' });
    await expect(restoreLogicalBackup({
      targetRepository,
      targetBlobs: targetBlobStore,
      organizationId: ORGANIZATION,
      targetIdentity: 'offline-target-registry',
      targetLocation: {
        kind: 'filesystem',
        identity: 'offline-target-registry',
        roots: [fixture.targetMetadata, fixture.targetBlobs],
      },
      backupDirectory: fixture.backup,
      targetIsolated: true,
      targetSeed: createFileStateSeed(fixture.targetMetadata),
    })).rejects.toMatchObject({ code: 'OBJECT_DIGEST_MISMATCH' });
    expect((await targetRepository.read(ORGANIZATION)).skills).toHaveLength(0);

    await chmod(join(fixture.backup, 'manifest.json'), 0o644);
    await expect(readLogicalBackup(fixture.backup)).rejects.toMatchObject({ code: 'PERMISSION' });
  });

  it('refuses a generic target before reading or mutating an isolated destination', async () => {
    const fixture = await sourceFixture();
    const backup = await createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation: {
        kind: 'filesystem',
        identity: 'offline-source-registry',
        roots: [fixture.sourceMetadata, fixture.sourceBlobs],
      },
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: {
        scope: 'offline',
        kind: 'offline-test',
        evidenceRef: 'vitest-fence',
        observedAt: '2026-01-01T00:02:00.000Z',
      },
    });
    const targetRepository = createFileStateRepository({ directory: fixture.targetMetadata });
    const targetBlobStore = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root: fixture.targetBlobs,
      prefix: 'target-registry',
    });
    await expect(restoreLogicalBackup({
      targetRepository,
      targetBlobs: targetBlobStore,
      organizationId: ORGANIZATION,
      targetIdentity: 'offline-target-registry',
      targetLocation: {
        kind: 'filesystem',
        identity: 'offline-target-registry',
        roots: [fixture.targetMetadata, fixture.targetBlobs],
      },
      backupDirectory: fixture.backup,
      targetIsolated: true,
      targetSeed: undefined as never,
    })).rejects.toMatchObject({ code: 'REVISION_UNSUPPORTED' });
    await expect(readdir(fixture.targetMetadata)).resolves.toEqual([]);
    await expect(readdir(fixture.targetBlobs)).resolves.toEqual([]);
    expect(backup.manifest.metadataRevision).toBeGreaterThan(1);
  });

  it('verifies target bytes after put and leaves metadata unseeded on a faulty provider', async () => {
    const fixture = await sourceFixture();
    await createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation: {
        kind: 'filesystem',
        identity: 'offline-source-registry',
        roots: [fixture.sourceMetadata, fixture.sourceBlobs],
      },
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: {
        scope: 'offline',
        kind: 'offline-test',
        evidenceRef: 'vitest-fence',
        observedAt: '2026-01-01T00:02:00.000Z',
      },
    });
    const targetRepository = createFileStateRepository({ directory: fixture.targetMetadata });
    let seeded = false;
    const faultyTarget: BlobStore = {
      async put(bytes) {
        return {
          key: `target-registry/sealed/${'a'.repeat(48)}`,
          digest: await digestBytes(bytes),
          size: bytes.byteLength,
        };
      },
      async get() {
        return new TextEncoder().encode('faulty read-back');
      },
      async remove() {
        // The rehearsal never calls remove; retaining this no-op keeps the
        // fixture explicit about the provider interface.
      },
    };
    await expect(restoreLogicalBackup({
      targetRepository,
      targetBlobs: faultyTarget,
      organizationId: ORGANIZATION,
      targetIdentity: 'offline-target-registry',
      targetLocation: {
        kind: 'filesystem',
        identity: 'offline-target-registry',
        roots: [fixture.targetMetadata, fixture.targetBlobs],
      },
      backupDirectory: fixture.backup,
      targetIsolated: true,
      targetSeed: {
        kind: 'isolated-empty-state-v1',
        async seed() {
          seeded = true;
        },
      },
    })).rejects.toMatchObject({ code: 'TARGET_DIGEST_MISMATCH' });
    expect(seeded).toBe(false);
    expect((await targetRepository.read(ORGANIZATION)).skills).toHaveLength(0);
  });

  it('rejects a symlinked backup parent before a target write', async () => {
    if (process.platform === 'win32') return;
    const fixture = await sourceFixture();
    await createLogicalBackup({
      sourceRepository: fixture.sourceRepository,
      sourceBlobs: fixture.sourceBlobStore,
      organizationId: ORGANIZATION,
      sourceIdentity: 'offline-source-registry',
      sourceLocation: {
        kind: 'filesystem',
        identity: 'offline-source-registry',
        roots: [fixture.sourceMetadata, fixture.sourceBlobs],
      },
      backupDirectory: fixture.backup,
      captureConsistency: 'offline-filesystem',
      deletionFence: {
        scope: 'offline',
        kind: 'offline-test',
        evidenceRef: 'vitest-fence',
        observedAt: '2026-01-01T00:02:00.000Z',
      },
    });
    const realObjects = join(fixture.backup, 'objects-real');
    await rename(join(fixture.backup, 'objects'), realObjects);
    await symlink(realObjects, join(fixture.backup, 'objects'), 'junction');
    const targetRepository = createFileStateRepository({ directory: fixture.targetMetadata });
    const targetBlobStore = await createNodeFilesSdkBlobStore({ provider: 'fs', root: fixture.targetBlobs, prefix: 'target-registry' });
    await expect(restoreLogicalBackup({
      targetRepository,
      targetBlobs: targetBlobStore,
      organizationId: ORGANIZATION,
      targetIdentity: 'offline-target-registry',
      targetLocation: {
        kind: 'filesystem',
        identity: 'offline-target-registry',
        roots: [fixture.targetMetadata, fixture.targetBlobs],
      },
      backupDirectory: fixture.backup,
      targetIsolated: true,
      targetSeed: createFileStateSeed(fixture.targetMetadata),
    })).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect((await targetRepository.read(ORGANIZATION)).skills).toHaveLength(0);
  });

  it('runs the executable local backup and restore path with sanitized output', async () => {
    if (process.platform === 'win32') return;
    root = await mkdtemp(join(tmpdir(), 'private-skills-restore-cli-'));
    const script = join(process.cwd(), 'scripts', 'restore-backup');
    const sourceState = join(root, 'source-state');
    const sourceBlobs = join(root, 'source-blobs');
    const backup = join(root, 'backup');
    const targetState = join(root, 'target-state');
    const targetBlobs = join(root, 'target-blobs');
    const run = (args: string[]) => execFileAsync(script, args, { encoding: 'utf8' });
    const backupResult = await run([
      'backup',
      '--organization', ORGANIZATION,
      '--state-dir', sourceState,
      '--blob-dir', sourceBlobs,
      '--blob-prefix', 'private-registry',
      '--source-id', 'cli-source',
      '--output', backup,
      '--fence-evidence', 'vitest-cli-fence',
    ]);
    expect(JSON.parse(backupResult.stdout)).toEqual({
      ok: true,
      operation: 'backup',
      organizationId: ORGANIZATION,
      metadataRevision: 0,
      objectCount: 0,
    });
    const restoreResult = await run([
      'restore',
      '--organization', ORGANIZATION,
      '--backup', backup,
      '--target-state-dir', targetState,
      '--target-blob-dir', targetBlobs,
      '--blob-prefix', 'private-registry',
      '--target-id', 'cli-target',
      '--target-isolated', 'true',
    ]);
    expect(JSON.parse(restoreResult.stdout)).toEqual({
      ok: true,
      operation: 'restore',
      organizationId: ORGANIZATION,
      metadataRevision: 0,
      objectCount: 0,
      remappedObjectCount: 0,
    });
    expect(restoreResult.stdout).not.toMatch(/manifest|sealed|token|secret/i);
  });
});
