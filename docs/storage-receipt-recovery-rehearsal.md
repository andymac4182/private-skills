# Storage receipt recovery rehearsal

This package contains a bounded local rehearsal and a separately guarded
hosted Blob executor for the known-completed storage-write path. The local
executable is
[`scripts/storage-receipt-recovery-rehearsal.ts`](../scripts/storage-receipt-recovery-rehearsal.ts),
and the companion PostgreSQL-gated test is
[`packages/storage/test/recovery.receipt.postgres.integration.test.ts`](../packages/storage/test/recovery.receipt.postgres.integration.test.ts).

Run it only with a disposable loopback PostgreSQL URL. The helper rejects
non-loopback hosts, creates uniquely named state and billing tables, and drops
those tables in its `finally` path. It creates a temporary Files SDK
filesystem root; no existing registry state or provider object is used.

```sh
PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL='postgresql://<credentials>@127.0.0.1:<port>/<disposable-db>' \
PSKILLS_RECEIPT_REHEARSAL_SOURCE_SHA='49f31eace58149e5d7b4349a0465012f0facde39' \
pnpm exec tsx scripts/storage-receipt-recovery-rehearsal.ts
```

The URL is consumed in process and is never printed. The output is sanitized:
it contains the loopback host, unique local table names, the non-secret local
provider binding, and short object-key fingerprints, but no credentials,
temporary paths, artifact bytes, or receipt tokens. The test form is:

```sh
PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL='postgresql://<credentials>@127.0.0.1:<port>/<disposable-db>' \
PSKILLS_RECEIPT_REHEARSAL_SOURCE_SHA='49f31eace58149e5d7b4349a0465012f0facde39' \
pnpm exec vitest run packages/storage/test/recovery.receipt.postgres.integration.test.ts
```

The positive scenario follows the production boundary through core: it
reserves storage in the PostgreSQL-backed `BillingService`, records a stable
attempt, awaits a private Files SDK upload and readback, and then injects a
metadata commit failure. Core persists the orphan and the verified write
receipt. A newly constructed Files SDK client and BillingService use the same
temporary root and database tables. Recovery accepts the receipt only because
its provider binding, key, digest, and size match the current attempt; it
deletes the exact object, verifies the provider reports it absent, settles the
exact billing generation, and marks the attempt released.

Two negative scenarios use the same real adapters. An object with no receipt
has no provider termination proof and remains present and charged. A
structurally valid receipt bound to an older provider identity is rejected
before provider cleanup; that object also remains present and charged. The
assertion that billing reaches zero is therefore attached only to the
verified-receipt scenario.

The hosted target is recorded for operator review:

| Target | Value | Current operation |
| --- | --- | --- |
| Vercel registry project | `prj_vw4QlLtnsPaZm8mtms1HuDqpSNti` | no mutation |
| Vercel Blob store | `store_C0EMhnU7DH3uSMaw` | no upload or delete |
| Rehearsal prefix | a newly generated `rehearsal/tenant-runtime/<uuid>/` prefix | must be checked with a read-only exact-prefix listing first |

The read-only probe has been run against the current production store. It
reported a private `syd1` store with 27 blobs and 7.77 MB, and the fresh prefix
`rehearsal/tenant-runtime/ccd57459-a52e-4175-a317-4503e557d726/` had zero
matches. The sanitized readback is in
[`docs/evidence/hosted-storage-receipt-readonly-20260916.json`](evidence/hosted-storage-receipt-readonly-20260916.json).

The concrete hosted execution path is prepared in
[`scripts/hosted-storage-receipt-recovery-rehearsal.ts`](../scripts/hosted-storage-receipt-recovery-rehearsal.ts).
It first writes a local plan containing a fresh exact prefix, sealed object
key, payload digest, provider binding, and store ID. Its guarded execute mode
rechecks that the exact prefix is empty, uploads through the private
`vercel-blob` Files SDK adapter, awaits the readback, persists the verified
receipt into the local disposable PostgreSQL state, restarts the client, and
uses the same recovery service and PostgreSQL `BillingService` to delete and
recheck the exact object. It separately runs no-receipt and binding-mismatch
retention cases. The mode refuses hosted mutation unless the operator passes
the explicit execution acknowledgement; it has not been run here. The local
result and this prepared route do not establish a Vercel Blob deletion,
billing, or production-route acceptance claim.

Generate a plan without contacting Vercel or PostgreSQL. Commit the resulting
JSON for review, then run the execute command only with a fresh plan and a
loopback disposable PostgreSQL URL. The database URL is read from the process
environment so it does not appear in a command-line argument or the JSON
evidence. Run the hosted command from the linked Vercel project directory so
`vercel env run -e production` supplies the private Blob credential:

```sh
pnpm exec tsx scripts/hosted-storage-receipt-recovery-rehearsal.ts \
  --source-sha 49f31eace58149e5d7b4349a0465012f0facde39 \
  --write-plan docs/evidence/hosted-storage-receipt-rehearsal-plan-20260916.json

PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL='postgresql://<credentials>@127.0.0.1:<port>/<disposable-db>' \
PSKILLS_ALLOW_HOSTED_STORAGE_RECEIPT_REHEARSAL=I_UNDERSTAND_NEW_PREFIX_ONLY \
vercel env run -e production -- \
  /absolute/path/to/worktree/node_modules/.bin/tsx \
  /absolute/path/to/worktree/scripts/hosted-storage-receipt-recovery-rehearsal.ts \
  --execute-plan /absolute/path/to/worktree/docs/evidence/hosted-storage-receipt-rehearsal-plan-20260916.json \
  --write-evidence /absolute/path/to/worktree/docs/evidence/hosted-storage-receipt-rehearsal-20260916.json
```

Execution refuses a non-loopback database, a plan for any other project/store,
an existing object under the exact fresh prefix, or a missing acknowledgement.
The recovery client is wrapped with the same exact-key guard as the writer. If
upload, metadata persistence, recovery, or local cleanup fails, the executor
keeps its generated PostgreSQL tables and emits
`mode: "hosted-recovery-failure"` with the exact table names, organization,
prefix, object key, and provider binding. Inspect that manifest and durable
attempt before retrying. Tables are dropped only after object absence, zero
storage billing, released metadata, and the negative retention cases have all
been verified.

The execute path mutates only the new plan object in the private store and its
temporary local PostgreSQL tables. It does not use the production registry
database, existing registry objects, token rows, provider rows, or default
registry state. A verified receipt is minted only after the provider upload
and exact readback succeed; an unknown outcome or binding mismatch remains
retained and charged.

The exact machine-readable scope and expected assertions are in
[`docs/evidence/storage-receipt-recovery-rehearsal-proposal-20260916.json`](evidence/storage-receipt-recovery-rehearsal-proposal-20260916.json).
