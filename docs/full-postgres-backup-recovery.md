# Full PostgreSQL backup and isolated restore proof

`scripts/full-postgres-backup-recovery-proof.mjs` is a bounded operator proof
for the current hosted registry. It does not change the hosted database,
Vercel environment, deployment, or Blob store.

Run it from this checkout with the linked Vercel project available:

```sh
node scripts/full-postgres-backup-recovery-proof.mjs
```

The script lists project environment metadata, selects the single
`DATABASE_URL` entry whose target includes `production`, and fetches that
entry by its environment-variable ID. The connection value stays in Node
process memory. It is never accepted as an argument, printed, written to the
repository, or placed in Docker arguments. Docker receives the parsed
`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, and `PGSSLMODE` names
through its child environment.

The source connection opens `REPEATABLE READ READ ONLY`, exports a PostgreSQL
snapshot, records the non-system base-table catalog, row counts, row digests,
and registry representation, then passes that snapshot to `pg_dump` from the
pinned `postgres:18` image. The dump is custom format and includes the whole
database-local dumpable object set; it is encrypted as a streaming
AES-256-GCM file with a freshly generated 32-byte key. The key, encrypted dump,
and mode-0600 manifest are created beneath a fresh directory outside the
checkout. The output reports their paths, never the key value.

The encrypted file is decrypted to a mode-0600 temporary file, its plaintext
and ciphertext digests are checked, and it is restored with `pg_restore` into a
new loopback-bound `pgvector/pgvector:pg18` container. The target image keeps
the source `vector` extension available while retaining PostgreSQL 18 tooling.
The target catalog, row counts, row digests, identity-table coverage, and
registry SQL/JSONB driver shape and revision must match the source snapshot.
The table row digests use PostgreSQL's deterministic `md5` aggregate and the
manifest also records SHA-256 digests for the encrypted dump, plaintext dump,
and registry digest set.
The new target container is retained for inspection; existing containers and
source data are not removed or changed.

The committed evidence file records the actual table catalog and bounded row
digests, the encrypted/plaintext sizes and digests, source snapshot fence,
target container, and the exact coverage limits. It deliberately excludes row
payloads, token hashes, registry JSON, database URLs, provider credentials,
and environment values.

The proof covers PostgreSQL database-local schema/data and the current
identity, semantic-index, and registry tables. `pg_dump` does not carry
cluster-global roles, tablespaces, provider-side configuration, Files SDK Blob
objects, billing-provider state, identity-provider credentials, or deployment
environment values. Those stores require their own recovery evidence. A
nonzero result is blocked evidence; retain any reported isolated target and
encrypted artifact for diagnosis and do not treat it as a migration gate.

## Forward migration recovery proof

After the read-only backup proof, a separate local check cloned the retained
14-table PG18 target into one new loopback `pgvector/pg18` container and ran
the reviewed additive billing SQL from
`packages/billing/migrations/0001_billing_schema.sql` at commit `ac87e31`.
The SQL digest was `sha256:4386cbcd2982545c14ea9df580a34a5fb052c2441c0e8369c779c9dec851d880`
and its length was 4,705 bytes. The migration ran in one local transaction
with `search_path` set to `public, pg_catalog` and `ON_ERROR_STOP` enabled.

The current billing shape verifier
`validateBillingCreationReadback` (from the runner lineage at `77194d0`)
accepted five empty billing tables with 51 columns, 13 checks, and 9 physical
indexes. The resulting 19-table catalog retained the original 12 identity
tables, two semantic-index rows, and the registry row at revision `232` with
its `jsonb` SQL type and observed JSONB string representation. Its row digests
matched the retained template. See
[`full-postgres-forward-billing-recovery-20260916.json`](evidence/full-postgres-forward-billing-recovery-20260916.json).

This is a local forward-recovery proof. It does not apply billing SQL to
production, create billing/provider rows, enable identity, change Vercel
configuration, or modify Blob objects. The new target is retained for
inspection; existing containers and data remain untouched.
