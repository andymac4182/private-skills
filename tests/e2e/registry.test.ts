import { afterEach, describe, expect, it } from 'vitest';

import type {
  InstallAuthorization,
  Job,
  PackVersion,
  Policy,
  Resolution,
  ScanResult,
  SkillVersion,
  TransferDescriptor,
} from '../../packages/contracts/src/index.js';
import { digestBytes, encodeBundle } from '../../packages/storage/src/index.js';
import { WorkerRunner } from '../../workers/runner/src/index.js';
import {
  bearer,
  bundleFor,
  createLocalRegistryHarness,
  jsonResponse,
  request,
  scannerResult,
  type LocalRegistryHarness,
} from './harness.js';
import { SERVICE_VERSION } from '../../packages/contracts/src/version.js';

const strictScannerPolicy: Policy = {
  revision: 'required-scanner-policy',
  scanners: [
    {
      id: 'cisco-skill-scanner',
      mode: 'required',
      blockSeverities: ['high', 'critical'],
      timeoutSeconds: 30,
    },
    {
      id: 'nvidia-skillspector',
      mode: 'disabled',
      blockSeverities: ['high', 'critical'],
      timeoutSeconds: 30,
    },
    {
      id: 'skillsguard',
      mode: 'disabled',
      blockSeverities: ['high', 'critical'],
      timeoutSeconds: 30,
    },
  ],
  // This flag must not weaken a required engine. The policy evaluator still
  // rejects a required scanner result with status error.
  allowUnscanned: true,
  evidenceMaxAgeSeconds: 86_400,
  hooks: [],
};

type JsonError = { error: { code: string; message: string } };

describe('registry HTTP protocol', () => {
  let harness: LocalRegistryHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('publishes, evaluates, authorizes, downloads, and revokes a skill', async () => {
    harness = await createLocalRegistryHarness();
    const { handler, origin, token, workerToken } = harness;
    const userHeaders = bearer(token);
    const workerHeaders = bearer(workerToken);
    const bundle = bundleFor('hello-world', 'A safe HTTP integration skill');

    const health = await request(handler, origin, '/health');
    expect(health.status).toBe(200);
    await expect(jsonResponse(health)).resolves.toMatchObject({
      ok: true,
      service: 'private-skills',
      version: SERVICE_VERSION,
    });

    const unauthenticatedCapabilities = await request(handler, origin, '/v1/capabilities');
    expect(unauthenticatedCapabilities.status).toBe(401);

    // Exercise the real authenticator's browser session exchange as well as
    // the bearer path used by workers and CLI clients.
    const session = await request(handler, origin, '/auth/session', {
      method: 'POST',
      json: { token },
    });
    expect(session.status).toBe(200);
    const sessionCookie = session.headers.get('set-cookie');
    expect(sessionCookie).toMatch(/^pskills_session=/u);
    const meViaSession = await request(handler, origin, '/v1/me', {
      headers: { cookie: sessionCookie!.split(';', 1)[0]! },
    });
    expect(meViaSession.status).toBe(200);
    await expect(jsonResponse(meViaSession)).resolves.toMatchObject({
      organizationId: 'org-e2e',
      subject: 'e2e-user',
    });

    const publish = await request(handler, origin, '/v1/publish', {
      method: 'POST',
      headers: userHeaders,
      json: {
        name: '@acme/hello-world',
        version: '1.0.0',
        description: 'A safe HTTP integration skill',
        bundle,
      },
    });
    expect(publish.status).toBe(202);
    const publishBody = await jsonResponse<{ operation: Job }>(publish);
    const queued = publishBody.operation;
    expect(queued.state).toBe('queued');
    expect(queued.kind).toBe('scan');
    expect(queued.resourceId).toBeTypeOf('string');
    expect(queued.artifact?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const pendingResolution = await request(handler, origin, '/v1/resolve', {
      method: 'POST',
      headers: userHeaders,
      json: { kind: 'skill', ref: '@acme/hello-world', version: '1.0.0' },
    });
    expect(pendingResolution.status).toBe(202);
    await expect(jsonResponse<{ operation: Job }>(pendingResolution)).resolves.toMatchObject({
      operation: { id: queued.id, state: 'queued' },
    });

    const claim = await request(handler, origin, '/internal/jobs/claim', {
      method: 'POST',
      headers: workerHeaders,
    });
    expect(claim.status).toBe(200);
    const claimed = (await jsonResponse<{ job: Job }>(claim)).job;
    expect(claimed.id).toBe(queued.id);
    expect(claimed.state).toBe('running');
    expect(claimed.leaseToken).toBeTypeOf('string');

    const complete = await request(handler, origin, `/internal/jobs/${encodeURIComponent(queued.id)}/complete`, {
      method: 'POST',
      headers: workerHeaders,
      // All scanners are disabled by the explicit development policy. The
      // server approves only because allowUnscanned is true in that policy.
      json: { leaseToken: claimed.leaseToken },
    });
    expect(complete.status).toBe(200);
    await expect(jsonResponse<{ operation: Job }>(complete)).resolves.toMatchObject({
      operation: { id: queued.id, state: 'completed' },
    });

    const skillResponse = await request(handler, origin, `/v1/skills/${encodeURIComponent(queued.resourceId!)}`, {
      headers: userHeaders,
    });
    expect(skillResponse.status).toBe(200);
    const skill = (await jsonResponse<{ skill: SkillVersion }>(skillResponse)).skill;
    expect(skill.state).toBe('approved');
    expect(skill.artifact.digest).toBe(queued.artifact?.digest);

    const scans = await request(
      handler,
      origin,
      `/v1/scans?artifactDigest=${encodeURIComponent(skill.artifact.digest)}`,
      { headers: userHeaders },
    );
    expect(scans.status).toBe(200);
    await expect(jsonResponse<{ scans: ScanResult[] }>(scans)).resolves.toEqual({ scans: [] });

    const resolved = await request(handler, origin, '/v1/resolve', {
      method: 'POST',
      headers: userHeaders,
      json: { kind: 'skill', ref: '@acme/hello-world', version: '1.0.0' },
    });
    expect(resolved.status).toBe(200);
    const resolution = (await jsonResponse<{ resolution: Resolution }>(resolved)).resolution;
    expect(resolution.digest).toBe(skill.artifact.digest);
    expect(resolution.members).toHaveLength(1);

    const packPublish = await request(handler, origin, '/v1/packs', {
      method: 'POST',
      headers: userHeaders,
      json: {
        name: '@acme/hello-pack',
        version: '1.0.0',
        description: 'A pinned end-to-end pack',
        skills: [{ ref: '@acme/hello-world', version: '1.0.0' }],
      },
    });
    expect(packPublish.status).toBe(201);
    const pack = (await jsonResponse<{ pack: PackVersion }>(packPublish)).pack;
    expect(pack.state).toBe('approved');
    expect(pack.members).toEqual([
      {
        resourceId: skill.id,
        name: skill.name,
        version: skill.version,
        digest: skill.artifact.digest,
      },
    ]);

    const packResolutionResponse = await request(handler, origin, '/v1/resolve', {
      method: 'POST',
      headers: userHeaders,
      json: { kind: 'pack', ref: '@acme/hello-pack', version: '1.0.0' },
    });
    expect(packResolutionResponse.status).toBe(200);
    const packResolution = (await jsonResponse<{ resolution: Resolution }>(packResolutionResponse)).resolution;
    expect(packResolution.kind).toBe('pack');
    expect(packResolution.members).toHaveLength(1);
    expect(packResolution.members[0]?.artifact.digest).toBe(skill.artifact.digest);

    const authorizationResponse = await request(handler, origin, '/v1/install-authorizations', {
      method: 'POST',
      headers: userHeaders,
      json: { resolution },
    });
    expect(authorizationResponse.status).toBe(201);
    const authorization = (await jsonResponse<{ authorization: InstallAuthorization }>(authorizationResponse)).authorization;
    expect(authorization.resolution.digest).toBe(resolution.digest);

    const descriptorResponse = await request(
      handler,
      origin,
      `/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`,
      {
        method: 'POST',
        headers: userHeaders,
        json: {
          resourceId: skill.id,
          authorizationId: authorization.id,
        },
      },
    );
    expect(descriptorResponse.status).toBe(200);
    const descriptor = await jsonResponse<TransferDescriptor>(descriptorResponse);
    expect(descriptor.mode).toBe('gateway');
    expect(descriptor.digest).toBe(skill.artifact.digest);
    expect(descriptor.headers.authorization).toBeUndefined();

    const transferPath = new URL(descriptor.url).pathname;
    const transferred = await request(handler, origin, transferPath, { headers: userHeaders });
    expect(transferred.status).toBe(200);
    const bytes = new Uint8Array(await transferred.arrayBuffer());
    expect(await digestBytes(bytes)).toBe(skill.artifact.digest);
    expect([...bytes]).toEqual([...encodeBundle(bundle)]);

    const revoke = await request(handler, origin, `/v1/skills/${encodeURIComponent(skill.id)}/revoke`, {
      method: 'POST',
      headers: userHeaders,
    });
    expect(revoke.status).toBe(200);
    await expect(jsonResponse<{ skill: SkillVersion }>(revoke)).resolves.toMatchObject({
      skill: { id: skill.id, state: 'revoked' },
    });

    const revokedPack = await request(handler, origin, `/v1/packs/${encodeURIComponent(pack.id)}`, {
      headers: userHeaders,
    });
    expect(revokedPack.status).toBe(200);
    await expect(jsonResponse<{ pack: PackVersion }>(revokedPack)).resolves.toMatchObject({
      pack: { id: pack.id, state: 'revoked' },
    });

    // Authorization and its opaque transfer grant are both rechecked against
    // current resource state. Revocation therefore fences previously issued
    // capabilities instead of merely hiding the catalog entry.
    const validateAfterRevoke = await request(
      handler,
      origin,
      `/v1/install-authorizations/${encodeURIComponent(authorization.id)}/validate`,
      { method: 'POST', headers: userHeaders },
    );
    expect(validateAfterRevoke.status).toBe(409);
    await expect(jsonResponse<JsonError>(validateAfterRevoke)).resolves.toMatchObject({
      error: { code: 'POLICY_BLOCKED' },
    });

    const transferAfterRevoke = await request(handler, origin, transferPath, { headers: userHeaders });
    expect(transferAfterRevoke.status).toBe(409);
    await expect(jsonResponse<JsonError>(transferAfterRevoke)).resolves.toMatchObject({
      error: { code: 'POLICY_BLOCKED' },
    });
  });

  it('does not approve an artifact when a required scanner returns an error', async () => {
    harness = await createLocalRegistryHarness({ policy: strictScannerPolicy });
    const { handler, origin, token, workerToken } = harness;
    const userHeaders = bearer(token);
    const workerHeaders = bearer(workerToken);
    const bundle = bundleFor('scanner-error', 'A skill whose scanner is unavailable');

    const publish = await request(handler, origin, '/v1/publish', {
      method: 'POST',
      headers: userHeaders,
      json: {
        name: '@acme/scanner-error',
        version: '1.0.0',
        bundle,
      },
    });
    expect(publish.status).toBe(202);
    const queued = (await jsonResponse<{ operation: Job }>(publish)).operation;
    const claim = await request(handler, origin, '/internal/jobs/claim', {
      method: 'POST',
      headers: workerHeaders,
    });
    const claimed = (await jsonResponse<{ job: Job }>(claim)).job;
    expect(claimed.id).toBe(queued.id);

    const failedEvidence = scannerResult(
      queued.artifact!.digest,
      queued.id,
      'cisco-skill-scanner',
      'error',
      'org-e2e',
      strictScannerPolicy.revision,
    );
    const complete = await request(handler, origin, `/internal/jobs/${encodeURIComponent(queued.id)}/complete`, {
      method: 'POST',
      headers: workerHeaders,
      json: { leaseToken: claimed.leaseToken, scanResults: [failedEvidence] },
    });
    expect(complete.status).toBe(200);
    await expect(jsonResponse<{ operation: Job }>(complete)).resolves.toMatchObject({
      operation: { state: 'completed', error: expect.stringContaining('returned error') },
    });

    const skillResponse = await request(handler, origin, `/v1/skills/${encodeURIComponent(queued.resourceId!)}`, {
      headers: userHeaders,
    });
    expect(skillResponse.status).toBe(200);
    await expect(jsonResponse<{ skill: SkillVersion }>(skillResponse)).resolves.toMatchObject({
      skill: { id: queued.resourceId, state: 'scan-error' },
    });

    const resolution = await request(handler, origin, '/v1/resolve', {
      method: 'POST',
      headers: userHeaders,
      json: { kind: 'skill', ref: '@acme/scanner-error', version: '1.0.0' },
    });
    expect(resolution.status).toBe(404);
    await expect(jsonResponse<JsonError>(resolution)).resolves.toMatchObject({
      error: { code: 'NOT_AVAILABLE' },
    });
  });

  it('runs a real worker loop for disabled scanners and reports an empty queue', async () => {
    harness = await createLocalRegistryHarness();
    const { handler, origin, token, workerToken } = harness;
    const userHeaders = bearer(token);

    const inProcessFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      return handler(new Request(url, init));
    };
    const runner = new WorkerRunner({
      baseUrl: origin,
      workerToken,
      workerId: 'e2e-runner',
      fetch: inProcessFetch,
      // The development policy has every scanner disabled. Disabled engines
      // are policy state rather than evidence, and the registry approves only
      // because allowUnscanned is explicit.
      adapters: [],
      allowUtf8BundleContent: false,
    });

    const idle = await runner.runOnce();
    expect(idle).toMatchObject({ claimed: false });

    const publish = await request(handler, origin, '/v1/publish', {
      method: 'POST',
      headers: userHeaders,
      json: {
        name: '@acme/worker-loop',
        version: '1.0.0',
        bundle: bundleFor('worker-loop', 'Processed by the real worker loop'),
      },
    });
    expect(publish.status).toBe(202);
    const queued = (await jsonResponse<{ operation: Job }>(publish)).operation;

    const result = await runner.runOnce();
    expect(result.claimed).toBe(true);
    expect(result.jobId).toBe(queued.id);
    expect(result.allow).toBe(true);
    // Disabled scanners produce no evidence; approval follows the explicit development policy.
    expect(result.scannerResults).toEqual([]);

    const skillResponse = await request(handler, origin, `/v1/skills/${encodeURIComponent(queued.resourceId!)}`, {
      headers: userHeaders,
    });
    expect(skillResponse.status).toBe(200);
    await expect(jsonResponse<{ skill: SkillVersion }>(skillResponse)).resolves.toMatchObject({
      skill: { id: queued.resourceId, state: 'approved' },
    });

    const idleAfterCompletion = await runner.runOnce();
    expect(idleAfterCompletion).toMatchObject({ claimed: false });
  });
});
