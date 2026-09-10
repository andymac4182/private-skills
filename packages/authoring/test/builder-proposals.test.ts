import { describe, expect, it } from 'vitest';
import { createDraftHandler } from '../src/drafts.js';
import type { AuthoringHandlerDependencies } from '../src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes } from '../../storage/src/index.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  SkillBuilderSessionRecord,
  SkillBundle,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-builder-test';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class MemoryBlobs implements BlobStore {
  private readonly values = new Map<string, Uint8Array>();
  private sequence = 0;

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const key = `sealed-${this.sequence++}`;
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

function principal(): Principal & { identity: 'user' } {
  return {
    organizationId: ORGANIZATION,
    subject: 'publisher',
    roles: ['publisher'],
    namespaces: ['@team'],
    scopes: ['skills:publish', 'skills:read', 'skills:builder'],
    identity: 'user',
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

interface Fixture {
  handler: ReturnType<typeof createDraftHandler>;
  repository: ReturnType<typeof createMemoryStateRepository>;
  draft: any;
  setPrincipal(value: Principal | null): void;
}

async function fixture(): Promise<Fixture> {
  const state = defaultRegistryState({ production: false, allowUnscanned: true });
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  const blobs = new MemoryBlobs();
  let current: Principal | null = principal();
  const auth: Authenticator = { authenticate: async () => current };
  const deps: AuthoringHandlerDependencies = {
    repository,
    blobs,
    auth,
    config: { organizationId: ORGANIZATION, maxBodyBytes: 1024 * 1024 },
    releaseAdmission: () => true,
    releaseAdmissionAtCommit: () => true,
  };
  const handler = createDraftHandler(deps);
  const bundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [
      { path: 'SKILL.md', content: base64('---\nname: builder-demo\ndescription: Builder demo\n---\n# Demo\n') },
      { path: 'docs/guide.md', content: base64('# Guide\n') },
    ],
  };
  const createdResponse = await handler(new Request(`${ORIGIN}/v1/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'draft-create' },
    body: JSON.stringify({ name: '@team/builder-demo', files: bundle.files }),
  }));
  expect(createdResponse.status).toBe(201);
  const draft = (await json(createdResponse)).draft;
  const session: SkillBuilderSessionRecord = {
    id: 'session-1',
    organizationId: ORGANIZATION,
    subject: 'publisher',
    draftId: draft.id,
    draftRevision: draft.revision,
    draftDigest: draft.digest,
    sessionKey: 'session-key',
    eveSessionId: 'eve-session-1',
    state: 'ready',
    requests: [],
    proposals: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
  await repository.transaction(ORGANIZATION, (mutable) => {
    mutable.builderSessions = [session];
  });
  return {
    handler,
    repository,
    draft,
    setPrincipal(value) {
      current = value;
    },
  };
}

function proposalRequest(
  draft: any,
  key: string,
  operations: readonly Record<string, unknown>[],
): Request {
  return new Request(`${ORIGIN}/v1/drafts/${encodeURIComponent(draft.id)}/proposals`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-pskills-tool-identity': 'skill-builder',
    },
    body: JSON.stringify({
      draftId: draft.id,
      revision: draft.revision,
      digest: draft.digest,
      sessionId: 'session-1',
      operations,
    }),
  });
}

describe('builder proposal idempotency', () => {
  it('rejects idempotency-key reuse when the canonical proposal request changes', async () => {
    const test = await fixture();
    const original = [{ op: 'edit', path: 'docs/guide.md', content: '# Updated guide\n' }];
    const first = await test.handler(proposalRequest(test.draft, 'proposal-request-1', original));
    expect(first.status).toBe(201);
    const firstBody = await json(first);

    const exactRetry = await test.handler(proposalRequest(test.draft, 'proposal-request-1', original));
    expect(exactRetry.status).toBe(200);
    expect((await json(exactRetry)).proposal).toEqual(firstBody.proposal);

    const changed = await test.handler(proposalRequest(test.draft, 'proposal-request-1', [
      { op: 'edit', path: 'docs/guide.md', content: '# Different guide\n' },
    ]));
    expect(changed.status).toBe(409);
    expect((await json(changed)).error.code).toBe('IDEMPOTENCY_CONFLICT');

    const state = await test.repository.read(ORGANIZATION);
    expect(state.builderSessions?.[0]?.proposals).toHaveLength(1);
    expect(state.builderSessions?.[0]?.proposals[0]?.id).toBe(firstBody.proposal.id);
  });
});
