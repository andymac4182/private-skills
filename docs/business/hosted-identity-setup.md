# Hosted identity setup

This guide describes the hosted identity boundary in integration commit
`360868edd0f5d688a1575900241a44203cd01ae8`. Better Auth `1.7.5` is an
opt-in Node runtime backed by PostgreSQL. The existing bearer-token login and
`POST /auth/session` path remain available while identity is disabled or being
migrated. A local fixture, a configuration response, or a successful build is
not proof of a real provider login.

## Audit snapshot

The following is a redacted metadata audit made on 16 September 2026. Vercel
environment values were not read or exported.

| Area | State | Evidence and next action |
| --- | --- | --- |
| Registry project | **Configured** | Vercel project `private-skills` (`prj_vw4QlLtnsPaZm8mtms1HuDqpSNti`), Node `24.x`, root directory `.`, GitHub link `andymac4182/private-skills`, production branch `main`. |
| Hosted origin | **Configured with value withheld** | Verified project domain is `https://private-skills-theta.vercel.app`; `PSKILLS_PUBLIC_ORIGIN` exists in production metadata. Confirm that its value is this origin before enabling callbacks. |
| PostgreSQL | **Configured with value withheld** | `DATABASE_URL` exists as an encrypted variable in development, preview, and production. Connection, schema, backup, and migration status were not tested by this metadata read. |
| Legacy authentication | **Configured with value withheld** | Production has `PSKILLS_BOOTSTRAP_TOKEN`, `PSKILLS_BOOTSTRAP_TOKENS`, and `PSKILLS_SESSION_SECRET`. This is the currently supported production access path. |
| Better Auth enablement | **Unconfigured** | Neither `PSKILLS_BETTER_AUTH_ENABLED` nor `BETTER_AUTH_ENABLED` is present in production, so the runtime defaults to disabled. |
| Better Auth URL and secret | **Unconfigured** | No `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, or `PSKILLS_BETTER_AUTH_SECRET` key is present. These are required before enabling identity. |
| Platform providers | **Unconfigured** | GitHub, Google, and Microsoft client ID/secret keys are absent from production metadata. No built-in provider is registered. |
| Generic OIDC | **Unconfigured** | The three accepted OIDC JSON variable names are absent. No generic provider is registered. |
| Better Auth migration | **Unknown** | Auto-migration is not configured and there is no hosted schema-plan/readback artifact. Run a reviewed migration before traffic. |
| Company SSO records | **Unknown** | The source contains the company SSO table and Better Auth mirror bridge, but no hosted provider row, mirror, or signed callback readback was inspected. |
| Service-token schema and live flow | **Unknown / release-held** | The source contains `private_skills_service_tokens` and the token console. The current integration remains held for live token exchange, use, and revocation proof. |
| Current production source | **Configured, identity off** | The latest READY production deployment observed was `668f53e` on `main`. `360868e` was not deployed by this audit. |
| Provider-console registrations | **Unknown** | Vercel metadata cannot show whether a GitHub, Google, Microsoft Entra, or customer OIDC console has the exact redirect URI. Verify in each owner-controlled console. |

The marketing project is separate and does not host identity: Vercel project
`private-skills-marketing` (`prj_UCQvxPTnSjcTjwONPwLroAGvAb7m`) is rooted at
`apps/marketing` and its metadata exposes only its public app-origin setting.
Do not add identity secrets to it or to any `NEXT_PUBLIC_`/`VITE_` variable.

## Callback URLs

Use the exact origin configured in `BETTER_AUTH_URL` (which takes precedence),
or in `PSKILLS_PUBLIC_ORIGIN`. With the currently verified registry origin and
the default `PSKILLS_BETTER_AUTH_BASE_PATH=/api/auth`, the platform callbacks
are:

| Provider | Exact callback URL |
| --- | --- |
| GitHub (`github`) | `https://private-skills-theta.vercel.app/api/auth/callback/github` |
| Google (`google`) | `https://private-skills-theta.vercel.app/api/auth/callback/google` |
| Microsoft (`microsoft`) | `https://private-skills-theta.vercel.app/api/auth/callback/microsoft` |
| Generic OIDC (`<provider-id>`) | `https://private-skills-theta.vercel.app/api/auth/callback/<provider-id>` |

The company-managed SSO callbacks are separate from platform social login:

| Company protocol | Exact callback URL |
| --- | --- |
| OIDC (`<provider-id>`) | `https://private-skills-theta.vercel.app/api/auth/sso/callback/<provider-id>` |
| SAML (`<provider-id>`) | `https://private-skills-theta.vercel.app/api/auth/sso/saml2/sp/acs/<provider-id>` |

`<provider-id>` is the server-owned provider ID and is limited to the
repository's provider-ID grammar. Register one exact URI, including scheme,
host, path, and trailing-slash behavior. Do not add query strings, fragments,
wildcards, guessed subdomains, or a callback supplied by a browser. A custom
domain needs its own provider registration and a fresh origin readback before
it is advertised.

## Deployment configuration

Set these in the **registry** Vercel project's production environment through
the dashboard or an approved secret manager. Do not put values in source,
logs, chat, or a browser response.

```dotenv
PSKILLS_BETTER_AUTH_ENABLED=true
BETTER_AUTH_URL=https://private-skills-theta.vercel.app
BETTER_AUTH_SECRET=<random server secret, at least 32 characters>
PSKILLS_BETTER_AUTH_BASE_PATH=/api/auth
PSKILLS_BETTER_AUTH_AUTO_MIGRATE=false
PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA=true
PSKILLS_BETTER_AUTH_EMAIL_DELIVERY=disabled
```

`DATABASE_URL` must point to the durable PostgreSQL database used by the
runtime. Keep `PSKILLS_STATE_PROVIDER=postgres` for the recommended shared
Node profile, and verify that the existing production value is compatible
before changing it. `PSKILLS_BETTER_AUTH_SCHEMA` is optional; if it is set,
use the same validated schema for the Better Auth and membership lookups.
`PSKILLS_BETTER_AUTH_AUTO_MIGRATE=false` is the multi-instance default. The
controlled migration job should call `runtime.runMigrations()` once and record
the plan and resulting schema readback.

The PostgreSQL service-token table is separate from Better Auth's tables. Run
the reviewed `API_TOKEN_SCHEMA_SQL`/`postgresApiTokenSchemaSql()` migration
before exposing `/v1/tokens`. Keep `PSKILLS_API_TOKEN_AUTO_MIGRATE` (or its
`API_TOKEN_AUTO_MIGRATE` alias) false unless a single controlled process is
intentionally responsible for the DDL. The company SSO table is likewise an
explicit `companySsoSchemaSql()` migration; when the bridge is used, its
Better Auth `ssoProvider` mirror must be migrated and reconciled with the
private row.

The current invitation mode is `copy-link` and requires a verified email. It
does not send email. Set
`PSKILLS_BETTER_AUTH_EMAIL_DELIVERY=configured` only when an existing server
email transport has been injected and tested; this repository does not supply
an email provider configuration.

## Provider registration

All four provider paths use authorization-code flow. Keep provider credentials
server-side and use the normal Vercel production environment scope. The
application rejects partial built-in credential pairs, requires an email from
an OAuth provider, and disables implicit account linking unless the local email
is verified.

### GitHub

1. In GitHub Developer Settings, create or select an OAuth App. Use the
   registry origin for its homepage and register the exact GitHub callback in
   the table above. Do not register a wildcard-like or guessed host.
2. Record the app's client ID and generate its client secret in the GitHub
   console. Store them as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in the
   registry project's production environment.
3. Deploy the reviewed Git commit and verify that the sign-in request reaches
   GitHub and returns to the exact callback with a valid session. GitHub app
   creation and callback settings are documented in [GitHub's OAuth App
   guide](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

### Google

1. In the Google Cloud project, configure the OAuth consent screen and create
   an OAuth client of type **Web application**. Add the exact Google callback
   URL as an authorized redirect URI; do not use a local callback for the
   hosted client.
2. Store the client ID and client secret as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` in the registry project. Complete any testing,
   audience, consent, or publisher verification required for the intended
   users.
3. Exercise a real test account after deployment and verify the returned email
   is verified before any organization adoption or invitation acceptance.
   Google's redirect and authorization-code requirements are in the [web
   server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

### Microsoft Entra ID

1. In Microsoft Entra admin center, register a web application with supported
   account types matching the intended customer boundary. Under
   **Authentication**, add the exact Microsoft callback URL as a **Web**
   redirect URI.
2. Create a client secret under **Certificates & secrets** and store its
   value as `MICROSOFT_CLIENT_SECRET` and the application ID as
   `MICROSOFT_CLIENT_ID`. Set `MICROSOFT_TENANT_ID` to the approved directory
   ID, or deliberately use `common` for a multi-tenant policy. The code default
   is `common`; do not rely on that default without an owner decision.
3. Leave `MICROSOFT_AUTHORITY` at
   `https://login.microsoftonline.com` unless the approved deployment needs a
   different HTTPS authority. Complete tenant consent and test with an account
   that belongs to the selected account-type policy. Microsoft documents web
   redirect registration in [Add a redirect URI to your
   application](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri).

### Generic OIDC

1. Ask the customer or identity administrator to create a confidential web
   client with authorization code plus PKCE and the exact callback for the
   server-owned provider ID. Obtain the provider's issuer and its exact
   `/.well-known/openid-configuration` URL.
2. Verify the discovery document before registration. Its `issuer` must match
   the configured issuer, its `authorization_endpoint`, `token_endpoint`, and
   `jwks_uri` must be HTTPS, and the signing keys must be available through
   `jwks_uri`. Redirects, issuer drift, missing keys, and oversized documents
   are rejected.
3. Store one bounded JSON array in
   `PSKILLS_OIDC_PROVIDERS_JSON` (the `PSKILLS_BETTER_AUTH_` and `BETTER_AUTH_`
   spellings are also accepted). The server-owned shape is:

   ```json
   [
     {
       "id": "company-one",
       "name": "Company One",
       "clientId": "...",
       "clientSecret": "...",
       "discoveryUrl": "https://id.example.com/.well-known/openid-configuration",
       "scopes": ["openid", "profile", "email"]
     }
   ]
   ```

   Keep the client secret in Vercel's encrypted/sensitive store rather than
   copying this example into a public file. The OIDC discovery metadata
   contract is defined by [OpenID Connect Discovery
   1.0](https://openid.net/specs/openid-connect-discovery-1_0.html).

### Company-managed SSO

Platform GitHub/Google/Microsoft login creates a user session but does not
choose a tenant. Company SSO is configured by an owner or admin through the
server-owned provider API at
`/v1/companies/:organizationId/sso/providers`. The API derives the callback
from the selected provider ID and refuses email-domain, organization-slug,
browser-header, and arbitrary callback selection.

For company OIDC, provide the issuer, client ID, client secret, exact
issuer-derived discovery URL, and scopes. For company SAML, provide IdP
metadata or an entity ID plus a signing certificate and SSO endpoint. Signed
assertions are required, IdP-initiated callbacks are disabled, and the
provider's organization binding and Better Auth mirror must agree before a
callback can create a session. The SSO contract and admin authorization rules
are in [`docs/identity-company-sso.md`](../identity-company-sso.md).

## Migration, adoption, and recovery

Use separate Preview and Production variables, databases, provider apps,
callback registrations, and test accounts. The sequence below keeps the
legacy path available until identity has passed its own checks.

1. **Fence and back up.** Record the exact Git SHA, Vercel deployment, origin,
   Better Auth version, schema name, migration plan, and backup manifest.
   Quiesce identity adoption, provider mutations, token mutations, billing
   webhooks, registry writes, and workers for the migration window.
2. **Review and migrate.** Generate Better Auth's plan from the running
   `IdentityRuntimeAdmin`, review every operation, then run
   `runtime.runMigrations()` against the isolated or fenced PostgreSQL target.
   Apply `companySsoSchemaSql()` and the service-token DDL as reviewed
   dependent migrations. Keep the schema additive; do not infer tables from an
   old registry JSON row.
3. **Read back the target.** Verify the planned core, organization,
   membership, invitation, rate-limit, company SSO, Better Auth mirror, and
   service-token tables. Check row counts, indexes, global provider IDs,
   organization bindings, expiry/revocation fields, and redacted logs before
   accepting a request.
4. **Adopt the existing organization explicitly.** Sign in through a verified
   Better Auth identity, then use the authenticated bootstrap-owner action at
   `/auth/identity/bootstrap/adopt` with the configured owner proof. Record the
   adoption marker and membership. A first social login, an email domain, a
   display name, or a browser field cannot adopt `default` or any other
   organization.
5. **Register company providers.** An owner/admin creates each company SSO
   row. Reconcile its Better Auth `ssoProvider` mirror, exact row ID,
   organization binding, issuer, configuration fingerprint, and callback.
   Run one real provider callback per protocol before enabling that company.
6. **Switch traffic deliberately.** Deploy the exact Git-connected `main`
   commit, verify its deployment SHA and branch, then read the safe
   `/auth/identity/config` and `/auth/identity/session` surfaces. Check the
   provider callback, active membership, company selection, logout, invitation
   email matching, role denial, and legacy token fallback. Keep the old
   revision available for comparison.
7. **Recover or forward-fix.** If identity, SSO, token, billing, or registry
   state is partial, stop writes and webhook consumption. Prefer a reviewed
   compatible forward fix with the additive schema; otherwise restore an
   isolated complete snapshot of users/accounts/sessions, organizations and
   memberships, invitations, SSO rows and mirrors, token hashes and
   revocations, billing/event rows, registry state, and sealed objects. The
   raw token cannot be recovered from its hash. Invalidate sessions when the
   secret, origin, or trust boundary changes, rotate restored provider and
   service credentials, and repeat the two-company authorization matrix before
   reopening traffic. Do not perform an unreviewed down migration or manually
   reassign a provider, token, subscription, or object to make a check pass.

## Inputs owned by the account holder

These values belong in the appropriate provider console or secret manager. Do
not request or paste them into chat.

| Owner | Required input or decision |
| --- | --- |
| Vercel project owner/admin | Production environment write access, the canonical origin decision, Git-connected `main` deployment, and approval of the migration window. |
| PostgreSQL/Neon owner | Durable connection, backup/restore access, schema and migration window, and a readback that contains no exported credentials. |
| GitHub/Google/Entra administrator | Provider application, exact callback registration, client ID/secret, account-type or audience policy, and consent/verification status. |
| Customer identity administrator | Generic OIDC issuer/discovery URL, client credentials, scopes/claims, or company SAML metadata/certificate, plus a real test account. |
| Private Skills owner/admin | Existing organization ID, explicit bootstrap-owner proof, company-provider authorization, role policy, invitation/recovery decision, and named incident owner. |
| Product/Legal/Support | Custom-domain decision, verified support and privacy contacts, retention/deletion policy, and the user-facing wording for provider failures and recovery. |

Stripe/payment account setup is a separate final external dependency. It is not
part of enabling identity and remains last in the launch sequence.

## Proof boundary

**Test-mode or local proof** may use the disposable PostgreSQL identity fixture,
synthetic Acme/Globex issuers, generated credentials, signed protocol tests,
and `GET /auth/identity/config` returning `enabled: true`. This proves source
configuration, migration seams, callback validation, and selected persistence
behavior. It does not prove a customer provider, Vercel runtime, account
consent, DNS/TLS, hosted migration, or production tenant authorization.

**Real hosted proof** requires a Git-triggered Vercel deployment of the exact
reviewed SHA, redacted production environment readback, successful migration
and schema check, and an actual owner-controlled GitHub, Google, Microsoft, or
customer OIDC account. Verify the end-to-end callback and session, active
membership, explicit company selection, logout, invitation email match, role
denial, scoped token use and revocation, and company SSO binding where enabled.
Record deployment and provider identifiers without recording secrets, cookies,
assertions, authorization codes, token values, or database URLs.

At this snapshot, production remains on `668f53e` with identity opt-in and no
provider keys. The `360868e` integration and its local tests do not close the
hosted identity, token, SSO, native CI, billing, or full launch gates.
