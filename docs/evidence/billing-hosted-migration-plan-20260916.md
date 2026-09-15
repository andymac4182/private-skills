# Hosted billing schema migration plan

This package is a review-only, plan-only execution path for the additive billing PostgreSQL schema. It did not execute hosted DDL, change an environment variable, enable billing or metering, call Stripe, or select a payment adapter. The targeted production `DATABASE_URL` was obtained through the authenticated Vercel environment-variable API by ID, held in process memory, and omitted from all output.

The exact reviewed SQL is [`0001_billing_schema.sql`](../../packages/billing/migrations/0001_billing_schema.sql), with SHA-256 `sha256:4386cbcd2982545c14ea9df580a34a5fb052c2441c0e8369c779c9dec851d880` and UTF-8 length 4,705 bytes. The static execution manifest is [`0001_billing_hosted_execution.manifest.json`](../../packages/billing/migrations/0001_billing_hosted_execution.manifest.json), and the runner is [`prepare-hosted-migration.ts`](../../packages/billing/scripts/prepare-hosted-migration.ts).

The runner defaults to `--plan`. It opens a repeatable-read, read-only transaction, sets `statement_timeout` to 15 seconds, `lock_timeout` to 3 seconds, and `idle_in_transaction_session_timeout` to 30 seconds, sets the session search path explicitly to `public, pg_catalog`, and acquires the transaction advisory lock for `private-skills.billing-schema.v1`. While holding that lock it records the namespace, all 12 known identity relation counts, the registry row/revision/type/size/digest summary, and the complete billing catalog readback. It then closes that transaction and repeats the readback on an independent read-only connection.

The targeted production plan passed with the following bounded observations:

| Domain | Result |
| --- | --- |
| Billing relations | All five absent across the catalog; no billing rows or webhook history exist |
| Identity relations | All 12 found in `public`; total row count 0 |
| Registry | `public.private_skills_registry_state`, one row, revision 232, `jsonb` state, 2,395,620 bytes |
| Namespace | Current schema `public`; explicit runner path `public, pg_catalog` |
| Independent readback | Stable against the locked baseline |
| Plan decision | `ready`; exact additive SQL applicable at the relation level |
| Hosted DDL | Not executed |

The apply branch is guarded by the exact operator confirmation
`PSKILLS_BILLING_MIGRATION_CONFIRM=APPLY_PRIVATE_SKILLS_BILLING_SCHEMA_20260916`, `--apply`, and a required `--baseline-output PATH`. Its transaction first repeats the locked preflight and requires the five relations to be absent, then runs the byte-pinned SQL. Before commit it validates all 51 columns, including names, PostgreSQL types, nullability, and defaults; all 13 check definitions; primary/unique constraints; all 9 physical indexes, including index columns and definitions; and zero rows. It also asserts that identity and registry baseline metadata stayed unchanged. Any validation failure aborts the transaction and rolls back the DDL. After commit it uses a separate read-only connection and requires the same complete shape and empty-row result.

The baseline writer creates a mode `0600` local artifact containing bounded catalog metadata, identity/registry counts, and digests. The current artifact is explicitly `encrypted: false` and contains no credentials or row payloads. It is evidence for the migration review and is not a replacement for an external provider-consistent encrypted PostgreSQL/object backup. The production change window still needs that backup, a migration owner lock, a write/webhook fence, and a final preflight immediately before any apply. Because the target has no billing relations or billing data, this package does not invent a destructive fence or webhook-history migration.

The focused package tests passed: eight tests across the hosted-plan and schema-review suites, TypeScript typechecking passed, and `git diff --check` passed. The separate disposable loopback rehearsal remains recorded in [`billing-schema-migration-review-20260916.md`](billing-schema-migration-review-20260916.md); this package does not claim hosted mutation evidence.
