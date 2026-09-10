import { describe, expect, it } from 'vitest';
import {
  OpenClawConsumerSelectionError,
  OpenClawSourceProofStoreError,
  OpenClawTrustedSnapshotImportService,
  StateRepositoryOpenClawConsumerSnapshotStore,
  StateRepositoryOpenClawSourceProofStore,
  createOpenClawCandidateProvider,
} from '../src/index.ts';
import { createMemoryStateRepository, defaultRegistryState } from '../../database/src/index.ts';
import {
  parseOpenClawFeed,
  serializeOpenClawFeed,
  sha256,
  utf8Bytes,
  type OpenClawCacheSnapshot,
  type OpenClawFeedEntry,
} from '../../openclaw/src/index.ts';
import type { Digest, Principal, RegistryState, SkillVersion } from '../../contracts/src/index.ts';
import type { OpenClawMetadataSnapshot } from '../src/index.ts';

const TENANT = 'tenant-a';
const SOURCE_URL = 'https://feed.example/v1/feeds/skills';
const SOURCE_DIGEST = `sha256:${'b'.repeat(64)}` as Digest;
const REGISTRY_DIGEST = `sha256:${'a'.repeat(64)}` as Digest;
const FIXED_NOW = Date.parse('2030-01-01T01:00:00.000Z');

const entry: OpenClawFeedEntry = {
  type: 'skill',
  id: '@acme/demo',
  title: 'Demo',
  version: '1.0.0',
  state: 'available',
  publisher: { id: 'acme', trust: 'community' },
  install: {
    candidates: [{
      sourceRef: 'public-clawhub',
      package: '@acme/demo',
      version: '1.0.0',
      integrity: SOURCE_DIGEST,
    }],
  },
};

const sourceArtifact = {
  verified: true as const,
  digest: SOURCE_DIGEST,
  format: 'clawhub-skill-v1' as const,
  identity: '@acme/demo@1.0.0',
};

type TestOpenClawJob = RegistryState['jobs'][number] & { openclawSource?: unknown };

function firstJob(state: RegistryState): TestOpenClawJob {
  return state.jobs[0]! as TestOpenClawJob;
}

function metadataSnapshot(overrides: Partial<OpenClawFeedEntry> = {}): OpenClawMetadataSnapshot {
  return {
    feed: {
      schemaVersion: 1,
      id: 'clawhub-official',
      generatedAt: '2030-01-01T00:00:00.000Z',
      sequence: 5,
      expiresAt: '2030-01-02T00:00:00.000Z',
      entries: [{ ...entry, ...overrides, install: { candidates: entry.install.candidates } }],
    },
    sha256: SOURCE_DIGEST,
    etag: `"${SOURCE_DIGEST}"`,
    acceptedAt: FIXED_NOW,
    sourceUrl: 'https://feed.example/v1/feeds/skills',
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    organizationId: TENANT,
    subject: 'reader',
    roles: ['reader'],
    scopes: ['registry:read'],
    ...overrides,
  };
}

function skill(): SkillVersion {
  return {
    id: 'skill-1',
    organizationId: TENANT,
    name: '@team/demo',
    skillName: 'demo',
    version: '1.0.0',
    description: 'approved',
    artifact: { key: 'blob-1', digest: REGISTRY_DIGEST, size: 10 },
    state: 'approved',
    policyRevision: 'policy-test',
    createdAt: '2030-01-01T00:00:00.000Z',
    approvedAt: '2030-01-01T00:00:00.000Z',
    provenance: {
      kind: 'skills-sh',
      externalId: entry.id,
      path: entry.id,
      revision: entry.version,
      externalDigest: SOURCE_DIGEST,
      sourceDigest: REGISTRY_DIGEST,
      sourceResolutionKind: 'snapshot',
    },
    fileCount: 1,
    scanIds: [],
  };
}

async function repositoryWithCompletedImport(): Promise<ReturnType<typeof createMemoryStateRepository>> {
  const repository = createMemoryStateRepository({
    stateFactory: () => defaultRegistryState({ production: false, allowUnscanned: true, policyRevision: 'policy-test' }),
  });
  await repository.transaction(TENANT, (state) => {
    const approved = skill();
    state.skills.push(approved);
    state.jobs.push({
      id: 'job-1',
      organizationId: TENANT,
      kind: 'import',
      state: 'completed',
      resourceId: approved.id,
      artifact: approved.artifact,
      policyRevision: state.policy.revision,
      policy: state.policy,
      import: {
        upstreamId: 'upstream-1',
        path: entry.id,
        externalId: entry.id,
        name: approved.name,
        version: approved.version,
      },
      upstream: {
        id: 'upstream-1',
        organizationId: TENANT,
        name: 'skills.sh',
        kind: 'skills-sh',
        enabled: true,
        namespace: '@team',
        baseUrl: 'https://skills.sh',
      },
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
      attempts: 1,
    });
    firstJob(state).openclawSource = {
      source: {
        kind: 'public-clawhub',
        sourceRef: 'public-clawhub',
        packageName: entry.id,
        version: entry.version,
        artifactDigest: SOURCE_DIGEST,
      },
      entry,
    };
  });
  return repository;
}

async function feedSnapshot(): Promise<OpenClawCacheSnapshot> {
  const body = serializeOpenClawFeed({
    schemaVersion: 1,
    id: 'clawhub-official',
    generatedAt: '2030-01-01T00:00:00.000Z',
    sequence: 4,
    expiresAt: '2030-01-02T00:00:00.000Z',
    entries: [entry],
  });
  const bytes = utf8Bytes(body);
  const digest = await sha256(bytes);
  return {
    feed: parseOpenClawFeed(body, { expectedFeedId: 'clawhub-official', checkExpiry: false }),
    body,
    bytes,
    sha256: digest,
    etag: `"${digest}"`,
    acceptedAt: FIXED_NOW,
    sourceUrl: SOURCE_URL,
  };
}

describe('OpenClaw source proof and consumer services', () => {
  it('writes a proof only for a completed approved import and projects it with current namespace/policy checks', async () => {
    const repository = await repositoryWithCompletedImport();
    const proofs = new StateRepositoryOpenClawSourceProofStore(repository, { now: () => FIXED_NOW });
    const input = {
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    };
    const recorded = await proofs.recordFromCompletion(input);
    expect(recorded).toMatchObject({
      tenantId: TENANT,
      skillId: 'skill-1',
      registryArtifactDigest: REGISTRY_DIGEST,
      sourceArtifact: { digest: SOURCE_DIGEST, identity: '@acme/demo@1.0.0' },
      entry: { id: entry.id, install: { candidates: [{ integrity: SOURCE_DIGEST }] } },
    });
    await expect(proofs.recordFromCompletion(input)).resolves.toMatchObject({ recordedAt: recorded.recordedAt });

    const provider = createOpenClawCandidateProvider({ proofs, now: () => FIXED_NOW });
    const state = await repository.read(TENANT);
    await expect(provider({
      tenantId: TENANT,
      principal: principal(),
      state,
      signal: new AbortController().signal,
    })).resolves.toMatchObject([{ skillId: 'skill-1', entry: { id: entry.id }, sourceArtifact: { digest: SOURCE_DIGEST } }]);

    await expect(provider({
      tenantId: TENANT,
      principal: principal({ namespaces: ['@other'] }),
      state,
      signal: new AbortController().signal,
    })).resolves.toEqual([]);

    await repository.transaction(TENANT, (mutable) => {
      mutable.skills[0]!.state = 'pending';
    });
    await expect(provider({
      tenantId: TENANT,
      principal: principal(),
      state: await repository.read(TENANT),
      signal: new AbortController().signal,
    })).resolves.toEqual([]);
  });

  it('uses current trusted metadata claims without changing source identity, and withholds blocked states', async () => {
    const repository = await repositoryWithCompletedImport();
    const proofs = new StateRepositoryOpenClawSourceProofStore(repository, { now: () => FIXED_NOW });
    await proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    });
    const provider = createOpenClawCandidateProvider({ proofs, now: () => FIXED_NOW });
    const state = await repository.read(TENANT);
    const downgraded = await provider({
      tenantId: TENANT,
      principal: principal(),
      state,
      metadata: metadataSnapshot({
        title: 'Current catalog title',
        publisher: { id: 'community', trust: 'community' },
      }),
      signal: new AbortController().signal,
    });
    expect(downgraded).toMatchObject([{
      entry: {
        title: 'Current catalog title',
        publisher: { id: 'community', trust: 'community' },
        state: 'available',
        version: entry.version,
        install: { candidates: [{ integrity: SOURCE_DIGEST, package: entry.id }] },
      },
      sourceArtifact: { digest: SOURCE_DIGEST, identity: sourceArtifact.identity },
    }]);

    for (const stateValue of ['blocked', 'disabled', 'deprecated'] as const) {
      await expect(provider({
        tenantId: TENANT,
        principal: principal(),
        state,
        metadata: metadataSnapshot({ state: stateValue }),
        signal: new AbortController().signal,
      })).resolves.toEqual([]);
    }
  });

  it('rejects metadata-only or changed completion evidence and preserves the immutable proof', async () => {
    const repository = await repositoryWithCompletedImport();
    const proofs = new StateRepositoryOpenClawSourceProofStore(repository, { now: () => FIXED_NOW });
    await expect(proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'missing-job',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    })).rejects.toMatchObject({ code: 'not-eligible' });

    await repository.transaction(TENANT, (state) => {
      state.skills[0]!.provenance = { ...state.skills[0]!.provenance, sourceResolutionKind: undefined };
    });
    await expect(proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    })).rejects.toMatchObject({ code: 'not-eligible' });

    await repository.transaction(TENANT, (state) => {
      state.skills[0]!.provenance = { ...state.skills[0]!.provenance, sourceResolutionKind: 'snapshot' };
    });

    await repository.transaction(TENANT, (state) => {
      state.skills[0]!.provenance = { ...state.skills[0]!.provenance, sourceDigest: undefined };
    });
    await expect(proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    })).rejects.toMatchObject({ code: 'not-eligible' });
    await repository.transaction(TENANT, (state) => {
      state.skills[0]!.provenance = { ...state.skills[0]!.provenance, sourceDigest: REGISTRY_DIGEST };
    });

    await repository.transaction(TENANT, (state) => {
      delete firstJob(state).openclawSource;
    });
    await expect(proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    })).rejects.toMatchObject({ code: 'not-eligible' });
    await repository.transaction(TENANT, (state) => {
      firstJob(state).openclawSource = {
        source: {
          kind: 'public-clawhub',
          sourceRef: 'public-clawhub',
          packageName: entry.id,
          version: entry.version,
          artifactDigest: SOURCE_DIGEST,
        },
        entry,
      };
    });

    await repository.transaction(TENANT, (state) => {
      const descriptor = firstJob(state).openclawSource as { source: Record<string, unknown>; entry: OpenClawFeedEntry };
      firstJob(state).openclawSource = { ...descriptor, entry: { ...entry, title: 'descriptor mismatch' } };
    });
    await expect(proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    })).rejects.toMatchObject({ code: 'not-eligible' });
    await repository.transaction(TENANT, (state) => {
      const descriptor = firstJob(state).openclawSource as { source: Record<string, unknown> };
      firstJob(state).openclawSource = { ...descriptor, entry };
    });

    const spoofDigest = `sha256:${'c'.repeat(64)}` as Digest;
    await expect(proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry: {
        ...entry,
        install: { candidates: [{ ...entry.install.candidates[0]!, integrity: spoofDigest }] },
      },
      sourceArtifact: { ...sourceArtifact, digest: spoofDigest },
    })).rejects.toMatchObject({ code: 'not-eligible' });

    const first = await proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    });
    const changedEntry = { ...entry, title: 'changed' };
    await repository.transaction(TENANT, (state) => {
      const descriptor = firstJob(state).openclawSource as { source: Record<string, unknown> };
      firstJob(state).openclawSource = { ...descriptor, entry: changedEntry };
    });
    await expect(proofs.recordFromCompletion({
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry: changedEntry,
      sourceArtifact,
    })).rejects.toMatchObject({ code: 'equivocation' });
    await expect(proofs.list(TENANT)).resolves.toMatchObject([{ recordedAt: first.recordedAt, entry: { title: 'Demo' } }]);
  });

  it('re-admits the same immutable source proof after a policy revision and blocks optional scanner findings', async () => {
    const repository = await repositoryWithCompletedImport();
    const proofs = new StateRepositoryOpenClawSourceProofStore(repository, { now: () => FIXED_NOW });
    const completion = {
      tenantId: TENANT,
      completionJobId: 'job-1',
      skillId: 'skill-1',
      entry,
      sourceArtifact,
    };
    const first = await proofs.recordFromCompletion(completion);

    await repository.transaction(TENANT, (state) => {
      const current = state.skills[0]!;
      current.policyRevision = 'policy-p2';
      state.policy.revision = 'policy-p2';
      state.jobs.push({
        ...state.jobs[0]!,
        id: 'job-2',
        policyRevision: 'policy-p2',
        policy: state.policy,
      });
    });
    const readmitted = await proofs.recordFromCompletion({ ...completion, completionJobId: 'job-2' });
    expect(readmitted).toMatchObject({
      recordedAt: first.recordedAt,
      completionJobId: 'job-1',
      policyRevision: 'policy-test',
      sourceArtifact: { digest: SOURCE_DIGEST, identity: '@acme/demo@1.0.0' },
    });

    const provider = createOpenClawCandidateProvider({ proofs, now: () => FIXED_NOW });
    await expect(provider({
      tenantId: TENANT,
      principal: principal(),
      state: await repository.read(TENANT),
      signal: new AbortController().signal,
    })).resolves.toMatchObject([{ skillId: 'skill-1' }]);

    const failingPolicyProvider = createOpenClawCandidateProvider({
      proofs,
      now: () => FIXED_NOW,
      isCurrentPolicyApproved: () => { throw new Error('policy evaluator unavailable'); },
    });
    await expect(failingPolicyProvider({
      tenantId: TENANT,
      principal: principal(),
      state: await repository.read(TENANT),
      signal: new AbortController().signal,
    })).resolves.toEqual([]);

    await repository.transaction(TENANT, (state) => {
      state.policy.scanners = [{
        id: 'skillsguard',
        mode: 'advisory',
        blockSeverities: ['high'],
        timeoutSeconds: 60,
      }];
      state.skills[0]!.scanIds = ['scan-optional'];
      state.scans.push({
        id: 'scan-optional',
        organizationId: TENANT,
        jobId: 'job-2',
        artifactDigest: REGISTRY_DIGEST,
        policyRevision: 'policy-p2',
        scannerId: 'skillsguard',
        engineVersion: 'test',
        rulesRevision: 'test',
        configurationHash: 'test',
        status: 'completed',
        findings: [{ ruleId: 'blocked', fingerprint: 'blocked', severity: 'high', category: 'test', message: 'blocked' }],
        coverage: { filesEnumerated: 1, filesAnalyzed: 1, filesSkipped: 0, filesUnsupported: 0, limitations: [], externalDestinations: [] },
        createdAt: '2030-01-01T00:00:00.000Z',
        durationMs: 1,
      });
    });
    await expect(provider({
      tenantId: TENANT,
      principal: principal(),
      state: await repository.read(TENANT),
      signal: new AbortController().signal,
    })).resolves.toEqual([]);
  });

  it('selects only a non-expired persisted snapshot and queues the existing scanner-bound path', async () => {
    const repository = createMemoryStateRepository();
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
    const snapshot = await feedSnapshot();
    await store.put({ tenantId: TENANT, feedId: 'clawhub-official', sourceUrl: SOURCE_URL }, snapshot);
    const queued: unknown[] = [];
    const service = new OpenClawTrustedSnapshotImportService({
      store,
      now: () => FIXED_NOW,
      queue: {
        enqueue: async (request) => {
          queued.push(request);
          return { operationId: 'job-queued', state: 'queued' as const };
        },
      },
    });
    const result = await service.selectAndQueue({
      key: { tenantId: TENANT, feedId: 'clawhub-official', sourceUrl: SOURCE_URL },
      externalId: entry.id,
      principal: principal(),
    });
    expect(result).toEqual({ operationId: 'job-queued', state: 'queued' });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      tenantId: TENANT,
      feedId: 'clawhub-official',
      feedSequence: 4,
      feedDigest: snapshot.sha256,
      externalId: entry.id,
      entry: { id: entry.id, install: { candidates: [{ integrity: SOURCE_DIGEST }] } },
    });
    expect((await repository.read(TENANT)).skills).toHaveLength(0);
  });

  it('does not queue for an expired, unavailable, or unauthorized snapshot', async () => {
    const repository = createMemoryStateRepository();
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
    await store.put({ tenantId: TENANT, feedId: 'clawhub-official', sourceUrl: SOURCE_URL }, await feedSnapshot());
    let calls = 0;
    const service = new OpenClawTrustedSnapshotImportService({
      store,
      now: () => Date.parse('2030-01-02T00:00:01.000Z'),
      queue: { enqueue: async () => { calls += 1; return { operationId: 'unexpected', state: 'queued' as const }; } },
    });
    await expect(service.selectAndQueue({
      key: { tenantId: TENANT, feedId: 'clawhub-official', sourceUrl: SOURCE_URL },
      externalId: entry.id,
      principal: principal(),
    })).rejects.toMatchObject<Partial<OpenClawConsumerSelectionError>>({ code: 'snapshot-expired' });

    const unavailable = new OpenClawTrustedSnapshotImportService({
      store,
      queue: { enqueue: async () => { calls += 1; return { operationId: 'unexpected', state: 'queued' as const }; } },
    });
    await expect(unavailable.selectAndQueue({
      key: { tenantId: TENANT, feedId: 'clawhub-official', sourceUrl: 'https://other.example/v1/feeds/skills' },
      externalId: entry.id,
      principal: principal(),
    })).rejects.toMatchObject({ code: 'snapshot-unavailable' });

    const denied = new OpenClawTrustedSnapshotImportService({
      store,
      now: () => FIXED_NOW,
      authorize: () => false,
      queue: { enqueue: async () => { calls += 1; return { operationId: 'unexpected', state: 'queued' as const }; } },
    });
    await expect(denied.selectAndQueue({
      key: { tenantId: TENANT, feedId: 'clawhub-official', sourceUrl: SOURCE_URL },
      externalId: entry.id,
      principal: principal(),
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls).toBe(0);
  });

  it('fails closed when a combined refresh reports stale metadata instead of queueing cached bytes', async () => {
    const repository = createMemoryStateRepository();
    const store = new StateRepositoryOpenClawConsumerSnapshotStore(repository);
    await store.put({ tenantId: TENANT, feedId: 'clawhub-official', sourceUrl: SOURCE_URL }, await feedSnapshot());
    let calls = 0;
    const service = new OpenClawTrustedSnapshotImportService({
      store,
      refresh: async () => ({ kind: 'stale' as const, snapshot: await feedSnapshot() }),
      queue: {
        enqueue: async () => {
          calls += 1;
          return { operationId: 'unexpected', state: 'queued' as const };
        },
      },
    });
    await expect(service.selectAndQueue({
      key: { tenantId: TENANT, feedId: 'clawhub-official', sourceUrl: SOURCE_URL },
      externalId: entry.id,
      principal: principal(),
    })).rejects.toMatchObject({ code: 'snapshot-unavailable' });
    expect(calls).toBe(0);
  });
});
