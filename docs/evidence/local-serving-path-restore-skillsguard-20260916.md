# Local serving-path restore with pinned SkillsGuard

Observed `2026-09-16T00:56:57Z` from the local restore rehearsal at commit
`c4d93750fcc4711a0bd4ca9fa74073d221096279`. The machine-readable result is
[`local-serving-path-restore-skillsguard-20260916.json`](local-serving-path-restore-skillsguard-20260916.json).

The rehearsal passed the bounded positive serving path. It copied the retained
PostgreSQL recovery target into a disposable clone, read the existing 11
private Blob objects through Files SDK, materialized their exact sealed keys in
a disposable filesystem root, and verified all bytes and digests. A local Nitro
Node process then served the restored registry against that clone and storage.

The probe first demonstrated the real restored policy gate: the selected
fixture returned `needs-rescan` / `evidence-stale`, with files and resolve both
returning `404 NOT_AVAILABLE`. A generated local publisher credential queued
`POST /v1/skills/:id/rescan`; the normal `WorkerRunner` claimed that exact job,
downloaded the artifact through the worker lease route, and invoked
`DockerExecutor` with the pinned `private-skills/skillsguard:1.1.1` image:

```text
image id: sha256:4173ec0a31e37a572b94f88cb596e8b76aa9309beef06c16bb2e4ba2f6463aa0
SkillsGuard release: 1.1.1
rules revision: 7badb5157f8f9e4dd9ee2acb6e0129636e3147e3
artifact digest: sha256:a826a988df12f1e49f88bd1e19740a32fcfff560685f2d051271e1057331521b
coverage: 1 enumerated, 1 analyzed, 0 skipped, 0 unsupported
findings: 0
```

The worker completed the same queued operation with `allow=true`. The policy
object and policy revision were unchanged by the scan transaction. Afterward,
the real application returned catalog `200`, detail `200`, files `200` with one
file, resolve `200`, authorization `201`, download descriptor `200`, and the
gateway transfer `200` with exactly 325 bytes and the expected artifact digest.
The unauthenticated catalog request remained `401`.

Run the opt-in proof after building the pinned Node Nitro output. The Vercel
environment runner is used only to provide the already-authorized private Blob
read token to this one process; the token is read in memory and is never
printed, persisted, passed to the clone, or passed to Nitro:

```sh
PSKILLS_RESTORE_RUN_LOCAL_SCANNER=true \
PSKILLS_RESTORE_EVIDENCE_PATH="$PWD/docs/evidence/local-serving-path-restore-skillsguard-$(date -u +%Y%m%d).json" \
vercel env run --non-interactive --cwd /path/to/targeted-private-skills-project -e production -- \
  node --import "$PWD/node_modules/tsx/dist/loader.mjs" \
  "$PWD/scripts/local-serving-path-restore-rehearsal.ts"
```

The source PostgreSQL container and hosted Blob prefix were read only. The
clone, local filesystem, scan evidence, job state, authorizations, and transfer
grant were disposable and cleaned up after the run. Docker scanner execution
uses the existing executor boundary with network disabled and a read-only
container filesystem.

This proves one restored default-organization fixture through the local Node,
PostgreSQL, Files SDK filesystem, and pinned local scanner path. Better Auth,
SSO, memberships, service-token revocations, billing, external directories,
hosted worker dispatch, hosted provider IAM/lifecycle state, external scanner
providers, and a second-company denial after restore remain outside this
rehearsal. It does not establish a coordinated hosted rollback or a shared
PostgreSQL/Blob snapshot.
