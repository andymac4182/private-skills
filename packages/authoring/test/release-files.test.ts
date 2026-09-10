import { describe, expect, it } from 'vitest';
import {
  createReleaseFilesHandler,
  DEFAULT_RELEASE_TEXT_PREVIEW_BYTES,
  type AuthoringHandlerDependencies,
} from '../src/index.js';
import { defaultRegistryState, createMemoryStateRepository } from '../../database/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  SkillBundle,
  SkillVersion,
  StateRepository,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-test';

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Text(value: string): string {
  return base64Bytes(new TextEncoder().encode(value));
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  getCalls = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const key = `sealed-${this.values.size}`;
    const copy = bytes.slice();
    this.values.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    this.getCalls += 1;
    const value = this.values.get(key);
    if (!value) throw new Error('missing blob');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function principal(
  subject: string,
  roles: Principal['roles'],
  namespaces: string[] = ['@team'],
): Principal {
  return {
    organizationId: ORGANIZATION,
    subject,
    roles,
    namespaces,
    scopes: ['skills:read'],
  } as Principal;
}

interface Fixture {
  state: RegistryState;
  repository: StateRepository;
  blobs: MemoryBlobs;
  release: SkillVersion;
  handler: ReturnType<typeof createReleaseFilesHandler>;
  setPrincipal(value: Principal | null): void;
}

async function fixture(options: { admitted?: boolean } = {}): Promise<Fixture> {
  const state = defaultRegistryState({ production: false, allowUnscanned: true });
  const largeText = 'x'.repeat(DEFAULT_RELEASE_TEXT_PREVIEW_BYTES + 1);
  const bundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [
      { path: 'SKILL.md', content: base64Text('---\nname: demo\ndescription: Demo skill\n---\n# Demo\n') },
      { path: 'docs/guide.md', content: base64Text('# Guide\n\nExact bytes.\n') },
      { path: 'assets/image.png', content: base64Bytes(new Uint8Array([137, 80, 78, 71, 0, 1, 2])) },
      { path: 'notes/custom.data', content: base64Text('valid UTF-8 with an unsupported extension') },
      { path: 'large.txt', content: base64Text(largeText) },
    ],
  };
  const encoded = encodeBundle(bundle);
  const blobs = new MemoryBlobs();
  const stored = await blobs.put(encoded);
  const release: SkillVersion = {
    id: 'release-1',
    organizationId: ORGANIZATION,
    name: '@team/demo',
    skillName: 'demo',
    version: '1.0.0',
    description: 'Demo skill',
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
  let current: Principal | null = principal('reader', ['reader']);
  const auth: Authenticator = {
    authenticate: async () => current,
  };
  const deps: AuthoringHandlerDependencies = {
    repository,
    blobs,
    auth,
    config: { organizationId: ORGANIZATION },
    releaseAdmission: async () => options.admitted ?? true,
  };
  return {
    state,
    repository,
    blobs,
    release,
    handler: createReleaseFilesHandler(deps),
    setPrincipal(value) {
      current = value;
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe('immutable release file view', () => {
  it('returns the verified digest and exact text while marking non-text files explicitly', async () => {
    const test = await fixture();
    const response = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await json(response);
    expect(body.release).toEqual({
      id: test.release.id,
      name: test.release.name,
      skillName: test.release.skillName,
      version: test.release.version,
      digest: test.release.artifact.digest,
      fileCount: 5,
    });
    expect(body.files.find((file: any) => file.path === 'SKILL.md')).toMatchObject({
      previewState: 'text',
      contents: '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    });
    expect(body.files.find((file: any) => file.path === 'docs/guide.md')).toMatchObject({
      previewState: 'text',
      contents: '# Guide\n\nExact bytes.\n',
    });
    expect(body.files.find((file: any) => file.path === 'assets/image.png')).toMatchObject({
      size: 7,
      previewState: 'binary',
    });
    expect(body.files.find((file: any) => file.path === 'notes/custom.data')).toMatchObject({
      previewState: 'unsupported',
    });
    expect(body.files.find((file: any) => file.path === 'large.txt')).toMatchObject({
      size: DEFAULT_RELEASE_TEXT_PREVIEW_BYTES + 1,
      previewState: 'oversize',
    });
    for (const file of body.files.filter((file: any) => file.previewState !== 'text')) {
      expect(file).not.toHaveProperty('contents');
    }
    expect(test.blobs.getCalls).toBe(1);
  });

  it('serves one exact canonical path through the singular route and rejects traversal', async () => {
    const test = await fixture();
    const response = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/file?path=docs%2Fguide.md`));
    expect(response.status).toBe(200);
    expect((await json(response)).files).toEqual([
      {
        path: 'docs/guide.md',
        size: 22,
        previewState: 'text',
        contents: '# Guide\n\nExact bytes.\n',
      },
    ]);

    const missingPath = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/file?path=unknown.md`));
    expect(missingPath.status).toBe(404);
    const traversal = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/file?path=..%2FSKILL.md`));
    expect(traversal.status).toBe(400);
    const listWithPath = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files?path=SKILL.md`));
    expect(listWithPath.status).toBe(400);
  });

  it('checks tenant, namespace, approval, and scanner admission before reading bytes', async () => {
    const test = await fixture();
    test.setPrincipal(principal('other-namespace', ['reader'], ['@other']));
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(404);
    expect(test.blobs.getCalls).toBe(0);

    test.setPrincipal({ ...principal('worker', ['worker']), identity: 'worker' } as Principal);
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(403);
    expect(test.blobs.getCalls).toBe(0);

    test.setPrincipal(principal('reader', ['reader']));
    await test.repository.transaction(ORGANIZATION, (state) => {
      state.skills[0]!.state = 'quarantined';
    });
    const deniedState = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`));
    expect(deniedState.status).toBe(404);
    expect(test.blobs.getCalls).toBe(0);

    const deniedAdmission = await fixture({ admitted: false });
    const admissionResponse = await deniedAdmission.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`));
    expect(admissionResponse.status).toBe(404);
    expect(deniedAdmission.blobs.getCalls).toBe(0);
  });

  it('fails closed when the sealed bytes do not match the immutable release digest', async () => {
    const test = await fixture();
    const key = test.release.artifact.key;
    test.blobs.values.set(key, new TextEncoder().encode('tampered'));
    const response = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`));
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      error: { code: 'DIGEST_MISMATCH', message: 'Release content failed integrity verification' },
    });
  });

  it('does not create or mutate durable state while reading', async () => {
    const test = await fixture();
    const before = await test.repository.read(ORGANIZATION);
    const response = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`));
    expect(response.status).toBe(200);
    const after = await test.repository.read(ORGANIZATION);
    expect(after).toEqual(before);
    expect(after.jobs).toEqual([]);
    expect(after.audit).toEqual([]);
  });
});
