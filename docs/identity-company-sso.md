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

Reads and mutations require the injected company authorizer to return an owner
or admin for the path organization. An authenticated platform recovery path may
return `mode: "recovery"`; the request body cannot enable recovery. Responses
contain provider metadata and secret-presence booleans only. Client secrets,
SAML metadata, certificates, and private keys remain server-side.

Registration validates an HTTPS issuer, the exact generated callback
`/api/auth/sso/callback/:providerId`, and the OIDC discovery document issuer and
endpoints. Loopback HTTP is available only when the disposable local policy
explicitly enables it. SAML metadata is parsed with Better Auth's SAML helper,
requires a signing certificate and signed-assertion policy, and rejects
IdP-initiated callbacks. The current seam validates and stores SAML input; it
does not claim end-to-end signed assertion authentication until the runtime
acceptance fixture covers that path.

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

References:

- [Better Auth SSO plugin](https://better-auth.com/docs/plugins/sso)
- [Better Auth generic OAuth plugin](https://better-auth.com/docs/plugins/generic-oauth)
