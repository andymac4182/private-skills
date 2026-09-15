# Hosted identity migration preflight

This runbook is paired with the read-only preflight at
[`scripts/hosted-identity-preflight.mjs`](../../scripts/hosted-identity-preflight.mjs).
It was reviewed against source baseline
`bd877a5cc6733fe4dcc50577fa500ed0011d2b33` (merge parent
`1ed4435`); that is source provenance, not a claim that this revision is
deployed. The runbook does not change production configuration or application
data. This task performed no production database connection, DDL, DML,
provider call, adoption, or deployment.

The supplied current production baseline is:

- Better Auth is disabled.
- The browser-safe identity configuration reports `providers: []`.
- The supplied current snapshot has one row in
  `public.private_skills_registry_state` at revision `231`. The sanitized
  restore evidence records that historical observation and its revision in
  [`docs/evidence/hosted-postgres-restore-proof-20260916.json`](../evidence/hosted-postgres-restore-proof-20260916.json).

Before a migration window, take a fresh fenced read-only capture and call its
revision `BASELINE_REVISION`. The supplied `231` is the expected starting
value for this window, not a permanent value: if an authorized write occurs
before the fence, use the fresh captured revision in both pre- and
post-migration comparisons. Do not compare a new readback only with the older
artifact.

These are starting conditions. They do not prove that the identity schema is
ready, that a provider credential exists, or that a company can sign in. The
schema lane can be rehearsed and, after a separately approved change, applied
without provider credentials. The provider and activation lane remains
blocked while identity is disabled and `providers` is empty. A Better Auth
secret and database connection are still required by the migration process;
they are server-side inputs and are never printed in the preflight report.

## Exact target map

The Node host composes the following boundaries through
`IdentityInfrastructure.runMigrations()`. `I` means the configured Better
Auth schema from `PSKILLS_BETTER_AUTH_SCHEMA` or `BETTER_AUTH_SCHEMA`; when
neither is configured, `I` is `public`.

| Boundary | Exact target | Migration and preservation rule |
| --- | --- | --- |
| Better Auth | `I."user"`, `I."account"`, `I."session"`, `I."verification"`, `I."organization"`, `I."member"`, `I."invitation"`, `I."rateLimit"`, `I."ssoProvider"` | `getIdentityMigrations(runtime)` is the authority because plugin configuration can change the plan. Review its compiled operations and dynamic table names before applying. |
| Company SSO registry | `I.private_skills_company_sso_providers` | `companySsoSchemaSql()` is additive and idempotent. A nonempty `PSKILLS_COMPANY_SSO_TABLE_NAME` override is a separate reviewed target. `providers: []` means no provider row or mirror row should be invented during this migration. |
| Public service tokens | `public.private_skills_service_tokens` | This location and table name are a compatibility boundary. Do not set `PSKILLS_API_TOKEN_SCHEMA` or `API_TOKEN_SCHEMA`; do not pass a custom `apiTokenSchemaName` or `apiTokenTableName`; do not copy, re-hash, or reassign existing tokens. |
| Identity operations | `I.private_skills_identity_operations_events` | This is an additive, bounded event projection. Keep `PSKILLS_IDENTITY_OPERATIONS_EVENTS_AUTO_MIGRATE=false` and run it only through the reviewed composition job. |
| Registry metadata | `public.private_skills_registry_state` | This is outside the identity migration. Capture one row and `BASELINE_REVISION` before the fence; the row count, revision, representation, and digest must match in the post-migration readback. The supplied snapshot's starting revision is `231`. Do not deserialize or rewrite the JSONB state. |
| Billing and usage | `public.private_skills_billing_customers`, `public.private_skills_billing_subscriptions`, `public.private_skills_billing_usage`, `public.private_skills_billing_webhook_events`, `public.private_skills_billing_usage_operations` | Billing owns these tables. Read them as part of the recovery fence; do not include them in the identity DDL job. |
| Sealed objects | The configured private Files SDK provider | Objects are outside PostgreSQL. Read back the provider inventory, size, and digest manifest separately; a registry row does not prove object availability. |

`ssoProvider` is a Better Auth model used by the company SSO bridge. It is
not a reason to create a placeholder provider when the current public config
has no providers. If an existing private row and mirror row are present, they
must retain the same row ID, provider ID, organization binding, status, and
configuration fingerprint.

The registry evidence also records a physical representation check in which
`jsonb_typeof(state)` returned `string` even though the SQL column type was
`jsonb`. Treat that as an observed value to compare during readback, not as a
reason to normalize the state. Record `jsonb_typeof(state)`,
`pg_typeof(state)`, byte length, and a bounded digest before and after the
migration.

## Configuration boundary

Keep the hosted deployment in its supplied state while doing the read-only
preflight: identity disabled, no provider registrations, and the legacy
bootstrap/session route available. The explicit migration process, when a
change owner approves it, must use these nonsecret switches:

```json
{
  "PSKILLS_ENVIRONMENT": "production",
  "PSKILLS_ORGANIZATION_ID": "default",
  "PSKILLS_BETTER_AUTH_ENABLED": "true",
  "PSKILLS_BETTER_AUTH_AUTO_MIGRATE": "false",
  "PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA": "true",
  "PSKILLS_COMPANY_SSO_AUTO_MIGRATE": "false",
  "PSKILLS_API_TOKEN_AUTO_MIGRATE": "false",
  "PSKILLS_IDENTITY_OPERATIONS_EVENTS_AUTO_MIGRATE": "false",
  "PSKILLS_STATE_PROVIDER": "postgres"
}
```

The process also receives `DATABASE_URL`, `BETTER_AUTH_SECRET` (at least 32
characters), and the canonical `BETTER_AUTH_URL` or `PSKILLS_PUBLIC_ORIGIN`
through the approved secret/configuration manager. The migration job must not
print, export, or persist those values. `PSKILLS_BETTER_AUTH_SCHEMA` is
optional, but the selected value must be the reviewed `I` in the target map.

The API-token schema aliases are now included in the name-only preflight. An
absent alias means the host uses the public default. An alias with an empty or
`public` value is equivalent to that default. Any other value blocks B27 and
requires a separate data-preserving review. The identity operations
auto-migration aliases are also inventoried and must have an explicit false
safe value for a multi-instance deployment.

Provider credentials are a separate gate. They are not required to generate a
schema plan or create the additive identity tables, but they are required
before enabling identity, registering a customer provider, proving a signed
callback, or running the two-company hosted matrix. Do not turn an empty
`providers` array into a claimed provider by entering a browser value or a
placeholder secret.

## Read-only preflight

Use a clean checkout and record the exact source revision selected for the
change window. The expected revision is supplied by the release owner; the
preflight verifies the local value with `git rev-parse` and rejects tracked
changes.

```sh
git status --short
git rev-parse HEAD
```

Discover configuration **names only**. Verify the linked registry project
before this step. `vercel env ls` is an inventory command; do not use
`vercel env pull`, `vercel env export`, or a dashboard secret download.

```sh
mkdir -p work/identity-preflight
vercel env ls production > work/identity-preflight/vercel-production-env-names.txt
```

Inspect the file for accidental values and remove them before using it. The
preflight extracts recognized names and never includes an environment value in
its report. Supply only nonsecret switches in a separate file. With the
current baseline, `PSKILLS_BETTER_AUTH_ENABLED` should be `false`; the report
is expected to remain blocked until a reviewed activation window.

```json
{
  "PSKILLS_ENVIRONMENT": "production",
  "PSKILLS_ORGANIZATION_ID": "default",
  "PSKILLS_BETTER_AUTH_ENABLED": "false",
  "PSKILLS_BETTER_AUTH_AUTO_MIGRATE": "false",
  "PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA": "true",
  "PSKILLS_COMPANY_SSO_AUTO_MIGRATE": "false",
  "PSKILLS_API_TOKEN_AUTO_MIGRATE": "false",
  "PSKILLS_IDENTITY_OPERATIONS_EVENTS_AUTO_MIGRATE": "false",
  "PSKILLS_STATE_PROVIDER": "postgres"
}
```

The evidence file contains sanitized readback results, never credentials or
raw rows. Keep `schemaReadback`, `adoption`, `backup`, `rollback`, and
`twoCompany` pending until each proof has actually completed:

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

Run the preflight with the reviewed source SHA chosen for the window:

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

Exit `0` means every evidence gate and required live check passed. Exit `2`
means a gate is pending or blocked; that is expected for the supplied
identity-disabled baseline. Exit `1` means an input is malformed.
`validatedEvidence` contains sanitized attestations. `verifiedLiveChecks`
contains the Git check and any requested loopback probes. An attestation can
never be copied into `liveChecks` to make a report ready.

The optional database probe accepts only a disposable loopback PostgreSQL URL
in `PSKILLS_PREFLIGHT_LOOPBACK_DATABASE_URL`. The optional identity probe
accepts only the exact loopback `/auth/identity/config` URL in
`PSKILLS_PREFLIGHT_LOOPBACK_IDENTITY_CONFIG_URL`. They read bounded metadata
and browser-safe config only; they reject hosted targets, never run DDL or
DML, and never place the URL in a report. Omitted probes are reported as
`skip`.

## Generate and review the migration plan

This command is read-only. Run it against a disposable loopback database or
an approved read-only production connection supplied in-process by the
secret/configuration manager. Do not place a connection string in a shell
history, output file, or report. The command uses the same host composition
as production, keeps all auto-migration settings false, compiles the dynamic
Better Auth plan, and prints only operation metadata plus a SHA-256 plan
digest. It does not call `runMigrations()`.

```sh
node --import tsx --input-type=module <<'EOF'
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { createIdentityInfrastructure } from './apps/web/server/identity-infrastructure.ts';
import { getIdentityMigrations } from './packages/identity/src/index.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
const secret = process.env.BETTER_AUTH_SECRET?.trim();
const origin = (process.env.BETTER_AUTH_URL ?? process.env.PSKILLS_PUBLIC_ORIGIN)?.trim();
if (!databaseUrl || !secret || !origin) throw new Error('DATABASE_URL, BETTER_AUTH_SECRET, and canonical origin are required in-process');
for (const name of ['PSKILLS_API_TOKEN_SCHEMA', 'API_TOKEN_SCHEMA']) {
  const value = process.env[name]?.trim();
  if (value && value !== 'public') throw new Error('API-token schema must remain public for B27 compatibility');
}

const sql = postgres(databaseUrl, { max: 2, prepare: false, connect_timeout: 10, idle_timeout: 10 });
const execute = async (connection, text, parameters = []) => {
  const result = await connection.unsafe(text, [...parameters]);
  return { rows: [...result], rowCount: result.count };
};
const pool = {
  query: (text, parameters) => execute(sql, text, parameters),
  connect: async () => {
    const connection = await sql.reserve();
    return {
      query: (text, parameters) => execute(connection, text, parameters),
      release: () => connection.release(),
    };
  },
};
const environment = {
  ...process.env,
  PSKILLS_BETTER_AUTH_ENABLED: 'true',
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: origin,
  PSKILLS_PUBLIC_ORIGIN: origin,
  PSKILLS_BETTER_AUTH_AUTO_MIGRATE: 'false',
  PSKILLS_COMPANY_SSO_AUTO_MIGRATE: 'false',
  PSKILLS_API_TOKEN_AUTO_MIGRATE: 'false',
  PSKILLS_IDENTITY_OPERATIONS_EVENTS_AUTO_MIGRATE: 'false',
};
const infrastructure = createIdentityInfrastructure(environment, {
  postgresPool: pool,
  canonicalOrigin: origin,
  companySsoAutoMigrate: false,
  apiTokenAutoMigrate: false,
  operationsEventsAutoMigrate: false,
});
if (!infrastructure.identity) throw new Error('identity runtime did not initialize');
try {
  const plan = await getIdentityMigrations(infrastructure.identity);
  const compiled = await plan.compileMigrations();
  const digest = `sha256:${createHash('sha256').update(compiled).digest('hex')}`;
  console.log(JSON.stringify({
    planDigest: digest,
    toBeCreated: plan.toBeCreated.map(({ table, order }) => ({ table, order })),
    toBeAdded: plan.toBeAdded.map(({ table, fields, order }) => ({ table, fields: Object.keys(fields).sort(), order })),
    toBeAddedIndexes: plan.toBeAddedIndexes.map(({ table, name }) => ({ table, name })),
    unsafeChanges: plan.unsafeChanges,
    schemaProblems: plan.schemaProblems,
  }, null, 2));
} finally {
  await infrastructure.identity.close();
  await sql.end({ timeout: 5 });
}
EOF
```

Review every listed operation and the compiled SQL in the restricted local
review session before recording `migrationPlan.reviewed=true`. Record the
digest, target schema, dynamic table names, `unsafeChanges`, and
`schemaProblems` in sanitized evidence. Any unsafe change, unexpected schema,
custom token location, or non-public token alias blocks the change. A plan
with no operations is still evidence that the target already matches the
reviewed Better Auth models; it is not permission to enable identity.

## Explicit additive migration

After the root change owner approves the reviewed digest, run one controlled
Node migration process with the same environment and pool shape as the plan
command. Keep application instances fenced and keep startup auto-migration
off. The existing host entrypoint is the migration boundary:

```ts
await infrastructure.runMigrations();
```

It runs these operations in order:

1. Better Auth's `identity.runMigrations()` plan.
2. The private company SSO table migration.
3. The public `private_skills_service_tokens` migration.
4. The identity operations-event table migration and bounded cleanup.

The repository SQL uses `CREATE SCHEMA IF NOT EXISTS`,
`CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS` for the private
SSO, service-token, and operations-event boundaries. Better Auth's planner
must remain the source of its own additive operations. Run the composed
entrypoint once, then run the readback below. Do not enable traffic or create
a provider during the migration process.

The migration is intentionally idempotent: a retry after a connection failure
may rerun the same reviewed plan after checking its digest. It must not run a
different plan against the same window, and it must not move the public token
table into `I` to make a custom schema appear complete.

## Pre- and post-migration readback

Use a connection supplied in-process by the approved secret manager. The
following SQL is read-only and should be run before the migration and again
after it with the same `identity_schema` value. It emits table metadata and
bounded aggregates; it does not emit organization IDs, token hashes, registry
state, object bytes, credentials, or provider responses.

```sh
psql "$DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=identity_schema="${PSKILLS_BETTER_AUTH_SCHEMA:-public}" \
  --no-psqlrc <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE (table_schema = :'identity_schema'
       AND table_name = ANY (ARRAY['user','account','session','verification','organization','member','invitation','rateLimit','ssoProvider','private_skills_company_sso_providers','private_skills_identity_operations_events']))
   OR (table_schema = 'public'
       AND table_name = ANY (ARRAY['private_skills_service_tokens','private_skills_registry_state','private_skills_billing_customers','private_skills_billing_subscriptions','private_skills_billing_usage','private_skills_billing_webhook_events','private_skills_billing_usage_operations']))
ORDER BY table_schema, table_name;

SELECT table_schema, table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE (table_schema = :'identity_schema'
       AND table_name = ANY (ARRAY['user','account','session','verification','organization','member','invitation','rateLimit','ssoProvider','private_skills_company_sso_providers','private_skills_identity_operations_events']))
   OR (table_schema = 'public' AND table_name = 'private_skills_service_tokens')
ORDER BY table_schema, table_name, ordinal_position;

SELECT count(*) AS registry_rows,
       min(revision) AS minimum_revision,
       max(revision) AS maximum_revision,
       min(jsonb_typeof(state)) AS minimum_state_json_type,
       max(jsonb_typeof(state)) AS maximum_state_json_type,
       min(pg_typeof(state)::text) AS state_sql_type,
       min(octet_length(state::text)) AS minimum_state_bytes,
       max(octet_length(state::text)) AS maximum_state_bytes,
       min(md5(state::text)) AS minimum_state_digest,
       max(md5(state::text)) AS maximum_state_digest
FROM public."private_skills_registry_state";

SELECT count(*) AS service_token_rows,
       count(*) FILTER (WHERE revoked_at IS NULL) AS active_rows,
       count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked_rows,
       md5(coalesce(string_agg(token_hash, ',' ORDER BY id), '')) AS token_hash_set_digest
FROM public."private_skills_service_tokens";

SELECT expected_table,
       to_regclass(format('%I.%I', :'identity_schema', expected_table)) IS NOT NULL AS table_present
FROM unnest(ARRAY['private_skills_company_sso_providers','ssoProvider','private_skills_identity_operations_events']) AS expected(expected_table)
ORDER BY expected_table;

COMMIT;
SQL
```

For the supplied baseline, the expected registry readback is `registry_rows=1`
and both revision bounds equal to the freshly captured `BASELINE_REVISION` (the
supplied snapshot starts at `231`). If the fresh fenced capture has a different
authorized row count, record that count and compare it before and after instead.
The two state-type values, byte bounds, and bounded digest must match the
pre-migration capture. A mismatch means stop and keep identity disabled;
do not rewrite the state to make the check pass. The service-token table must
be in `public`, its token-hash-set digest and active/revoked counts must match,
and its revocation columns must still be present. After the identity tables
exist, run the direct count query below and confirm that private SSO and mirror
bindings agree when rows exist. With `providers: []`, no new row is expected.
Compare the billing counts and object inventory to the backup manifest even
though the identity migration does not own those stores.

If the selected `I` is `public`, the Better Auth tables and private identity
tables are unqualified public tables. If `I` is a custom schema, every
identity and private SSO table must be in that schema while the service-token
and registry tables remain public. A table found in both locations, or a token
table found in `I`, is a B27 stop.

After the post-migration presence check reports all three private identity
tables, compare their bounded row counts and provider bindings:

```sh
psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --set=identity_schema="${PSKILLS_BETTER_AUTH_SCHEMA:-public}" --no-psqlrc <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 'private_sso' AS boundary, count(*) AS rows
FROM :"identity_schema"."private_skills_company_sso_providers"
UNION ALL
SELECT 'sso_provider_mirror' AS boundary, count(*) AS rows
FROM :"identity_schema"."ssoProvider"
UNION ALL
SELECT 'identity_operations' AS boundary, count(*) AS rows
FROM :"identity_schema"."private_skills_identity_operations_events";
COMMIT;
SQL
```

If any of these tables is absent, stop and repair the migration before
releasing the fence. The pre-migration invocation must use the presence query
only; it must not assume that an identity-disabled deployment already has
these tables.

## Required order and activation gates

Keep the legacy bearer/session path available until the final traffic gate.
The preflight publishes this order:

1. Fence registry writes, identity adoption, service-token changes, billing
   webhooks, usage reservations, uploads, workers, and provider mutations;
   capture one complete encrypted recovery point.
2. Generate the Better Auth plan and review its dynamic operations; record its digest,
   operations, unsafe changes, schema, and table names.
3. Apply the reviewed company SSO schema through
   `IdentityInfrastructure.runMigrations()` once to the fenced target,
   with startup auto-migration disabled for every instance.
4. Prove service-token schema compatibility with the pre/post schema readback,
   including the public token location and B27 lookup. The local test proof
   below does not close the hosted target gate.
5. Read back registry state, billing metadata, and private sealed objects.
   Verify independent revisions, sizes, digests, grants, scan evidence, and
   required policy gates.
6. Adopt the existing default organization only through the explicit
   owner-authenticated action. Require a verified Better Auth user, a
   separately verified configured owner proof, a live owner membership, an
   atomic binding, an adoption marker, and replay-safe retry behavior.
7. Register each company provider through its server-owned organization
   binding and prove a real signed callback. Provider credentials and callback
   registrations are required at this point.
8. Run the two-company hosted `Request` matrix, including positive membership,
   token, SSO, registry, object, search, and worker checks plus foreign and
   revoked denials.
9. Switch traffic only after the report is ready and deployment, origin,
   provider callback, owner adoption, and legacy fallback have been read back.

Social first login, email-domain matching, organization display names, prompt
fields, request headers, and caller-selected issuer URLs cannot select or adopt
the default organization. The server-configured organization and verified
membership are the only tenant selectors.

## Local disposable proof

Use a new loopback PostgreSQL database or unique schema. The existing composed
test runs the real Better Auth, company SSO, public API-token, and operations
event migrations with auto-migration disabled, then verifies that a token
created in the public table remains usable when Better Auth uses a different
schema:

```sh
PSKILLS_IDENTITY_TEST_DATABASE_URL="$LOOPBACK_POSTGRES_URL" \
  node_modules/.bin/vitest run apps/web/src/company-sso-runtime.postgres.integration.test.ts
```

The fixture refuses non-loopback URLs, creates unique schemas, and drops only
those schemas. A passing local proof demonstrates the implementation contract
and idempotent composition. It does not prove production credentials,
provider callbacks, backup completeness, or hosted two-company isolation.

## Rollback and forward-fix

The migration is additive. If the plan or readback fails, leave identity
disabled, keep the fence active, retain the legacy deployment and session
path, and restore only into an isolated target when a restore is required. Do
not run an unreviewed down migration against populated Better Auth, SSO,
token, billing, or registry tables.

An interrupted `CREATE IF NOT EXISTS` sequence is retried with the same
reviewed plan after the target is read back. A missing column, index conflict,
schema drift, or mismatched SSO mirror is repaired by a reviewed forward fix.
If the token table is in a custom schema, stop and correct the runtime
configuration or write a separately reviewed data-preserving compatibility
plan; never copy or re-hash token material. If registry revision, state type,
state digest, billing counters, or object inventory changes, stop and compare
the recovery point before releasing the fence.

The rollback gate requires the previous deployment, a legacy smoke, the
bootstrap/session configuration, and a successful readback that public API
tokens remain available. A schema migration pass never authorizes traffic by
itself.

## Backup and two-company gates

The encrypted recovery point must cover Better Auth tables, private SSO and
its mirror, public service-token hashes and revocation state, billing and
webhook/idempotency state, registry metadata, and the private object
inventory. It must record a consistent availability fence, secret exclusion,
object digest verification, and legacy-access preservation. A registry-only
`private_skills_registry_state` dump is not a tenant backup.

After actual provider credentials and isolated test accounts are configured,
run the two-company matrix with equal display names and, where practical,
equal content digests. Record only bounded booleans, counts, and digests. Each
company must pass session membership, active organization, scoped token,
provider binding and callback, registry metadata, semantic search, sealed
object, and worker checks. Cross-company session switches, token use,
provider/issuer mismatches, registry reads, search, object reads, and worker
jobs must be denied before data or bytes are returned. Membership removal,
token expiry/revocation, expired assertions, and the legacy fallback must also
be observed.

Set `twoCompany.status` to `passed` only when both companies pass and every
cross-tenant denial is recorded without secrets. The current `providers: []`
baseline cannot satisfy this gate.

## External inputs and next action

| External input | What this checkout supplies |
| --- | --- |
| Name-only production inventory and safe switch values | Sanitized parsing, alias checks, explicit auto-migration gates, and no-value report generation |
| Reviewed dynamic plan, target schema, database readback, and change fence | Exact host migration order, public-token B27 check, and pre/post SQL readback |
| Existing default organization, verified Better Auth user, separate owner proof, and adoption readback | Explicit atomic/replay-safe adoption requirements; no first-user, email-domain, or header selection |
| Complete encrypted backup and private-object digest manifest | Durable-domain coverage and legacy-preservation checks |
| Provider credentials, callback registrations, and two-company accounts | Provider activation and cross-company `Request` matrix after schema readiness |
| Disposable loopback PostgreSQL URL | Actual local migration and public-token compatibility proof; non-loopback targets are rejected |

The next executable action is the local disposable proof above, followed by a
read-only target package containing the name-only inventory, migration-plan
digest/operations, and the pre-migration SQL readback. Do not run the explicit
production migration or change any production environment until the root
change owner has reviewed that package and approved the migration digest.
