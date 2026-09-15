# Tenant operations readiness

This runbook records the migration, backup, restore, rollback, and monitoring
boundary for the multi-tenant service at commit
`4016c4b024e13fb55b1cf1375bc998330a3ad0c1`. It is an operations review of the
current source tree. It does not represent a hosted migration, a production
restore, or a release approval.

The decision for this revision is **no release on operations evidence**. The
repository has useful local identity, billing, tenant-routing, scanner, and
registry/object tests, plus an opt-in local rehearsal that restores the
current Better Auth, SSO, service-token, billing, registry, and object state
for two companies. It still does not prove a restored Better Auth and billing
database serving two companies through the deployed `Request` runtime. The
hosted restore artifact remains registry/object-only, and the local rehearsal
uses the Files SDK filesystem adapter rather than the selected hosted
provider. A green registry restore cannot substitute for identity,
membership, session, SSO, service-token, billing, or usage restoration.

The existing Eve model setting is retained: `PSKILLS_REVIEW_MODEL` defaults to
`openai/gpt-5.6-luna` in `apps/reviewer/agent/lib/config.ts` and
`docs/eve-reviewer.md`. This audit does not change that model, the AI Gateway,
or a provider credential. Eve cost reservation and provider reconciliation are
part of the billing/runtime adoption work owned by the corresponding finish
agents.

## What is in the current system

The service has several durable stores with the same logical tenant key but
separate migration and recovery lifecycles. They must be backed up and
validated together:

| Boundary | Current store or planner | What an operator must preserve |
| --- | --- | --- |
| Better Auth identity | Better Auth `1.7.5` and `getIdentityMigrations(runtime)` in [`packages/identity/src/index.ts`](../../packages/identity/src/index.ts) | Users, provider accounts, sessions, verification records, organizations, members, invitations, and database rate-limit records for the configured plugin set. |
| Company SSO | [`private_skills_company_sso_providers`](../../packages/identity/src/company-sso-repository.ts), created by `companySsoSchemaSql()`, plus the Better Auth `ssoProvider` mirror when the bridge is adopted | The explicit provider-to-organization binding, protocol configuration, revision, provider status, and the exact mirrored Better Auth row ID. Both stores must be restored or reconciled together. |
| Scoped service credentials | [`private_skills_service_tokens`](../../packages/api-tokens/src/index.ts) | Tenant, user, role ceiling, scopes, expiry, hash, and revocation state. The raw token is never recoverable from a backup. |
| Registry metadata | [`private_skills_registry_state`](../../packages/database/src/postgres.ts) | Per-organization JSON state, revision, grants, releases, scans, audit, and object references. |
| Billing | The five tables emitted by `billingPostgresSchemaSql()` in [`packages/billing/src/repository.ts`](../../packages/billing/src/repository.ts) | Customer and subscription mappings, usage periods, webhook idempotency/event history (including unbound events), and usage reservation operations. |
| Sealed objects | The configured private object provider | The immutable object bytes and provider metadata addressed by the registry references. Postgres state alone cannot restore them. |

The current Better Auth plugin configuration uses the core and organization
models `user`, `account`, `session`, `verification`, `organization`, `member`,
and `invitation`. Database rate limiting adds the `rateLimit` model. The
planner is dynamic: a future plugin, a configured `schemaName`, or a model
override can change the physical table names. Before a migration, inspect the
actual `getIdentityMigrations(runtime)` result for that deployment and record
the schema name and plan digest. A hand-written list is a review aid, not a
replacement for the planner.

There are deliberately no assumed foreign keys between the identity,
company-SSO, service-token, billing, and registry tables. Their
`organization_id`/organization identity is an application invariant checked by
the runtime. A database restore is incomplete when rows exist in one boundary
but the corresponding organization or membership is absent in another.

The SSO bridge in integration commit `01a365083e7bbe055464cfdb37205ef8f35e1b0f`
mirrors the private company row into Better Auth's `ssoProvider` model and
preserves the registry row ID for the callback reference fence. The bridge is
not present in the audited `4016c4b` tree, so the current audit records this as
an adoption dependency. Once that bridge is integrated, a backup or restore
that contains only `private_skills_company_sso_providers` is incomplete: the
private row and `ssoProvider` mirror must have matching provider ID,
organization ID, owner, configuration fingerprint, and row ID. A callback
proof is also required; a persisted mirror alone does not prove a signed SSO
assertion.

## Evidence at this revision

The following evidence is available locally and is bounded as described:

| Evidence | Result | Boundary and limitation |
| --- | --- | --- |
| `packages/identity/test/index.test.ts`, `apps/web/src/identity-infrastructure.test.ts`, and `apps/web/src/tenant-runtime.test.ts` | Passed in the targeted local run below | Exercises configuration, membership lookup, tenant routing, cache isolation, and header-spoof rejection. It does not run a real PostgreSQL Better Auth migration. |
| `packages/billing/test/index.test.ts`, `tests/billing-routes.test.ts` | Passed in the targeted local run below | Exercises provider-neutral billing state, tenant-derived billing routes, idempotency and role checks. It does not connect a live billing provider or restore billing tables. |
| `tests/restore-rehearsal.test.ts` and `tests/restore-rehearsal-postgres.test.ts` | Passed in the targeted local run below | Covers the registry/object restore adapter and PostgreSQL preflight. The hermetic fixture uses `allowUnscanned: true`; it is registry-only and does not prove Better Auth, company SSO, service tokens, or billing recovery. |
| `docs/evidence/hosted-restore-20260910.json` | Records source revision `114`, five referenced objects, and digest/size checks | This is a sanitized isolated logical restore of registry metadata and referenced objects. It records operator quiescence, not a provider lifecycle guarantee, and did not start a restored public origin or scanner. |
| `tests/operations-postgres-rehearsal.test.ts` | Passed with a loopback-only disposable PostgreSQL URL in the audit follow-up | Migrates unique Better Auth source/target schemas, mounts the adopted SSO schema, copies every current identity table including a `ssoProvider` mirror row, the private SSO row, service-token row, all five billing tables, registry state, and sealed-object bytes through the real `files-sdk/fs` adapter in separate temporary source/target roots. It verifies row and object manifests with `FilesSdkBlobStore.getVerified`, session and membership authorization, token revocation, billing mappings/reservations, and a restored two-company `Request` flow from resolve through install authorization, download descriptor, and exact-byte transfer digest; the foreign company's object and metadata are denied. The audited `4016c4b` runtime does not compose the bridge, and this test uses a local filesystem provider plus direct table copy, so callback/runtime wiring and hosted provider recovery remain open. |
| `packages/identity/test/postgres.integration.test.ts`, `packages/identity/test/company-sso.postgres.integration.test.ts`, and `packages/billing/test/postgres.integration.test.ts` | Not run in the local proof because their opt-in database environment variables were unset | These are the required next disposable-PostgreSQL exercises for Better Auth, SSO, token, and billing persistence. No production credentials belong in the test environment or its output. |
| `docs/business/launch-acceptance.md` | The audited launch matrix had obsolete Better Auth acceptance links; integration follow-up `2bbfe28` replaced them with `apps/web/src/tenant-identity-route.postgres.integration.test.ts` and `tests/e2e/multi-tenant-postgres-acceptance.test.ts` | The reference gap is recorded as resolved by the follow-up. The replacement PostgreSQL proofs still do not close hosted runtime, provider, or full backup/restore acceptance. |

The read-only consistency check for this runbook is
[`scripts/validate-operations-readiness.mjs`](../../scripts/validate-operations-readiness.mjs):

```sh
node scripts/validate-operations-readiness.mjs
node --test tests/operations-readiness.test.mjs
```

The validator reads the runbook and the current schema/runtime anchors. It
does not connect to a database, call a provider, send a callback, read a
credential, mutate application data, or perform a backup. A passing validator
shows that this document still names the current code boundaries; it is not a
hosted acceptance result.

The full PostgreSQL and object-provider rehearsal was run with
`PSKILLS_OPERATIONS_POSTGRES_URL` set by a local password-file wrapper to the
disposable loopback database, and with the password and URL value kept out of
output. The command run inside that wrapper was:

```sh
node_modules/.bin/vitest run tests/operations-postgres-rehearsal.test.ts
```

When the opt-in variable is absent, this test reports skipped. That is an
intentional safe default and must be reported as missing evidence rather than
as a successful restore.

The object side of this local proof uses the actual `files-sdk@2.4.0`
`files-sdk/fs` adapter via `createNodeFilesClient({ provider: "fs", root })`.
The source and target roots are unique temporary directories; the test copies
the sealed keys into the target provider, reads them back with
`FilesSdkBlobStore.getVerified`, and then downloads the restored tenant A
artifact through the registry authorization route to verify its exact bytes
and SHA-256 digest. It also attempts the tenant B artifact with tenant A's
authorization and verifies a stable denial without exposing the foreign
digest. No provider double is involved. This remains a local filesystem
provider proof, not S3, R2, Vercel Blob, or hosted-origin recovery.

## Migration procedure

Run the following as a reviewed change with an owner, a recorded change window,
and a clean rollback decision. Keep `PSKILLS_BETTER_AUTH_AUTO_MIGRATE=false`
for multi-instance deployments. The explicit migration path is the default;
the identity documentation allows auto-migration only for a controlled single
process.

1. **Preflight and fence writes.** Record the application revision, configured
   Better Auth version and schema name, `getIdentityMigrations(runtime)` plan
   digest, company-SSO/API-token/billing/registry table names, object-provider
   version, and a backup manifest identifier. Quiesce tenant writes and webhook
   consumers or install an equivalent provider-supported fence. The fence must
   cover registry writes, identity adoption, service-token changes, billing
   webhooks, usage reservations, uploads, and Eve jobs.
2. **Review the identity plan.** Generate the Better Auth plan from the running
   `IdentityRuntimeAdmin`, review every create/alter/index operation and any
   unsafe change, then run the web host's
   `IdentityInfrastructure.runMigrations()` once before accepting traffic.
   That entrypoint applies Better Auth, company SSO, and service-token schemas
   in order, using the configured table names and the explicit API-token schema
   option when one is supplied. The Better Auth and private SSO tables follow
   `PSKILLS_BETTER_AUTH_SCHEMA`; service-token storage remains public by
   default for compatibility. Apply additive expand/contract changes for
   populated tables. Never infer a migration from the old registry table, and
   never run an unreviewed destructive down migration against a populated
   identity database.
3. **Apply the remaining application schemas.** Create the billing and registry
   tables using their current schema helpers and configured names, then record
   the resulting schema version and indexes. If a deployment does not use the
   web host composition, run the reviewed company SSO and API-token helpers
   separately before accepting those routes. These helpers have opt-in
   `autoMigrate`; ownership of when they execute belongs to the migration
   runner.
4. **Adopt the existing organization explicitly.** If the old `default`
   organization is retained, use the explicit bootstrap-owner action described
   in [`docs/identity.md`](../identity.md). Require the authenticated owner,
   create the Better Auth organization and membership, and record the adoption
   marker in the same controlled operation. Do not adopt by email domain,
   display name, browser header, prompt field, or first social login. Do not
   copy the default builder, upload-reviewer, consolidation, scanner, or
   provider credential into a new organization.
5. **Map billing identities.** Migrate customer and subscription rows only
   through an owner-reviewed organization mapping. Enforce the provider and
   identifier uniqueness constraints. Preserve the complete webhook event
   ledger, including rows with a null organization (unbound events are part of
   the global replay/idempotency history). Preserve usage snapshots and
   operation keys. Never choose a tenant from an unverified browser selector or
   from provider metadata alone. Billing cost reservation and entitlement
   wiring remains a separate adoption gate.
6. **Migrate registry and objects.** Use the existing registry/object procedure
   in [`docs/restore-rehearsal.md`](../restore-rehearsal.md) with immutable
   object keys, digest and size checks, grant and scan history, and the required
   scanner policy. A migration must not set a required release to an
   unscanned state or make an Eve publish/scan call bypass admission.
7. **Read back before traffic.** Check table existence, schema/version, row
   counts by organization, uniqueness and index constraints, organization IDs
   across identity/SSO/tokens/billing/registry, object digests, revocation and
   expiry fields, and redacted logs. Verify that the target has no tenant rows
   without a corresponding organization/membership policy. Keep the fence until
   the two-company matrix in the restore section passes.

## Backup contract

Capture one consistent recovery point for all durable domains. A PostgreSQL
logical backup containing only `private_skills_registry_state` is a valid
registry backup but is not a tenant backup. At minimum the manifest must name:

- Better Auth tables produced by the actual planner for the deployed options:
  `user`, `account`, `session`, `verification`, `organization`, `member`,
  `invitation`, `rateLimit`, and (when the company SSO bridge is enabled)
  `ssoProvider` for this configuration. `account` can contain
  provider access/refresh/id token material; encrypt the backup, restrict
  access, and treat it as secret-bearing even though the application redacts
  those fields from responses.
- `private_skills_company_sso_providers`, including the organization binding,
  provider ID, protocol configuration, status, and revision. Keep OIDC/SAML
  client secrets out of manifests and logs; rotate them after an incident or
  when a restore target is shared.
- Better Auth's `ssoProvider` mirror when commit `01a3650` is adopted. Restore
  it with the private row as one consistency unit: matching row ID,
  `providerId`, `organizationId`, owner, and configuration fingerprint. If the
  mirror cannot be read back exactly, keep SSO disabled and reconcile through
  the server-owned bridge; never let a browser callback select a different
  provider row.
- `private_skills_service_tokens`, preserving token hashes and revocation/expiry
  state. Do not export raw bearer tokens. Prefer revoking or rotating restored
  credentials until the target has passed its access checks.
- `private_skills_billing_customers`,
  `private_skills_billing_subscriptions`,
  `private_skills_billing_usage`,
  `private_skills_billing_webhook_events`, and
  `private_skills_billing_usage_operations`. The webhook event table has a
  provider/event primary key and can contain an unbound event; do not filter it
  to a selected company when creating a recovery point.
- `private_skills_registry_state`, plus the object-provider inventory or
  immutable sealed prefixes referenced by the registry. Verify object digest
  and byte size before making metadata visible.
- Deployment, policy, scanner, model, and provider configuration metadata
  required to reproduce behavior, with secret values replaced by names or
  digests. Include migration plan/version, backup timestamp, fence status,
  object prefix, and row-count/digest summaries.

For a full-environment recovery, retain global identity uniqueness and all
users/accounts/sessions that can be referenced by memberships. For a
per-company recovery, decide before the incident whether shared users are
copied with their full account graph or re-established through a new login.
Do not create dangling Better Auth memberships by filtering only rows whose
organization ID matches the selected company. Preserve global provider/event
uniqueness and document any intentionally cleared sessions, rate-limit rows,
or pending invitations.

The backup should be encrypted in the provider's supported mechanism, have a
mode-restricted manifest, and be restorable by an operator who is authorized
for the tenant and the identity/billing stores. Never put a database URL,
client secret, session cookie, API token, OIDC assertion, webhook body, or
artifact/report content in this repository, a CI log, or a third-party model
prompt.

## Isolated restore rehearsal

Restore into a new database, object prefix, and temporary origin. Do not write
the live database or live object provider while testing. The restore order
should preserve Better Auth relationships and application invariants:

The executable local rehearsal uses the real Files SDK filesystem adapter
(`files-sdk/fs`) with separate temporary source and target roots. It copies
immutable object keys into the target provider, validates both target objects
with `getVerified`, and exercises the restored tenant route through
authorization, descriptor, and transfer. The local fixture sets
`allowUnscanned: true` only to keep the rehearsal deterministic; this is not a
scanner-admission or hosted-provider result. S3, R2, Vercel Blob, and the
deployed runtime still require their own isolated proof.

1. Create the target schema and run the reviewed Better Auth migration plan.
2. Restore `user` rows and the related `account`, `session`, and `verification`
   rows. If the session secret, base URL, or trust boundary changes, invalidate
   sessions and require fresh login. Restore `rateLimit` deliberately, or
   clear it with an explicit cold-start decision and record that choice.
3. Restore `organization`, `member`, and `invitation` rows; verify every member
   points to an existing user and organization. Restore company SSO providers
   and, when enabled, their Better Auth `ssoProvider` mirrors with matching
   IDs/configuration. Restore service-token hashes/revocations only after the
   organization mapping is fixed.
4. Restore billing customers, subscriptions, usage, the complete webhook
   event ledger, and usage operations. Reconcile entitlements from verified
   provider state and preserve idempotency/event keys. Do not replay a webhook
   merely because a subscription row is missing from a partial target.
5. Restore registry state and sealed objects. Validate revisions, grants,
   required scanner evidence, digest, and byte size before enabling reads.
6. Start the temporary origin and read-only worker last. Keep writes,
   outbound billing callbacks, SSO provisioning, and Eve provider calls
   disabled until checks pass. Rescan stale required evidence through the
   normal admission path; do not use the local restore fixture's
   `allowUnscanned: true` setting as hosted proof.

Before enabling any restored route, call the Better Auth `getSession` path and
read back the active membership from the target database. A healthy HTTP
response without that membership check is not tenant authorization evidence.

The acceptance matrix must use two companies with equal display names and equal
content digests where possible. For each company, verify:

- a Better Auth session resolves the intended organization and a live member
  lookup denies a removed or foreign member; switching the active organization
  cannot select a company without membership;
- a service token is accepted only for its organization, role ceiling, scope,
  expiry, and non-revoked state; a tenant or service mismatch is a generic
  denial before registry/object access;
- an SSO callback is selected by a server-owned provider-to-organization
  binding, with the private SSO row and Better Auth `ssoProvider` mirror
  matching, and with an expired or invalid assertion denied; callback headers
  and prompt text cannot replace the binding;
- the billing customer/subscription and usage rows resolve to the same
  organization, duplicate and out-of-order webhook events remain idempotent,
  and a reservation cannot consume another company's seats, storage, scans, or
  Eve cents;
- builder, upload-reviewer, consolidation, worker, source, search, download,
  grant, release, and Eve callback paths use the fixed tenant binding. A foreign
  draft, review, token, object, or callback returns a stable denial without
  opening the object. Required scanner admission and Eve publish policy remain
  active;
- restored objects have the expected digest and size, and registry revisions
  are independent for the two companies.

The target is incomplete if only the registry/object checks pass. Record target
database/schema identifiers, migration plan/version, row counts by tenant,
object manifest digests, check results, and the exact limitations. Keep the
target isolated until the evidence is reviewed, then destroy it through the
provider's supported lifecycle controls.

## Rollback and forward-fix

Application and configuration rollback is separate from database rollback.
Before traffic, record the deployed revision, migration plan/version, backup
manifest, object prefix, fence, and operator. If code fails while the schema is
compatible, redeploy the previous compatible revision and keep the additive
schema. Do not assume a down migration is safe after rows have been populated.

If Better Auth, SSO, service-token, billing, or registry state was partially
migrated, stop writes and webhook consumption, retain the evidence, and choose
one reviewed path:

- keep the expanded schema and deploy a compatible forward fix; or
- restore the complete isolated snapshot (identity, membership, SSO, tokens,
  billing, registry, and objects) and switch the application only after the
  two-company matrix passes.

Never edit registry JSON to repair an identity or billing mismatch. Never
manually reassign a provider customer, subscription, webhook event, or token to
another organization to make a check pass. Preserve provider/event idempotency
when retries arrive out of order. Rotate restored account-provider secrets,
SSO secrets, and service credentials when the target crosses a trust boundary.

Rollback must leave the old origin available for comparison and must record
which events were fenced, accepted, ignored, or replayed. Required scanner
failures continue to deny distribution throughout a rollback; a 503 or paused
worker is not permission to publish.

## Monitoring and incident response

`/health` is a liveness signal. It does not prove that a tenant has a valid
Better Auth membership, a usable SSO binding, a current billing entitlement, or
an intact registry/object reference. The launch monitor needs checks at each
boundary:

| Signal | Examples | Response owner/action |
| --- | --- | --- |
| Migration drift | Planner changes, missing Better Auth table/index, schema-version mismatch, failed migration lock | Hosting/Identity: fence writes, stop rollout, compare plan and backup manifest. |
| Tenant authorization | Session or active-membership denial spikes, tenant/service mismatch, revoked/expired token use, callback provider mismatch | Identity/Runtime: deny the request, revoke affected credentials, disable the affected tenant/provider, preserve redacted evidence. |
| SSO | Invalid/expired assertions, provider status changes, callback failures, provisioning errors | Identity: disable the provider or tenant binding, rotate secrets, require fresh login. |
| Billing | Webhook signature/replay/duplicate/stale/unbound counts, webhook backlog, reconciliation drift, provider mapping conflict, reservation conflict | Billing: pause billing mutations or affected provisioning, preserve event keys, reconcile from verified provider state. |
| Usage | Seats, storage bytes, scans, and Eve cost cents near cap; negative/duplicate operation; reservation latency | Billing/Runtime: reject at a stable cap response, repair forward, never meter against another organization. |
| Registry/object | Revision conflict, grant denial, digest/size mismatch, missing sealed object, object-provider 5xx | Registry/Operations: keep object private, stop release/download, restore or repair through the normal grant/scanner path. |
| Workers/scanners | Queue age, lease expiry, retry growth, stale required evidence, scanner admission failure, callback poll timeout | Worker/Release: pause affected jobs, rescan through admission, keep required release blocked. |
| Eve/provider | Gateway/provider errors, model selection mismatch, timeout, token/cost reservation failure, spend near the Eve cents cap | Eve/Billing: fail closed, refund/reconcile only through the billing hook, preserve `openai/gpt-5.6-luna` as the configured default unless a reviewed deployment changes it. |

Metrics should carry a tenant dimension where operators need isolation
visibility, with bounded cardinality and no secrets. Logs should contain stable
error codes, operation class, deployment revision, and aggregate counts. Do
not log cookies, authorization headers, raw tokens, provider secrets, account
credentials, SSO assertions, webhook bodies, source text, report contents, or
sealed object bytes. Alert on trends and counts rather than raw tenant names or
high-cardinality identifiers.

For a suspected cross-tenant incident, immediately deny the affected request
class, revoke or rotate the affected service credentials, disable the affected
SSO/provider binding or tenant, stop worker/provider calls if needed, and keep
the scanner and publish gate closed. Preserve the migration/backup/event
identifiers and redacted logs. Re-enable traffic only after the authorization,
billing, and object checks pass in an isolated target or a reviewed forward
fix.

## Ownership and adoption seams

This document records the operations contract; it does not wire the remaining
runtime paths.

| Owner | Adoption seam | Required evidence |
| --- | --- | --- |
| `runtime_finish` | `apps/web/server/runtime.ts`, `runtime-node.ts`, `identity-infrastructure.ts`, and the tenant-runtime composition/migration invocation | Actual `Request` runtime uses verified Better Auth membership or scoped service credential before it creates a fixed-company handler; no new company receives default credentials; migration readiness is exposed to the launch gate. |
| `billing_finish` | Billing provider/test-mode mapping, usage and Eve cost reservation hooks, reconciliation, and route composition | Test-mode webhook and reservation proof with tenant-derived organization; no provider selector from browser/prompt; complete event/idempotency readback. |
| Eve/runtime adoption | Tenant-bound service helper and builder/upload-reviewer/consolidation callback integration | Service and tenant claims match the fixed binding; missing/expired/foreign credentials fail closed; prompts and callback headers cannot choose a tenant; scanner admission and publish policy remain mandatory. |
| Hosting/Operations | Migration runner, backup provider, isolated restore target, monitoring, alert owners, and retention | Disposable PostgreSQL Better Auth/SSO/token/billing restore, two-company `Request` proof, object restore, rollback/forward-fix rehearsal, and live alert readback. |

The explicit remaining actions are:

1. Attach a redacted schema/version and migration-plan readback from the
   disposable PostgreSQL planner run. The audit rehearsal now exercises the
   planner and unique source/target schemas locally, but it emits no launch
   artifact and has no hosted migration record.
2. Repeat the consistent backup and isolated restore with the integrated
   runtime and selected hosted object provider. The local rehearsal now covers
   Better Auth, private company SSO and the `ssoProvider` mirror schema from
   `01a3650`, service tokens, all billing tables (including unbound webhook
   events), registry state, and sealed objects through the real Files SDK
   filesystem adapter. Decide the shared-user and global-event policy for
   per-company restores before a hosted drill.
3. Run the two-company restored-origin matrix through the actual `Request`
   runtime, including session, active membership, token, SSO, billing, usage,
   registry, object, scanner, and Eve callback behavior.
4. Complete billing test-mode provider/reconciliation and cost reservation
   adoption, then repeat the restore proof with those hooks enabled.
5. Add named monitoring owners, alert thresholds, retention, and a live
   migration/webhook/worker/model-budget incident drill.
6. Keep the resolved launch-acceptance references pointed at the actual
   PostgreSQL tests, and retain their explicit baseline/hosted limitations until
   they exercise the deployed runtime.

Until these actions have evidence, retain the no-release decision for
operations readiness.
