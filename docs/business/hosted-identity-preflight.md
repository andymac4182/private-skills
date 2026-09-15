# Hosted identity migration preflight

This runbook is paired with the read-only preflight at
[`scripts/hosted-identity-preflight.mjs`](../../scripts/hosted-identity-preflight.mjs)
and was prepared against integration source `857b1495cec6351ce176f9919af40bd9033e0585`.
It prepares an existing registry for Better Auth without changing production
configuration or application data. The command reads local files, a
name-only environment inventory, safe nonsecret flags, and sanitized operator
evidence. It always verifies the local checkout with `git rev-parse`. It does
not call Vercel, a production database, a provider, or the registry. Optional
read-only probes may contact only an explicitly supplied loopback PostgreSQL
URL or loopback `/auth/identity/config` URL.

The command exits `0` only when every evidence gate and every required live
check passes. It exits `2` when a gate is pending or blocked, and `1` when an
input is malformed. A report with `ready: false` is the expected result while
identity is disabled, credentials are being gathered, B27 remains held, or a
live check is missing. `validatedEvidence` records sanitized attestations;
`verifiedLiveChecks` records the local Git check and any requested loopback
probes. Evidence attestations alone can never make `ready` true.

## Run the preflight

Use a reviewed checkout and record its source revision. The expected revision
is an explicit operator input; it must be the exact source intended for the
migration window.

```sh
git status --short
git rev-parse HEAD
```

Discover configuration **names only**. The linked registry project must be
verified before this step. `vercel env ls` is an inventory command; do not use
`vercel env pull`, `vercel env export`, or a dashboard secret download.

```sh
mkdir -p work/identity-preflight
vercel env ls production > work/identity-preflight/vercel-production-env-names.txt
```

Inspect that file and remove any accidental values before using it. The
preflight extracts only recognized names and never includes an environment
value in its report. Supply values for nonsecret switches in a separate file;
the file must contain only the allowlisted keys below.

```json
{
  "PSKILLS_ENVIRONMENT": "production",
  "PSKILLS_ORGANIZATION_ID": "default",
  "PSKILLS_BETTER_AUTH_ENABLED": "true",
  "PSKILLS_BETTER_AUTH_AUTO_MIGRATE": "false",
  "PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA": "true",
  "PSKILLS_COMPANY_SSO_AUTO_MIGRATE": "false",
  "PSKILLS_API_TOKEN_AUTO_MIGRATE": "false",
  "PSKILLS_STATE_PROVIDER": "postgres"
}
```

The evidence file is operator-owned and must contain readback results rather
than credentials or raw rows. Its top-level sections are `schemaReadback`,
`adoption`, `backup`, `rollback`, and `twoCompany`. Use the shape below as a
starting point and keep any false or pending field until the corresponding
proof has actually completed:

```json
{
  "schemaReadback": {
    "status": "pending",
    "migrationPlan": {
      "reviewed": false,
      "applied": false,
      "planDigest": "sha256:<64-lowercase-hex>",
      "tableNames": []
    },
    "tablesReadBack": false,
    "companySso": { "privateTableReadBack": false, "mirrorReadBack": false, "bindingMatch": false },
    "serviceTokens": {
      "tableReadBack": false,
      "hashesPreserved": false,
      "revocationFieldsReadBack": false,
      "schemaCompatibility": "held",
      "tableSchema": "public",
      "tableName": "private_skills_service_tokens"
    },
    "registry": { "tableReadBack": false, "stateRevisionsReadBack": false },
    "objects": { "inventoryReadBack": false, "digestsVerified": false }
  },
  "adoption": { "status": "pending" },
  "backup": { "status": "pending", "domains": [] },
  "rollback": { "status": "pending" },
  "twoCompany": { "status": "pending" }
}
```

Run the preflight with the source revision selected for the change window:

```sh
REVIEWED_SOURCE_SHA="$(git rev-parse HEAD)"
node scripts/hosted-identity-preflight.mjs \
  --environment production \
  --config-names-file work/identity-preflight/vercel-production-env-names.txt \
  --safe-values-file work/identity-preflight/identity-safe-values.json \
  --evidence-file work/identity-preflight/identity-evidence.json \
  --source-sha "$REVIEWED_SOURCE_SHA" \
  --expected-source-sha "$REVIEWED_SOURCE_SHA" \
  --json
```

The JSON report contains configuration names, check states, the migration
order, external-input list, and limitations. It never contains token values,
database URLs, cookies, provider secrets, SSO assertions, webhook bodies,
artifact bytes, or scanner output. Keep the report access-controlled because
configuration names and deployment evidence can still describe the service.

The Git check is performed by the command itself and compares the local
`rev-parse` result with `--expected-source-sha` (or `--source-sha` when no
expected value is supplied). The two flags are operator selections, not live
proof. To add a local database readback, set
`PSKILLS_PREFLIGHT_LOOPBACK_DATABASE_URL` to a disposable `postgres://` or
`postgresql://` URL whose host is `localhost`, `127.0.0.1`, or `::1`, then run
the same command. To add the public identity check, set
`PSKILLS_PREFLIGHT_LOOPBACK_IDENTITY_CONFIG_URL` to the exact loopback
`/auth/identity/config` URL. These operator-only variables are never included
in the configuration inventory or report, and non-loopback targets are
rejected. When omitted, those probes are reported as `skip`; the command does
not contact the hosted database or HTTP origin.

Live-pass records are generated inside this process by the Git or loopback
probe. A `status: "pass"` field copied into the evidence JSON cannot promote
an attestation into a live check.

The PostgreSQL probe loads the Node `postgres` client lazily and reads only
`information_schema` table metadata for the Better Auth, company SSO,
service-token, and registry tables. The identity probe reads only the bounded,
browser-safe JSON config and checks the enabled explicit-adoption contract.
Neither probe runs migrations, reads application rows, or writes data. If the
client is unavailable or a table/config contract is wrong, the live check is
`blocked` and the report cannot be used as a traffic approval.

## Required order

Keep the legacy bearer/session path available until the final traffic gate.
The preflight publishes this fixed order so a partial migration cannot be
treated as a successful activation:

1. Fence registry writes, identity adoption, service-token changes, billing
   webhooks, usage reservations, uploads, workers, and provider mutations;
   capture one complete encrypted recovery point.
2. Generate the Better Auth plan from the running `IdentityRuntimeAdmin`,
   review every operation, record the plan digest and dynamic table names, and
   apply the plan once to the fenced target. Keep startup auto-migration off
   for a multi-instance deployment.
3. Apply the reviewed company SSO schema and reconcile its Better Auth
   `ssoProvider` mirror. The private row, mirror row, organization binding,
   provider ID, and configuration fingerprint must agree.
4. Prove service-token schema compatibility before enabling identity. B27 is
   held while a custom Better Auth schema could move the existing public
   `private_skills_service_tokens` lookup. A local implementation proof does
   not close the hosted gate: a separate token-table/schema configuration or a
   reviewed data-preserving migration must pass against the target readback
   before this gate can be marked `passed`.
5. Read back registry state and private sealed objects. Verify independent
   revisions, object size and digest, grants, scan evidence, and required
   policy gates. PostgreSQL rows alone do not restore objects.
6. Adopt the existing default organization through the explicit
   owner-authenticated action. Require a verified Better Auth session, a
   separately verified configured owner proof, a live owner membership, an
   atomic binding, an adoption marker, and replay-safe retry behavior.
7. Register each company provider through its server-owned organization
   binding and prove one real signed callback per protocol.
8. Run the two-company hosted `Request` matrix, including positive membership,
   token, SSO, registry, object, search, and worker checks plus foreign and
   revoked denials.
9. Switch traffic only after the report is ready and the deployment, origin,
   provider callback, and legacy fallback have been read back.

Social first login, email-domain matching, organization display names, prompt
fields, request headers, and caller-selected issuer URLs cannot select or adopt
the default organization. The server-configured organization and the verified
membership are the only tenant selectors.

## Backup and rollback gates

The backup readback must cover all six durable domains: Better Auth tables,
company SSO and its mirror, service-token hashes and revocation state, billing
and webhook/idempotency state, registry metadata, and the private object
inventory. It must record a consistent availability fence, encryption,
secret-value exclusion, object digest verification, and legacy-access
preservation. A registry-only `private_skills_registry_state` dump is not a
tenant backup.

The rollback readback must retain the previous deployment, the legacy bootstrap
and session path, and a successful legacy smoke. Keep schema changes additive;
use a compatible forward fix when populated tables are involved. Do not run an
unreviewed down migration or manually reassign a token, provider, subscription,
webhook, or object to repair a mismatch. Keep the fence in place until the
two-company matrix passes, and record which events were fenced, accepted,
ignored, or replayed.

## Two-company proof after credentials are configured

Use two separately owned test organizations and accounts. Give them equal
display names and, where practical, equal content digests so an accidental
name or content match cannot hide a tenant mix-up. Configure the customer SSO
provider rows through the server-owned organization API and use real test
callbacks; do not place an assertion or provider secret in the evidence file.

For each company, record sanitized pass/fail results for:

- Better Auth session resolution, active organization, live membership lookup,
  membership removal, and a rejected active-organization switch to a foreign
  company;
- scoped API-token exchange, `/v1/me`, role/scope enforcement, expiry,
  revocation, and a generic denial when the token is used for the other
  company;
- company SSO provider binding, signed callback, issuer/provider mismatch,
  expired assertion, and cross-company callback denial;
- registry listing/detail, semantic search, worker job, release/grant, and
  exact sealed-object transfer, including a foreign object denial before the
  object is opened and independent metadata revisions;
- the legacy bootstrap/session fallback while identity traffic is being
  compared, followed by a readback that the fallback remains available for
  rollback.

Set `twoCompany.status` to `passed` only when both companies have positive
checks and every cross-tenant denial is observed. The preflight requires
`sessionMembership`, `activeOrganization`, `serviceToken`, `ssoBinding`,
`registryMetadata`, `sealedObject`, `search`, and `workerJob` for each company,
plus matching denial fields. Store only booleans, bounded counters, digests,
and deployment/provider references that do not expose secrets, cookies,
assertions, raw tokens, or artifact content.

## External inputs and independent work

| External input | Independent preflight work |
| --- | --- |
| Vercel production environment name inventory and nonsecret switch readback | Name-only parsing, alias checks, secret-value rejection, and sanitized report generation |
| Better Auth/Neon access, reviewed dynamic migration plan, schema readback, and change fence | Fixed Better Auth → SSO → token ordering and B27 hold enforcement |
| Existing default organization ID, verified Better Auth user, separate owner proof, and adoption readback | Header/domain/first-user rejection and explicit atomic/replay-safe adoption assertions |
| Encrypted complete backup manifest and private object digest inventory | Durable-domain completeness, fence, secret-exclusion, and legacy-preservation checks |
| Previous deployment, legacy smoke, and rollback owner | Additive-schema/no-down-migration rollback gate |
| Customer provider registrations, real accounts, signed callbacks, and two-company runtime results | Sanitized matrix validation; no provider call is made by this command |
| Disposable loopback PostgreSQL URL and/or loopback public-config URL, when intentionally supplied | Actual bounded local probes; non-loopback and hosted targets are rejected |

The source tree, command, tests, migration order, and report schema are
independent of production credentials. Local evidence and optional loopback
checks do not establish hosted provider, database, or deployment readiness.
The current integration remains blocked until the account holder supplies the
external readbacks, and the hosted B27 target compatibility proof is complete.
