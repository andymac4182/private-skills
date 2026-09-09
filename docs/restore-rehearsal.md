# Restore rehearsal evidence

`tests/restore-rehearsal.test.ts` is a hermetic local rehearsal of the
metadata/object restore boundary. It writes a skill and sealed object through
the file adapters, copies both durable trees into fresh directories, and
reopens fresh repository and blob instances. The test verifies the original
artifact digest through direct storage reads, resolution, and transfer bytes.

It also covers the security fences around restore: unauthenticated requests
are rejected, a principal from another organization cannot resolve or mint an
authorization for the source tenant, a release revoked after restore blocks
new resolution and transfers, and a release revoked before a second backup
remains revoked in the restored copy while its blob still hashes to the
original digest.

The fixture explicitly uses `defaultRegistryState({ production: false,
allowUnscanned: true })` and does not create worker scanner evidence. This
local proof therefore does not certify restoration of required scanner results
or production policy evidence. A hosted rehearsal still needs isolated Neon
and object-storage backup/restore, hash/reference verification, and operator
checks before serving traffic.

## Planned hosted online-snapshot procedure

This procedure is planned only; it has not been run against the hosted Neon or
object store. The restore target must be a separate database, private storage
prefix, and temporary origin. It must not receive production traffic until the
checks below pass.

The current commit protocol does not require stopping ordinary publishes for a
logical restore of the state captured at revision `R`. PostgreSQL stores the
complete organization state in one JSONB row and commits the row update under a
row lock (`packages/database/src/postgres.ts:27-35,130-155`). Native publish and
import completion upload and read back a fresh sealed object before committing
the metadata pointer (`packages/core/src/index.ts:1393-1400,1433-1447` and
`packages/storage/src/files.ts:294-307`). The Files SDK store uses fresh random sealed keys and does not
reuse them for later writes (`packages/storage/src/files.ts:217-223,275-315`).
Consequently, later publishes can create newer keys and revisions without
changing an object referenced by the snapshot. An upload that has not yet
committed its metadata is an orphan and may be omitted from a referenced-state
restore.

The procedure still requires a deletion and lifecycle fence. The internal blob
gateway has an authenticated `DELETE` route (`packages/storage/src/http.ts:541-615`), and the storage adapter forwards removal to the provider
(`packages/storage/src/files.ts:353-357`). Before starting the copy, the
operator must prove that this route, retention/GC workers, and provider
lifecycle deletion cannot remove sealed objects for the entire copy window. If
that cannot be proved, use a provider snapshot or pause the API and workers.
Ordinary metadata publishes need not pause when this fence is in place.

1. Record the deployment revision, organization ID, state table, storage
   provider/prefix, active policy revision, and the fence start time. Keep this
   manifest free of credentials.
2. Capture `state` and `revision` for the organization from one PostgreSQL
   MVCC snapshot (a provider-consistent `pg_dump`, or an explicit read-only
   repeatable-read transaction). Call the captured metadata revision `R`.
3. Traverse the captured state and write a manifest of every referenced sealed
   key, digest, size, organization, release, pack member, and required scan
   association. Do not infer keys from a live listing; the metadata snapshot is
   authoritative.
4. Read each referenced source object, hash the exact bytes, and copy it to the
   isolated private target under the same key where the provider supports
   create-only writes. If key-preserving copy is unavailable, create an
   explicit key map and rewrite all references through the target's qualified
   atomic seed/import operation. A missing object or digest/size mismatch
   fails the rehearsal.
5. Restore the metadata snapshot into the isolated Neon database using an
   adapter-specific seed/import operation that can preserve revision `R`; a
   generic incrementing transaction is insufficient. Verify that its
   organization row is exactly revision `R`. Verify every manifest entry again
   through a fresh storage client before starting workers.
6. Start a temporary origin with the restored state and storage. Check health,
   authentication, organization isolation, policy/scanner gates, catalog
   resolution, artifact transfer digests, and both authorized and revoked
   transfers. Keep `allowUnscanned=false` for the hosted test; the local test's
   `allowUnscanned=true` fixture remains a stated limitation.
7. Release the deletion fence only after the manifest and authorization checks
   pass. Retain the source and target manifests and the exact captured `R` for
   rollback and investigation.

The local implementation is available as `scripts/restore-backup` (or
`node --import tsx scripts/restore-backup.ts`). It only wires the existing file
state and Files SDK adapters; it never deletes source or target objects. A
local rehearsal can be run with an explicit offline fence:

```sh
scripts/restore-backup backup \
  --organization restore-rehearsal-org \
  --state-dir ./work/data/state \
  --blob-dir ./work/data/blobs \
  --blob-prefix private-registry \
  --source-id local-source \
  --output ./work/restore-backup \
  --fence-evidence local-hermetic-test

scripts/restore-backup restore \
  --organization restore-rehearsal-org \
  --backup ./work/restore-backup \
  --target-state-dir ./work/restore-state \
  --target-blob-dir ./work/restore-blobs \
  --blob-prefix private-registry \
  --target-id local-isolated-target \
  --target-isolated true
```

The utility records exact source keys, digests, sizes, policy, revocations, and
metadata revision in a mode-`0600` manifest and stores object bytes under a
mode-`0700` directory. It bounds manifest/state/object reads, rejects
symlinked backup parents, and reads each target object back to verify its
digest and size before metadata is seeded. Its generic `BlobStore` restore path
may receive fresh target keys, so it records the key map and rewrites
references before the isolated metadata seed. A restore without an explicit
repository-specific empty-target seed is rejected before target reads or
writes: the portable transaction interface intentionally advances revisions
and cannot honestly import a captured revision. The local FileState seed
preserves revision zero as well as revisions greater than one, subject to the
caller’s isolated-directory attestation. That seed is an offline operation for
an exclusively owned destination; it is not a CAS mechanism for a concurrent
service or a live replacement database.

The local command requires existing or newly created private (`0700`) state and
blob directories. It accepts only qualified source/target locations and
rejects source, backup, and target roots that overlap. The command output is a
small status object and never includes manifest contents, keys, or credentials.
The default aggregate referenced-object budget is 512 MiB; API callers may
raise it only up to the bounded 2 GiB hard limit.

The manifest is private and mode-`0600`, but it is unsigned. The restore
utility therefore treats it as operator-trusted backup metadata and does not
claim that its policy, revision, or revocation fields are authenticated. The
SHA-256 checks establish that copied object bytes match the digest and size
recorded in that metadata; they do not authenticate the metadata itself. A
hosted rehearsal must establish source-snapshot and manifest provenance
through its separately authorized operator or provider workflow.

### Hosted acceptance criteria

- The target contains the captured organization metadata at exactly revision
  `R`; later source publishes do not alter the restored state or any copied
  sealed bytes.
- Every object reachable from a skill, pack member, active job, or required
  report in the captured state has the recorded key, size, and SHA-256 digest
  in the target. Missing or mismatched bytes remain unavailable.
- The deletion/GC/provider-lifecycle fence is evidenced for the whole copy
  window, or the rehearsal uses a provider-consistent snapshot instead.
- An unauthenticated request and a principal from another organization cannot
  read metadata, resolve releases, mint transfers, or obtain artifact bytes.
- Current policy, scanner evidence, lease fencing, and pre-capture revocations
  remain effective after restore; no worker starts before these checks pass.
- The result is documented as a logical referenced-state restore. Orphaned or
  otherwise unreferenced objects are handled by a separate retention/reconcile
  process, and a provider-wide exact inventory claim is not made.
