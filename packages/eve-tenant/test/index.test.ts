import { describe, expect, it } from 'vitest';

import {
  EVE_TENANT_DELEGATION_SECRET_ENV,
  bindEveTenantService,
  createEveTenantCredentialProvider,
  credentialAuthorization,
  eveTenantDelegationIssuerOptionsFromEnv,
  issueEveTenantDelegation,
  requireEveTenantCaller,
  sessionAuthFromEveTenantPrincipal,
  verifyEveTenantDelegation,
  type EveTenantDelegationIssuerOptions,
  type EveTenantCredential,
} from '../src/index.js';

const SECRET = 'eve-tenant-delegation-secret-0123456789abcdef';
const ISSUER = 'https://registry.example.test';
const NOW = 2_000_000_000_000;

const issuer: EveTenantDelegationIssuerOptions = {
  issuer: ISSUER,
  secret: SECRET,
  serviceIdentity: 'private-skills-registry-bff',
  now: () => NOW,
};

describe('tenant-aware Eve delegation', () => {
  it('issues and verifies a tenant/service credential with an exact draft binding', async () => {
    const issued = await issueEveTenantDelegation(issuer, {
      tenantId: 'company-a',
      service: 'skill-builder',
      binding: {
        registrySessionId: 'registry-session-a',
        draftId: 'draft-a',
        draftRevision: 4,
        draftDigest: `sha256:${'a'.repeat(64)}`,
      },
    });

    await expect(verifyEveTenantDelegation(issued.token, {
      ...issuer,
      expectedServiceIdentity: 'private-skills-registry-bff',
    }, {
      service: 'skill-builder',
      tenantId: 'company-a',
      binding: {
        registrySessionId: 'registry-session-a',
        draftId: 'draft-a',
        draftRevision: 4,
        draftDigest: `sha256:${'a'.repeat(64)}`,
      },
    })).resolves.toMatchObject({
      iss: ISSUER,
      aud: 'skill-builder',
      tenantId: 'company-a',
      serviceIdentity: 'private-skills-registry-bff',
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 60,
    });
  });

  it('rejects wrong service, tenant, issuer, secret, and draft binding', async () => {
    const issued = await issueEveTenantDelegation(issuer, {
      tenantId: 'company-a',
      service: 'upload-reviewer',
      binding: { jobId: 'job-a', sessionId: 'eve-session-a' },
    });
    const verifier = { ...issuer, expectedServiceIdentity: 'private-skills-registry-bff' };
    const binding = { jobId: 'job-a', sessionId: 'eve-session-a' };

    await expect(verifyEveTenantDelegation(issued.token, verifier, {
      service: 'skill-builder', tenantId: 'company-a', binding,
    })).rejects.toThrow('service audience');
    await expect(verifyEveTenantDelegation(issued.token, verifier, {
      service: 'upload-reviewer', tenantId: 'company-b', binding,
    })).rejects.toThrow('tenant binding');
    await expect(verifyEveTenantDelegation(issued.token, {
      ...verifier, issuer: 'https://other-registry.example.test',
    }, { service: 'upload-reviewer', tenantId: 'company-a', binding })).rejects.toThrow('issuer');
    await expect(verifyEveTenantDelegation(issued.token, {
      ...verifier, secret: 'another-eve-tenant-secret-0123456789abcdef',
    }, { service: 'upload-reviewer', tenantId: 'company-a', binding })).rejects.toThrow('signature');
    await expect(verifyEveTenantDelegation(issued.token, verifier, {
      service: 'upload-reviewer', tenantId: 'company-a', binding: { jobId: 'job-b' },
    })).rejects.toThrow('jobId binding');
  });

  it('pins a provider to one company and never accepts a caller-selected company', async () => {
    const provider = createEveTenantCredentialProvider({
      ...issuer,
      tenantId: 'company-a',
      service: 'consolidation-reviewer',
    });
    const credential = await provider.resolve({
      tenantId: 'company-a',
      service: 'consolidation-reviewer',
      binding: { runId: 'run-a', sessionId: 'eve-session-a' },
    });
    expect(credential.tenantId).toBe('company-a');
    expect(credential.service).toBe('consolidation-reviewer');
    expect(credentialAuthorization(credential)).toMatch(/^Bearer\s+ey/iu);
    await expect(provider.resolve({
      tenantId: 'company-b',
      service: 'consolidation-reviewer',
    })).rejects.toThrow('does not match the provider');
    await expect(provider.resolve({
      tenantId: 'company-a',
      service: 'skill-builder',
    })).rejects.toThrow('service does not match');
  });

  it('binds a broker provider before headers and rejects a broker cross-tenant response', async () => {
    const calls: Array<{ tenantId: string; service: string }> = [];
    const provider = bindEveTenantService({
      async resolve(request) {
        calls.push({ tenantId: request.tenantId, service: request.service });
        return {
          token: 'tenant-token-a',
          tenantId: 'company-a',
          service: 'upload-reviewer',
          serviceIdentity: 'registry-bff',
          expiresAt: Date.now() + 10_000,
        } satisfies EveTenantCredential;
      },
    }, { tenantId: 'company-a', service: 'upload-reviewer' });

    const headers = await provider.headers({ 'x-existing': 'keep' }, { jobId: 'job-a' });
    expect(headers.get('authorization')).toBe('Bearer tenant-token-a');
    expect(headers.get('x-pskills-tenant-id')).toBe('company-a');
    expect(headers.get('x-pskills-eve-service')).toBe('upload-reviewer');
    expect(calls).toEqual([{ tenantId: 'company-a', service: 'upload-reviewer' }]);

    const foreignProvider = bindEveTenantService({
      async resolve() {
        return {
          token: 'tenant-token-b',
          tenantId: 'company-b',
          service: 'upload-reviewer',
          serviceIdentity: 'registry-bff',
          expiresAt: Date.now() + 10_000,
        } satisfies EveTenantCredential;
      },
    }, { tenantId: 'company-a', service: 'upload-reviewer' });
    await expect(foreignProvider.credential()).rejects.toThrow('does not match the bound tenant');
  });

  it('exposes only sanitized tenant attributes to Eve auth and reads the active caller', () => {
    const auth = sessionAuthFromEveTenantPrincipal({
      claims: {
        v: 1,
        iss: ISSUER,
        aud: 'skill-builder',
        tenantId: 'company-a',
        serviceIdentity: 'registry-bff',
        iat: Math.floor(NOW / 1000),
        exp: Math.floor(NOW / 1000) + 60,
        jti: 'delegation-a',
        binding: { draftId: 'draft-a', draftRevision: 1, draftDigest: `sha256:${'b'.repeat(64)}` },
      },
    });
    expect(auth.attributes).toEqual({
      tenantId: 'company-a',
      service: 'skill-builder',
      serviceIdentity: 'registry-bff',
      delegationId: 'delegation-a',
      delegationDraftId: 'draft-a',
      delegationDraftRevision: '1',
      delegationDraftDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(JSON.stringify(auth)).not.toContain(SECRET);
    expect(requireEveTenantCaller({ session: { auth: { current: auth } } }, 'skill-builder')).toMatchObject({
      tenantId: 'company-a',
      service: 'skill-builder',
      binding: {
        draftId: 'draft-a',
        draftRevision: 1,
        draftDigest: `sha256:${'b'.repeat(64)}`,
      },
    });
  });

  it('fails closed when only the initiator has a tenant or when env delegation is incomplete', () => {
    const current = {
      attributes: { tenantId: 'company-a', service: 'skill-builder' },
      principalType: 'service',
      principalId: 'registry-bff',
    };
    expect(() => requireEveTenantCaller({
      session: {
        auth: {
          current: null,
          initiator: current,
        } as never,
      },
    } as never, 'skill-builder')).toThrow('tenant Eve service caller');
    expect(eveTenantDelegationIssuerOptionsFromEnv({}, {
      issuer: ISSUER,
      serviceIdentity: 'registry-bff',
    })).toBeUndefined();
    expect(eveTenantDelegationIssuerOptionsFromEnv({
      [EVE_TENANT_DELEGATION_SECRET_ENV]: SECRET,
    }, {
      issuer: ISSUER,
      serviceIdentity: 'registry-bff',
    })).toMatchObject({ issuer: ISSUER, serviceIdentity: 'registry-bff', secret: SECRET });
    expect(() => eveTenantDelegationIssuerOptionsFromEnv({
      [EVE_TENANT_DELEGATION_SECRET_ENV]: 'short',
    }, { issuer: ISSUER, serviceIdentity: 'registry-bff' })).toThrow('32-1024 bytes');
  });
});
