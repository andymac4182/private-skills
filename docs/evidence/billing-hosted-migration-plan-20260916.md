# Hosted billing schema migration plan and apply

This package records the reviewed plan and the subsequent authorized apply of the additive billing PostgreSQL schema. The migration did not change an environment variable, enable billing or metering, call Stripe, or select a payment adapter. The targeted production `DATABASE_URL` was obtained through the authenticated Vercel environment-variable API by ID, held in process memory, and omitted from all output.

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
| Hosted DDL | Applied once after the plan passed; independent post-commit readback passed |

The apply branch is guarded by the exact operator confirmation
`PSKILLS_BILLING_MIGRATION_CONFIRM=APPLY_PRIVATE_SKILLS_BILLING_SCHEMA_20260916`, `--apply`, and a required `--baseline-output PATH`. Its transaction first repeats the locked preflight and requires the five relations to be absent, then runs the byte-pinned SQL. Before commit it validates all 51 columns, including names, PostgreSQL types, nullability, and defaults; all 13 check definitions; primary/unique constraints; all 9 physical indexes, including index columns and definitions; and zero rows. It also asserts that identity and registry baseline metadata stayed unchanged. Any validation failure aborts the transaction and rolls back the DDL. After commit it uses a separate read-only connection and requires the same complete shape and empty-row result.

The first guarded apply attempt rolled back before commit because the verifier initially counted catalog `NOT NULL` pseudo-constraints and expected sort direction in the index column list. The portable verifier fix was committed as `fd1e26dfde5da4efac18143a414a819c18b766ae`; the regression fixture now covers both cases. A deliberate PostgreSQL 18.6 transaction probe passed the full shape gate and rolled back, and the next fresh-preflight apply committed successfully with runner `77194d0f893387f53f2e325c806f48816c72ad84`.

The baseline writer created a mode `0600` local artifact containing bounded catalog metadata, identity/registry counts, and digests. The apply artifact is explicitly `encrypted: false` and contains no credentials or row payloads. The separate full encrypted backup/restore gate passed before apply: evidence commit `38915216d289afed66c608c9fe8e42a98137c4a0`, AES-GCM backup reference SHA-256 `b395c43c40c21facb50f6474e89d078f59f49bab8a51333e5773da78edcf77dc`, 590,279 bytes, and mode `0600`; its isolated restore matched 14 relations, 12 empty identity relations, two semantic-search rows in one table, and registry revision 232. The local baseline artifact remains metadata evidence and is not a replacement for that encrypted backup.

The focused package tests passed: eight tests across the hosted-plan and schema-review suites, TypeScript typechecking passed, and `git diff --check` passed. The final billing-focused run passed 60 tests across six files. The independent post-apply readback reported `ready`, five public relations, 51 columns, 13 checks, 9 indexes, zero billing rows, zero identity rows, and registry revision 232. The separate disposable loopback rehearsal remains recorded in [`billing-schema-migration-review-20260916.md`](billing-schema-migration-review-20260916.md).
