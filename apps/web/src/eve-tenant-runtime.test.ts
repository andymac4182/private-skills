import { describe, expect, it } from 'vitest';

import {
  EVE_TENANT_DELEGATION_SECRET_ENV,
  EVE_TENANT_ID_HEADER,
  EVE_TENANT_SERVICE_HEADER,
} from '../../../packages/eve-tenant/src/index.js';
import { createEveTenantHostRuntime } from '../server/eve-tenant-runtime.js';

const SECRET = 'eve-tenant-host-runtime-secret-0123456789';
const ISSUER = 'https://registry.example.test';
const SERVICE_IDENTITY = 'registry-host-runtime';

describe('Eve tenant host runtime', () => {
  it('mints and verifies credentials independently for all three services', async () => {
    const runtime = createEveTenantHostRuntime({
      [EVE_TENANT_DELEGATION_SECRET_ENV]: SECRET,
      PSKILLS_EVE_TENANT_DELEGATION_ISSUER: ISSUER,
      PSKILLS_EVE_TENANT_SERVICE_IDENTITY: SERVICE_IDENTITY,
    }, ISSUER);
    expect(runtime).toBeDefined();

    for (const service of ['upload-reviewer', 'skill-builder', 'consolidation-reviewer'] as const) {
      const binding = service === 'upload-reviewer'
        ? { sessionId: 'eve-session', jobId: 'upload-job' }
        : service === 'skill-builder'
          ? {
            registrySessionId: 'registry-session',
            draftId: 'draft-a',
            draftRevision: 3,
            draftDigest: `sha256:${'a'.repeat(64)}`,
          }
          : { sessionId: 'eve-session', runId: 'review-run' };
      const headers = await runtime!.providerFor('company-a', service).headers({ 'content-type': 'application/json' }, binding);
      expect(headers.get(EVE_TENANT_ID_HEADER)).toBe('company-a');
      expect(headers.get(EVE_TENANT_SERVICE_HEADER)).toBe(service);

      const request = new Request(`${ISSUER}/callback`, { headers });
      await expect(runtime!.verify(request, service, { tenantId: 'company-a', binding })).resolves.toMatchObject({
        tenantId: 'company-a',
        aud: service,
        serviceIdentity: SERVICE_IDENTITY,
        binding,
      });
      await expect(runtime!.verify(request, service, { tenantId: 'company-b', binding })).resolves.toBeNull();
      const principal = await runtime!.authenticatePrincipal(request, service, { tenantId: 'company-a', binding });
      expect(principal).toMatchObject({ organizationId: 'company-a', authMethod: 'eve-tenant', eveTenant: { service } });
    }
  });

  it('rejects routing metadata and incomplete opt-in configuration', async () => {
    const runtime = createEveTenantHostRuntime({
      [EVE_TENANT_DELEGATION_SECRET_ENV]: SECRET,
      PSKILLS_EVE_TENANT_DELEGATION_ISSUER: ISSUER,
      PSKILLS_EVE_TENANT_SERVICE_IDENTITY: SERVICE_IDENTITY,
    }, ISSUER)!;
    const service = runtime.providerFor('company-a', 'skill-builder');
    const headers = await service.headers(undefined, {
      registrySessionId: 'registry-session',
      draftId: 'draft-a',
      draftRevision: 1,
      draftDigest: `sha256:${'b'.repeat(64)}`,
    });
    headers.set(EVE_TENANT_ID_HEADER, 'company-b');
    await expect(runtime.verify(new Request(`${ISSUER}/callback`, { headers }), 'skill-builder')).resolves.toBeNull();

    expect(createEveTenantHostRuntime({}, ISSUER)).toBeUndefined();
    expect(() => createEveTenantHostRuntime({
      [EVE_TENANT_DELEGATION_SECRET_ENV]: SECRET,
      PSKILLS_EVE_TENANT_DELEGATION_ISSUER: ISSUER,
    }, ISSUER)).toThrow('SERVICE_IDENTITY');
  });
});
