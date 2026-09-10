import { describe, expect, it } from 'vitest';
import { createDraftHandler } from '../src/drafts.js';
import type { AuthoringHandlerDependencies } from '../src/index.js';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  BlobStore,
  Principal,
  RegistryState,
  SkillBuilderProposalRecord,
  SkillBuilderSessionRecord,
  SkillBundle,
  SkillDraft,
  StateRepository,
  StoredBlob,
} from '../../contracts/src/index.js';

const ORIGIN = 'https://registry.example.test';
const ORGANIZATION = 'org-test';
const SUBJECT = 'human-editor';
const DRAFT_ID = 'draft-1';
const SESSION_ID = 'session-1';
const PROPOSAL_ID = 'proposal-1';
const REJECT_KEY = 'reject-1';
const PROPOSAL_CONTENT = 'private proposal content must never enter the audit';

class MemoryBlobs implements BlobStore {
  private readonly values = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const copy = bytes.slice();
    const digest = await digestBytes(copy);
    this.values.set(digest, copy);
    return { key: digest, digest, size: copy.byteLength };
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

const principal: Principal = {
  organizationId: ORGANIZATION,
  subject: SUBJECT,
  roles: ['publisher'],
  namespaces: ['@team'],
  scopes: ['skills:publish'],
};

function rejectRequest(draft: SkillDraft, key = REJECT_KEY): Request {
  return new Request(`${ORIGIN}/v1/drafts/${draft.id}/proposals/${PROPOSAL_ID}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({
      draftId: draft.id,
      revision: draft.revision,
      digest: draft.digest,
      sessionId: SESSION_ID,
    }),
  });
}

interface Fixture {
  repository: StateRepository;
  backing: ReturnType<typeof createMemoryStateRepository>;
  draft: SkillDraft;
  handler: ReturnType<typeof createDraftHandler>;
  transactionEntered(): boolean;
}

async function fixture(options: { failTransaction?: boolean } = {}): Promise<Fixture> {
  const state = defaultRegistryState({ production: false, allowUnscanned: true });
  const bundle: SkillBundle = {
    format: 'pskills-bundle-v1',
    files: [
      { path: 'SKILL.md', content: base64('---\nname: demo\ndescription: Demo\n---\n# Demo\n') },
      { path: 'docs/guide.md', content: base64('# Guide\n') },
    ],
  };
  const blobs = new MemoryBlobs();
  const stored = await blobs.put(encodeBundle(bundle));
  const now = '2026-09-10T00:00:00.000Z';
  const draft: SkillDraft = {
    id: DRAFT_ID,
    organizationId: ORGANIZATION,
    origin: 'upload',
    name: '@team/demo',
    skillName: 'demo',
    description: 'Demo',
    revision: 1,
    digest: stored.digest,
    artifact: stored,
    files: bundle.files,
    status: 'open',
    actor: SUBJECT,
    createdAt: now,
    updatedAt: now,
  };
  const proposal: SkillBuilderProposalRecord = {
    id: PROPOSAL_ID,
    idempotencyKey: 'builder-request-secret',
    requestDigest: stored.digest,
    organizationId: ORGANIZATION,
    draftId: DRAFT_ID,
    subject: SUBJECT,
    sessionId: SESSION_ID,
    baseRevision: draft.revision,
    baseDigest: draft.digest,
    proposedDigest: stored.digest,
    operations: [{ op: 'edit', path: 'docs/guide.md', content: PROPOSAL_CONTENT }],
    state: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  const session: SkillBuilderSessionRecord = {
    id: SESSION_ID,
    organizationId: ORGANIZATION,
    subject: SUBJECT,
    draftId: DRAFT_ID,
    draftRevision: draft.revision,
    draftDigest: draft.digest,
    sessionKey: 'session-secret',
    eveSessionId: 'eve-session-secret',
    state: 'ready',
    requests: [],
    proposals: [proposal],
    createdAt: now,
    updatedAt: now,
  };
  state.drafts = [draft];
  state.builderSessions = [session];
  const backing = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } });
  let transactionEntered = false;
  const repository: StateRepository = options.failTransaction
    ? {
      read: (organizationId) => backing.read(organizationId),
      transaction: async <T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T> => {
        transactionEntered = true;
        const working = await backing.read(organizationId);
        updater(working);
        throw new Error('injected transaction failure');
      },
    }
    : backing;
  const deps: AuthoringHandlerDependencies = {
    repository,
    blobs,
    auth: { authenticate: async () => principal },
    config: { organizationId: ORGANIZATION, maxBodyBytes: 1024 * 1024 },
    releaseAdmission: () => true,
    releaseAdmissionAtCommit: () => true,
  };
  return {
    repository,
    backing,
    draft,
    handler: createDraftHandler(deps),
    transactionEntered: () => transactionEntered,
  };
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe('builder proposal rejection audit', () => {
  it('audits one redacted terminal reject and leaves an identical replay unchanged', async () => {
    const test = await fixture();
    const before = await test.repository.read(ORGANIZATION);

    const first = await test.handler(rejectRequest(test.draft));
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    expect(firstBody.proposal).toMatchObject({ id: PROPOSAL_ID, state: 'rejected' });

    const afterFirst = await test.repository.read(ORGANIZATION);
    expect(afterFirst.drafts).toEqual(before.drafts);
    expect(afterFirst.builderSessions?.[0]?.proposals[0]?.state).toBe('rejected');
    expect(afterFirst.audit).toHaveLength(1);
    expect(afterFirst.audit[0]).toMatchObject({
      action: 'draft.builder.proposal.rejected',
      subject: SUBJECT,
      resourceId: DRAFT_ID,
      details: { source: 'builder-proposal', proposalId: PROPOSAL_ID },
    });
    const serializedAudit = JSON.stringify(afterFirst.audit[0]);
    expect(serializedAudit).not.toContain(PROPOSAL_CONTENT);
    expect(serializedAudit).not.toContain('builder-request-secret');
    expect(serializedAudit).not.toContain('session-secret');

    const replay = await test.handler(rejectRequest(test.draft));
    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual(firstBody);
    const afterReplay = await test.repository.read(ORGANIZATION);
    expect(afterReplay.audit).toEqual(afterFirst.audit);
    expect(afterReplay.builderSessions?.[0]?.proposals[0]).toEqual(afterFirst.builderSessions?.[0]?.proposals[0]);
  });

  it('does not commit the reject or its audit when the enclosing transaction fails', async () => {
    const test = await fixture({ failTransaction: true });
    const before = await test.backing.read(ORGANIZATION);

    const response = await test.handler(rejectRequest(test.draft));
    expect(response.status).toBe(500);
    expect((await json(response)).error.code).toBe('INTERNAL_ERROR');
    expect(test.transactionEntered()).toBe(true);

    const after = await test.backing.read(ORGANIZATION);
    expect(after).toEqual(before);
  });
});
