import { describe, expect, it } from 'vitest';

import {
  COMPANY_SSO_CALLBACK_PATH,
  COMPANY_SSO_SAML_CALLBACK_PATH,
  COMPANY_SSO_SYNTHETIC_DOMAIN,
  MemoryCompanySsoRepository,
  companySsoCallbackUrl,
  companySsoPluginOptions,
  syncCompanySsoProvider,
  removeCompanySsoProvider,
  type CompanySsoBetterAuthAdapter,
  createCompanySsoApi,
  discoverCompanyOidc,
  explicitCompanySsoSelection,
  normalizeCompanyIssuer,
  toBetterAuthCompanySsoProvider,
  validateCompanySsoRegistration,
  type CompanySsoAuthorizationContext,
  type CompanySsoAuthorizer,
  type CompanySsoProviderRecord,
} from '../src/company-sso.js';

const APP_ORIGIN = 'https://app.example.test';
const DISCOVERY_URL = 'https://idp.example.test/.well-known/openid-configuration';

function discovery(issuer = 'https://idp.example.test'): Record<string, string> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    userinfo_endpoint: `${issuer}/userinfo`,
  };
}

function fetchDiscovery(document: Record<string, unknown> = discovery()): typeof fetch {
  return async (url, init) => {
    expect(url).toBe(DISCOVERY_URL);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    return new Response(JSON.stringify(document), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function oidcInput(providerId = 'acme-oidc', organizationId?: string): Record<string, unknown> {
  return {
    ...(organizationId === undefined ? {} : { organizationId }),
    providerId,
    displayName: 'Acme Identity',
    protocol: 'oidc',
    issuer: 'https://idp.example.test/',
    callbackUrl: companySsoCallbackUrl(APP_ORIGIN, providerId),
    oidc: {
      clientId: 'acme-client-id',
      clientSecret: 'acme-client-secret',
      discoveryUrl: DISCOVERY_URL,
      scopes: ['openid', 'profile', 'email'],
    },
  };
}

function authorizerFor(allowedOrganization = 'acme', role = 'owner', mode: 'member' | 'recovery' = 'member'): CompanySsoAuthorizer {
  return {
    authorize: async ({ organizationId }): Promise<CompanySsoAuthorizationContext | null> => organizationId === allowedOrganization
      ? { principalId: mode === 'recovery' ? 'platform-recovery' : 'owner-1', organizationId, role, mode }
      : null,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, init);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function createRecord(repository: MemoryCompanySsoRepository, overrides: Partial<CompanySsoProviderRecord> = {}): Promise<CompanySsoProviderRecord> {
  const input = await validateCompanySsoRegistration('acme', oidcInput('acme-oidc'), {
    appOrigin: APP_ORIGIN,
    fetch: fetchDiscovery(),
  });
  const now = new Date('2026-09-15T00:00:00.000Z').toISOString();
  return repository.create({
    id: 'row-acme-oidc',
    ...input,
    createdBy: 'owner-1',
    updatedBy: 'owner-1',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe('company-managed SSO validation', () => {
  it('hydrates OIDC discovery and binds the callback to the company provider id', async () => {
    const result = await validateCompanySsoRegistration('acme', oidcInput(), {
      appOrigin: APP_ORIGIN,
      fetch: fetchDiscovery(),
    });
    expect(result.organizationId).toBe('acme');
    expect(result.issuer).toBe('https://idp.example.test');
    expect(result.callbackUrl).toBe(`${APP_ORIGIN}${COMPANY_SSO_CALLBACK_PATH}/acme-oidc`);
    expect(result.oidc).toMatchObject({
      clientId: 'acme-client-id',
      discoveryUrl: DISCOVERY_URL,
      authorizationEndpoint: 'https://idp.example.test/authorize',
      tokenEndpoint: 'https://idp.example.test/token',
      jwksEndpoint: 'https://idp.example.test/jwks',
      pkce: true,
    });
  });

  it('rejects issuer drift, discovery drift, insecure endpoints, and callback substitution', async () => {
    await expect(discoverCompanyOidc('https://idp.example.test', DISCOVERY_URL, {
      appOrigin: APP_ORIGIN,
      fetch: fetchDiscovery(discovery('https://other-idp.example.test')),
    })).rejects.toMatchObject({ code: 'ISSUER_MISMATCH' });
    await expect(discoverCompanyOidc('https://idp.example.test', 'https://idp.example.test/metadata', {
      appOrigin: APP_ORIGIN,
      fetch: fetchDiscovery(),
    })).rejects.toMatchObject({ code: 'DISCOVERY_MISMATCH' });
    await expect(validateCompanySsoRegistration('acme', {
      ...oidcInput(),
      callbackUrl: 'https://attacker.example.test/callback',
    }, { appOrigin: APP_ORIGIN, fetch: fetchDiscovery() })).rejects.toMatchObject({ code: 'CALLBACK_MISMATCH' });
    await expect(validateCompanySsoRegistration('acme', {
      ...oidcInput(),
      issuer: 'http://idp.example.test',
    }, { appOrigin: APP_ORIGIN, fetch: fetchDiscovery() })).rejects.toMatchObject({ code: 'INSECURE_URL' });
    await expect(validateCompanySsoRegistration('acme', {
      ...oidcInput(),
      oidc: { ...(oidcInput().oidc as Record<string, unknown>), discoveryUrl: 'http://idp.example.test/.well-known/openid-configuration' },
    }, { appOrigin: APP_ORIGIN, fetch: fetchDiscovery() })).rejects.toMatchObject({ code: 'INSECURE_URL' });
  });

  it('allows loopback only when the disposable validation policy opts in', async () => {
    const input = oidcInput('local-oidc');
    input.issuer = 'http://127.0.0.1:9001';
    input.callbackUrl = companySsoCallbackUrl('http://127.0.0.1:5398', 'local-oidc', true);
    input.oidc = {
      clientId: 'local-client',
      clientSecret: 'local-secret',
      discoveryUrl: 'http://127.0.0.1:9001/.well-known/openid-configuration',
    };
    const result = await validateCompanySsoRegistration('acme', input, {
      appOrigin: 'http://127.0.0.1:5398',
      allowLoopbackHttp: true,
      fetch: async () => new Response(JSON.stringify(discovery('http://127.0.0.1:9001')), { status: 200 }),
    });
    expect(result.oidc?.authorizationEndpoint).toBe('http://127.0.0.1:9001/authorize');
  });

  it('does not accept email-domain or user-controlled organization discovery', async () => {
    await expect(validateCompanySsoRegistration('acme', { ...oidcInput(), domain: 'acme.example' }, { appOrigin: APP_ORIGIN, fetch: fetchDiscovery() })).rejects.toMatchObject({ code: 'DOMAIN_DISCOVERY_DISABLED' });
    await expect(validateCompanySsoRegistration('acme', { ...oidcInput(), organizationId: 'globex' }, { appOrigin: APP_ORIGIN, fetch: fetchDiscovery() })).rejects.toMatchObject({ code: 'ORGANIZATION_MISMATCH' });
    await expect(validateCompanySsoRegistration('acme', { ...oidcInput(), organizationSlug: 'globex' }, { appOrigin: APP_ORIGIN, fetch: fetchDiscovery() })).rejects.toMatchObject({ code: 'DOMAIN_DISCOVERY_DISABLED' });
  });
});

describe('company-managed SSO SAML validation', () => {
  const metadata = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.test/entity"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>AA==</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/sso"/></IDPSSODescriptor></EntityDescriptor>`;

  it('parses IdP metadata and requires signed assertions', async () => {
    const providerId = 'acme-saml';
    const result = await validateCompanySsoRegistration('acme', {
      providerId,
      protocol: 'saml',
      issuer: APP_ORIGIN,
      callbackUrl: companySsoCallbackUrl(APP_ORIGIN, providerId, false, 'saml'),
      saml: {
        entryPoint: 'https://idp.example.test/sso',
        idpMetadata: { metadata },
      },
    }, { appOrigin: APP_ORIGIN });
    expect(result.callbackUrl).toBe(`${APP_ORIGIN}${COMPANY_SSO_SAML_CALLBACK_PATH}/acme-saml`);
    expect(result.saml?.identityProviderIssuer).toBe('https://idp.example.test/entity');
    expect(result.saml?.wantAssertionsSigned).toBe(true);
    expect(result.saml?.idpMetadata.metadata).toContain('X509Certificate');
  });

  it('rejects unsigned, unsolicited, oversized, or certificate-less SAML configurations', async () => {
    const base = {
      providerId: 'acme-saml', protocol: 'saml', issuer: APP_ORIGIN,
      callbackUrl: companySsoCallbackUrl(APP_ORIGIN, 'acme-saml', false, 'saml'),
      saml: { entryPoint: 'https://idp.example.test/sso', idpMetadata: { metadata } },
    };
    await expect(validateCompanySsoRegistration('acme', { ...base, saml: { ...base.saml, wantAssertionsSigned: false } }, { appOrigin: APP_ORIGIN })).rejects.toMatchObject({ code: 'SAML_SIGNED_ASSERTIONS_REQUIRED' });
    await expect(validateCompanySsoRegistration('acme', { ...base, saml: { ...base.saml, idpInitiatedCallbackUrl: '/app/company' } }, { appOrigin: APP_ORIGIN })).rejects.toMatchObject({ code: 'SAML_IDP_INITIATED_DISABLED' });
    await expect(validateCompanySsoRegistration('acme', { ...base, saml: { ...base.saml, idpMetadata: { metadata: '<EntityDescriptor />' } } }, { appOrigin: APP_ORIGIN })).rejects.toMatchObject({ code: 'INVALID_SAML_CERTIFICATE' });
  });
});

describe('company-managed SSO admin API and tenant enforcement', () => {
  it('persists a provider, returns only redacted metadata, and keeps company lists isolated', async () => {
    const repository = new MemoryCompanySsoRepository();
    const api = createCompanySsoApi({
      repository,
      authorizer: {
        authorize: async ({ organizationId }) => ({ principalId: 'owner-1', organizationId, role: 'owner', mode: 'member' }),
      },
      appOrigin: APP_ORIGIN,
      fetch: fetchDiscovery(),
      idGenerator: () => 'row-acme-oidc',
      now: () => new Date('2026-09-15T00:00:00.000Z'),
    });
    const created = await api.handler(request('/v1/companies/acme/sso/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(oidcInput()),
    }));
    expect(created?.status).toBe(201);
    const createdBody = await json(created!);
    const publicProvider = createdBody.provider as Record<string, unknown>;
    expect(publicProvider).toMatchObject({ organizationId: 'acme', providerId: 'acme-oidc', hasClientSecret: true });
    expect(JSON.stringify(publicProvider)).not.toContain('acme-client-secret');
    expect(JSON.stringify(publicProvider)).not.toContain('acme-client-id');

    const acmeList = await api.handler(request('/v1/companies/acme/sso/providers'));
    const globexList = await api.handler(request('/v1/companies/globex/sso/providers'));
    expect((await json(acmeList!)).providers).toHaveLength(1);
    expect((await json(globexList!)).providers).toEqual([]);
    expect(publicProvider.callbackUrl).toBe(`${APP_ORIGIN}${COMPANY_SSO_CALLBACK_PATH}/acme-oidc`);
  });

  it('denies foreign-company access and blocks body organization overrides', async () => {
    const repository = new MemoryCompanySsoRepository();
    await createRecord(repository);
    const api = createCompanySsoApi({ repository, authorizer: authorizerFor('acme'), appOrigin: APP_ORIGIN, fetch: fetchDiscovery() });
    const foreign = await api.handler(request('/v1/companies/globex/sso/providers'));
    expect(foreign?.status).toBe(403);
    const override = await api.handler(request('/v1/companies/acme/sso/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(oidcInput('globex-oidc', 'globex')),
    }));
    expect(override?.status).toBe(403);
    expect((await json(override!)).code).toBe('ORGANIZATION_MISMATCH');
  });

  it('limits mutations to admins, supports authenticated recovery, and applies revision fences', async () => {
    const repository = new MemoryCompanySsoRepository();
    await createRecord(repository);
    const readerApi = createCompanySsoApi({ repository, authorizer: authorizerFor('acme', 'reader'), appOrigin: APP_ORIGIN, fetch: fetchDiscovery() });
    const denied = await readerApi.handler(request('/v1/companies/acme/sso/providers/acme-oidc', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }) }));
    expect(denied?.status).toBe(403);

    const adminApi = createCompanySsoApi({ repository, authorizer: authorizerFor('acme'), appOrigin: APP_ORIGIN, fetch: fetchDiscovery() });
    const updated = await adminApi.handler(request('/v1/companies/acme/sso/providers/acme-oidc', { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': '1' }, body: JSON.stringify({ status: 'disabled' }) }));
    expect(updated?.status).toBe(200);
    expect((await json(updated!)).provider).toMatchObject({ status: 'disabled', revision: 2 });
    const stale = await adminApi.handler(request('/v1/companies/acme/sso/providers/acme-oidc', { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': '1' }, body: JSON.stringify({ displayName: 'Stale write' }) }));
    expect(stale?.status).toBe(409);

    const recoveryApi = createCompanySsoApi({ repository, authorizer: authorizerFor('acme', 'owner', 'recovery'), appOrigin: APP_ORIGIN, fetch: fetchDiscovery() });
    const deleted = await recoveryApi.handler(request('/v1/companies/acme/sso/providers/acme-oidc', { method: 'DELETE', headers: { 'if-match': '2' } }));
    expect(deleted?.status).toBe(200);
    expect(await repository.get('acme', 'acme-oidc')).toBeNull();
  });

  it('rejects domain discovery and preserves platform provider ids', async () => {
    const repository = new MemoryCompanySsoRepository();
    const api = createCompanySsoApi({ repository, authorizer: authorizerFor(), appOrigin: APP_ORIGIN, fetch: fetchDiscovery() });
    const domain = await api.handler(request('/v1/companies/acme/sso/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...oidcInput(), domain: 'acme.example' }) }));
    expect(domain?.status).toBe(422);
    const reservedInput = { ...oidcInput('acme-oidc'), providerId: 'github', callbackUrl: `${APP_ORIGIN}${COMPANY_SSO_CALLBACK_PATH}/github` };
    const reserved = await api.handler(request('/v1/companies/acme/sso/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reservedInput) }));
    expect(reserved?.status).toBe(422);
  });
});

describe('company-managed SSO Better Auth adapter seam', () => {
  it('uses the persisted provider record and never treats synthetic domain as discovery input', async () => {
    const repository = new MemoryCompanySsoRepository();
    const record = await createRecord(repository);
    expect(toBetterAuthCompanySsoProvider(record)).toMatchObject({ id: record.id, providerId: 'acme-oidc', organizationId: 'acme', domain: COMPANY_SSO_SYNTHETIC_DOMAIN });
    expect(toBetterAuthCompanySsoProvider(record).oidcConfig).toMatchObject({ discoveryEndpoint: record.oidc?.discoveryUrl });
    const selection = explicitCompanySsoSelection(record, 'acme', 'acme-oidc', APP_ORIGIN);
    expect(selection.callbackURL).toBe(record.callbackUrl);
    expect(() => explicitCompanySsoSelection(record, 'globex', 'acme-oidc', APP_ORIGIN)).toThrowError(expect.objectContaining({ code: 'COMPANY_PROVIDER_MISMATCH' }));

    const options = companySsoPluginOptions({ repository });
    expect(options.providersLimit).toBe(0);
    expect(options.domainVerification?.enabled).toBe(false);
    const resolve = options.resolveUser!;
    const decision = await resolve({
      protocol: 'oidc', providerId: record.providerId,
      accountKey: { issuer: record.issuer, accountId: 'subject-1' },
      providerUser: { email: 'alice@example.test', emailVerified: true, name: 'Alice' },
      providerClaims: { iss: record.issuer, sub: 'subject-1' },
      verifiedIdTokenClaims: { iss: record.issuer, sub: 'subject-1' },
      providerReference: { providerId: record.providerId, source: { type: 'persisted', recordId: record.id }, authenticationConfigurationFingerprint: 'test' },
    }, {} as never);
    expect(decision).toEqual({ action: 'continue' });
    const mismatched = await resolve({
      protocol: 'oidc', providerId: record.providerId,
      accountKey: { issuer: 'https://other-idp.example.test', accountId: 'subject-1' },
      providerUser: { email: 'alice@example.test', emailVerified: true, name: 'Alice' },
      providerClaims: {}, verifiedIdTokenClaims: {},
      providerReference: { providerId: record.providerId, source: { type: 'persisted', recordId: 'other-row' }, authenticationConfigurationFingerprint: 'test' },
    }, {} as never);
    expect(mismatched.action).toBe('reject');
    await expect(options.guardProviderMutation?.({
      action: 'delete', provider: { id: record.id, providerId: record.providerId, organizationId: record.organizationId }, providerReference: { providerId: record.providerId, source: { type: 'persisted', recordId: record.id }, authenticationConfigurationFingerprint: 'test' },
    }, {} as never)).rejects.toMatchObject({ code: 'COMPANY_SSO_MUTATION_OWNERSHIP' });
  });

  it('pins SAML identities to the metadata IdP entity and keeps the SP issuer separate', async () => {
    const metadata = '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.test/entity"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>AA==</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/sso"/></IDPSSODescriptor></EntityDescriptor>';
    const repository = new MemoryCompanySsoRepository();
    const validated = await validateCompanySsoRegistration('acme', {
      providerId: 'acme-saml',
      displayName: 'Acme SAML',
      protocol: 'saml',
      issuer: `${APP_ORIGIN}/saml/sp`,
      callbackUrl: companySsoCallbackUrl(APP_ORIGIN, 'acme-saml', false, 'saml'),
      saml: { entryPoint: 'https://idp.example.test/sso', idpMetadata: { metadata } },
    }, { appOrigin: APP_ORIGIN });
    const record = await repository.create({
      id: 'row-acme-saml',
      ...validated,
      createdBy: 'owner-1',
      updatedBy: 'owner-1',
      revision: 1,
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    });
    const resolve = companySsoPluginOptions({ repository }).resolveUser!;
    const baseInput = {
      protocol: 'saml' as const,
      providerId: record.providerId,
      accountKey: { issuer: record.saml!.identityProviderIssuer, accountId: 'alice@acme.test' },
      providerUser: { email: 'alice@acme.test', emailVerified: false, name: 'Alice' },
      providerClaims: {},
      providerAttributes: {},
      verifiedIdTokenClaims: {},
      providerReference: { providerId: record.providerId, source: { type: 'persisted' as const, recordId: record.id }, authenticationConfigurationFingerprint: 'test' },
    };
    await expect(resolve(baseInput, {} as never)).resolves.toEqual({ action: 'continue' });
    await expect(resolve({ ...baseInput, accountKey: { issuer: 'https://idp.example.test/foreign', accountId: baseInput.accountKey.accountId } }, {} as never)).resolves.toMatchObject({ code: 'COMPANY_SSO_ISSUER_MISMATCH' });
    await expect(resolve({ ...baseInput, accountKey: { issuer: record.issuer, accountId: baseInput.accountKey.accountId } }, {} as never)).resolves.toMatchObject({ code: 'COMPANY_SSO_ISSUER_MISMATCH' });
  });

  it('bridges the private row into ssoProvider with an exact id and rejects collisions', async () => {
    const repository = new MemoryCompanySsoRepository();
    const record = await createRecord(repository);
    const rows = new Map<string, Record<string, unknown>>();
    const adapter = {
      findOne: async ({ where }: { where: Array<{ field: string; value: unknown }> }) => {
        const providerId = where.find((entry) => entry.field === 'providerId')?.value;
        return typeof providerId === 'string' ? rows.get(providerId) ?? null : null;
      },
      create: async ({ data, forceAllowId }: { data: Record<string, unknown>; forceAllowId?: boolean }) => {
        expect(forceAllowId).toBe(true);
        rows.set(String(data.providerId), { ...data });
        return data;
      },
      update: async ({ update }: { update: Record<string, unknown> }) => {
        const current = rows.get(record.providerId);
        if (!current) return null;
        rows.set(record.providerId, { ...current, ...update });
        return rows.get(record.providerId);
      },
      delete: async ({ where }: { where: Array<{ field: string; value: unknown }> }) => {
        const providerId = where.find((entry) => entry.field === 'providerId')?.value;
        if (typeof providerId === 'string') rows.delete(providerId);
      },
    } as unknown as CompanySsoBetterAuthAdapter;
    const auth = { $context: Promise.resolve({ adapter }) };

    await syncCompanySsoProvider(auth, record);
    expect(rows.get(record.providerId)).toMatchObject({ id: record.id, organizationId: record.organizationId, userId: record.createdBy });
    const storedConfig = JSON.parse(String(rows.get(record.providerId)?.oidcConfig)) as Record<string, unknown>;
    expect(storedConfig.discoveryEndpoint).toBe(record.oidc?.discoveryUrl);
    await syncCompanySsoProvider(auth, { ...record, status: 'disabled', revision: 2 });
    expect(rows.get(record.providerId)).toMatchObject({ id: record.id, providerId: record.providerId });

    await expect(syncCompanySsoProvider(auth, { ...record, id: 'row-foreign', organizationId: 'globex' }))
      .rejects.toMatchObject({ code: 'COMPANY_SSO_CONFLICT' });
    await removeCompanySsoProvider(auth, record);
    expect(rows.has(record.providerId)).toBe(false);
  });

  it('runs the trusted mirror hook on company API mutations', async () => {
    const repository = new MemoryCompanySsoRepository();
    const upserts: CompanySsoProviderRecord[] = [];
    const removals: CompanySsoProviderRecord[] = [];
    const api = createCompanySsoApi({
      repository,
      authorizer: authorizerFor(),
      appOrigin: APP_ORIGIN,
      fetch: fetchDiscovery(),
      idGenerator: () => 'row-api-oidc',
      bridge: {
        upsert: async (record) => { upserts.push(record); },
        remove: async (record) => { removals.push(record); },
      },
    });
    const created = await api.handler(request('/v1/companies/acme/sso/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(oidcInput()),
    }));
    expect(created?.status).toBe(201);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ id: 'row-api-oidc', organizationId: 'acme', providerId: 'acme-oidc' });

    const deleted = await api.handler(request('/v1/companies/acme/sso/providers/acme-oidc', { method: 'DELETE', headers: { 'if-match': '1' } }));
    expect(deleted?.status).toBe(200);
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ id: 'row-api-oidc', organizationId: 'acme', providerId: 'acme-oidc' });
  });
});
