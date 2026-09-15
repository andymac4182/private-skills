import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthFn } from 'eve/channels/auth';
import { builderAuth } from '../../../apps/skill-builder/agent/channels/eve.js';
import {
  authorizeBuilderRequest,
  builderBindingMatches,
  parseSessionRequest,
} from '../../../apps/skill-builder/agent/channels/builder.js';
import { uploadReviewAuth } from '../../../apps/upload-reviewer/agent/channels/eve.js';
import { reviewerAuth } from '../../../apps/reviewer/agent/channels/eve.js';
import {
  EVE_TENANT_ID_HEADER,
  EVE_TENANT_SERVICE_HEADER,
  issueEveTenantDelegation,
  type EveTenantDelegationBinding,
  type EveTenantService,
} from '../src/index.js';

const ISSUER = 'https://registry.example';
const SECRET = 's'.repeat(32);
const SERVICE_IDENTITY = 'registry-bff';

interface EntrypointCase {
  readonly name: string;
  readonly auth: AuthFn<Request>;
  readonly service: EveTenantService;
  readonly staticTokenEnv: string;
  readonly jobBinding?: EveTenantDelegationBinding;
}

const entrypoints: readonly EntrypointCase[] = [
  {
    name: 'skill builder',
    auth: builderAuth,
    service: 'skill-builder',
    staticTokenEnv: 'PSKILLS_BUILDER_EVE_API_TOKEN',
  },
  {
    name: 'upload reviewer',
    auth: uploadReviewAuth,
    service: 'upload-reviewer',
    staticTokenEnv: 'PSKILLS_UPLOAD_REVIEW_EVE_API_TOKEN',
    jobBinding: { jobId: 'job-a' },
  },
  {
    name: 'consolidation reviewer',
    auth: reviewerAuth,
    service: 'consolidation-reviewer',
    staticTokenEnv: 'PSKILLS_EVE_API_TOKEN',
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

async function delegation(service: EveTenantService, overrides: { tenantId?: string; now?: () => number; binding?: EveTenantDelegationBinding } = {}): Promise<string> {
  const issued = await issueEveTenantDelegation({
    issuer: ISSUER,
    secret: SECRET,
    serviceIdentity: SERVICE_IDENTITY,
    now: overrides.now,
  }, {
    tenantId: overrides.tenantId ?? 'company-a',
    service,
    ...(overrides.binding === undefined ? {} : { binding: overrides.binding }),
  });
  return issued.token;
}

function configureTenantMode(): void {
  vi.stubEnv('PSKILLS_EVE_TENANT_DELEGATION_SECRET', SECRET);
  vi.stubEnv('PSKILLS_EVE_TENANT_DELEGATION_ISSUER', ISSUER);
  vi.stubEnv('PSKILLS_EVE_TENANT_SERVICE_IDENTITY', SERVICE_IDENTITY);
}

function request(token: string, headers: Record<string, string> = {}, scheme = 'Bearer'): Request {
  return new Request('https://eve.example/eve/v1/session', {
    headers: {
      authorization: `${scheme} ${token}`,
      ...headers,
    },
  });
}

describe('tenant-aware Eve entrypoint auth', () => {
  it.each(entrypoints)('accepts a signed $name tenant claim and preserves only verified metadata', async ({ auth, service, jobBinding }) => {
    configureTenantMode();
    const token = await delegation(service, { binding: jobBinding });
    const result = await auth(request(token, {
      [EVE_TENANT_ID_HEADER]: 'company-a',
      [EVE_TENANT_SERVICE_HEADER]: service,
      ...(jobBinding?.jobId === undefined ? {} : { 'x-pskills-upload-review-job': jobBinding.jobId }),
    }));
    expect(result).toMatchObject({
      attributes: {
        tenantId: 'company-a',
        service,
        serviceIdentity: SERVICE_IDENTITY,
        ...(jobBinding?.jobId === undefined ? {} : { uploadReviewJobId: jobBinding.jobId }),
      },
      principalType: 'service',
      principalId: SERVICE_IDENTITY,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each(entrypoints)('rejects a $name token with the wrong service audience', async ({ auth, service, staticTokenEnv, jobBinding }) => {
    configureTenantMode();
    const otherService: EveTenantService = service === 'skill-builder' ? 'upload-reviewer' : 'skill-builder';
    const token = await delegation(otherService, { binding: jobBinding });
    vi.stubEnv(staticTokenEnv, token);
    await expect(auth(request(token))).resolves.toBeNull();
  });

  it.each(entrypoints)('rejects a $name request whose routing tenant header disagrees with the signed tenant', async ({ auth, service, staticTokenEnv, jobBinding }) => {
    configureTenantMode();
    const token = await delegation(service, { binding: jobBinding });
    vi.stubEnv(staticTokenEnv, token);
    await expect(auth(request(token, { [EVE_TENANT_ID_HEADER]: 'company-b' }))).resolves.toBeNull();
  });

  it('rejects an upload job header that disagrees with the signed job binding', async () => {
    configureTenantMode();
    const token = await delegation('upload-reviewer', { binding: { jobId: 'job-a' } });
    await expect(uploadReviewAuth(request(token, { 'x-pskills-upload-review-job': 'job-b' }))).resolves.toBeNull();
  });

  it('requires the custom builder start body to match the signed draft binding', async () => {
    configureTenantMode();
    const digest = `sha256:${'a'.repeat(64)}`;
    const token = await delegation('skill-builder', {
      binding: {
        registrySessionId: 'registry-session-a',
        draftId: 'draft-a',
        draftRevision: 4,
        draftDigest: digest,
      },
    });
    const authorization = await authorizeBuilderRequest(request(token));
    expect(authorization?.kind).toBe('tenant');
    if (authorization?.kind !== 'tenant') throw new Error('tenant authorization was not accepted');
    const input = parseSessionRequest({
      sessionKey: 'session-key-a',
      registrySessionId: 'registry-session-a',
      draftId: 'draft-a',
      revision: 4,
      digest,
      message: 'Improve this draft.',
      requestId: 'request-a',
      requestDigest: digest,
    });
    expect(builderBindingMatches(input, authorization.tenant.principal)).toBe(true);
    expect(builderBindingMatches({ ...input, draftId: 'draft-b' }, authorization.tenant.principal)).toBe(false);
  });

  it.each(entrypoints)('rejects an expired $name delegation instead of falling through to static auth', async ({ auth, service, staticTokenEnv, jobBinding }) => {
    configureTenantMode();
    const token = await delegation(service, {
      now: () => Date.now() - 5 * 60 * 1000,
      binding: jobBinding,
    });
    vi.stubEnv(staticTokenEnv, token);
    await expect(auth(request(token))).resolves.toBeNull();
  });

  it.each(entrypoints)('keeps the legacy $name static path when tenant delegation secret is missing', async ({ auth, staticTokenEnv, jobBinding }) => {
    vi.stubEnv('PSKILLS_EVE_TENANT_DELEGATION_SECRET', '');
    vi.stubEnv('PSKILLS_EVE_TENANT_DELEGATION_ISSUER', '');
    vi.stubEnv('PSKILLS_EVE_TENANT_SERVICE_IDENTITY', '');
    vi.stubEnv(staticTokenEnv, 'legacy-static-token');
    const headers: Record<string, string> = {};
    if (jobBinding?.jobId !== undefined) headers['x-pskills-upload-review-job'] = jobBinding.jobId;
    const result = await auth(request('legacy-static-token', headers));
    expect(result).toMatchObject({
      attributes: {
        service: expect.any(String),
        ...(jobBinding?.jobId === undefined ? {} : { uploadReviewJobId: jobBinding.jobId }),
      },
      principalType: 'service',
    });
  });

  it.each(entrypoints)('does not accept a tenant $name token when delegation secret is missing', async ({ auth, staticTokenEnv, service, jobBinding }) => {
    vi.stubEnv('PSKILLS_EVE_TENANT_DELEGATION_SECRET', '');
    vi.stubEnv('PSKILLS_EVE_TENANT_DELEGATION_ISSUER', '');
    vi.stubEnv('PSKILLS_EVE_TENANT_SERVICE_IDENTITY', '');
    vi.stubEnv(staticTokenEnv, 'legacy-static-token');
    const token = await delegation(service, { binding: jobBinding });
    await expect(auth(request(token))).resolves.toBeNull();
  });
});
