import { describe, expect, it } from 'vitest';
import {
  createEmptyRegistryState,
  createRegistryHandler,
  getCurrentSkillAdmission,
  isSkillCurrentlyApproved,
} from '../src/index.js';
import { digestBytes, encodeBundle } from '../../storage/src/index.js';
import type {
  Authenticator,
  BillingUsageAdmission,
  BlobStore,
  Digest,
  MeteredUsageDelta,
  MeteredUsageReservation,
  Policy,
  Principal,
  RegistryDependencies,
  RegistryState,
  ScanResult,
  SkillVersion,
  StateRepository,
} from '../../contracts/src/index.js';
import { SERVICE_VERSION } from '../../contracts/src/version.js';

const ORIGIN = 'https://registry.example.test';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const bundle = (name: string) => ({
  format: 'pskills-bundle-v1' as const,
  files: [{
    path: 'SKILL.md',
    content: base64(`---\nname: ${name}\ndescription: Test skill ${name}\n---\n# ${name}\n`),
  }],
});

const bundleWithTwoFiles = (name: string) => ({
  ...bundle(name),
  files: [
    ...bundle(name).files,
    { path: 'README.md', content: base64(`# ${name}\n`) },
  ],
});

class MemoryRepository implements StateRepository {
  state: RegistryState;

  constructor(allowUnscanned = true) {
    this.state = createEmptyRegistryState({
      revision: 'policy-test',
      scanners: [],
      allowUnscanned,
      evidenceMaxAgeSeconds: 3600,
    });
  }

  async read(): Promise<RegistryState> {
    return structuredClone(this.state);
  }

  async transaction<T>(_organizationId: string, update: (state: RegistryState) => T): Promise<T> {
    const working = structuredClone(this.state);
    const result = update(working);
    this.state = working;
    return result;
  }
}

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  reads = 0;
  nextKey = 0;

  async put(bytes: Uint8Array) {
    const key = `blob-${this.nextKey++}`;
    const copy = bytes.slice();
    this.values.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    this.reads += 1;
    const value = this.values.get(key);
    if (!value) throw new Error('missing blob');
    return value.slice();
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class RecoverableMemoryBlobs extends MemoryBlobs {
  readonly attemptWriteKeys: string[] = [];

  allocateObjectKey(): string {
    return `sealed-${this.nextKey++}`;
  }

  async putAtKey(key: string, bytes: Uint8Array) {
    this.attemptWriteKeys.push(key);
    const copy = bytes.slice();
    this.values.set(key, copy);
    return { key, digest: await digestBytes(copy), size: copy.byteLength };
  }

  async inspectObject(key: string) {
    const value = this.values.get(key);
    if (!value) return { state: 'absent' as const, key };
    return { state: 'present' as const, key, digest: await digestBytes(value), size: value.byteLength };
  }

  async confirmWriteTerminated(_key: string): Promise<boolean> {
    return true;
  }
}

class RecordingBilling implements BillingUsageAdmission {
  readonly reservations = new Set<string>();

  status(): { enabled: boolean } {
    return { enabled: true };
  }

  async reserveUsage(_organizationId: string, _delta: MeteredUsageDelta, operationKey: string): Promise<MeteredUsageReservation> {
    const idempotent = this.reservations.has(operationKey);
    this.reservations.add(operationKey);
    return { idempotent, reservationGeneration: 1 };
  }

  async reconcileUsage(): Promise<void> {
    return undefined;
  }
}

function requiredFilePolicy(revision = 'required-file-count'): Policy {
  return {
    revision,
    scanners: [{
      id: 'skillsguard',
      mode: 'required',
      blockSeverities: ['high', 'critical'],
      timeoutSeconds: 60,
    }],
    allowUnscanned: false,
    evidenceMaxAgeSeconds: 3_600,
    hooks: [],
  };
}

function cleanScan(
  id: string,
  digest: Digest,
  policyRevision: string,
  fileCount: number,
): ScanResult {
  return {
    id,
    organizationId: 'org-test',
    jobId: `${id}-job`,
    artifactDigest: digest,
    policyRevision,
    scannerId: 'skillsguard',
    engineVersion: 'test',
    rulesRevision: 'test',
    configurationHash: 'test',
    status: 'completed',
    findings: [],
    coverage: {
      filesEnumerated: fileCount,
      filesAnalyzed: fileCount,
      filesSkipped: 0,
      filesUnsupported: 0,
      limitations: [],
      externalDestinations: [],
    },
    createdAt: new Date().toISOString(),
    durationMs: 1,
  };
}

function incompleteScanResult(job: { id: string; artifact: { digest: Digest }; policyRevision: string }, fileCount: number) {
  return {
    id: `scan-${job.id}`,
    organizationId: 'org-test',
    jobId: job.id,
    artifactDigest: job.artifact.digest,
    policyRevision: job.policyRevision,
    scannerId: 'skillsguard',
    engineVersion: 'test',
    rulesRevision: 'test',
    configurationHash: 'test',
    status: 'completed',
    findings: [],
    coverage: {
      filesEnumerated: fileCount,
      filesAnalyzed: fileCount,
      filesSkipped: 0,
      filesUnsupported: 0,
      limitations: [],
      externalDestinations: [],
    },
    createdAt: new Date().toISOString(),
    durationMs: 1,
  };
}

async function seedApprovedSkill(
  test: ReturnType<typeof setup>,
  name: string,
  files: ReturnType<typeof bundleWithTwoFiles>,
  scanFileCount: number,
) {
  const artifact = await test.blobs.put(encodeBundle(files));
  const policyRevision = test.repository.state.policy.revision;
  const skill: SkillVersion = {
    id: `skill-${name}`,
    organizationId: 'org-test',
    name: `@team/${name}`,
    skillName: name,
    version: '1.0.0',
    description: name,
    artifact,
    state: 'approved',
    policyRevision,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    provenance: { kind: 'native' },
    fileCount: files.files.length,
    scanIds: [`scan-${name}`],
  };
  test.repository.state.skills.push(skill);
  test.repository.state.scans.push(cleanScan(`scan-${name}`, artifact.digest, policyRevision, scanFileCount));
  return skill;
}

function principalFor(subject: string, roles: Principal['roles'], namespaces?: string[]): Principal {
  return { organizationId: 'org-test', subject, roles, namespaces };
}

function setup(options: { allowUnscanned?: boolean; principal?: Principal | null; blobs?: MemoryBlobs; billing?: BillingUsageAdmission } = {}) {
  const repository = new MemoryRepository(options.allowUnscanned ?? true);
  const blobs = options.blobs ?? new MemoryBlobs();
  let principal = options.principal === undefined
    ? principalFor('publisher', ['publisher'], ['@team'])
    : options.principal;
  const auth: Authenticator = {
    authenticate: async () => principal,
    createSession: async (token) => token === 'session-token'
      ? {
          cookie: 'pskills_session=session; HttpOnly; SameSite=Lax',
          principal: {
            ...principalFor('session-user', ['reader'], ['@team']),
            scopes: ['registry:read'],
          },
        }
      : null,
    clearSessionCookie: () => 'pskills_session=; Max-Age=0; HttpOnly; SameSite=Lax',
  };
  const deps = {
    repository,
    blobs,
    auth,
    ...(options.billing ? { billing: options.billing } : {}),
    config: {
      publicOrigin: ORIGIN,
      maxBodyBytes: 1024 * 1024,
      organizationId: 'org-test',
      leaseSeconds: 30,
    },
  } as RegistryDependencies;
  const handler = createRegistryHandler(deps);
  return {
    repository,
    blobs,
    handler,
    setPrincipal(value: Principal | null) {
      principal = value;
    },
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe('registry core handler', () => {
  it('keeps health public while protecting registry routes and namespaces', async () => {
    const test = setup({ principal: null });
    const health = await test.handler(new Request(`${ORIGIN}/health`));
    expect(health.status).toBe(200);
    expect(await json(health)).toEqual({ ok: true, service: 'private-skills', version: SERVICE_VERSION });

    const me = await test.handler(new Request(`${ORIGIN}/v1/me`));
    expect(me.status).toBe(401);

    test.setPrincipal(principalFor('publisher', ['publisher'], ['@other']));
    const denied = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      body: JSON.stringify({ name: '@team/demo', version: '1.0.0', bundle: bundle('demo') }),
    }));
    expect(denied.status).toBe(403);

    test.setPrincipal({
      ...principalFor('mixed-worker', ['worker', 'reader']),
      identity: 'worker',
      scopes: ['registry:*'],
    } as Principal);
    const workerUserRoute = await test.handler(new Request(`${ORIGIN}/v1/me`));
    expect(workerUserRoute.status).toBe(403);
  });

  it('enforces explicit scopes while retaining role-only adapter compatibility', async () => {
    const test = setup();
    test.setPrincipal({
      ...principalFor('scoped-publisher', ['publisher'], ['@team']),
      identity: 'user',
      scopes: ['skills:publish'],
    } as Principal);
    const publish = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/scoped', version: '1.0.0', bundle: bundle('scoped') }),
    }));
    expect(publish.status).toBe(202);
    const list = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect(list.status).toBe(403);

    test.setPrincipal({
      ...principalFor('empty-scopes', ['publisher'], ['@team']),
      scopes: [],
    } as Principal);
    const emptyScopeList = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect(emptyScopeList.status).toBe(403);

    test.setPrincipal(principalFor('role-only', ['publisher'], ['@team']));
    const roleOnlyList = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect(roleOnlyList.status).toBe(200);
  });

  it('reports current admission metadata while keeping stale files inaccessible', async () => {
    const test = setup({ allowUnscanned: false });
    test.repository.state.policy = requiredFilePolicy('policy-admission');
    const skill = await seedApprovedSkill(test, 'admission-metadata', bundleWithTwoFiles('admission-metadata'), 2);
    const storedScan = test.repository.state.scans.find((scan) => scan.id === skill.scanIds[0]);
    expect(storedScan).toBeDefined();
    storedScan!.createdAt = '2026-09-10T00:00:00.000Z';
    test.setPrincipal(principalFor('reader', ['reader'], ['@team']));

    const staleList = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect(staleList.status).toBe(200);
    const staleListed = (await json(staleList)).skills[0];
    expect(staleListed.currentAdmission).toEqual({
      allowed: false,
      status: 'needs-rescan',
      reason: 'evidence-stale',
      policyRevision: 'policy-admission',
      scannerId: 'skillsguard',
      expiresAt: '2026-09-10T01:00:00.000Z',
    });
    expect(isSkillCurrentlyApproved(test.repository.state, skill)).toBe(false);
    expect(getCurrentSkillAdmission(test.repository.state, skill).allowed).toBe(false);

    const staleDetail = await test.handler(new Request(`${ORIGIN}/v1/skills/${skill.id}`));
    expect(staleDetail.status).toBe(200);
    expect((await json(staleDetail)).skill.currentAdmission).toEqual(staleListed.currentAdmission);

    const staleFiles = await test.handler(new Request(`${ORIGIN}/v1/skills/${skill.id}/files`));
    expect(staleFiles.status).toBe(404);

    storedScan!.createdAt = new Date(Date.now() - 1_000).toISOString();
    const currentList = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    const currentAdmission = (await json(currentList)).skills[0].currentAdmission;
    expect(currentAdmission).toMatchObject({
      allowed: true,
      status: 'current',
      reason: 'current',
      policyRevision: 'policy-admission',
      expiresAt: new Date(Date.parse(storedScan!.createdAt) + 3_600_000).toISOString(),
    });
    expect(isSkillCurrentlyApproved(test.repository.state, skill)).toBe(true);

    skill.state = 'quarantined';
    const quarantinedList = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect((await json(quarantinedList)).skills[0].currentAdmission).toEqual({
      allowed: false,
      status: 'unavailable',
      reason: 'quarantined',
      policyRevision: 'policy-admission',
    });

    test.setPrincipal(principalFor('other-namespace', ['reader'], ['@other']));
    const hiddenList = await test.handler(new Request(`${ORIGIN}/v1/skills`));
    expect((await json(hiddenList)).skills).toEqual([]);
    expect((await test.handler(new Request(`${ORIGIN}/v1/skills/${skill.id}`))).status).toBe(404);
  });

  it('exposes only the authenticated principal scopes through me and session metadata', async () => {
    const test = setup();
    test.setPrincipal({
      ...principalFor('reader', ['reader'], ['@team']),
      scopes: ['registry:read', 'proxy:resolve'],
      display: {
        userName: ' Alice Example ',
        userEmail: 'alice@example.test',
        organizationName: 'Acme Labs',
        organizationSlug: 'acme-labs',
      },
    } as Principal);
    const me = await test.handler(new Request(`${ORIGIN}/v1/me`));
    expect(me.status).toBe(200);
    expect((await json(me))).toMatchObject({
      scopes: ['registry:read', 'proxy:resolve'],
      display: {
        userName: 'Alice Example',
        userEmail: 'alice@example.test',
        organizationName: 'Acme Labs',
        organizationSlug: 'acme-labs',
      },
    });

    test.setPrincipal({
      ...principalFor('read-only', ['reader'], ['@team']),
      scopes: ['registry:read'],
    } as Principal);
    const readOnly = await test.handler(new Request(`${ORIGIN}/v1/me`));
    expect(readOnly.status).toBe(200);
    const readOnlyBody = await json(readOnly);
    expect(readOnlyBody.scopes).toEqual(['registry:read']);
    expect(readOnlyBody.scopes).not.toContain('proxy:resolve');

    const session = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'session-token' }),
    }));
    expect(session.status).toBe(200);
    expect((await json(session)).principal.scopes).toEqual(['registry:read']);
  });

  it('rejects cross-site login and logout mutations while allowing a CLI token exchange', async () => {
    const test = setup();
    const attackerLogin = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
      body: JSON.stringify({ token: 'session-token' }),
    }));
    expect(attackerLogin.status).toBe(403);
    expect((await json(attackerLogin)).error.code).toBe('CSRF_DENIED');

    const cliLogin = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'session-token' }),
    }));
    expect(cliLogin.status).toBe(200);

    const attackerLogout = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'DELETE',
      headers: { cookie: 'pskills_session=session', origin: 'https://attacker.example' },
    }));
    expect(attackerLogout.status).toBe(403);
    const cookieLogout = await test.handler(new Request(`${ORIGIN}/auth/session`, {
      method: 'DELETE',
      headers: { cookie: 'pskills_session=session', origin: ORIGIN },
    }));
    expect(cookieLogout.status).toBe(204);
  });

  it('publishes canonical bundles and makes an explicit unscanned policy visible in the state', async () => {
    const test = setup({ allowUnscanned: true });
    const response = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/demo', version: '1.0.0', description: 'demo', bundle: bundle('demo') }),
    }));
    expect(response.status).toBe(202);
    const operation = (await json(response)).operation;

    test.setPrincipal(principalFor('worker', ['worker']));
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const job = (await json(claim)).job;
    expect(job.id).toBe(operation.id);
    const workerArtifact = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/artifact`, {
      headers: {
        'x-worker-fencing-token': job.fencingToken ?? job.leaseToken,
        'x-artifact-digest': job.artifactDigest ?? job.artifact.digest,
      },
    }));
    expect(workerArtifact.status).toBe(200);
    expect(workerArtifact.headers.get('x-artifact-digest')).toBe(job.artifact.digest);
    const complete = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-fencing-token': job.fencingToken ?? job.leaseToken,
      },
      body: JSON.stringify({ fencingToken: job.fencingToken ?? job.leaseToken }),
    }));
    expect(complete.status).toBe(200);

    const stored = test.repository.state.skills[0];
    expect(stored?.state).toBe('approved');
    expect(stored?.scanIds).toEqual([]);
    expect(stored?.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fences stale workers when a lease is reclaimed', async () => {
    const test = setup();
    const publish = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/lease', version: '1.0.0', bundle: bundle('lease') }),
    }));
    const operation = (await json(publish)).operation;
    test.setPrincipal(principalFor('worker', ['worker']));
    const firstClaim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const first = (await json(firstClaim)).job;
    test.repository.state.jobs[0]!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    const secondClaim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const second = (await json(secondClaim)).job;
    expect(second.id).toBe(operation.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);

    const stale = await test.handler(new Request(`${ORIGIN}/internal/jobs/${operation.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: first.leaseToken }),
    }));
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe('LEASE_FENCED');
  });

  it('binds an import completion to the digest of its newly acquired bundle', async () => {
    const test = setup();
    test.setPrincipal(principalFor('admin', ['admin']));
    const upstream = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'trusted-source',
        kind: 'registry',
        namespace: '@team',
        baseUrl: 'https://source.example.test',
      }),
    }));
    expect(upstream.status).toBe(201);
    const upstreamId = (await json(upstream)).upstream.id;

    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    const importedBundle = bundle('imported');
    const queued = await test.handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstreamId,
        path: 'skills/imported',
        name: '@team/imported',
        version: '1.0.0',
      }),
    }));
    expect(queued.status).toBe(202);
    const operation = (await json(queued)).operation;

    test.setPrincipal(principalFor('worker', ['worker']));
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const job = (await json(claim)).job;
    const bytes = encodeBundle(importedBundle);
    const digest = await digestBytes(bytes);
    const complete = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        leaseToken: job.leaseToken,
        artifactDigest: digest,
        bundle: importedBundle,
        provenance: {
          kind: 'registry',
          upstreamId,
          repository: 'https://source.example.test',
          path: 'skills/imported',
          revision: digest,
        },
      }),
    }));
    expect(complete.status).toBe(200);
    expect((await json(complete)).operation.id).toBe(operation.id);
    expect(test.repository.state.skills[0]?.artifact.digest).toBe(digest);
    expect(test.repository.state.skills[0]?.state).toBe('approved');
  });

  it('reuses a committed import reservation owner after a retry without a second provider write', async () => {
    const blobs = new RecoverableMemoryBlobs();
    const billing = new RecordingBilling();
    const test = setup({ blobs, billing });
    test.setPrincipal(principalFor('admin', ['admin']));
    const upstream = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'retry-source',
        kind: 'registry',
        namespace: '@team',
        baseUrl: 'https://source.example.test',
      }),
    }));
    expect(upstream.status).toBe(201);
    const upstreamId = (await json(upstream)).upstream.id;

    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    const importedBundle = bundle('retried-import');
    const queued = await test.handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstreamId,
        path: 'skills/retried-import',
        name: '@team/retried-import',
        version: '1.0.0',
      }),
    }));
    expect(queued.status).toBe(202);

    test.setPrincipal(principalFor('worker', ['worker']));
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const job = (await json(claim)).job;
    const bytes = encodeBundle(importedBundle);
    const digest = await digestBytes(bytes);
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    const completionBody = {
      leaseToken: job.leaseToken,
      artifactDigest: wrongDigest,
      bundle: importedBundle,
      provenance: {
        kind: 'registry',
        upstreamId,
        repository: 'https://source.example.test',
        path: 'skills/retried-import',
        revision: digest,
      },
    };
    const failed = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(completionBody),
    }));
    expect(failed.status).toBe(409);
    expect((await json(failed)).error.code).toBe('DIGEST_MISMATCH');

    const failedState = await test.repository.read();
    const reservationKey = `private-skills:import-storage:${job.id}`;
    const orphan = (failedState.storageAttempts ?? []).find((attempt) => attempt.reservationKey === reservationKey);
    expect(orphan).toMatchObject({ state: 'orphaned', reservationGeneration: 1 });
    expect(blobs.attemptWriteKeys).toEqual([orphan!.objectKey]);

    const retry = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...completionBody, artifactDigest: digest }),
    }));
    expect(retry.status).toBe(200);
    expect((await json(retry)).operation.state).toBe('completed');
    expect(blobs.attemptWriteKeys).toEqual([orphan!.objectKey]);

    const finalState = await test.repository.read();
    expect((finalState.storageAttempts ?? []).filter((attempt) => attempt.reservationKey === reservationKey)).toEqual([
      expect.objectContaining({
        id: orphan!.id,
        state: 'committed',
        reservationGeneration: 1,
        objectKey: orphan!.objectKey,
      }),
    ]);
    expect(finalState.skills).toHaveLength(1);
    expect(finalState.skills[0]!.artifact).toEqual({
      key: orphan!.objectKey,
      digest,
      size: bytes.byteLength,
    });
  });

  it('pins exact approved pack members and blocks grants after revocation', async () => {
    const test = setup();
    for (const [slug, version] of [['one', '1.0.0'], ['two', '2.0.0']]) {
      const publish = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `@team/${slug}`, version, bundle: bundle(slug) }),
      }));
      const operation = (await json(publish)).operation;
      test.setPrincipal(principalFor('worker', ['worker']));
      const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
      const job = (await json(claim)).job;
      expect(job.id).toBe(operation.id);
      await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaseToken: job.leaseToken }),
      }));
      test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    }

    const packResponse = await test.handler(new Request(`${ORIGIN}/v1/packs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/pack', version: '1.0.0', skills: [
        { ref: '@team/one', version: '1.0.0' },
        { ref: '@team/two', version: '2.0.0' },
      ] }),
    }));
    expect(packResponse.status).toBe(201);
    const pack = (await json(packResponse)).pack;
    expect(pack.members.map((member: { name: string }) => member.name)).toEqual(['@team/one', '@team/two']);
    expect(pack.members.every((member: { digest: string }) => /^sha256:[0-9a-f]{64}$/.test(member.digest))).toBe(true);

    const authResponse = await test.handler(new Request(`${ORIGIN}/v1/install-authorizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', ref: '@team/one', version: '1.0.0' }),
    }));
    const authorization = (await json(authResponse)).authorization;
    const skill = test.repository.state.skills.find((item) => item.name === '@team/one')!;
    const descriptor = await test.handler(new Request(`${ORIGIN}/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: skill.id, authorizationId: authorization.id }),
    }));
    expect(descriptor.status).toBe(200);
    const transferUrl = (await json(descriptor)).url as string;
    test.setPrincipal(null);
    const unauthenticatedTransfer = await test.handler(new Request(transferUrl));
    expect(unauthenticatedTransfer.status).toBe(401);
    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));

    test.setPrincipal(principalFor('admin', ['admin']));
    const revoked = await test.handler(new Request(`${ORIGIN}/v1/skills/${skill.id}/revoke`, { method: 'POST' }));
    expect(revoked.status).toBe(200);
    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    const afterRevoke = await test.handler(new Request(`${ORIGIN}/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: skill.id, authorizationId: authorization.id }),
    }));
    expect(afterRevoke.status).toBe(409);
  });

  it('invalidates legacy partial scan evidence before resolution, authorization, or transfer', async () => {
    const test = setup({ allowUnscanned: false });
    test.repository.state.policy = requiredFilePolicy();
    const skill = await seedApprovedSkill(test, 'legacy-file-count', bundleWithTwoFiles('legacy-file-count'), 2);
    test.setPrincipal(principalFor('reader', ['reader'], ['@team']));

    const resolved = await test.handler(new Request(`${ORIGIN}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', ref: skill.name, version: skill.version }),
    }));
    expect(resolved.status).toBe(200);

    const authorizationResponse = await test.handler(new Request(`${ORIGIN}/v1/install-authorizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', ref: skill.name, version: skill.version }),
    }));
    expect(authorizationResponse.status).toBe(201);
    const authorization = (await json(authorizationResponse)).authorization;

    const descriptor = await test.handler(new Request(`${ORIGIN}/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: skill.id, authorizationId: authorization.id }),
    }));
    expect(descriptor.status).toBe(200);
    const transferUrl = (await json(descriptor)).url as string;
    const initialTransfer = await test.handler(new Request(transferUrl));
    expect(initialTransfer.status).toBe(200);
    expect(test.blobs.reads).toBe(1);

    const storedScan = test.repository.state.scans.find((scan) => scan.id === skill.scanIds[0]);
    expect(storedScan).toBeDefined();
    storedScan!.coverage.filesEnumerated = 3;
    storedScan!.coverage.filesAnalyzed = 3;
    expect(isSkillCurrentlyApproved(test.repository.state, skill)).toBe(false);
    storedScan!.coverage.filesEnumerated = 1;
    storedScan!.coverage.filesAnalyzed = 1;
    expect(isSkillCurrentlyApproved(test.repository.state, skill)).toBe(false);

    const afterResolve = await test.handler(new Request(`${ORIGIN}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', ref: skill.name, version: skill.version }),
    }));
    expect(afterResolve.status).toBe(404);

    const afterAuthorization = await test.handler(new Request(`${ORIGIN}/v1/install-authorizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', ref: skill.name, version: skill.version }),
    }));
    expect(afterAuthorization.status).toBe(404);

    const afterGrant = await test.handler(new Request(`${ORIGIN}/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: skill.id, authorizationId: authorization.id }),
    }));
    expect(afterGrant.status).toBe(409);

    const readsBeforeDeniedTransfer = test.blobs.reads;
    const deniedTransfer = await test.handler(new Request(transferUrl));
    expect(deniedTransfer.status).toBe(409);
    expect(test.blobs.reads).toBe(readsBeforeDeniedTransfer);
  });

  it('requires complete file-count evidence for native scan completion', async () => {
    const test = setup({ allowUnscanned: false });
    test.repository.state.policy = requiredFilePolicy();
    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    const publish = await test.handler(new Request(`${ORIGIN}/v1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@team/incomplete-scan', version: '1.0.0', bundle: bundleWithTwoFiles('incomplete-scan') }),
    }));
    expect(publish.status).toBe(202);
    const operation = (await json(publish)).operation;

    test.setPrincipal(principalFor('worker', ['worker']));
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const job = (await json(claim)).job;
    const complete = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        leaseToken: job.leaseToken,
        scanResults: [incompleteScanResult(job, 1)],
      }),
    }));
    expect(complete.status).toBe(200);
    expect((await json(complete)).operation).toMatchObject({ id: operation.id, state: 'completed' });
    expect(test.repository.state.skills[0]).toMatchObject({ fileCount: 2, state: 'scan-error' });
    expect(test.repository.state.jobs[0]).toMatchObject({ state: 'completed', error: expect.stringContaining('did not enumerate every artifact file') });
  });

  it('requires complete file-count evidence for imported scan completion', async () => {
    const test = setup({ allowUnscanned: false });
    test.repository.state.policy = requiredFilePolicy();
    test.setPrincipal(principalFor('admin', ['admin']));
    const upstream = await test.handler(new Request(`${ORIGIN}/v1/upstreams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'trusted-source', kind: 'registry', namespace: '@team', baseUrl: 'https://source.example.test' }),
    }));
    expect(upstream.status).toBe(201);
    const upstreamId = (await json(upstream)).upstream.id;

    const importedBundle = bundleWithTwoFiles('incomplete-import');
    test.setPrincipal(principalFor('publisher', ['publisher'], ['@team']));
    const queued = await test.handler(new Request(`${ORIGIN}/v1/imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamId, path: 'skills/incomplete-import', name: '@team/incomplete-import', version: '1.0.0' }),
    }));
    expect(queued.status).toBe(202);
    const operation = (await json(queued)).operation;

    test.setPrincipal(principalFor('worker', ['worker']));
    const claim = await test.handler(new Request(`${ORIGIN}/internal/jobs/claim`, { method: 'POST' }));
    const job = (await json(claim)).job;
    const bytes = encodeBundle(importedBundle);
    const digest = await digestBytes(bytes);
    const complete = await test.handler(new Request(`${ORIGIN}/internal/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        leaseToken: job.leaseToken,
        artifactDigest: digest,
        bundle: importedBundle,
        provenance: {
          kind: 'registry',
          upstreamId,
          repository: 'https://source.example.test',
          path: 'skills/incomplete-import',
          revision: digest,
        },
        scanResults: [incompleteScanResult({ id: job.id, artifact: { digest }, policyRevision: job.policyRevision }, 1)],
      }),
    }));
    expect(complete.status).toBe(200);
    expect((await json(complete)).operation).toMatchObject({ id: operation.id, state: 'completed' });
    expect(test.repository.state.skills[0]).toMatchObject({ fileCount: 2, state: 'scan-error' });
    expect(test.repository.state.jobs[0]).toMatchObject({ state: 'completed', error: expect.stringContaining('did not enumerate every artifact file') });
  });
});
