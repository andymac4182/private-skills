import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TokenAuthenticator,
  type BootstrapTokenConfig,
} from '../../packages/auth/src/index.js';
import {
  createMemoryStateRepository,
  defaultRegistryState,
} from '../../packages/database/src/index.js';
import {
  createRegistryHandler,
  type RegistryHandler,
} from '../../packages/core/src/index.js';
import { createNodeFilesSdkBlobStore } from '../../packages/storage/src/node.js';
import {
  decodeBundle,
  digestBytes,
  encodeBundle,
} from '../../packages/storage/src/index.js';
import type {
  BlobStore,
  Policy,
  Principal,
  ScanResult,
  SkillBuilderSessionRecord,
  SkillDraftFileManifestEntry,
  SkillBundle,
  SkillVersion,
  StoredBlob,
} from '../../packages/contracts/src/index.js';

const ORIGIN = 'http://large-draft-e2e.test';
const ORGANIZATION = 'org-large-draft-e2e';
const PUBLISHER_TOKEN = 'large-draft-publisher-token';
const BASE_RESOURCE_ID = 'release-large-draft';

// Vercel's serverless request-body limit is 4.5 MB. The update below sends
// only three changed files and one digest-only reference to the current
// sealed large file, so the wire request stays below that hosting boundary.
const VERCEL_BODY_CAP_BYTES = 4_500_000;
const LARGE_FILE_BYTES = Math.floor(3.5 * 1024 * 1024);
const LARGE_FILE_PATH = 'assets/unchanged.bin';
const RENAMED_LARGE_FILE_PATH = 'assets/renamed.bin';

type DraftFileReference = {
  path: string;
  sourcePath?: string;
  digest: `sha256:${string}`;
};

type DraftFileInput = SkillBundle['files'][number] | DraftFileReference;

interface JsonRequestInit extends RequestInit {
  json?: unknown;
}

interface PublicDraftResponse {
  draft: {
    id: string;
    revision: number;
    digest: SkillVersion['artifact']['digest'];
    files: SkillDraftFileManifestEntry[];
  };
  idempotent?: boolean;
}

interface LargeDraftFixture {
  handler: RegistryHandler;
  repository: ReturnType<typeof createMemoryStateRepository>;
  blobs: CountingBlobStore;
  baseRelease: SkillVersion;
  baseBundle: SkillBundle;
  baseBytes: Uint8Array;
  largeContent: string;
  close: () => Promise<void>;
}

function base64Bytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64Text(value: string): string {
  return base64Bytes(new TextEncoder().encode(value));
}

async function draftManifest(files: SkillBundle['files']): Promise<SkillDraftFileManifestEntry[]> {
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

function deterministicLargeBytes(): Uint8Array {
  const bytes = new Uint8Array(LARGE_FILE_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 29 + 17) & 0xff;
  }
  return bytes;
}

class CountingBlobStore implements BlobStore {
  putCalls = 0;
  getCalls = 0;

  constructor(private readonly inner: BlobStore) {}

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    this.putCalls += 1;
    return await this.inner.put(bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    this.getCalls += 1;
    return await this.inner.get(key);
  }

  async remove(key: string): Promise<void> {
    await this.inner.remove(key);
  }
}

function publisher(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'large-draft-publisher',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: ['@team'],
    scopes: ['registry:*', 'skills:read', 'skills:write', 'skills:publish', 'skills:builder'],
  };
}

function requiredBaseScan(
  artifactDigest: SkillVersion['artifact']['digest'],
  policyRevision: string,
  fileCount: number,
): ScanResult {
  return {
    id: 'large-draft-base-scan',
    organizationId: ORGANIZATION,
    jobId: 'large-draft-base-scan-job',
    artifactDigest,
    policyRevision,
    scannerId: 'skillsguard',
    engineVersion: 'fixture-engine',
    rulesRevision: 'fixture-rules',
    configurationHash: `sha256:${'1'.repeat(64)}`,
    status: 'completed',
    findings: [],
    coverage: {
      filesEnumerated: fileCount,
      filesAnalyzed: fileCount,
      filesSkipped: 0,
      filesUnsupported: 0,
      limitations: ['deterministic local fixture scanner'],
      externalDestinations: [],
    },
    createdAt: new Date().toISOString(),
    durationMs: 1,
  };
}

async function makeFixture(): Promise<LargeDraftFixture> {
  const root = await mkdtemp(join(tmpdir(), 'private-skills-large-draft-e2e-'));
  const fileBytes = deterministicLargeBytes();
  const largeContent = base64Bytes(fileBytes);
  const baseBundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [
      {
        path: 'SKILL.md',
        content: base64Text(
          '---\nname: large-draft\ndescription: Base large draft\n---\n\n# Base\n',
        ),
      },
      { path: 'docs/guide.md', content: base64Text('Base guide\n') },
      { path: 'rules.json', content: base64Text('{"revision":1,"safe":true}\n') },
      { path: LARGE_FILE_PATH, content: largeContent },
    ],
  };
  const baseBytes = encodeBundle(baseBundle);
  const filesStore = await createNodeFilesSdkBlobStore({
    provider: 'fs',
    root,
    prefix: 'large-draft',
  });
  const blobs = new CountingBlobStore(filesStore);
  const artifact = await blobs.put(baseBytes);

  const policy: Policy = {
    revision: 'large-draft-required-scanner',
    scanners: [
      {
        id: 'cisco-skill-scanner',
        mode: 'disabled',
        blockSeverities: ['high', 'critical'],
        timeoutSeconds: 5,
      },
      {
        id: 'nvidia-skillspector',
        mode: 'disabled',
        blockSeverities: ['high', 'critical'],
        timeoutSeconds: 5,
      },
      {
        id: 'skillsguard',
        mode: 'required',
        blockSeverities: ['high', 'critical'],
        timeoutSeconds: 5,
      },
    ],
    allowUnscanned: false,
    evidenceMaxAgeSeconds: 3_600,
    hooks: [],
  };
  const state = defaultRegistryState({
    production: false,
    allowUnscanned: false,
    policyRevision: policy.revision,
  });
  state.policy = policy;
  const baseScan = requiredBaseScan(artifact.digest, policy.revision, baseBundle.files.length);
  state.scans.push(baseScan);
  const baseRelease: SkillVersion = {
    id: BASE_RESOURCE_ID,
    organizationId: ORGANIZATION,
    name: '@team/large-draft',
    skillName: 'large-draft',
    version: '1.0.0',
    description: 'Base large draft',
    artifact,
    state: 'approved',
    policyRevision: policy.revision,
    createdAt: '2026-09-10T00:00:00.000Z',
    approvedAt: '2026-09-10T00:00:01.000Z',
    provenance: { kind: 'native' },
    fileCount: baseBundle.files.length,
    scanIds: [baseScan.id],
  };
  state.skills.push(baseRelease);
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });

  const tokenConfig: BootstrapTokenConfig = {
    id: 'large-draft-publisher',
    token: PUBLISHER_TOKEN,
    organizationId: ORGANIZATION,
    subject: publisher().subject,
    roles: publisher().roles,
    namespaces: ['@team'],
    scopes: ['registry:*', 'skills:read', 'skills:write', 'skills:publish', 'skills:builder'],
  };
  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: [tokenConfig],
    sessionSecret: 'large-draft-e2e-session-secret-that-is-long-enough',
    publicOrigin: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  await auth.ready();

  const handler = createRegistryHandler({
    repository,
    blobs,
    auth,
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: VERCEL_BODY_CAP_BYTES,
      organizationId: ORGANIZATION,
      leaseSeconds: 60,
    },
  });
  return {
    handler,
    repository,
    blobs,
    baseRelease,
    baseBundle,
    baseBytes,
    largeContent,
    close: async () => await rm(root, { recursive: true, force: true }),
  };
}

async function call(
  handler: RegistryHandler,
  path: string,
  init: JsonRequestInit = {},
): Promise<Response> {
  const { json, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  headers.set('authorization', `Bearer ${PUBLISHER_TOKEN}`);
  let body = requestInit.body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    headers.set('content-type', 'application/json');
    headers.set('content-length', String(new TextEncoder().encode(body).byteLength));
  }
  return await handler(new Request(new URL(path, ORIGIN), {
    ...requestInit,
    headers,
    body,
  }));
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function responseBytes(response: Response): Promise<number> {
  return (await response.clone().arrayBuffer()).byteLength;
}

function deltaFiles(largeDigest: `sha256:${string}`): DraftFileInput[] {
  return [
    {
      path: RENAMED_LARGE_FILE_PATH,
      sourcePath: LARGE_FILE_PATH,
      digest: largeDigest,
    },
    {
      path: 'rules.json',
      content: base64Text('{"revision":2,"safe":true}\n'),
    },
    { path: 'docs/guide.md', content: base64Text('Edited guide\n') },
    {
      path: 'SKILL.md',
      content: base64Text(
        '---\nname: large-draft\ndescription: Edited large draft\n---\n\n# Edited\n',
      ),
    },
  ];
}

function fileByPath(bundle: SkillBundle, path: string): SkillBundle['files'][number] {
  const file = bundle.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`missing fixture file ${path}`);
  return file;
}

describe('large draft delta authoring over the real handler and Files SDK fs adapter', () => {
  const fixtures: LargeDraftFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) await fixtures.pop()!.close();
  });

  it('keeps the 3.5 MiB file sealed while applying three small edits below the hosting cap and replaying CAS idempotently', async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);

    const baseBytesBefore = await fixture.blobs.get(fixture.baseRelease.artifact.key);
    expect(baseBytesBefore).toEqual(fixture.baseBytes);
    expect(baseBytesBefore.byteLength).toBeGreaterThan(3.5 * 1024 * 1024 - 1);
    const largeDigest = await digestBytes(new Uint8Array(Buffer.from(fixture.largeContent, 'base64')));

    const createdResponse = await call(
      fixture.handler,
      `/v1/skills/${encodeURIComponent(BASE_RESOURCE_ID)}/drafts`,
      {
        method: 'POST',
        headers: { 'idempotency-key': 'large-draft-create' },
        json: { baseDigest: fixture.baseRelease.artifact.digest },
      },
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    expect(await responseBytes(createdResponse)).toBeLessThan(VERCEL_BODY_CAP_BYTES);
    const created = await json<PublicDraftResponse>(createdResponse);
    expect(created.draft).toMatchObject({
      id: expect.any(String),
      revision: 1,
      digest: fixture.baseRelease.artifact.digest,
    });
    expect(created.draft.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      LARGE_FILE_PATH,
      'docs/guide.md',
      'rules.json',
    ]);
    expect(created.draft.files).toEqual(await draftManifest([...fixture.baseBundle.files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0)));
    expect(created.draft.files.every((file) => !('content' in file))).toBe(true);

    const payload = {
      expectedRevision: 1,
      expectedDigest: created.draft.digest,
      files: deltaFiles(largeDigest),
    };
    const fullSnapshotBodyBytes = new TextEncoder().encode(JSON.stringify({
      expectedRevision: payload.expectedRevision,
      expectedDigest: payload.expectedDigest,
      files: fixture.baseBundle.files,
    })).byteLength;
    const deltaBodyBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    expect(fullSnapshotBodyBytes).toBeGreaterThan(VERCEL_BODY_CAP_BYTES);
    expect(deltaBodyBytes).toBeLessThan(VERCEL_BODY_CAP_BYTES);
    expect(payload.files).toHaveLength(4);
    expect(payload.files.filter((file): file is DraftFileReference => 'digest' in file)).toEqual([
      {
        path: RENAMED_LARGE_FILE_PATH,
        sourcePath: LARGE_FILE_PATH,
        digest: largeDigest,
      },
    ]);

    const putsBeforeUpdate = fixture.blobs.putCalls;
    const updatedResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      {
        method: 'PUT',
        headers: { 'idempotency-key': 'large-draft-delta-1' },
        json: payload,
      },
    );
    expect(updatedResponse.status, await updatedResponse.clone().text()).toBe(200);
    expect(await responseBytes(updatedResponse)).toBeLessThan(VERCEL_BODY_CAP_BYTES);
    const updated = await json<PublicDraftResponse>(updatedResponse);
    expect(updated.draft.revision).toBe(2);
    expect(updated.draft.digest).not.toBe(created.draft.digest);
    expect(updated.draft.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      RENAMED_LARGE_FILE_PATH,
      'docs/guide.md',
      'rules.json',
    ]);
    expect(updated.draft.files.some((file) => file.path === LARGE_FILE_PATH)).toBe(false);
    const expectedUpdatedFiles: SkillBundle['files'] = [
      {
        path: RENAMED_LARGE_FILE_PATH,
        content: fixture.largeContent,
      },
      {
        path: 'SKILL.md',
        content: base64Text('---\nname: large-draft\ndescription: Edited large draft\n---\n\n# Edited\n'),
      },
      { path: 'docs/guide.md', content: base64Text('Edited guide\n') },
      { path: 'rules.json', content: base64Text('{"revision":2,"safe":true}\n') },
    ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    expect(updated.draft.files).toEqual(await draftManifest(expectedUpdatedFiles));
    expect(updated.draft.files.every((file) => !('content' in file))).toBe(true);
    expect(fixture.blobs.putCalls).toBe(putsBeforeUpdate + 1);

    const loadedResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
    );
    expect(loadedResponse.status, await loadedResponse.clone().text()).toBe(200);
    expect(await responseBytes(loadedResponse)).toBeLessThan(VERCEL_BODY_CAP_BYTES);
    const loaded = await json<PublicDraftResponse>(loadedResponse);
    expect(loaded.draft).toEqual(updated.draft);

    const selectedTextResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/files?path=${encodeURIComponent('SKILL.md')}&revision=2&digest=${encodeURIComponent(updated.draft.digest)}`,
    );
    expect(selectedTextResponse.status, await selectedTextResponse.clone().text()).toBe(200);
    expect(await responseBytes(selectedTextResponse)).toBeLessThan(VERCEL_BODY_CAP_BYTES);
    const selectedText = await json<{ file: { path: string; size: number; digest: string; previewState: string; content?: string } }>(selectedTextResponse);
    expect(selectedText.file).toMatchObject({
      path: 'SKILL.md',
      previewState: 'text',
      content: base64Text('---\nname: large-draft\ndescription: Edited large draft\n---\n\n# Edited\n'),
    });
    expect(selectedText.file).not.toHaveProperty('contents');

    const selectedBinaryResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/files?path=${encodeURIComponent(RENAMED_LARGE_FILE_PATH)}&revision=2&digest=${encodeURIComponent(updated.draft.digest)}`,
    );
    expect(selectedBinaryResponse.status, await selectedBinaryResponse.clone().text()).toBe(200);
    expect(await responseBytes(selectedBinaryResponse)).toBeLessThan(VERCEL_BODY_CAP_BYTES);
    const selectedBinary = await json<{ file: { path: string; size: number; digest: string; previewState: string; content?: string } }>(selectedBinaryResponse);
    expect(selectedBinary.file).toMatchObject({
      path: RENAMED_LARGE_FILE_PATH,
      size: LARGE_FILE_BYTES,
      digest: largeDigest,
      previewState: 'binary',
    });
    expect(selectedBinary.file).not.toHaveProperty('content');

    const staleSelected = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/files?path=SKILL.md&revision=1&digest=${encodeURIComponent(created.draft.digest)}`,
    );
    expect(staleSelected.status).toBe(409);

    const stateAfterUpdate = await fixture.repository.read(ORGANIZATION);
    const draftAfterUpdate = stateAfterUpdate.drafts?.find((draft) => draft.id === created.draft.id);
    expect(draftAfterUpdate).toMatchObject({ revision: 2, digest: updated.draft.digest });
    expect(draftAfterUpdate?.artifact.digest).toBe(updated.draft.digest);
    const sealedDraftBytes = await fixture.blobs.get(draftAfterUpdate!.artifact.key);
    const sealedDraft = decodeBundle(sealedDraftBytes);
    expect(sealedDraft.files.some((file) => file.path === LARGE_FILE_PATH)).toBe(false);
    expect(fileByPath(sealedDraft, RENAMED_LARGE_FILE_PATH).content).toBe(fixture.largeContent);
    expect(await digestBytes(sealedDraftBytes)).toBe(updated.draft.digest);

    // The immutable base object and its metadata remain byte-for-byte stable.
    const baseBytesAfter = await fixture.blobs.get(fixture.baseRelease.artifact.key);
    expect(baseBytesAfter).toEqual(baseBytesBefore);
    expect(await digestBytes(baseBytesAfter)).toBe(fixture.baseRelease.artifact.digest);
    expect((await fixture.repository.read(ORGANIZATION)).skills.find((skill) => skill.id === BASE_RESOURCE_ID)?.artifact)
      .toEqual(fixture.baseRelease.artifact);

    const replayResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}`,
      {
        method: 'PUT',
        headers: { 'idempotency-key': 'large-draft-delta-1' },
        json: payload,
      },
    );
    expect(replayResponse.status, await replayResponse.clone().text()).toBe(200);
    const replayed = await json<PublicDraftResponse>(replayResponse);
    expect(replayed.idempotent).toBe(true);
    expect(replayed.draft.id).toBe(updated.draft.id);
    expect(replayed.draft.revision).toBe(updated.draft.revision);
    expect(replayed.draft.digest).toBe(updated.draft.digest);
    expect(replayed.draft.files).toEqual(updated.draft.files);
    expect(fixture.blobs.putCalls).toBe(putsBeforeUpdate + 1);

    const finalState = await fixture.repository.read(ORGANIZATION);
    const finalDraft = finalState.drafts?.find((draft) => draft.id === created.draft.id);
    expect(finalDraft?.revision).toBe(2);
    expect(finalDraft?.digest).toBe(updated.draft.digest);

    const builderSession: SkillBuilderSessionRecord = {
      id: 'large-draft-builder-session',
      organizationId: ORGANIZATION,
      subject: publisher().subject,
      draftId: created.draft.id,
      draftRevision: 2,
      draftDigest: updated.draft.digest,
      sessionKey: 'large-draft-builder-session-key',
      eveSessionId: 'large-draft-eve-session',
      state: 'ready',
      requests: [],
      proposals: [],
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    await fixture.repository.transaction(ORGANIZATION, (state) => {
      state.builderSessions = [builderSession];
    });
    const builderContent = base64Text(
      '---\nname: large-draft\ndescription: Builder applied large draft\n---\n\n# Builder applied\n',
    );
    const proposalResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/proposals`,
      {
        method: 'POST',
        headers: {
          'idempotency-key': 'large-draft-builder-proposal',
          'x-pskills-tool-identity': 'skill-builder',
        },
        json: {
          draftId: created.draft.id,
          revision: 2,
          digest: updated.draft.digest,
          sessionId: builderSession.id,
          operations: [{ op: 'edit', path: 'SKILL.md', content: Buffer.from(builderContent, 'base64').toString('utf8') }],
        },
      },
    );
    expect(proposalResponse.status, await proposalResponse.clone().text()).toBe(201);
    const proposal = await json<{ proposal: { id: string } }>(proposalResponse);
    const applyResponse = await call(
      fixture.handler,
      `/v1/drafts/${encodeURIComponent(created.draft.id)}/proposals/${encodeURIComponent(proposal.proposal.id)}/apply`,
      {
        method: 'POST',
        headers: { 'idempotency-key': 'large-draft-builder-apply' },
        json: {
          draftId: created.draft.id,
          revision: 2,
          digest: updated.draft.digest,
          sessionId: builderSession.id,
        },
      },
    );
    expect(applyResponse.status, await applyResponse.clone().text()).toBe(200);
    expect(await responseBytes(applyResponse)).toBeLessThan(VERCEL_BODY_CAP_BYTES);
    const applied = await json<PublicDraftResponse & { proposal: unknown }>(applyResponse);
    expect(applied.draft).toMatchObject({ revision: 3 });
    expect(applied.draft.files.every((file) => !('content' in file))).toBe(true);
  }, 40_000);
});
