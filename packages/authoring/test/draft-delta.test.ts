import { describe, expect, it } from 'vitest';
import { createDraftHandler } from '../src/drafts.js';
import type { AuthoringHandlerDependencies } from '../src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { decodeBundle, digestBytes } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  SkillBundle,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-delta-test';
const SAVE_LIMIT = 256 * 1024;
const LARGE_FILE_BYTES = 3_500_000;

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64Text(value: string): string {
  return base64Bytes(new TextEncoder().encode(value));
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

function publisher(): Principal {
  return {
    organizationId: ORGANIZATION,
    subject: 'publisher',
    roles: ['publisher'],
    namespaces: ['@team'],
    scopes: ['skills:publish', 'skills:read'],
  };
}

function uploadRequest(files: SkillBundle['files']): Request {
  return new Request(`${ORIGIN}/v1/drafts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'large-create',
    },
    body: JSON.stringify({ name: '@team/large-skill', files }),
  });
}

function deltaRequest(
  draftId: string,
  expectedRevision: number,
  expectedDigest: string | undefined,
  files: unknown[],
  idempotencyKey: string,
): Request {
  return new Request(`${ORIGIN}/v1/drafts/${draftId}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      expectedRevision,
      ...(expectedDigest === undefined ? {} : { expectedDigest }),
      files,
    }),
  });
}

async function responseJson(response: Response): Promise<any> {
  return response.json();
}

describe('bounded draft delta saves', () => {
  it('keeps unchanged sealed bytes server-side and replays one CAS revision', async () => {
    const largeBytes = new Uint8Array(LARGE_FILE_BYTES);
    for (let index = 0; index < largeBytes.length; index += 1) {
      largeBytes[index] = (index * 31 + 17) % 251;
    }
    const largeContent = base64Bytes(largeBytes);
    const notesContent = base64Text('unchanged notes\n');
    const initialSkillContent = base64Text('---\nname: large-skill\ndescription: Large skill\n---\n# Initial\n');
    const changedSkillContent = base64Text('---\nname: large-skill\ndescription: Edited large skill\n---\n# Edited\n');
    const initialFiles: SkillBundle['files'] = [
      { path: 'SKILL.md', content: initialSkillContent },
      { path: 'assets/large.bin', content: largeContent, executable: true },
      { path: 'notes.txt', content: notesContent },
    ];
    const state = defaultRegistryState({ production: false, allowUnscanned: true });
    const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
    const blobs = new MemoryBlobs();
    let principal: Principal | null = publisher();
    const auth: Authenticator = { authenticate: async () => principal };
    const baseDeps: AuthoringHandlerDependencies = {
      repository,
      blobs,
      auth,
      config: { organizationId: ORGANIZATION, maxBodyBytes: 8 * 1024 * 1024 },
      releaseAdmission: () => true,
    };
    const createHandler = createDraftHandler(baseDeps);

    const createdResponse = await createHandler(uploadRequest(initialFiles));
    expect(createdResponse.status).toBe(201);
    const created = (await responseJson(createdResponse)).draft as {
      id: string;
      revision: number;
      digest: string;
    };
    expect(created.revision).toBe(1);
    const largeDigest = await digestBytes(largeBytes);
    const notesDigest = await digestBytes(new TextEncoder().encode('unchanged notes\n'));
    const deltaFiles = [
      { path: 'notes.txt', digest: notesDigest },
      { path: 'renamed/large.bin', sourcePath: 'assets/large.bin', digest: largeDigest },
      { path: 'SKILL.md', content: changedSkillContent },
    ];
    const fullBodyBytes = new TextEncoder().encode(JSON.stringify({
      expectedRevision: created.revision,
      expectedDigest: created.digest,
      files: initialFiles.map((file) => file.path === 'SKILL.md'
        ? { ...file, content: changedSkillContent }
        : file.path === 'assets/large.bin'
          ? { ...file, path: 'renamed/large.bin' }
          : file),
    }));
    const deltaBodyBytes = new TextEncoder().encode(JSON.stringify({
      expectedRevision: created.revision,
      expectedDigest: created.digest,
      files: deltaFiles,
    }));
    expect(fullBodyBytes.byteLength).toBeGreaterThan(SAVE_LIMIT);
    expect(deltaBodyBytes.byteLength).toBeLessThan(SAVE_LIMIT);

    const saveDeps: AuthoringHandlerDependencies = {
      ...baseDeps,
      config: { organizationId: ORGANIZATION, maxBodyBytes: SAVE_LIMIT },
    };
    const saveHandler = createDraftHandler(saveDeps);
    const missingDigest = await saveHandler(deltaRequest(created.id, 1, undefined, deltaFiles, 'delta-save-missing-digest'));
    expect(missingDigest.status).toBe(400);
    expect((await responseJson(missingDigest)).error.code).toBe('INVALID_REQUEST');
    expect(blobs.putCalls).toBe(1);
    const wrongFileDigest = deltaFiles.map((file) => file.path === 'renamed/large.bin'
      ? { ...file, digest: `sha256:${'0'.repeat(64)}` }
      : file);
    const wrongDigest = await saveHandler(deltaRequest(created.id, 1, created.digest, wrongFileDigest, 'delta-save-wrong-file-digest'));
    expect(wrongDigest.status).toBe(409);
    expect((await responseJson(wrongDigest)).error.code).toBe('DRAFT_CONFLICT');
    expect(blobs.putCalls).toBe(1);
    const first = await saveHandler(deltaRequest(created.id, 1, created.digest, deltaFiles, 'delta-save-1'));
    expect(first.status).toBe(200);
    const firstBody = await responseJson(first);
    expect(firstBody.idempotent).toBe(false);
    expect(firstBody.draft).toMatchObject({ revision: 2, skillName: 'large-skill' });
    expect(firstBody.draft.files.find((file: { path: string }) => file.path === 'renamed/large.bin')).toMatchObject({
      content: largeContent,
      executable: true,
    });
    expect(blobs.putCalls).toBe(2);

    const savedState = await repository.read(ORGANIZATION);
    const savedDraft = savedState.drafts?.[0];
    expect(savedDraft?.revision).toBe(2);
    expect(savedDraft?.digest).toBe(firstBody.draft.digest);
    const savedBytes = await blobs.get(savedDraft!.artifact.key);
    const savedBundle = decodeBundle(savedBytes);
    expect(savedBundle.files.find((file) => file.path === 'renamed/large.bin')).toMatchObject({
      content: largeContent,
      executable: true,
    });
    expect(savedBundle.files.some((file) => file.path === 'assets/large.bin')).toBe(false);
    expect(savedBundle.files.find((file) => file.path === 'SKILL.md')?.content).toBe(changedSkillContent);
    expect(await digestBytes(savedBytes)).toBe(savedDraft?.digest);

    const replay = await saveHandler(deltaRequest(created.id, 1, created.digest, deltaFiles, 'delta-save-1'));
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual({ draft: firstBody.draft, idempotent: true });
    expect(blobs.putCalls).toBe(2);
    expect((await repository.read(ORGANIZATION)).drafts?.[0]?.revision).toBe(2);

    const stale = await saveHandler(deltaRequest(created.id, 1, created.digest, deltaFiles, 'delta-save-stale'));
    expect(stale.status).toBe(409);
    expect((await responseJson(stale)).error).toMatchObject({
      code: 'DRAFT_CONFLICT',
      details: { currentRevision: 2 },
    });
    expect(blobs.putCalls).toBe(2);

    const staleDigest = await saveHandler(deltaRequest(created.id, 2, created.digest, deltaFiles, 'delta-save-stale-digest'));
    expect(staleDigest.status).toBe(409);
    expect((await responseJson(staleDigest)).error.code).toBe('DRAFT_CONFLICT');
    expect(blobs.putCalls).toBe(2);
    principal = null;
  });
});
