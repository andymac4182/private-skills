import { describe, expect, it } from 'vitest';
import { createDraftHandler, writeDraftRevision } from '../src/drafts.js';
import type { AuthoringHandlerDependencies } from '../src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import { createUploadReviewPersistenceService, uploadReviewIdempotencyKey } from '../../upload-reviews/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  SkillDraftPublicationRecord,
  SkillBundle,
  SkillVersion,
  StoredBlob,
} from '../../contracts/src/index.js';
import type {
  EnqueueUploadReviewInput,
  MarkUploadReviewStaleInput,
  UploadReviewBinding,
  UploadReviewJob,
  UploadReviewPersistenceService,
} from '../../upload-reviews/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-test';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function manifest(files: SkillBundle['files']): Promise<Array<{ path: string; size: number; digest: string; executable?: boolean }>> {
  return await Promise.all(files.map(async (file) => ({
    path: file.path,
    size: bytesFromBase64(file.content).byteLength,
    digest: await digestBytes(bytesFromBase64(file.content)),
    ...(file.executable === true ? { executable: true } : {}),
  })));
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  putCalls = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const key = `sealed-${this.putCalls++}`;
    const copy = bytes.slice();
    this.values.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error('missing blob');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function user(subject = 'publisher', namespaces = ['@team']): Principal {
  return {
    organizationId: ORGANIZATION,
    subject,
    roles: ['publisher'],
    namespaces,
    scopes: ['skills:publish', 'skills:read'],
  };
}

interface ReviewQueueHarness {
  service: UploadReviewPersistenceService;
  jobs: UploadReviewJob[];
  failNextEnqueue: boolean;
}

function sameReviewBinding(left: UploadReviewBinding, right: UploadReviewBinding): boolean {
  return left.draftId === right.draftId &&
    left.draftRevision === right.draftRevision &&
    left.contentDigest === right.contentDigest &&
    left.baseReleaseId === right.baseReleaseId &&
    left.baseReleaseVersion === right.baseReleaseVersion &&
    left.baseDigest === right.baseDigest &&
    left.policyRevision === right.policyRevision;
}

function reviewQueueHarness(): ReviewQueueHarness {
  const harness: ReviewQueueHarness = {
    service: undefined as unknown as UploadReviewPersistenceService,
    jobs: [],
    failNextEnqueue: false,
  };
  let sequence = 0;
  harness.service = {
    enqueue: async (organizationId: string, input: EnqueueUploadReviewInput): Promise<UploadReviewJob> => {
      if (harness.failNextEnqueue) {
        harness.failNextEnqueue = false;
        throw new Error('injected review enqueue failure');
      }
      const idempotencyKey = input.idempotencyKey ?? uploadReviewIdempotencyKey(input.binding, input.reviewerRevision);
      const existing = harness.jobs.find((job) => job.organizationId === organizationId && job.idempotencyKey === idempotencyKey);
      if (existing) return existing;
      const now = new Date().toISOString();
      const job: UploadReviewJob = {
        id: `review-${++sequence}`,
        organizationId,
        idempotencyKey,
        binding: input.binding,
        snapshot: input.snapshot,
        model: input.model,
        reviewerRevision: input.reviewerRevision,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      harness.jobs.push(job);
      return job;
    },
    markStale: async (organizationId: string, input: MarkUploadReviewStaleInput): Promise<UploadReviewJob[]> => {
      const changed: UploadReviewJob[] = [];
      const now = new Date().toISOString();
      for (const job of harness.jobs) {
        if (job.organizationId !== organizationId || job.binding.draftId !== input.draftId || sameReviewBinding(job.binding, input.current) || job.state === 'stale') continue;
        job.state = 'stale';
        job.updatedAt = now;
        job.finishedAt = now;
        job.staleReason = input.reason;
        changed.push(job);
      }
      return changed;
    },
  } as unknown as UploadReviewPersistenceService;
  return harness;
}

interface Fixture {
  repository: ReturnType<typeof createMemoryStateRepository>;
  blobs: MemoryBlobs;
  release: SkillVersion;
  bundle: SkillBundle;
  deps: AuthoringHandlerDependencies;
  handler: ReturnType<typeof createDraftHandler>;
  setPrincipal(value: Principal | null): void;
  setAdmission(value: boolean): void;
  setCommitAdmission(value: boolean): void;
  reviewService?: UploadReviewPersistenceService;
  reviewTriggerCalls: number;
}

async function fixture(options: { withReview?: boolean; maxBodyBytes?: number } = {}): Promise<Fixture> {
  const state = defaultRegistryState({ production: false, allowUnscanned: true });
  const bundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [
      { path: 'SKILL.md', content: base64('---\nname: demo\ndescription: Demo\n---\n# Demo\n') },
      { path: 'docs/guide.md', content: base64('# Guide\n') },
      { path: 'rules.json', content: base64('{"safe":true}\n') },
    ],
  };
  const bytes = encodeBundle(bundle);
  const blobs = new MemoryBlobs();
  const stored = await blobs.put(bytes);
  const release: SkillVersion = {
    id: 'release-1',
    organizationId: ORGANIZATION,
    name: '@team/demo',
    skillName: 'demo',
    version: '1.0.0',
    description: 'Demo',
    artifact: stored,
    state: 'approved',
    policyRevision: state.policy.revision,
    createdAt: '2026-09-10T00:00:00.000Z',
    approvedAt: '2026-09-10T00:00:01.000Z',
    provenance: { kind: 'native' },
    fileCount: bundle.files.length,
    scanIds: [],
  };
  state.skills.push(release);
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  let current: Principal | null = user();
  let admitted = true;
  let commitAdmitted = true;
  let reviewTriggerCalls = 0;
  const reviewService = options.withReview ? createUploadReviewPersistenceService(repository) : undefined;
  const auth: Authenticator = { authenticate: async () => current };
  const deps: AuthoringHandlerDependencies = {
    repository,
    blobs,
    auth,
    config: { organizationId: ORGANIZATION, maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024 },
    releaseAdmission: () => admitted,
    releaseAdmissionAtCommit: () => commitAdmitted,
    ...(reviewService ? {
      uploadReview: {
        service: reviewService,
        model: 'test/reviewer',
        reviewerRevision: 'review-contract-1',
        trigger: async () => {
          reviewTriggerCalls += 1;
        },
      },
    } : {}),
  };
  return {
    repository,
    blobs,
    release,
    bundle,
    deps,
    handler: createDraftHandler(deps),
    setPrincipal(value) {
      current = value;
    },
    setAdmission(value) {
      admitted = value;
    },
    setCommitAdmission(value) {
      commitAdmitted = value;
    },
    reviewService,
    get reviewTriggerCalls() {
      return reviewTriggerCalls;
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function create(test: Fixture, key = 'create-1'): Promise<any> {
  return json(await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
  })));
}

function updateRequest(
  draftId: string,
  key: string,
  expectedRevision: number,
  files: SkillBundle['files'],
): Request {
  return new Request(`${ORIGIN}/v1/drafts/${draftId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ expectedRevision, files }),
  });
}

function uploadCreateRequest(name: string, key: string, files: SkillBundle['files']): Request {
  return new Request(`${ORIGIN}/v1/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ name, files }),
  });
}

function publishRequest(draftId: string, key: string, expectedRevision: number, version: string): Request {
  return new Request(`${ORIGIN}/v1/drafts/${draftId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ expectedRevision, version }),
  });
}

describe('durable skill drafts', () => {
  it('creates an upload-origin draft, edits it, and queues a scanner release without a fake base', async () => {
    const test = await fixture();
    const denied = await test.handler(uploadCreateRequest('@other/demo', 'upload-denied', test.bundle.files));
    expect(denied.status).toBe(404);

    const incomplete = await test.handler(uploadCreateRequest('@team/incomplete', 'upload-incomplete', [
      { path: 'docs/only.md', content: base64('# Repair this draft\n') },
    ]));
    expect(incomplete.status).toBe(201);
    const incompleteDraft = (await json(incomplete)).draft;
    expect(incompleteDraft).toMatchObject({ origin: 'upload', skillName: '', status: 'open' });
    const incompletePublish = await test.handler(publishRequest(incompleteDraft.id, 'upload-incomplete-publish', 1, '1.0.0'));
    expect(incompletePublish.status).toBe(409);
    expect((await json(incompletePublish)).error.code).toBe('DRAFT_INVALID');
    expect((await test.repository.read(ORGANIZATION)).jobs).toHaveLength(0);

    const createdResponse = await test.handler(uploadCreateRequest('@team/new-skill', 'upload-create', test.bundle.files));
    expect(createdResponse.status).toBe(201);
    const created = (await json(createdResponse)).draft;
    expect(created).toMatchObject({
      origin: 'upload',
      name: '@team/new-skill',
      revision: 1,
      status: 'open',
    });
    expect(created).not.toHaveProperty('baseResourceId');
    expect(created).not.toHaveProperty('baseDigest');

    const editedFiles = [
      { ...test.bundle.files[0]!, content: base64('---\nname: new-skill\ndescription: Edited upload\n---\n# Edited\n') },
      ...test.bundle.files.slice(1),
    ];
    const updated = await test.handler(updateRequest(created.id, 'upload-update', 1, editedFiles));
    expect(updated.status).toBe(200);
    const updatedDraft = (await json(updated)).draft;
    const published = await test.handler(publishRequest(created.id, 'upload-publish', 2, '1.0.0'));
    expect(published.status).toBe(202);
    const operation = (await json(published)).operation;
    const state = await test.repository.read(ORGANIZATION);
    const release = state.skills.find((skill) => skill.id === operation.resourceId)!;
    expect(release).toMatchObject({
      name: '@team/new-skill',
      skillName: 'new-skill',
      description: 'Edited upload',
      state: 'pending',
      artifact: { digest: updatedDraft.digest },
      provenance: { kind: 'native', sourceDigest: updatedDraft.digest },
    });
    expect(release).not.toHaveProperty('authoring');
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({ kind: 'scan', resourceId: operation.resourceId, state: 'queued' });
  });

  it('creates from an approved immutable release and retries idempotently', async () => {
    const test = await fixture();
    const createdResponse = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
      body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
    }));
    expect(createdResponse.status).toBe(201);
    const created = await json(createdResponse);
    expect(created.draft).toMatchObject({
      baseResourceId: 'release-1',
      baseDigest: test.release.artifact.digest,
      revision: 1,
      digest: test.release.artifact.digest,
      status: 'open',
    });
    expect(created.draft.files).toEqual(await manifest(test.bundle.files));
    expect(created.draft).not.toHaveProperty('artifact.key');

    const retried = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
      body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
    }));
    expect(retried.status).toBe(200);
    expect(await json(retried)).toEqual({ draft: created.draft, idempotent: true });
    expect(test.blobs.putCalls).toBe(2); // original release + one fresh draft object

    const state = await test.repository.read(ORGANIZATION);
    expect(state.drafts).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
    expect(state.skills[0]!.artifact).toEqual(test.release.artifact);
  });

  it('updates with a monotonic CAS revision and preserves the base release', async () => {
    const test = await fixture();
    const created = await create(test);
    const draftId = created.draft.id;
    const changedFiles = [
      { ...test.bundle.files[0]!, content: base64('---\nname: demo\ndescription: Edited\n---\n# Edited\n') },
      { ...test.bundle.files[1]!, content: base64('# Edited guide\n') },
      { ...test.bundle.files[2]!, content: base64('{"safe":false}\n') },
    ];
    const updatedResponse = await test.handler(updateRequest(draftId, 'update-1', 1, changedFiles));
    expect(updatedResponse.status).toBe(200);
    const updated = await json(updatedResponse);
    expect(updated.draft.revision).toBe(2);
    expect(updated.draft.digest).not.toBe(test.release.artifact.digest);
    expect(updated.draft.files).toEqual(await manifest(changedFiles));

    const loaded = await test.handler(new Request(`${ORIGIN}/v1/drafts/${draftId}`));
    expect(loaded.status).toBe(200);
    expect((await json(loaded)).draft).toEqual(updated.draft);

    const stale = await test.handler(updateRequest(draftId, 'update-stale', 1, test.bundle.files));
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({
      error: {
        code: 'DRAFT_CONFLICT',
        message: 'Draft revision is stale; rebase before saving',
        details: { currentRevision: 2 },
      },
    });
    expect((await test.repository.read(ORGANIZATION)).skills[0]!.artifact).toEqual(test.release.artifact);
  });

  it('canonicalizes file order before sealing and replays idempotency from the verified blob', async () => {
    const test = await fixture();
    const created = await create(test);
    const unsorted = [...test.bundle.files].reverse();
    const updated = await test.handler(updateRequest(created.draft.id, 'unordered', 1, unsorted));
    expect(updated.status).toBe(200);
    const updatedBody = await json(updated);
    expect(updatedBody.draft.files.map((file: { path: string }) => file.path)).toEqual([
      'SKILL.md',
      'docs/guide.md',
      'rules.json',
    ]);
    const loaded = await test.handler(new Request(`${ORIGIN}/v1/drafts/${created.draft.id}`));
    expect(loaded.status).toBe(200);
    expect((await json(loaded)).draft.files).toEqual(updatedBody.draft.files);
    const retry = await test.handler(updateRequest(created.draft.id, 'unordered', 1, unsorted));
    expect(retry.status).toBe(200);
    expect((await json(retry)).draft).toEqual(updatedBody.draft);
  });

  it('makes a successful update retry idempotent and rejects key reuse with another payload', async () => {
    const test = await fixture();
    const created = await create(test);
    const files = test.bundle.files.map((file) => ({ ...file, content: base64(`${file.path}\nchanged\n`) }));
    const first = await test.handler(updateRequest(created.draft.id, 'update-1', 1, files));
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    const retry = await test.handler(updateRequest(created.draft.id, 'update-1', 1, files));
    expect(retry.status).toBe(200);
    expect(await json(retry)).toEqual({ draft: firstBody.draft, idempotent: true });
    expect((await test.repository.read(ORGANIZATION)).drafts![0]!.revision).toBe(2);

    const conflictingReuse = await test.handler(updateRequest(created.draft.id, 'update-1', 1, test.bundle.files));
    expect(conflictingReuse.status).toBe(409);
    expect((await json(conflictingReuse)).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('exposes one CAS writer for human builder applies with idempotent replay and stale conflicts', async () => {
    const test = await fixture();
    const created = await create(test);
    const human = user('human-editor');
    const files = test.bundle.files.map((file) => ({
      ...file,
      content: base64(`${file.path}\nbuilder edit\n`),
    }));
    const input = {
      draftId: created.draft.id,
      expectedRevision: 1,
      files,
      idempotencyKey: 'builder-apply-1',
      principal: human,
      deps: test.deps,
      kind: 'builder-proposal' as const,
      proposalId: 'proposal-1',
    };

    const first = await writeDraftRevision(input);
    expect(first.idempotent).toBe(false);
    expect(first.draft.revision).toBe(2);
    const firstState = await test.repository.read(ORGANIZATION);
    expect(firstState.audit.at(-1)).toMatchObject({
      action: 'draft.update',
      subject: 'human-editor',
      resourceId: created.draft.id,
      details: { source: 'builder-proposal', proposalId: 'proposal-1' },
    });

    const replay = await writeDraftRevision(input);
    expect(replay.idempotent).toBe(true);
    expect(replay.draft.digest).toBe(first.draft.digest);
    expect((await test.repository.read(ORGANIZATION)).drafts![0]!.revision).toBe(2);

    await expect(writeDraftRevision({
      ...input,
      files: test.bundle.files,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(writeDraftRevision({
      ...input,
      idempotencyKey: 'builder-stale',
    })).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
  });

  it('reconciles advisory review queues when create or update replays recover a post-commit failure', async () => {
    const test = await fixture();
    const queue = reviewQueueHarness();
    test.deps.uploadReview = {
      service: queue.service,
      model: 'test/reviewer',
      reviewerRevision: 'review-contract-1',
      trigger: async () => undefined,
    };

    queue.failNextEnqueue = true;
    const firstCreate = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'recover-release-create' },
      body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
    }));
    expect(firstCreate.status).toBe(201);
    expect(queue.jobs).toHaveLength(0);
    const recoveredCreate = await create(test, 'recover-release-create');
    expect(recoveredCreate.draft.revision).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ state: 'pending', binding: { draftRevision: 1 } });
    await create(test, 'recover-release-create');
    expect(queue.jobs).toHaveLength(1);

    const created = recoveredCreate.draft;
    const editedFiles = test.bundle.files.map((file) => ({
      ...file,
      content: base64(`${file.path}\nrecovery edit\n`),
    }));
    queue.failNextEnqueue = true;
    const firstUpdate = await test.handler(updateRequest(created.id, 'recover-update', 1, editedFiles));
    expect(firstUpdate.status).toBe(200);
    expect((await test.repository.read(ORGANIZATION)).drafts![0]!.revision).toBe(2);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ state: 'stale', binding: { draftRevision: 1 } });

    const recoveredUpdate = await test.handler(updateRequest(created.id, 'recover-update', 1, editedFiles));
    expect(recoveredUpdate.status).toBe(200);
    expect((await test.repository.read(ORGANIZATION)).drafts![0]!.revision).toBe(2);
    expect(queue.jobs).toHaveLength(2);
    expect(queue.jobs.filter((job) => job.state === 'pending')).toHaveLength(1);
    expect(queue.jobs.find((job) => job.binding.draftRevision === 2)).toMatchObject({ state: 'pending' });
    await test.handler(updateRequest(created.id, 'recover-update', 1, editedFiles));
    expect(queue.jobs).toHaveLength(2);

    const advancedFiles = editedFiles.map((file) => ({
      ...file,
      content: base64(`${file.path}\nadvanced revision\n`),
    }));
    const advanced = await test.handler(updateRequest(created.id, 'recover-advance', 2, advancedFiles));
    expect(advanced.status).toBe(200);
    expect(queue.jobs).toHaveLength(3);
    expect(queue.jobs.find((job) => job.binding.draftRevision === 3)).toMatchObject({ state: 'pending' });
    await test.handler(updateRequest(created.id, 'recover-update', 1, editedFiles));
    expect(queue.jobs).toHaveLength(3);
    expect(queue.jobs.find((job) => job.binding.draftRevision === 3)).toMatchObject({ state: 'pending' });

    queue.failNextEnqueue = true;
    const firstUpload = await test.handler(uploadCreateRequest('@team/recover-upload', 'recover-upload-create', test.bundle.files));
    expect(firstUpload.status).toBe(201);
    expect(queue.jobs).toHaveLength(3);
    const recoveredUploadResponse = await test.handler(uploadCreateRequest('@team/recover-upload', 'recover-upload-create', test.bundle.files));
    expect(recoveredUploadResponse.status).toBe(200);
    const recoveredUpload = await json(recoveredUploadResponse);
    expect(queue.jobs).toHaveLength(4);
    expect(queue.jobs.filter((job) => job.binding.draftId === recoveredUpload.draft.id)).toHaveLength(1);
    expect((await test.repository.read(ORGANIZATION)).drafts).toHaveLength(2);
  });

  it('rejects unauthorized drafts and unsafe file paths without reading or persisting content', async () => {
    const test = await fixture();
    test.setPrincipal({ ...user('reader', ['@other']), roles: ['reader'], scopes: ['skills:read'] });
    const deniedCreate = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'denied' },
      body: JSON.stringify({ baseDigest: test.release.artifact.digest }),
    }));
    expect(deniedCreate.status).toBe(403);
    expect(test.blobs.putCalls).toBe(1);

    test.setPrincipal(user());
    const created = await create(test);
    const unsafe = await test.handler(updateRequest(created.draft.id, 'unsafe', 1, [
      { path: '../escape.md', content: base64('nope') },
    ]));
    expect(unsafe.status).toBe(400);
    expect((await test.repository.read(ORGANIZATION)).drafts![0]!.revision).toBe(1);
  });

  it('serves one bounded file only for the current draft revision and omits unsafe previews', async () => {
    const test = await fixture();
    const created = await create(test);
    const oversized = base64('x'.repeat(256 * 1024 + 1));
    const changedFiles = [
      ...test.bundle.files,
      { path: 'assets/blob.bin', content: base64('\u0000\u0001') },
      { path: 'data.unknown', content: base64('unknown format\n') },
      { path: 'notes.md', content: oversized },
    ];
    const updated = await test.handler(updateRequest(created.draft.id, 'lazy-file-update', 1, changedFiles));
    expect(updated.status).toBe(200);
    const updatedDraft = (await json(updated)).draft;

    const selected = await test.handler(new Request(
      `${ORIGIN}/v1/drafts/${encodeURIComponent(created.draft.id)}/files?path=SKILL.md&revision=${updatedDraft.revision}&digest=${encodeURIComponent(updatedDraft.digest)}`,
    ));
    expect(selected.status).toBe(200);
    const selectedBody = (await json(selected)).file;
    expect(selectedBody).toMatchObject({
      path: 'SKILL.md',
      previewState: 'text',
      content: test.bundle.files[0]!.content,
    });
    expect(selectedBody).not.toHaveProperty('contents');

    for (const [path, previewState] of [['assets/blob.bin', 'binary'], ['data.unknown', 'unsupported'], ['notes.md', 'oversize']] as const) {
      const response = await test.handler(new Request(
        `${ORIGIN}/v1/drafts/${encodeURIComponent(created.draft.id)}/files?path=${encodeURIComponent(path)}&revision=${updatedDraft.revision}&digest=${encodeURIComponent(updatedDraft.digest)}`,
      ));
      expect(response.status).toBe(200);
      const body = (await json(response)).file;
      expect(body).toMatchObject({ path, previewState });
      expect(body).not.toHaveProperty('content');
    }

    const stale = await test.handler(new Request(
      `${ORIGIN}/v1/drafts/${encodeURIComponent(created.draft.id)}/files?path=SKILL.md&revision=1&digest=${encodeURIComponent(created.draft.digest)}`,
    ));
    expect(stale.status).toBe(409);

    test.setPrincipal({ ...user('other-namespace', ['@other']), roles: ['publisher'] });
    const namespaceDenied = await test.handler(new Request(
      `${ORIGIN}/v1/drafts/${encodeURIComponent(created.draft.id)}/files?path=SKILL.md&revision=${updatedDraft.revision}&digest=${encodeURIComponent(updatedDraft.digest)}`,
    ));
    expect(namespaceDenied.status).toBe(404);

    test.setPrincipal({ ...user('reader'), roles: ['reader'], scopes: ['skills:read'] });
    const readerDenied = await test.handler(new Request(
      `${ORIGIN}/v1/drafts/${encodeURIComponent(created.draft.id)}/files?path=SKILL.md&revision=${updatedDraft.revision}&digest=${encodeURIComponent(updatedDraft.digest)}`,
    ));
    expect(readerDenied.status).toBe(403);
  });

  it('fails clearly when a valid metadata manifest cannot fit the response bound', async () => {
    const test = await fixture({ withReview: true, maxBodyBytes: 8 * 1024 * 1024 });
    const segment = 'a'.repeat(255);
    const files: SkillBundle['files'] = Array.from({ length: 2_000 }, (_, index) => ({
      path: `${Array.from({ length: 10 }, () => segment).join('/')}/${index}`,
      content: base64('x'),
    }));
    const response = await test.handler(uploadCreateRequest('@team/large-manifest', 'large-manifest', files));
    expect(response.status).toBe(413);
    expect((await json(response)).error).toMatchObject({ code: 'DRAFT_RESPONSE_TOO_LARGE' });
    let state = await test.repository.read(ORGANIZATION) as RegistryState & { uploadReviewJobs?: unknown[]; uploadReviewResults?: unknown[] };
    expect(state.drafts ?? []).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
    expect(state.builderSessions ?? []).toHaveLength(0);
    expect(state.uploadReviewJobs ?? []).toHaveLength(0);
    expect(state.uploadReviewResults ?? []).toHaveLength(0);
    expect(test.blobs.putCalls).toBe(1);

    const retry = await test.handler(uploadCreateRequest('@team/large-manifest', 'large-manifest', files));
    expect(retry.status).toBe(413);
    state = await test.repository.read(ORGANIZATION) as RegistryState & { uploadReviewJobs?: unknown[]; uploadReviewResults?: unknown[] };
    expect(state.drafts ?? []).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
    expect(state.uploadReviewJobs ?? []).toHaveLength(0);
    expect(state.uploadReviewResults ?? []).toHaveLength(0);
    expect(test.blobs.putCalls).toBe(1);

    const smallDraft = await create(test, 'preflight-write-base');
    state = await test.repository.read(ORGANIZATION) as RegistryState & { uploadReviewJobs?: unknown[]; uploadReviewResults?: unknown[] };
    expect(state.drafts ?? []).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
    expect(state.uploadReviewJobs ?? []).toHaveLength(1);
    expect(test.blobs.putCalls).toBe(2);
    await expect(writeDraftRevision({
      draftId: smallDraft.draft.id,
      expectedRevision: 1,
      expectedDigest: smallDraft.draft.digest,
      files,
      idempotencyKey: 'oversized-normal-save',
      principal: user(),
      deps: test.deps,
    })).rejects.toMatchObject({ code: 'DRAFT_RESPONSE_TOO_LARGE' });
    await expect(writeDraftRevision({
      draftId: smallDraft.draft.id,
      expectedRevision: 1,
      expectedDigest: smallDraft.draft.digest,
      files,
      idempotencyKey: 'oversized-builder-apply',
      principal: user(),
      deps: test.deps,
      kind: 'builder-proposal',
      proposalId: 'oversized-proposal',
      onCommit: () => {
        throw new Error('builder commit must not run after response preflight');
      },
    })).rejects.toMatchObject({ code: 'DRAFT_RESPONSE_TOO_LARGE' });
    state = await test.repository.read(ORGANIZATION) as RegistryState & { uploadReviewJobs?: unknown[]; uploadReviewResults?: unknown[] };
    expect(state.drafts?.[0]).toMatchObject({ revision: 1, digest: smallDraft.draft.digest });
    expect(state.audit).toHaveLength(1);
    expect(state.uploadReviewJobs ?? []).toHaveLength(1);
    expect(state.uploadReviewResults ?? []).toHaveLength(0);
    expect(test.blobs.putCalls).toBe(2);
  });

  it('rejects a same-revision publication race before the draft CAS mutation', async () => {
    const longSegment = 'a'.repeat(255);
    const longFiles: SkillBundle['files'] = Array.from({ length: 1_686 }, (_, index) => ({
      path: `${Array.from({ length: 10 }, () => longSegment).join('/')}/${index}`,
      content: base64('x'),
    }));

    async function publicationRace(kind: 'update' | 'builder-proposal'): Promise<void> {
      const test = await fixture({ withReview: true });
      const created = await create(test, `race-base-${kind}`);
      let allowPut!: () => void;
      let signalPut!: () => void;
      const putStarted = new Promise<void>((resolve) => { signalPut = resolve; });
      const putGate = new Promise<void>((resolve) => { allowPut = resolve; });
      const originalPut = test.blobs.put.bind(test.blobs);
      test.blobs.put = async (bytes) => {
        if (test.blobs.putCalls === 2) {
          signalPut();
          await putGate;
        }
        return await originalPut(bytes);
      };

      let committed = false;
      const write = writeDraftRevision({
        draftId: created.draft.id,
        expectedRevision: 1,
        expectedDigest: created.draft.digest,
        files: longFiles,
        idempotencyKey: `race-${kind}`,
        principal: user(),
        deps: test.deps,
        kind,
        proposalId: kind === 'builder-proposal' ? 'race-proposal' : undefined,
        ...(kind === 'builder-proposal' ? {
          responseEnvelope: (publicDraft) => ({ proposal: { state: 'applied' }, draft: publicDraft }),
          onCommit: () => { committed = true; },
        } : {}),
      });

      const started = await Promise.race([
        putStarted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      if (!started) allowPut();
      expect(started).toBe(true);

      const publications: SkillDraftPublicationRecord[] = Array.from({ length: 16 }, (_, index) => ({
        key: `publication-${index}`,
        subject: 'publisher',
        requestDigest: created.draft.digest,
        revision: 1,
        digest: created.draft.digest,
        version: `1.0.${index}`,
        resourceId: `skill-${index}`,
        jobId: `job-${index}`,
        createdAt: `2026-09-10T00:00:${String(index).padStart(2, '0')}.000Z`,
      }));
      await test.repository.transaction(ORGANIZATION, (state) => {
        state.drafts![0]!.publications = publications;
      });
      allowPut();

      await expect(write).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
      expect(committed).toBe(false);
      const state = await test.repository.read(ORGANIZATION) as RegistryState & { uploadReviewJobs?: unknown[] };
      expect(state.drafts![0]).toMatchObject({ revision: 1, digest: created.draft.digest });
      expect(state.drafts![0]!.publications).toHaveLength(16);
      expect(state.audit).toHaveLength(1);
      expect(state.uploadReviewJobs ?? []).toHaveLength(1);
      // The sealed blob is written before the repository CAS, matching the
      // existing storage/CAS contract; the failed 409 leaves no state or
      // review mutation and the orphan is eligible for normal blob cleanup.
      expect(test.blobs.putCalls).toBe(3);
    }

    await publicationRace('update');
    await publicationRace('builder-proposal');
  });

  it('returns an explicit conflict when the selected base digest is stale', async () => {
    const test = await fixture();
    const response = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'stale-base' },
      body: JSON.stringify({ baseDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }),
    }));
    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe('DIGEST_MISMATCH');
    expect((await test.repository.read(ORGANIZATION)).drafts ?? []).toEqual([]);
  });

  it('queues an immutable scanner job for publication and retries idempotently', async () => {
    const test = await fixture();
    const created = await create(test);
    const firstResponse = await test.handler(publishRequest(created.draft.id, 'publish-1', 1, '1.1.0'));
    expect(firstResponse.status).toBe(202);
    const first = await json(firstResponse);
    expect(first).toMatchObject({
      idempotent: false,
      operation: {
        state: 'queued',
        version: '1.1.0',
        revision: 1,
        digest: created.draft.digest,
        scanRequired: true,
      },
    });

    const state = await test.repository.read(ORGANIZATION);
    expect(state.skills).toHaveLength(2);
    const published = state.skills.find((skill) => skill.id === first.operation.resourceId);
    expect(published).toMatchObject({
      name: test.release.name,
      version: '1.1.0',
      state: 'pending',
      policyRevision: state.policy.revision,
      fileCount: test.bundle.files.length,
      authoring: {
        baseResourceId: test.release.id,
        baseDigest: test.release.artifact.digest,
        draftId: created.draft.id,
        draftRevision: 1,
        actor: 'publisher',
      },
    });
    expect(published?.artifact).toEqual(state.drafts![0]!.artifact);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      id: first.operation.id,
      kind: 'scan',
      state: 'queued',
      resourceId: first.operation.resourceId,
      artifact: published?.artifact,
      policyRevision: state.policy.revision,
    });
    expect(state.drafts![0]!.publications).toHaveLength(1);
    expect(state.drafts![0]!.status).toBe('open');
    expect(state.skills[0]!.artifact).toEqual(test.release.artifact);

    const retryResponse = await test.handler(publishRequest(created.draft.id, 'publish-1', 1, '1.1.0'));
    expect(retryResponse.status).toBe(200);
    expect(await json(retryResponse)).toEqual({ operation: first.operation, idempotent: true });
    expect((await test.repository.read(ORGANIZATION)).jobs).toHaveLength(1);

    const publicDraft = await test.handler(new Request(`${ORIGIN}/v1/drafts/${created.draft.id}`));
    expect(publicDraft.status).toBe(200);
    const publication = (await json(publicDraft)).draft.publications[0];
    expect(publication).toMatchObject({
      revision: 1,
      version: '1.1.0',
      resourceId: first.operation.resourceId,
      jobId: first.operation.id,
      digest: created.draft.digest,
    });
    expect(publication).not.toHaveProperty('key');
    expect(publication).not.toHaveProperty('subject');
    expect(publication).not.toHaveProperty('requestDigest');
  });

  it('derives the new release metadata and native provenance from edited bytes', async () => {
    const test = await fixture();
    const created = await create(test);
    const edited = [
      { ...test.bundle.files[0]!, content: base64('---\nname: edited\ndescription: Edited release\n---\n# Edited\n') },
      ...test.bundle.files.slice(1),
    ];
    const updated = await test.handler(updateRequest(created.draft.id, 'metadata-edit', 1, edited));
    const draft = (await json(updated)).draft;
    const published = await test.handler(publishRequest(draft.id, 'metadata-publish', 2, '2.0.0'));
    expect(published.status).toBe(202);
    const body = await json(published);
    const state = await test.repository.read(ORGANIZATION);
    const release = state.skills.find((skill) => skill.id === body.operation.resourceId)!;
    expect(release).toMatchObject({
      skillName: 'edited',
      description: 'Edited release',
      provenance: { kind: 'native', sourceDigest: draft.digest },
      authoring: { baseResourceId: test.release.id, baseDigest: test.release.artifact.digest, draftRevision: 2 },
    });
    expect(release.provenance).not.toHaveProperty('externalId');
    expect(release.provenance).not.toHaveProperty('sourceUrl');
  });

  it('requires atomic commit-time release admission', async () => {
    const test = await fixture();
    const created = await create(test);
    test.setCommitAdmission(false);
    const response = await test.handler(publishRequest(created.draft.id, 'commit-denied', 1, '1.1.0'));
    expect(response.status).toBe(503);
    expect((await json(response)).error.code).toBe('RELEASE_UNAVAILABLE');
    const state = await test.repository.read(ORGANIZATION);
    expect(state.skills).toHaveLength(1);
    expect(state.jobs).toHaveLength(0);
  });

  it('rejects semver edge cases that the parser cannot validate', async () => {
    const test = await fixture();
    const created = await create(test);
    const response = await test.handler(publishRequest(created.draft.id, 'invalid-prerelease', 1, '1.2.3-'));
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('INVALID_VERSION');
    const buildMetadata = await test.handler(publishRequest(created.draft.id, 'valid-build-metadata', 1, '1.2.3+build.7'));
    expect(buildMetadata.status).toBe(202);
    expect((await json(buildMetadata)).operation.version).toBe('1.2.3+build.7');
  });

  it('rejects publication when the base release loses admission or the CAS revision is stale', async () => {
    const test = await fixture();
    const created = await create(test);
    test.setAdmission(false);
    const denied = await test.handler(publishRequest(created.draft.id, 'publish-denied', 1, '1.1.0'));
    expect(denied.status).toBe(404);
    expect((await json(denied)).error.code).toBe('NOT_FOUND');
    expect((await test.repository.read(ORGANIZATION)).jobs).toHaveLength(0);

    test.setAdmission(true);
    const stale = await test.handler(publishRequest(created.draft.id, 'publish-stale', 2, '1.1.0'));
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe('DRAFT_CONFLICT');
  });

  it('queues advisory Eve review snapshots on draft changes and scopes human decisions to the draft', async () => {
    const test = await fixture({ withReview: true });
    const created = await create(test);
    expect(test.reviewTriggerCalls).toBe(1);
    let state = await test.repository.read(ORGANIZATION) as RegistryState & { uploadReviewJobs?: any[]; uploadReviewResults?: any[] };
    expect(state.uploadReviewJobs).toHaveLength(1);
    expect(state.uploadReviewJobs![0]).toMatchObject({
      state: 'pending',
      binding: {
        draftId: created.draft.id,
        draftRevision: 1,
        contentDigest: created.draft.digest,
        baseReleaseId: test.release.id,
        baseReleaseVersion: test.release.version,
        baseDigest: test.release.artifact.digest,
        policyRevision: state.policy.revision,
      },
      model: 'test/reviewer',
      reviewerRevision: 'review-contract-1',
    });

    const changedFiles = test.bundle.files.map((file, index) => ({
      ...file,
      content: base64(`${file.path}\nreview revision ${index}\n`),
    }));
    const updatedResponse = await test.handler(updateRequest(created.draft.id, 'review-update', 1, changedFiles));
    expect(updatedResponse.status).toBe(200);
    expect(test.reviewTriggerCalls).toBe(2);
    state = await test.repository.read(ORGANIZATION) as RegistryState & { uploadReviewJobs?: any[]; uploadReviewResults?: any[] };
    expect(state.uploadReviewJobs).toHaveLength(2);
    expect(state.uploadReviewJobs!.map((job) => job.state).sort()).toEqual(['pending', 'stale']);
    expect(state.uploadReviewResults).toHaveLength(1);
    expect(state.uploadReviewResults![0]).toMatchObject({ state: 'stale', staleReason: 'draft revision changed' });

    const listed = await test.handler(new Request(`${ORIGIN}/v1/drafts/${created.draft.id}/reviews`));
    expect(listed.status).toBe(200);
    const listedBody = await json(listed);
    expect(listedBody.reviews).toHaveLength(2);
    expect(listedBody.reviews[0]).not.toHaveProperty('snapshot');
    expect(listedBody.reviews[0]).not.toHaveProperty('leaseToken');

    const pending = state.uploadReviewJobs!.find((job) => job.state === 'pending')!;
    const claim = await test.reviewService!.claim(ORGANIZATION, pending.id, { now: '2026-09-10T00:01:00.000Z' });
    const completed = await test.reviewService!.complete(ORGANIZATION, pending.id, claim.leaseToken!, {
      findings: [{
        severity: 'low',
        category: 'style',
        title: 'Review note',
        summary: 'A bounded advisory note',
        path: 'SKILL.md',
        line: 1,
      }],
      now: '2026-09-10T00:02:00.000Z',
    });
    const decision = await test.handler(new Request(`${ORIGIN}/v1/drafts/${created.draft.id}/reviews/${completed.id}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ findingId: completed.findings[0]!.id, decision: 'acknowledged' }),
    }));
    expect(decision.status).toBe(200);
    expect((await json(decision)).review.findings[0]).toMatchObject({ decision: 'acknowledged' });
  });
});
