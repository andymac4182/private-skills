import { describe, expect, it } from 'vitest';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  RegistryState,
  SkillBundle,
  SkillVersion,
  StoredBlob,
} from '../../contracts/src/index.js';
import { createRegistryHandler } from '../src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-test';

function base64Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  getCalls = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const stored: StoredBlob = {
      key: `release-${this.values.size}`,
      digest: await digestBytes(copy),
      size: copy.byteLength,
    };
    this.values.set(stored.key, copy);
    return stored;
  }

  async get(key: string): Promise<Uint8Array> {
    this.getCalls += 1;
    const bytes = this.values.get(key);
    if (!bytes) throw new Error('missing release');
    return bytes.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function reader(
  subject = 'reader',
  namespaces: string[] = ['@team'],
  scopes: string[] = ['registry:read'],
): Principal {
  return {
    organizationId: ORGANIZATION,
    subject,
    roles: ['reader'],
    namespaces,
    scopes,
  };
}

interface Fixture {
  state: RegistryState;
  blobs: MemoryBlobs;
  repository: ReturnType<typeof createMemoryStateRepository>;
  handler: ReturnType<typeof createRegistryHandler>;
  setPrincipal(value: Principal | null): void;
}

async function fixture(options: { state?: RegistryState } = {}): Promise<Fixture> {
  const state = options.state ?? defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: 'policy-release-files',
  });
  const bundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [
      { path: 'SKILL.md', content: base64Text('---\nname: demo\ndescription: Demo\n---\n# Demo\n') },
      { path: 'docs/guide.md', content: base64Text('# Guide\n') },
    ],
  };
  const bytes = encodeBundle(bundle);
  const blobs = new MemoryBlobs();
  const artifact = await blobs.put(bytes);
  const release: SkillVersion = {
    id: 'release-1',
    organizationId: ORGANIZATION,
    name: '@team/demo',
    skillName: 'demo',
    version: '1.0.0',
    description: 'Demo',
    artifact,
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
  let current: Principal | null = reader();
  const auth: Authenticator = { authenticate: async () => current };
  const handler = createRegistryHandler({
    repository,
    blobs,
    auth,
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: 1024 * 1024,
      organizationId: ORGANIZATION,
      leaseSeconds: 30,
    },
  });
  return {
    state,
    blobs,
    repository,
    handler,
    setPrincipal(value) {
      current = value;
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe('core release file route composition', () => {
  it('mounts the manifest and selected-file routes behind core auth and admission', async () => {
    const test = await fixture();
    const before = await test.repository.read(ORGANIZATION);

    const manifest = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`));
    expect(manifest.status).toBe(200);
    const manifestBody = await json(manifest);
    expect(manifestBody.release).toMatchObject({
      id: 'release-1',
      name: '@team/demo',
      digest: test.state.skills[0]!.artifact.digest,
      fileCount: 2,
    });
    expect(manifestBody.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'SKILL.md', previewState: 'text' }),
      expect.objectContaining({ path: 'docs/guide.md', previewState: 'text' }),
    ]));
    expect(manifestBody.files.every((file: Record<string, unknown>) => !Object.prototype.hasOwnProperty.call(file, 'contents'))).toBe(true);
    expect(manifestBody.files.every((file: { contentDigest: string }) => /^sha256:[0-9a-f]{64}$/u.test(file.contentDigest))).toBe(true);

    const selected = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/file?path=docs%2Fguide.md`));
    expect(selected.status).toBe(200);
    expect((await json(selected)).files).toEqual([
      expect.objectContaining({
        path: 'docs/guide.md',
        previewState: 'text',
        contents: '# Guide\n',
        contentDigest: await digestBytes(new TextEncoder().encode('# Guide\n')),
      }),
    ]);

    expect(test.blobs.getCalls).toBe(2);
    expect(await test.repository.read(ORGANIZATION)).toEqual(before);
  });

  it('fails closed for auth, tenant, namespace, worker, and explicit scope violations before reading bytes', async () => {
    const test = await fixture();

    test.setPrincipal(null);
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(401);

    test.setPrincipal(reader('other-namespace', ['@other']));
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(404);

    test.setPrincipal({
      organizationId: 'other-org',
      subject: 'other-tenant',
      roles: ['reader'],
      scopes: ['registry:read'],
    });
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(403);

    test.setPrincipal({
      ...reader('worker', ['@team'], ['registry:read']),
      roles: ['worker', 'reader'],
      identity: 'worker',
    } as Principal);
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(403);

    test.setPrincipal(reader('scope-limited', ['@team'], ['skills:write']));
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(403);

    expect(test.blobs.getCalls).toBe(0);
  });

  it('does not read an artifact when current policy admission or release state denies distribution', async () => {
    const deniedState = defaultRegistryState({
      production: true,
      allowUnscanned: false,
      policyRevision: 'policy-required',
    });
    const test = await fixture({ state: deniedState });
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(404);
    expect(test.blobs.getCalls).toBe(0);

    const revokedState = defaultRegistryState({
      production: false,
      allowUnscanned: true,
      policyRevision: 'policy-revoked',
    });
    const revoked = await fixture({ state: revokedState });
    revoked.state.skills[0]!.state = 'revoked';
    // The repository stores a clone, so update the durable fixture as well.
    await revoked.repository.transaction(ORGANIZATION, (state) => {
      state.skills[0]!.state = 'revoked';
    });
    expect((await revoked.handler(new Request(`${ORIGIN}/v1/skills/release-1/files`))).status).toBe(404);
    expect(revoked.blobs.getCalls).toBe(0);
  });

  it('keeps route validation in the authoring adapter and never mutates durable state', async () => {
    const test = await fixture();
    const before = await test.repository.read(ORGANIZATION);
    const traversal = await test.handler(new Request(`${ORIGIN}/v1/skills/release-1/file?path=..%2FSKILL.md`));
    expect(traversal.status).toBe(400);
    expect(test.blobs.getCalls).toBe(0);
    expect(await test.repository.read(ORGANIZATION)).toEqual(before);
  });
});
