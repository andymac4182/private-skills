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
