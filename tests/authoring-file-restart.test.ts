import { mkdtemp, rm } from 'node:fs/promises';
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
import {
  decodeBundle,
  digestBytes,
  encodeBundle,
} from '../packages/storage/src/index.js';
import type {
  BlobStore,
  Policy,
  RegistryConfiguration,
  RegistryState,
  ScanResult,
  SkillBundle,
  SkillDraftFileManifestEntry,
  SkillVersion,
} from '../packages/contracts/src/index.js';

const ORIGIN = 'http://authoring-file-restart.test';
const ORGANIZATION = 'org-authoring-file-restart';
const PUBLISHER_TOKEN = 'authoring-file-restart-publisher';
const READER_TOKEN = 'authoring-file-restart-reader';
const BLOB_PREFIX = 'authoring-file-restart';
const POLICY: Policy = {
  revision: 'authoring-file-restart-policy',
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
const CONFIG: RegistryConfiguration = {
  publicOrigin: ORIGIN,
  maxBodyBytes: 2 * 1024 * 1024,
  organizationId: ORGANIZATION,
  leaseSeconds: 60,
};

type HttpHandler = (request: Request) => Promise<Response>;

interface FileBackedServices {
  handler: RegistryHandler;
  repository: FileStateRepository;
  blobs: BlobStore;
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function bundleWith(description: string, guide: string, safe: boolean): SkillBundle {
  return {
    format: 'pskills-bundle-v1',
    files: [
      {
        path: 'SKILL.md',
        content: base64(`---\nname: base-skill\ndescription: ${description}\n---\n\nNever execute this fixture.\n`),
      },
      { path: 'docs/guide.md', content: base64(`${guide}\n`) },
      { path: 'rules.json', content: base64(JSON.stringify({ safe }) + '\n') },
    ],
  };
}

async function manifest(files: SkillBundle['files']): Promise<SkillDraftFileManifestEntry[]> {
  return await Promise.all(files.map(async (file) => {
    const bytes = Uint8Array.from(Buffer.from(file.content, 'base64'));
    return {
      path: file.path,
      size: bytes.byteLength,
      digest: await digestBytes(bytes),
      ...(file.executable === true ? { executable: true } : {}),
    };
  }));
}

async function createAuth(): Promise<TokenAuthenticator> {
  const userTokens: BootstrapTokenConfig[] = [
    {
      id: 'publisher',
      token: PUBLISHER_TOKEN,
      organizationId: ORGANIZATION,
      subject: 'publisher',
      roles: ['owner', 'admin', 'publisher', 'reader'],
      namespaces: ['@acme'],
      scopes: ['registry:*', 'skills:read', 'skills:write', 'skills:publish'],
    },
    {
      id: 'reader',
      token: READER_TOKEN,
      organizationId: ORGANIZATION,
      subject: 'reader',
      roles: ['reader'],
      namespaces: ['@acme'],
      scopes: ['registry:*', 'skills:read'],
    },
  ];
  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: userTokens,
    sessionSecret: 'authoring-file-restart-session-secret-that-is-long-enough',
    publicOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  await auth.ready();
  return auth;
}

async function openServices(
  stateDirectory: string,
  blobDirectory: string,
  initial?: RegistryState,
): Promise<FileBackedServices> {
  const repository = initial === undefined
    ? createFileStateRepository({ directory: stateDirectory })
    : createFileStateRepository({ directory: stateDirectory, initial: { [ORGANIZATION]: initial } });
  const blobs = await createNodeFilesSdkBlobStore({
    provider: 'fs',
    root: blobDirectory,
    prefix: BLOB_PREFIX,
  });
  const auth = await createAuth();
  return {
    handler: createRegistryHandler({ repository, blobs, auth, config: CONFIG }),
    repository,
    blobs,
  };
}

function headers(token?: string): HeadersInit {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

async function call(
  handler: HttpHandler,
  path: string,
  token?: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, ...requestInit } = init;
  const requestHeaders = new Headers({ ...headers(token), ...(requestInit.headers ?? {}) });
  let body = requestInit.body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    requestHeaders.set('content-type', 'application/json');
  }
  return handler(new Request(new URL(path, ORIGIN), { ...requestInit, headers: requestHeaders, body }));
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function draftCreateRequest(baseDigest: string): { method: 'POST'; headers: HeadersInit; json: unknown } {
  return {
    method: 'POST',
    headers: { 'idempotency-key': 'file-restart-create' },
    json: { baseDigest },
  };
}

function draftUpdateRequest(
  expectedRevision: number,
  idempotencyKey: string,
  files: SkillBundle['files'],
): { method: 'PUT'; headers: HeadersInit; json: unknown } {
  return {
    method: 'PUT',
    headers: { 'idempotency-key': idempotencyKey },
    json: { expectedRevision, files },
  };
}

describe('file-backed authoring restart composition', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('reopens an edited release draft with exact files, fences stale CAS writes, and preserves the base release', async () => {
    root = await mkdtemp(join(tmpdir(), 'private-skills-authoring-file-restart-'));
    const stateDirectory = join(root, 'state');
    const blobDirectory = join(root, 'blobs');
    const baseBundle = bundleWith('Base release', 'Base guide', true);
    const baseBytes = encodeBundle(baseBundle);

    const initialBlobs = await createNodeFilesSdkBlobStore({
      provider: 'fs',
      root: blobDirectory,
      prefix: BLOB_PREFIX,
    });
    const baseArtifact = await initialBlobs.put(baseBytes);
    const baseScan: ScanResult = {
      id: 'file-restart-base-scan',
      organizationId: ORGANIZATION,
      jobId: 'file-restart-base-scan-job',
      artifactDigest: baseArtifact.digest,
      policyRevision: POLICY.revision,
      scannerId: 'skillsguard',
      engineVersion: 'fixture',
      rulesRevision: 'fixture',
      configurationHash: `sha256:${'1'.repeat(64)}`,
      status: 'completed',
      findings: [],
      coverage: {
        filesEnumerated: baseBundle.files.length,
        filesAnalyzed: baseBundle.files.length,
        filesSkipped: 0,
        filesUnsupported: 0,
        limitations: ['deterministic local fixture scanner'],
        externalDestinations: [],
      },
      createdAt: new Date().toISOString(),
      durationMs: 1,
    };
    const initialState = defaultRegistryState({
      production: false,
      allowUnscanned: false,
      policyRevision: POLICY.revision,
    });
    initialState.policy = structuredClone(POLICY);
    initialState.scans.push(baseScan);
    const baseRelease: SkillVersion = {
      id: 'skill-file-restart-base',
      organizationId: ORGANIZATION,
      name: '@acme/base-skill',
      skillName: 'base-skill',
      version: '1.0.0',
      description: 'Base release',
      artifact: baseArtifact,
      state: 'approved',
      policyRevision: POLICY.revision,
      createdAt: '2026-09-10T00:00:00.000Z',
      approvedAt: '2026-09-10T00:00:01.000Z',
      provenance: { kind: 'native' },
      fileCount: baseBundle.files.length,
      scanIds: [baseScan.id],
    };
    initialState.skills.push(baseRelease);

    const first = await openServices(stateDirectory, blobDirectory, initialState);
    const createdResponse = await call(
      first.handler,
      `/v1/skills/${encodeURIComponent(baseRelease.id)}/drafts`,
      PUBLISHER_TOKEN,
      draftCreateRequest(baseArtifact.digest),
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = await json<{ draft: { id: string; revision: number; digest: string } }>(createdResponse);
    expect(created.draft).toMatchObject({ revision: 1, digest: baseArtifact.digest });

    const editedBundle = bundleWith('Restart-edited release', 'Restart-edited guide', false);
    const updateResponse = await call(
      first.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
      draftUpdateRequest(1, 'file-restart-update', editedBundle.files),
    );
    expect(updateResponse.status, await updateResponse.clone().text()).toBe(200);
    const updated = await json<{
      draft: {
        id: string;
        revision: number;
        digest: string;
        files: SkillDraftFileManifestEntry[];
      };
    }>(updateResponse);
    expect(updated.draft).toMatchObject({
      id: created.draft.id,
      revision: 2,
      files: await manifest(editedBundle.files),
    });
    expect(updated.draft.digest).toBe(await digestBytes(encodeBundle(editedBundle)));

    // A new repository, Files SDK client, authenticator, and composed handler
    // model a fresh process reading only the durable state/object directories.
    const second = await openServices(stateDirectory, blobDirectory);
    const reloadedResponse = await call(
      second.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
    );
    expect(reloadedResponse.status, await reloadedResponse.clone().text()).toBe(200);
    const reloaded = await json<{ draft: typeof updated.draft }>(reloadedResponse);
    expect(reloaded.draft).toEqual(updated.draft);

    const reloadedState = await second.repository.read(ORGANIZATION);
    // Each draft write now persists a storage-attempt ownership record before
    // the provider write, so the two logical edits occupy four repository
    // transactions while the draft revision remains two.
    expect(reloadedState.metadataRevision).toBe(4);
    const persistedDraft = reloadedState.drafts?.find((draft) => draft.id === created.draft.id);
    expect(persistedDraft).toMatchObject({
      revision: 2,
      digest: updated.draft.digest,
      files: editedBundle.files,
    });
    expect(persistedDraft).toBeDefined();
    const restoredBytes = await second.blobs.get(persistedDraft!.artifact.key);
    expect(await digestBytes(restoredBytes)).toBe(updated.draft.digest);
    expect(decodeBundle(restoredBytes)).toEqual(editedBundle);

    for (const expectedFile of editedBundle.files) {
      const query = new URLSearchParams({
        path: expectedFile.path,
        revision: String(updated.draft.revision),
        digest: updated.draft.digest,
      });
      const selectedResponse = await call(
        second.handler,
        `/v1/drafts/${encodeURIComponent(created.draft.id)}/files?${query.toString()}`,
        PUBLISHER_TOKEN,
      );
      expect(selectedResponse.status, await selectedResponse.clone().text()).toBe(200);
      const selected = await json<{
        file: { path: string; size: number; digest: string; content?: string };
      }>(selectedResponse);
      expect(selected.file).toMatchObject({
        path: expectedFile.path,
        size: Buffer.from(expectedFile.content, 'base64').byteLength,
        digest: await digestBytes(Uint8Array.from(Buffer.from(expectedFile.content, 'base64'))),
        content: expectedFile.content,
      });
    }

    const staleResponse = await call(
      second.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      PUBLISHER_TOKEN,
      draftUpdateRequest(1, 'file-restart-stale-update', baseBundle.files),
    );
    expect(staleResponse.status, await staleResponse.clone().text()).toBe(409);
    expect(await json<{ error: { code: string; details?: { currentRevision?: number } } }>(staleResponse)).toMatchObject({
      error: { code: 'DRAFT_CONFLICT', details: { currentRevision: 2 } },
    });
    const afterStale = await second.repository.read(ORGANIZATION);
    const unchangedDraft = afterStale.drafts?.find((draft) => draft.id === created.draft.id);
    expect(unchangedDraft).toMatchObject({ revision: 2, digest: updated.draft.digest, files: editedBundle.files });

    const unchangedBase = afterStale.skills.find((skill) => skill.id === baseRelease.id);
    expect(unchangedBase).toEqual(baseRelease);
    const restoredBaseBytes = await second.blobs.get(baseArtifact.key);
    expect(Array.from(restoredBaseBytes)).toEqual(Array.from(baseBytes));
    expect(await digestBytes(restoredBaseBytes)).toBe(baseArtifact.digest);

  });
});
