# Storage recovery finality review

This is a sanitized, read-only review of the storage recovery verifier in the
`53a2d41` storage recovery working tree, with the provider classification from
`c5c0c06` and the original recovery workflow from `6981b6f`. No production
provider, database, or billing data was used.

The verifier in `packages/storage/src/recovery.ts:250-293` accepts an
`orphaned` attempt when its job is not queued or running. It also accepts a
`pending` attempt when its job is `failed` and has no lease token. The route
creates the `writer-terminated` reference itself
(`apps/web/server/routes/storage-recovery.ts:196-209`); that reference is not
a provider operation receipt.

## Provider finality gap

Core and authoring persist `orphaned` after a caught provider call
(`packages/core/src/index.ts:8035-8054` and
`packages/authoring/src/drafts.ts:298-315`). A timeout, rejected promise, or
local abort proves only that the caller stopped waiting. It does not prove
that a remote PUT was cancelled or cannot finish. A failed job with its lease
cleared is the same metadata fact, not proof that a provider request is
zombie-free. The stable object key and `recovering` token fence metadata
commit, but they do not cancel provider I/O.

Required delayed-write test, currently absent:

1. Hold a provider PUT after it has been accepted but before its promise
   settles.
2. Record the writer timeout/failure and the failed job with no active lease.
3. Run recovery and assert that it retains the attempt and makes no
   `{ storageBytes: 0 }` correction.
4. Complete the delayed PUT and assert that the exact object remains
   discoverable and the reservation remains charged.
5. In a separate positive case, provide an authoritative provider terminal
   failure/cancellation receipt bound to the attempt and assert that an absent
   read may then release it.

Without that terminal provider fact, a delayed PUT can complete after
recovery has released billing, leaving an untracked object and an undercount.
If the configured provider cannot expose operation finality or cancellation
acknowledgement, retention is the truthful result and the operator route must
offer a retry/reconcile action rather than release automatically.

## Billing/finalization race

`StorageRecoveryService.recover` applies the billing zero correction before
`#finalize("released")` (`packages/storage/src/recovery.ts:390-429`). The
finalization transaction can then discover a new metadata reference or a
replacement recovery token and return `metadata-referenced` or
`stale-recovery`. In either case the zero correction has already happened.

Required finalization-race test, currently absent:

1. Pause immediately after the idempotent billing correction returns.
2. Concurrently insert a reference to the attempt's object, or replace the
   recovery token through a second resume attempt.
3. Allow finalization to run.
4. Assert that the attempt is not released and that no unpaired zero
   correction remains. A safe implementation may retain the charge or record
   a durable compensating correction, but the retry must converge without a
   second unrelated charge mutation.

The existing restart test in `packages/storage/test/recovery.test.ts:282-306`
proves that a durable `recovering` marker can replay the same idempotent
correction after a crash. It does not cover a provider still writing, a
reference appearing between billing and finalization, or a stale recovery
token. The metadata-reference test at `:252-280` also runs before billing and
therefore does not cover this ordering race.

## Truthful proof contract

Before releasing, the runtime needs a provider-authoritative terminal receipt
or operation query (failure or cancellation) whose operation identity is
durably bound to the exact organization, storage-attempt ID, stable object
key, digest, and writer/job fencing generation. It must then perform the
absent check, or delete and recheck an exact present object. A failed local
promise, an `orphaned` flag, a failed job, or an absent result from one read
cannot substitute for that proof. The verifier should also reject a stale
job/lease generation or any replacement work for the same attempt.

The durable recovery marker and same-key billing operation remain useful for
restart recovery, but only after provider operation finality is established.
Hosted/S3/Blob provider operation finality remains open at this snapshot.

Review status: the delayed-write and billing/finalization tests above are
required closure tests and were not run in this docs-only review. No product
code was changed here.
