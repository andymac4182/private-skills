# Company-managed SSO

The company SSO launch seam binds one Better Auth SSO provider to exactly one
Private Skills organization. The company admin API owns configuration and the
provider registry owns the organization binding. A company portal selects a
provider by its server-issued `providerId`; the sign-in request must not select
an email domain, organization slug, or arbitrary organization id.

The API is mounted at:

```
/v1/companies/:organizationId/sso/providers
/v1/companies/:organizationId/sso/providers/:providerId
```

The public company login seam is mounted separately:

```
GET  /v1/companies/:organizationId/sso/login
POST /v1/companies/:organizationId/sso/login
```

The GET response contains only active providers and the public `providerId`,
display name, and protocol. The POST body selects one of those server-issued
ids and carries a same-origin `/app` or invitation return path. The runtime
resolves the provider again for the path organization, calls `selectProvider`,
and forwards the protocol selected from the persisted row to Better Auth. It
never accepts an email domain or a caller-selected issuer or protocol as
discovery input.

Reads and mutations require the injected company authorizer to return an owner
or admin for the path organization. An authenticated platform recovery path may
return `mode: "recovery"`; the request body cannot enable recovery. Responses
contain provider metadata and secret-presence booleans only. Client secrets,
SAML metadata, certificates, and private keys remain server-side.

Registration validates an HTTPS issuer, the exact generated callback
`/api/auth/sso/callback/:providerId` for OIDC or
`/api/auth/sso/saml2/sp/acs/:providerId` for SAML, and the OIDC discovery
document issuer and endpoints. Loopback HTTP is available only when the
disposable local policy explicitly enables it. SAML metadata is parsed with
Better Auth's SAML helper, requires a signing certificate and signed-assertion
policy, and rejects IdP-initiated callbacks. The current seam validates and
stores SAML input. The runtime acceptance fixture exercises the signed
assertion path with a loopback samlify IdP, and separately proves that a
different signed IdP issuer and a different SP audience are rejected.

`COMPANY_SSO_SCHEMA_SQL` is an explicit migration. It creates
`private_skills_company_sso_providers` with a database-wide unique
`provider_id`, an organization binding, protocol-specific JSON configuration,
revision fencing, and no email-domain column. `autoMigrate` is opt-in on the
Postgres repository.

The Better Auth adapter uses `@better-auth/sso@1.7.5`, matching the repository's
`better-auth@1.7.5`. It sets `providersLimit: 0`, keeps domain verification
disabled, and allows only provider-bound organization provisioning. The
runtime must call `selectProvider`/`explicitCompanySsoSelection` from the
company portal before invoking the SSO sign-in endpoint. The plugin's own
registration, update, and delete endpoints are guarded so they cannot bypass
the company admin API.

The private registry is bridged into Better Auth explicitly. Construct a
`createCompanySsoBetterAuthBridge(auth)` with the live Better Auth instance and
pass it as `bridge` when creating the company API. A successful company POST or
update then calls `syncCompanySsoProvider`; deletion removes the exact mirror
row. The bridge writes model `ssoProvider` with `forceAllowId: true`, maps the
registry's `oidc.discoveryUrl` to Better Auth's `oidcConfig.discoveryEndpoint`,
and uses the registry row `id` as the Better Auth row `id`. This is required
because the SSO plugin records a persisted provider reference containing that
row id and rejects a callback if the id or configuration fingerprint changes.
The bridge rejects any existing provider-id row whose id, organization, or
admin owner does not match, so a company cannot overwrite a platform or other
company provider. `getRuntimeProvider` returns the same id-bearing Better Auth
shape for runtime callers that need to inspect or reconcile a single row.

For OIDC sign-in and callback requests, the Node composition resolves the
configured provider row from the request's provider id and adds only that
row's validated IdP endpoint origins to Better Auth's trusted-origin set. This
keeps private development fixtures usable while preventing a request-supplied
issuer from widening trust.

References:

- [Better Auth SSO plugin](https://better-auth.com/docs/plugins/sso)
- [Better Auth generic OAuth plugin](https://better-auth.com/docs/plugins/generic-oauth)
