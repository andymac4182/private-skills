# Billing PostgreSQL schema migration review

This is a review package for billing schema candidate `900bc3e680093d9c3dd10790eab9ce1b24e71bc1`. It contains no hosted DDL, environment update, provider call, or production row payload. A targeted read-only production readback was obtained through the authenticated Vercel project environment-variable API; the credential was held in process memory and never printed or written to a file.

The byte-for-byte migration artifact is [`0001_billing_schema.sql`](../../packages/billing/migrations/0001_billing_schema.sql). It is generated from the authoritative [`billingPostgresSchemaSql()`](../../packages/billing/src/repository.ts#L571-L710) helper and is checked against it by [`schema-migration-review.test.ts`](../../packages/billing/test/schema-migration-review.test.ts). The checked-in manifest is [`0001_billing_schema.manifest.json`](../../packages/billing/migrations/0001_billing_schema.manifest.json).

The default-prefix SQL digest is `sha256:4386cbcd2982545c14ea9df580a34a5fb052c2441c0e8369c779c9dec851d880` and its UTF-8 length is 4,705 bytes. Its additive inventory is:

| Operation | Count | Effect |
| --- | ---: | --- |
| `CREATE TABLE IF NOT EXISTS` | 5 | Creates customer, subscription, usage, webhook-event, and usage-operation relations |
| `ADD COLUMN IF NOT EXISTS` | 7 | Adds three usage seat-lifecycle columns and four operation lifecycle/generation columns to older tables |
| guarded `ADD CONSTRAINT` | 2 | Adds usage-operation status and generation checks when the target relation does not already have the named constraint |
| `CREATE INDEX IF NOT EXISTS` | 2 | Adds organization/time indexes for webhook events and usage operations |

There are no `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, or `INSERT` statements in the artifact. The SQL is additive, but `IF NOT EXISTS` does not validate an already existing relation's shape. A production preflight must compare columns, nullability/defaults, primary/unique keys, checks, and indexes and stop on drift or invalid legacy data before accepting traffic. The helper adds the new operation checks for an existing relation; checks declared inside an already existing table are not retrofitted by `CREATE TABLE IF NOT EXISTS`.

The relation contract is:

| Relation | Columns | Primary key | Unique key | Checks | Explicit indexes |
| --- | ---: | --- | --- | --- | --- |
| `private_skills_billing_customers` | 5 | `organization_id` | `(provider, customer_id)` | — | implicit primary/unique indexes |
| `private_skills_billing_subscriptions` | 14 | `organization_id` | `(provider, subscription_id)` | `event_created_at >= 0`; `source = 'verified-webhook'` | implicit primary/unique indexes |
| `private_skills_billing_usage` | 11 | `organization_id` | — | period order; non-negative seats, bytes, scans, Eve cents, baseline, revision; reservations JSON must be an array | implicit primary index |
| `private_skills_billing_webhook_events` | 9 | `(provider, event_id)` | — | `created_at >= 0` | `(organization_id, received_at DESC)` |
| `private_skills_billing_usage_operations` | 12 | `(organization_id, operation_key)` | — | status is `reserved`, `committed`, or `released`; generation is at least 1 | `(organization_id, created_at DESC)` |

`organization_id` is application-owned tenant identity. There are deliberately no cross-domain foreign keys in this migration. The nullable webhook `organization_id` preserves unbound verified events for global replay/idempotency history; a migration must not filter those rows by company.

The executable review utility is [`schema-migration-review.ts`](../../packages/billing/scripts/schema-migration-review.ts). `--manifest` prints only expected schema metadata. `--inspect-env DATABASE_URL` performs a repeatable-read, read-only catalog and row-count readback; it does not select row payloads or print connection details. If matching tables are split across schemas, it reports `ambiguous` instead of combining them into a false complete result. A missing environment is reported as `{ "configured": false, "readOnly": true }`. The initial local absence check was:

```sh
env -u DATABASE_URL pnpm exec tsx packages/billing/scripts/schema-migration-review.ts --inspect-env DATABASE_URL
```

That local check returned `configured: false`; it was not used as a claim about hosted availability. The later targeted Vercel readback used the production-scoped `DATABASE_URL` record by project/environment-variable ID and returned the following sanitized baseline:

| Target fact | Readback |
| --- | --- |
| Billing schema status | `absent` |
| Billing relations found | 0 of 5, across all schemas |
| Expected relation names missing | all five default-prefix relations |
| Current schema / search path | `public`; `"$user", public` |
| Billing row payload selected | no |
| Schema digest | `sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |

Because no expected billing relation exists, the reviewed additive SQL is applicable at the billing-relation level and would create the relations in the default `public` namespace under the current search path. This is a readiness finding, not permission to run it: the production change still requires an encrypted backup, migration owner lock, write/webhook fence, and a final preflight immediately before application.

`PostgresBillingRepository` defaults `autoMigrate` to `false` at [`repository.ts:958`](../../packages/billing/src/repository.ts#L947-L969). The Node composition now reads `PSKILLS_BILLING_AUTO_MIGRATE`: it defaults to `false` in production and `true` only for development/test convenience, with `true` as an explicit production migration-window opt-in at [`runtime-node.ts:397`](../../apps/web/server/runtime-node.ts#L371-L410). For a populated multi-instance production database, the reviewed rollout should apply the static SQL once under the migration owner and fence, then leave this flag unset or false. The review also records the current schema digest because there is no database schema-version row.

The loopback proof ran against the separate disposable PostgreSQL fixture on `127.0.0.1:55432` with its password read in memory. The URL and password were omitted from output. The utility creates unique schemas and drops them in a `finally` block. It does not accept a non-loopback URL in rehearsal mode.

Observed result:

| Check | Result |
| --- | --- |
| Catalog readback | `ready`; 5/5 billing relations, 51 columns, 13 checks, 9 physical indexes (including primary/unique indexes) |
| Populated migration loop | Passed across three reruns; all five tables populated; row digests unchanged |
| Unbound webhook retention | Passed; two event rows, including one with null organization, preserved |
| Isolated logical backup/restore | Passed; all five populated relations copied into a separately migrated schema with identical row digests |
| Existing legacy upgrade | Passed; an older schema missing seat/operation lifecycle columns retained all original row counts and stable-column digests after the additive helper ran |
| Transaction rollback | Passed; an intentional failed migration transaction left zero objects in the isolated rollback schema |

The observed populated row-manifest digest for the last run was `sha256:276b2eaae7506a3012c107bc1883539a9bcb1b188bf856eb503d1e76bad9b148`. The rehearsal's temporary physical table names are randomized, so this value identifies that run's logical row snapshot rather than serving as a universal fixture constant. It is a local logical row-digest proof, not a replacement for the encrypted provider backup required for production. `pg_dump` was unavailable in the review shell; the production change window must still capture a consistent encrypted backup covering identity, SSO, service tokens, all billing relations, registry state, and sealed objects, with its operator-visible manifest stored outside this repository.

The production recovery decision is forward-only for populated data. If code is incompatible while this additive schema is present, redeploy the last compatible application and leave the expanded tables in place. If the migration or data readback is partial, fence registry writes, identity mutations, uploads, metered jobs, billing webhooks, and provider callbacks; retain the backup and redacted readback; then either apply a reviewed forward fix or restore the complete isolated snapshot. Do not run a destructive down migration, manually reassign provider/customer or webhook rows, or delete billing operations to make a check pass. Restore usage-operation generations and webhook event IDs intact so retries remain idempotent and old callbacks stay fenced.

Billing metering can be enabled before a Stripe account through the explicit providerless production posture: durable PostgreSQL, `PSKILLS_BILLING_ENABLED=true`, and `PSKILLS_BILLING_METERED_EVALUATION=true`. The service then enforces the finite provisional free-plan limits while checkout, portal, invoice-provider reads, and webhooks remain unavailable. The checked-in Free, Team, and Business allowances are engineering fixtures; they are not approved public prices or launch entitlements. The runtime rejects the local billing adapter in production; `PSKILLS_BILLING_PROVIDER=local` is accepted only with the explicit non-production test flag. No local payment adapter should be enabled in the hosted production environment during this migration review.

Before any hosted migration, the owner still needs an actual encrypted backup identifier, a write/webhook fence, an external migration lock/change window, and post-apply two-company authorization and metering checks. This package is evidence for that review gate, not an approval to run hosted DDL.
