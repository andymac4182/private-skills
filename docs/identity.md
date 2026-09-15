# Better Auth identity runtime

Private Skills keeps the existing bootstrap token route (`POST /auth/session`)
and adds an opt-in Better Auth identity runtime for browser users. The runtime
uses Better Auth `1.7.5`, its PostgreSQL Kysely adapter, and the existing
Postgres.js client through `kysely-postgres-js`. A Neon PostgreSQL connection
works through the same `DATABASE_URL` setting.

The runtime exposes three route families:

- `GET` and `POST /api/auth/*` are the Better Auth protocol and organization
  plugin routes. Provider callbacks use
  `/api/auth/callback/{provider-id}`.
- `GET /auth/identity/config` returns the browser-safe `IdentityPublicConfig`.
  It contains provider ids and callback paths, never client secrets or tokens.
- `GET /auth/identity/session` returns `{ "session": IdentitySession | null }`.
  The session view contains user, organization, and live membership data. It
  never contains a Better Auth session token or provider access/refresh token.

The existing `POST /auth/session` route accepts either the configured legacy
bootstrap token or a persisted company API token issued through `/v1/tokens`.
The API-token path returns a v1 HMAC-signed reference cookie containing only
the token, company, user, audience, version, and expiry claims; the raw secret
is never placed in a cookie. Each request resolves the persisted token and the
current company membership again, so expiry, revocation, removal, and role or
scope changes take effect without waiting for a browser session refresh.
`DELETE /auth/session` clears the shared cookie. A durable identity/session
secret is required for this exchange; the legacy bootstrap path remains
available for compatibility.

`IdentityRuntime.handler` owns all three families. The host runtime only needs
to pass a standard Fetch `Request` to it and return the `Response`; unrelated
paths receive `404`. The identity BFF session response is `Cache-Control:
no-store`.

## Provider configuration

Set `PSKILLS_BETTER_AUTH_ENABLED=true`, `DATABASE_URL`, and a random
`BETTER_AUTH_SECRET` of at least 32 characters. The base URL is read from
`BETTER_AUTH_URL`, then `PSKILLS_PUBLIC_ORIGIN`, and defaults to the loopback
development URL. Built-in providers are enabled only when both credentials are
present:

```text
GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET
MICROSOFT_TENANT_ID (default: common)
MICROSOFT_AUTHORITY (default: https://login.microsoftonline.com)
```

The same values may be prefixed with `PSKILLS_BETTER_AUTH_` or
`BETTER_AUTH_`. A partial credential pair fails startup instead of silently
registering a broken provider. Microsoft identity is keyed by its immutable
provider subject; email domains are not an authorization rule.

Generic OIDC providers are server-owned JSON registrations in
`PSKILLS_OIDC_PROVIDERS_JSON` (the `BETTER_AUTH_*` spelling is accepted too):

```json
[
  {
    "id": "company-one",
    "name": "Company One",
    "clientId": "private-skills",
    "clientSecret": "set-in-the-deployment-secret-store",
    "discoveryUrl": "https://id.example.test/.well-known/openid-configuration",
    "scopes": ["openid", "profile", "email"]
  }
]
```

Each generic provider must have a unique id and a discovery URL. Better Auth's
generic OAuth plugin uses authorization-code flow with PKCE and requires
verified OIDC ID-token metadata (`issuer` and `jwks_uri`) before registering a
provider. Local HTTP discovery is accepted only for loopback development
fixtures. No provider credentials or discovery configuration are accepted from
browser input.

## Organizations and invitations

The Better Auth organization plugin is the authority for organizations,
memberships, invitation rows, active organization state, and last-owner
protections. The configured roles are `owner`, `admin`, `publisher`, and
`reader`; Better Auth's built-in `member` role is mapped to `reader`. Unknown
roles fail closed. Organization, membership, invitation, and request-rate
limits have bounded defaults in `.env.example`.

Social sign-in creates a user session without assigning a tenant. A user with
no membership receives a valid sanitized session with `needsOnboarding: true`,
while `authenticate()` returns `null` until Better Auth has a live active
membership. Removing a membership or organization is observed on the next
session lookup because memberships are read from the organization plugin on
every request. An existing default tenant can only be adopted through the
separate explicit bootstrap-owner flow; email domains and first social login
never perform adoption.

Invitation delivery defaults to `copy-link`; no email is sent. The link can be
constructed with `createInvitationLink(baseURL, invitationId)`. Accepting an
invitation requires a currently authenticated user whose locally verified email
matches the invitation email, case-insensitively. An existing email transport
may be supplied to `createIdentityRuntime` and selected with
`PSKILLS_BETTER_AUTH_EMAIL_DELIVERY=configured`; the runtime refuses that mode
when no transport is supplied.

## PostgreSQL migrations

Migrations are explicit by default. Better Auth's migration planner creates the
core `user`, `account`, `session`, and `verification` tables plus the
organization plugin's organization, member, and invitation tables (and the
database rate-limit table). When `PSKILLS_BETTER_AUTH_SCHEMA` is set, the
planner qualifies all tables in that PostgreSQL schema.

The factory exposes both `runtime.runMigrations()` and
`getIdentityMigrations(runtime)`. A deployment runner should review the plan,
run it before accepting traffic, and close the runtime:

```ts
const runtime = createIdentityRuntimeFromEnv(process.env);
if (runtime) {
  await runtime.runMigrations();
  await runtime.close();
}
```

`PSKILLS_BETTER_AUTH_AUTO_MIGRATE=true` makes the runtime's `ready` promise run
the same planner before any handler, session, or principal operation. It is
intended for a controlled single process; explicit migration is preferred for
multi-instance deployments.

The web Node host composes Better Auth with the company SSO and persisted
service-token repositories. Its `IdentityInfrastructure.runMigrations()`
entrypoint runs the Better Auth, company SSO, API-token, and operations-event
plans in order, using the configured
`PSKILLS_BETTER_AUTH_SCHEMA` for the Better Auth and private SSO tables. The
service-token schema remains public for compatibility unless the host
explicitly supplies `apiTokenSchemaName` or `PSKILLS_API_TOKEN_SCHEMA`; its
configured table name is preserved. The lower-level
`runtime.runMigrations()` above remains the Better Auth-only entrypoint for
callers that construct the package runtime directly.

Identity operations visibility uses the separate
`private_skills_identity_operations_events` table. It records only bounded
event kinds and reason codes for sign-in, provider callback, and membership
denials. A tenant id and role are written only after the server verifies the
current Better Auth membership; failures before that check remain global and
are excluded from a company panel. No token, provider response, URL, email,
request body, or exception text is stored.

The table migration is explicit by default. Set
`PSKILLS_IDENTITY_OPERATIONS_EVENTS_AUTO_MIGRATE=true` only when one controlled
process owns startup DDL, or call the infrastructure `runMigrations()` helper
from the reviewed deployment job. That helper also removes up to the bounded
`PSKILLS_IDENTITY_OPERATIONS_EVENTS_CLEANUP_BATCH_SIZE` of rows older than
`PSKILLS_IDENTITY_OPERATIONS_EVENTS_RETENTION_DAYS` (30 days by default) on
each run. The operations status endpoint returns aggregate totals and
last-24-hour counts for the selected company; it never returns event rows.

The implementation follows Better Auth's current
[PostgreSQL adapter guidance](https://www.better-auth.com/docs/adapters/postgresql),
[organization plugin](https://www.better-auth.com/docs/plugins/organization),
and [generic OAuth guidance](https://www.better-auth.com/docs/plugins/generic-oauth).
