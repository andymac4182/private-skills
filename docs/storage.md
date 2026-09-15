# Files SDK storage and transfer portability

This is a proposed contract, researched on 9 September 2026. Files SDK is the required server-side storage abstraction; no backend or runtime combination is implemented or certified yet. The Rust CLI uses the registry's HTTP protocol, never provider credentials or a JavaScript runtime.

## Storage boundary

Put Files SDK behind an application-owned `BlobStore` interface. Domain services reference an opaque `storageRef`, SHA-256 digest, and byte size; they never depend on a bucket URL, provider ETag, or public path. Keep the provider's returned object identifier in the storage mapping so adapters with generated identifiers remain possible. Files SDK provides shared operations and web-standard bodies, separate provider entry points, and optional native SDK dependencies. Install and bundle only the selected adapter and its required peers. [Files SDK repository](https://github.com/haydenbleasel/files-sdk).

The minimum backend contract is private write, read, stat, and delete; durable retention until explicitly deleted; exact-byte retrieval; and access controls compatible with the role separation below. Listing is optional because PostgreSQL tracks object inventory. Store authoritative digest, size, ownership, retention, and scan associations in PostgreSQL; provider metadata is supplementary. ETags identify provider generations where supported and are not substitutes for cryptographic hashes.

`BlobStore` exposes private object creation, streamed reading, stat, and deletion, with optional transfer and range methods. An existing Files SDK adapter, a custom adapter, or a Files SDK gateway can satisfy the contract. Unsupported privacy or durability fails deployment validation. A public-only backend is unsuitable for private skills; URL obscurity does not satisfy privacy.

Capabilities refine the implementation without becoming universal prerequisites. Query `files.capabilities` for signing, ranges, multipart, metadata, server-side copy, and native conditional operations. Add application configuration and verified test results for privacy, runtime compatibility, limits, and grant expiry semantics; the SDK flags do not prove those properties. [Capabilities](https://files-sdk.dev/docs/capabilities).

## Immutable objects and publication

Use the same state machine for private publishing and upstream proxy acquisition:

1. Create a fenced ingestion attempt and a random quarantine upload target. Authorize only that attempt, expected source, tenant, operation, expiry, and permitted size. Upload completion is a claim requiring verification.
2. Trusted ingestion completely reads the candidate, enforces archive/extraction limits, and produces the canonical distribution bytes. Record the original digest separately if normalization changes the archive. Never execute uploaded code.
3. Before scanning, write those canonical bytes to a fresh, random, server-only **sealed object** for this attempt. Complete the write, independently retrieve/hash it, and record its digest and size. Clients never receive write access to that object. A durable attempt records the object key before provider I/O so a lost response can retry the same identity and verify its bytes.
4. Each isolated scanner receives read-only input independently verified against the sealed digest. Scanner identities cannot rewrite the object, publish versions, or issue ordinary download access.
5. After every required scan satisfies its policy, the trusted coordinator atomically commits the immutable version-to-object pointer and matching evidence in PostgreSQL, checking fencing, current permissions, policy, and revocation. Until this transaction succeeds, normal download routes deny the sealed object.

Publication changes database state only. It does not copy, rename, repackage, or rewrite scanned bytes. Optional later replication verifies the destination digest before a database pointer change, retains provenance, and never changes release identity. Neither a digest-shaped key nor a completed upload proves approval.

This protocol requires no native conditional write, atomic copy, or signed URL. Application writers allocate unique attempt objects, never overwrite sealed objects, and serialize publication through database constraints and fencing. Separate roles prevent upload holders and scanners from mutating sealed content; storage credentials remain trusted infrastructure credentials. Where a provider supports conditional create or exact reads, use them as additional protection. Files SDK rejects unsupported native conditions rather than emulating them with `exists()` followed by a write. Its documented conditional support is limited, including no default R2 or filesystem support. [Conditional operations](https://files-sdk.dev/docs/conditional-operations).

## Transfer contract

Both upload initiation and authorized downloads return a provider-independent descriptor. This download example is illustrative:

```json
{
  "mode": "gateway",
  "url": "https://transfers.example.invalid/v1/download",
  "method": "GET",
  "expiresAt": "2026-09-09T12:00:00Z",
  "headers": { "Authorization": "Bearer <opaque-transfer-grant>" },
  "size": 123456,
  "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rangeSupported": false
}
```

`mode` is `signed-url` or `gateway`; `url`, HTTP `method`, `expiresAt`, required `headers`, byte `size`, SHA-256 `digest`, and `rangeSupported` form the common contract. For upload initiation, size and digest are client-declared expectations; ingestion verifies them before trusting either. Multipart or POST-form extensions require an explicit negotiated contract. A Rust client follows only registry-approved HTTPS transfer destinations and never forwards its registry credential to storage. A dedicated transfer grant is distinct from that credential.

Prefer a private signed URL when the selected adapter can issue one with acceptable scope, lifetime, and response headers. Otherwise use an authenticated streaming gateway. Files SDK's Web-native gateway already supports redirect/proxy selection, but the registry supplies its own artifact and policy authorization; do not expose unrestricted generic Files API operations. [Gateway](https://files-sdk.dev/docs/ui/server/gateway).

An opaque download gateway grant expires after at most 60 seconds and references the complete authorization context: principal, tenant, namespace, immutable version/source, artifact/digest, operation, effective policy, and pack/install-plan identity where applicable. Every download request, including resumed requests, rechecks expiration, current access, publication, revocation, and whole-pack policy before reading bytes. Upload grants instead authorize the caller's still-open quarantine attempt, permitted write operation, limits, and expiry; they do not require an unpublished artifact to have a distribution approval. They become unusable after completion/sealing and never permit writes to sealed objects. An external gateway performs authenticated registry introspection and fails closed if authorization cannot be established. Never let callers substitute a storage key or digest to obtain another context's access.

Force attachment disposition, disable shared caching of grants/private responses, propagate cancellation, and bound requests. Revocation denies new requests immediately; an in-progress response or issued storage URL has a bounded race. Signed URLs can remain usable until expiry, so use gateway mode when the backend cannot meet the configured lifetime or request-time authorization requirement. The CLI always verifies the final digest before installation.

Do not assume `url()` means private signing: private Vercel Blob requires SDK downloads, Netlify Blobs has no URL primitive, and bare R2 bindings need HTTP credentials for signing. Some providers ignore requested expiry or use fixed lifetimes. Copy also varies and may buffer or transfer bytes through the process. None of these gaps permits switching private objects to public access. [Provider gaps](https://files-sdk.dev/docs/provider-gaps).

## Runtime placement and scanner hooks

Use `download(key, { as: "stream" })` explicitly; the default is Blob-backed. Advertise resumable ranges only when supported. Return the documented unsupported-range behavior instead of silently buffering an entire object. [Downloads](https://files-sdk.dev/docs/api/download).

The transfer gateway may share the Nitro deployment or run separately on suitable Node/container infrastructure when provider SDKs, payload limits, memory, or execution duration demand it. Edge APIs remain portable by delegating bytes over the same authenticated protocol. The Files SDK S3 documentation recommends its fetch-based adapter for edge runtimes where the AWS SDK's XML parsing is incompatible. [S3 adapter](https://files-sdk.dev/docs/adapters/s3).

The current `files-sdk/nitro` helper explicitly targets Nitro v2/h3 v1. For Nitro 3, use a verified bridge to the Web-native Files SDK handler rather than assuming that helper is compatible. [Nitro binding](https://files-sdk.dev/docs/ui/server/nitro).

Files SDK `onAction` and related observation hooks are fire-and-forget: their failure cannot reject the operation. Use them for telemetry, never required scanning. Registry scan hooks execute through the durable job/policy workflow and persist a decision before publication. [onAction](https://files-sdk.dev/docs/api/onaction).

## Backend conformance and operations

Certify each runtime/backend/transfer-mode combination against real infrastructure: unauthorized private reads fail; stored bytes round-trip exactly; upload interruption and stale-worker retries cannot change sealed objects; missing/failed scans deny downloads; wrong-context and expired grants fail; large transfers respect limits; and declared range/expiry behavior matches reality. Test revocation, cancellation, and digest verification through the native CLI.

Initial acceptance covers Node/container, Vercel, and an edge Nitro target, including private signed delivery and gateway fallback across different storage adapters. Additional Files SDK/custom adapters are eligible through the same suite. Interface compatibility alone is not a universal tested-support claim.

Track object references and retention holds transactionally. Collect abandoned attempts only after leases and retention expire; exclude published artifacts, active jobs, and required reports. Back up database mappings and private objects together, then restore and verify digests, access, and scan evidence before reopening distribution. Storage migration and cleanup must preserve the same approval boundary.

## Ambiguous write recovery

`RecoverableBlobStore` adds a stable prewrite key, same-key idempotent upload, and bounded object inspection. An upload that may have reached the provider remains an `orphaned` storage attempt with its metered reservation charged. The reconciler treats only a verified `absent` result after provider write termination is confirmed as safe to release; provider errors, timeouts, oversized reads, and digest mismatches remain `unknown` and retain the charge.

Recovery requires a dedicated operator capability (`private-skills:storage-recovery-operator`) and `storage:recovery` scope. Tenant owner/admin, scanner worker, and ordinary service credentials do not authorize it. A trusted platform proof that the writer failed or was terminated is required for every attempt. If the exact object is present, an operator must explicitly authorize cleanup and the reconciler reads it again to confirm absence before issuing the exact `{ storageBytes: 0 }` billing correction. A durable `recovering` fence makes the workflow resumable after a process crash; there is no age-based automatic deletion or billing release. Metadata references are checked under the organization transaction before claim and before release.

The Node/Nitro mount is `POST /internal/storage/recovery`. It accepts only
`attemptId`, `cleanupConfirmed`, and `resume`; the organization and proof are
server-derived. Configure the separate
`PSKILLS_STORAGE_RECOVERY_TOKEN` (or its SHA-256 hash) and
`PSKILLS_STORAGE_RECOVERY_ORGANIZATION_ID` to enable it. The runtime's proof
verifier requires the durable orphaned writer transition, or a failed
lease-free job for a pending attempt, and will not convert a still-pending
attempt to orphaned when a proof is rejected. Recovery also calls the
adapter's provider-specific `confirmWriteTerminated(key)` proof; an absent or
false result retains the attempt and charge because a rejected or timed-out
remote write may still materialize later. The adapter must return true only
after its provider can no longer create that key. A successful recovery first
persists a `releasing` metadata fence, then verifies/cleans the exact object,
records `billingCorrection: "release-pending"` before the external billing
zero, passes the captured billing reservation generation, and finally marks
the attempt released while clearing that marker. If a process dies after the
marker or billing call, a resumed reconciler keeps the marker and reuses the
same generation-bound correction key. It may settle the release only after an
exact durable ledger row is found; if a late metadata reference exists, it
requires that row before promoting the marker to `restore-pending` and applying
the ledger-owned inverse. A missing or unreadable ledger row retains the
charge and marker for a later retry. Attempts without a generation remain
retained unless the operator explicitly enables
`PSKILLS_STORAGE_RECOVERY_ALLOW_LEGACY_GENERATION`; the ledger still rejects a
reopened key.

If a metadata reference appears after the exact zero correction, the attempt is
marked `billingCorrection: "restore-pending"` in the same durable transition
that retains it. The preceding `release-pending` marker is never cleared by a
resume that merely observes metadata: the reconciler first reads the exact
generation-bound zero operation. Retries settle the inverse reservation under a
stable operation key bound to the original reservation generation (G1) before
clearing that marker. The ledger returns a fresh generation (G2); the storage
attempt persists G2 and removes the marker in one transaction. A lost response
retries the same G1 restoration operation, while a delayed G1 zero is rejected
and a later cleanup uses a G2-specific correction key. A failed or unknown
inverse leaves the marker and the original reservation charged.

The current Node factory does not claim this finality for any built-in provider.
The filesystem, S3, R2, GCS, Azure, and Vercel Blob Files SDK adapters expose
no provider-authoritative termination callback, so their recovery route remains
fail-closed and keeps the reservation charged. The HTTP adapter has the same
default: it can be enabled only when its gateway is constructed with a
`confirmWriteTerminated` callback backed by a provider-specific terminal
acknowledgement and writer fence. A host that cannot produce that evidence must
leave hosted recovery open; a local or custom adapter may implement the
callback after it has fenced the writer and received a provider-terminal
result. A missing, timeout, rejection, absent read, or operator assertion is
never a substitute for that result.
