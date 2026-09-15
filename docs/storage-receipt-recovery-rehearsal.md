# Storage receipt recovery rehearsal

This is a bounded local rehearsal for the known-completed storage-write path.
It is pinned to source `f4eea80d4d9ffa228c9e450fa53ae5942cfb383c` and does not
execute the hosted recovery route. The executable is
[`scripts/storage-receipt-recovery-rehearsal.ts`](../scripts/storage-receipt-recovery-rehearsal.ts),
and the companion PostgreSQL-gated test is
[`packages/storage/test/recovery.receipt.postgres.integration.test.ts`](../packages/storage/test/recovery.receipt.postgres.integration.test.ts).

Run it only with a disposable loopback PostgreSQL URL. The helper rejects
non-loopback hosts, creates uniquely named state and billing tables, and drops
those tables in its `finally` path. It creates a temporary Files SDK
filesystem root; no existing registry state or provider object is used.

```sh
PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL='postgresql://<credentials>@127.0.0.1:<port>/<disposable-db>' \
PSKILLS_RECEIPT_REHEARSAL_SOURCE_SHA='f4eea80d4d9ffa228c9e450fa53ae5942cfb383c' \
pnpm exec tsx scripts/storage-receipt-recovery-rehearsal.ts
```

The URL is consumed in process and is never printed. The output is sanitized:
it contains the loopback host, unique local table names, the non-secret local
provider binding, and short object-key fingerprints, but no credentials,
temporary paths, artifact bytes, or receipt tokens. The test form is:

```sh
PSKILLS_RECEIPT_REHEARSAL_DATABASE_URL='postgresql://<credentials>@127.0.0.1:<port>/<disposable-db>' \
PSKILLS_RECEIPT_REHEARSAL_SOURCE_SHA='f4eea80d4d9ffa228c9e450fa53ae5942cfb383c' \
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

The hosted target is recorded for a future operator review:

| Target | Value | Current operation |
| --- | --- | --- |
| Vercel registry project | `prj_vw4QlLtnsPaZm8mtms1HuDqpSNti` | no mutation |
| Vercel Blob store | `store_C0EMhnU7DH3uSMaw` | no upload or delete |
| Rehearsal prefix | a newly generated `rehearsal/<nonce>/` prefix | must be checked with a read-only exact-prefix listing first |

The next hosted step, after root review, is a names/counts-only read using the
in-process production Blob credential: generate a fresh prefix, list that
prefix, and record zero matches without printing keys or credentials. A future
hosted rehearsal would then require an awaited upload and verified receipt,
an operator-owned provider finality record, an independently read-back object,
and explicit cleanup authorization. The local result does not establish a
Vercel Blob deletion, billing, or production-route acceptance claim.

The exact machine-readable scope and expected assertions are in
[`docs/evidence/storage-receipt-recovery-rehearsal-proposal-20260916.json`](evidence/storage-receipt-recovery-rehearsal-proposal-20260916.json).
