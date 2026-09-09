import {
  bearer,
  bundleFor,
  createLocalRegistryHarness,
  jsonResponse,
  request,
} from '../tests/e2e/harness.js';
import type {
  InstallAuthorization,
  Job,
  Policy,
  Resolution,
  SkillVersion,
  TransferDescriptor,
} from '../packages/contracts/src/index.js';
import { digestBytes, encodeBundle } from '../packages/storage/src/index.js';

interface HttpClient {
  request(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
}

type ErrorBody = { error?: { code?: string; message?: string } };

function assertStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
  }
}

async function assertJsonStatus<T>(
  response: Response,
  expected: number,
  label: string,
): Promise<T> {
  assertStatus(response, expected, label);
  return jsonResponse<T>(response);
}

async function localClient(): Promise<{
  client: HttpClient;
  close: () => Promise<void>;
  token: string;
  workerToken: string;
  origin: string;
}> {
  const harness = await createLocalRegistryHarness();
  return {
    client: {
      request: (path, init) => request(harness.handler, harness.origin, path, init),
    },
    close: harness.close,
    token: harness.token,
    workerToken: harness.workerToken,
    origin: harness.origin,
  };
}

function remoteClient(baseUrl: string): HttpClient {
  const base = new URL(baseUrl);
  return {
    request: async (path, init = {}) => {
      const { json, ...fetchInit } = init;
      const headers = new Headers(fetchInit.headers);
      let body = fetchInit.body;
      if (json !== undefined) {
        body = JSON.stringify(json);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      return fetch(new URL(path, base), { ...fetchInit, body, headers });
    },
  };
}

async function runProtocolSmoke(
  client: HttpClient,
  options: { token: string; workerToken: string },
): Promise<void> {
  const userHeaders = bearer(options.token);
  const workerHeaders = bearer(options.workerToken);
  const suffix = Date.now().toString(36);
  const skillName = `smoke-${suffix}`;
  const fullName = `@acme/${skillName}`;
  const bundle = bundleFor(skillName, 'Private Skills HTTP smoke test');

  const health = await client.request('/health');
  const healthBody = await assertJsonStatus<{ ok: boolean; service: string }>(health, 200, 'health');
  if (!healthBody.ok || healthBody.service !== 'private-skills') {
    throw new Error('health: response did not identify private-skills');
  }

  const me = await client.request('/v1/me', { headers: userHeaders });
  await assertJsonStatus(me, 200, 'authenticated principal');

  const policyResponse = await client.request('/v1/policy', { headers: userHeaders });
  const policy = await assertJsonStatus<{ policy: Policy }>(policyResponse, 200, 'policy');
  const developmentUnscanned =
    policy.policy.allowUnscanned && policy.policy.scanners.every((scanner) => scanner.mode === 'disabled');
  if (!developmentUnscanned) {
    throw new Error(
      'smoke mutation flow requires an explicitly configured development policy with allowUnscanned=true and all scanners disabled',
    );
  }

  const publish = await client.request('/v1/publish', {
    method: 'POST',
    headers: userHeaders,
    json: { name: fullName, version: '1.0.0', bundle },
  });
  const queued = (await assertJsonStatus<{ operation: Job }>(publish, 202, 'publish')).operation;
  if (!queued.resourceId || !queued.artifact?.digest) throw new Error('publish: response omitted job resource');

  const claim = await client.request('/internal/jobs/claim', {
    method: 'POST',
    headers: workerHeaders,
  });
  const claimed = (await assertJsonStatus<{ job: Job }>(claim, 200, 'worker claim')).job;
  if (claimed.id !== queued.id || !claimed.leaseToken) throw new Error('worker claim: wrong job or lease');

  const complete = await client.request(`/internal/jobs/${encodeURIComponent(queued.id)}/complete`, {
    method: 'POST',
    headers: workerHeaders,
    json: { leaseToken: claimed.leaseToken },
  });
  const completed = (await assertJsonStatus<{ operation: Job }>(complete, 200, 'worker completion')).operation;
  if (completed.state !== 'completed') throw new Error(`worker completion: state was ${completed.state}`);

  const skillResponse = await client.request(`/v1/skills/${encodeURIComponent(queued.resourceId)}`, {
    headers: userHeaders,
  });
  const skill = (await assertJsonStatus<{ skill: SkillVersion }>(skillResponse, 200, 'skill')).skill;
  if (skill.state !== 'approved') throw new Error(`skill: expected approved, received ${skill.state}`);

  const resolvedResponse = await client.request('/v1/resolve', {
    method: 'POST',
    headers: userHeaders,
    json: { kind: 'skill', ref: fullName, version: '1.0.0' },
  });
  const resolution = (await assertJsonStatus<{ resolution: Resolution }>(resolvedResponse, 200, 'resolve')).resolution;

  const authorizationResponse = await client.request('/v1/install-authorizations', {
    method: 'POST',
    headers: userHeaders,
    json: { resolution },
  });
  const authorization = (
    await assertJsonStatus<{ authorization: InstallAuthorization }>(
      authorizationResponse,
      201,
      'install authorization',
    )
  ).authorization;

  const descriptorResponse = await client.request(
    `/v1/artifacts/${encodeURIComponent(skill.artifact.digest)}/download`,
    {
      method: 'POST',
      headers: userHeaders,
      json: { resourceId: skill.id, authorizationId: authorization.id },
    },
  );
  const descriptor = await assertJsonStatus<TransferDescriptor>(descriptorResponse, 200, 'download grant');
  const transferPath = new URL(descriptor.url).pathname;
  const transferResponse = await client.request(transferPath);
  assertStatus(transferResponse, 200, 'artifact transfer');
  const bytes = new Uint8Array(await transferResponse.arrayBuffer());
  if (await digestBytes(bytes) !== skill.artifact.digest) throw new Error('artifact transfer: digest mismatch');
  if (bytes.length !== encodeBundle(bundle).length) throw new Error('artifact transfer: size mismatch');

  const revokeResponse = await client.request(`/v1/skills/${encodeURIComponent(skill.id)}/revoke`, {
    method: 'POST',
    headers: userHeaders,
  });
  const revoked = (await assertJsonStatus<{ skill: SkillVersion }>(revokeResponse, 200, 'revoke')).skill;
  if (revoked.state !== 'revoked') throw new Error('revoke: resource did not enter revoked state');

  const afterRevoke = await client.request(transferPath);
  assertStatus(afterRevoke, 409, 'revoked transfer');
  const afterRevokeBody = await jsonResponse<ErrorBody>(afterRevoke);
  if (afterRevokeBody.error?.code !== 'POLICY_BLOCKED') {
    throw new Error(`revoked transfer: expected POLICY_BLOCKED, received ${afterRevokeBody.error?.code ?? 'unknown'}`);
  }

  console.log(`smoke ok: ${fullName} ${skill.artifact.digest}`);
}

async function main(): Promise<void> {
  const baseUrl = process.env.PSKILLS_E2E_BASE_URL;
  if (baseUrl) {
    const token = process.env.PSKILLS_E2E_TOKEN;
    const workerToken = process.env.PSKILLS_E2E_WORKER_TOKEN;
    if (!token || !workerToken) {
      throw new Error('PSKILLS_E2E_BASE_URL requires PSKILLS_E2E_TOKEN and PSKILLS_E2E_WORKER_TOKEN');
    }
    await runProtocolSmoke(remoteClient(baseUrl), { token, workerToken });
    return;
  }

  const local = await localClient();
  try {
    await runProtocolSmoke(local.client, {
      token: local.token,
      workerToken: local.workerToken,
    });
  } finally {
    await local.close();
  }
}

main().catch((error: unknown) => {
  console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
