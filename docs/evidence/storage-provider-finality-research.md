# Storage provider finality research

This is a read-only review of the current provider surfaces used by the
storage recovery work. It covers the pinned `@vercel/blob@2.8.0` package, the
Files SDK Vercel Blob and S3 adapters, AWS S3, and the general S3-compatible
case. Documentation was checked on 2026-09-16. No provider credentials or
production requests were used.

## Findings

| Provider/path | Operation identity and status | Cancellation/finality | Safe recovery decision |
| --- | --- | --- | --- |
| Vercel Blob single `put` | The [current `put` reference](https://vercel.com/docs/vercel-blob/using-blob-sdk#put) returns object metadata (`pathname`, URL, ETag, and related fields). No public operation-status or abort handle is described. | [`abortSignal`](https://vercel.com/docs/vercel-blob/examples#aborting-requests) cancels the SDK request. The docs do not promise that a remote PUT accepted by the service is prevented from committing after the caller aborts. | Treat timeout, abort, and lost response as unknown and retain the attempt. A missing `head`/`get` is an observation, not a terminal write receipt. |
| Vercel Blob multipart | The [SDK reference](https://vercel.com/docs/vercel-blob/using-blob-sdk#multipart-uploads) describes create/upload/complete and the pinned package exposes `createMultipartUpload`, `uploadPart`, and `completeMultipartUpload`. The public API/source checked has no documented `abortMultipartUpload` or operation-status method. | An abort signal only stops the SDK call. No Vercel Blob control-plane receipt for cancellation or eventual completion is documented for this server upload path. | Retain unless Vercel supplies a provider-specific terminal operation receipt. Do not infer finality from a single absent read or from `del`. |
| AWS S3 single `PutObject` | [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html) returns request/object metadata, not a durable upload ID or status query. `If-None-Match: *` is useful for create-only fencing but does not settle a timed-out request. | HTTP/SDK cancellation is a client concern. A success response means the complete object was stored; an error or lost response does not identify whether the request committed. | Retain an ambiguous attempt. Reconcile the exact key and checksum; release only on a provider-specific terminal failure/cancel proof, which this API does not expose. |
| AWS S3 multipart | Initiation returns an `uploadId`; [AbortMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html) prevents new parts, but AWS states that in-flight parts may still succeed or fail and recommends `ListParts` verification. | This is a provider-specific drain mechanism, not an instantaneous cancellation receipt. AWS's [multipart procedure](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) says to stop only after part uploads have completed and that parts are billed until complete or stop. | After all locally owned part calls have settled, abort, repeat as needed, and require `ListParts` empty. If any part call remains ambiguous or the provider check cannot be performed, retain. Check the exact object separately before release. |
| S3-compatible endpoint | “S3-compatible” does not define one set of semantics. The Files SDK [S3 adapter](https://files-sdk.dev/docs/adapters/s3) and its [conditional capability rules](https://files-sdk.dev/docs/conditional-operations#capabilities-and-current-support) deliberately do not inherit AWS claims for custom endpoints. | Operation IDs, abort behavior, conditional headers, and listing consistency must be established from that endpoint's own documentation and conformance test. | Default to unknown-retained. Enable automatic release only for a named provider whose abort/status contract and delayed-write test are recorded. |

Vercel Blob is S3-backed, but that does not make the AWS S3 multipart control
plane available through the Blob API. The [Vercel package source](https://github.com/vercel/storage/blob/main/packages/blob/src/index.ts)
currently exposes the three multipart calls above, while the local pinned
package has no abort export. This is an API-surface observation, not a claim
that Vercel can never add such a feature.

## Files SDK interpretation

The [Files SDK cancellation contract](https://files-sdk.dev/docs/cancellations)
guarantees that an `AbortSignal` fails the Files call quickly, while whether
the adapter cancels the underlying provider request depends on that adapter.
An aborted or timed-out call therefore remains ambiguous at the provider
boundary. The [receipts contract](https://files-sdk.dev/docs/receipts) emits a
receipt for successful mutating calls only; an absent receipt is not a failure
receipt.

The SDK does expose a useful positive signal. If an awaited plugin throws after
`next()` has observed a provider commit, the resulting `FilesError` carries
`applied: true` (and `appliedEtag` for an upload), and exact readback is the
correct reconciliation. The same [conditional-operations guidance](https://files-sdk.dev/docs/conditional-operations#hooks-receipts-and-terminal-outcomes)
explicitly says that a provider mutation cannot be rolled back and that a
network response can be lost after commit. `applied: true` proves a commit;
its absence after a network timeout proves neither commit nor non-commit.

## Smallest actionable recovery design

1. Persist an `unknown-retained` state for every timeout, abort, connection
   reset, failed job, or lost response that could have reached the provider.
   Bind the record to the organization, storage-attempt ID, stable object key,
   expected digest/size, writer generation, provider kind, and any provider
   request correlation or multipart `uploadId`. A local lease or rejected
   promise is not the provider fence.
2. On a successful provider result, read the exact private object and verify
   digest and byte count before committing the metadata reference. On
   `applied: true`, do the same exact read and do not retry the create-only
   mutation. A present object with the wrong digest remains held for operator
   action.
3. On recovery, fence the attempt's writer generation, cancel the local task,
   and wait for every locally owned task to settle. For an AWS MPU with a
   recorded `uploadId`, abort after that drain, repeat abort if necessary, and
   poll `ListParts` until empty. Only then can the provider-specific MPU
   cleanup be considered sufficient to stop part-storage billing. This does
   not generalize to Vercel Blob or arbitrary S3-compatible endpoints.
4. For Vercel Blob single PUT/multipart and AWS single PUT, where no documented
   provider operation-status or cancellation proof is available, keep the
   byte reservation and expose a manual reconcile/retry path. A time-based
   drain window, failed job, absent read, or local `AbortSignal` alone must not
   issue a zero-byte billing correction.
5. Keep billing correction and metadata release fenced by the same attempt
   generation. Durable release intent precedes the external zero correction;
   the attempt is marked released only after correction success. If a
   reference or newer generation appears during finalization, retain the
   charge or record a compensating correction rather than leaving an unpaired
   release.

## Required closure tests

These are implementation tests for the owning storage/billing/runtime work;
they were not run by this docs-only review:

- A delayed single PUT is accepted by a fake provider, the caller times out,
  recovery sees no object, and the provider completes later. The attempt must
  remain charged and the late object must not become an untracked release.
- A Files SDK call returns `aborted` without `applied`; a delayed provider
  completion must still be retained. A separate `applied: true` case must
  reconcile by exact read and avoid a second create.
- An AWS MPU has a part in flight while abort runs. The harness must drain
  owned part tasks, repeat abort as required, observe `ListParts` empty, and
  only then permit cleanup. An unresolved part keeps the reservation.
- A custom S3-compatible endpoint with no verified abort/finality capability
  follows the unknown-retained path even when one `head` reports absence.
- Billing correction succeeds, then a newer reference or recovery generation
  appears before finalization. No unpaired zero correction may remain.

At this snapshot the current Files SDK/Vercel adapter has no provider-authoritative
single-PUT finality hook. Hosted Vercel Blob and unverified S3-compatible
provider recovery remain open; the AWS MPU procedure is the only bounded,
provider-documented cleanup path identified here.
