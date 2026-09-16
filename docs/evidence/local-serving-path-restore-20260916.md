# Local serving-path restore rehearsal

Observed `2026-09-16T00:42:54Z` from candidate `87a2f0c` with the retained
local PostgreSQL recovery target and the previously copied private Blob
prefix. The executable probe is
[`scripts/local-serving-path-restore-rehearsal.ts`](../../scripts/local-serving-path-restore-rehearsal.ts);
the machine-readable result is
[`local-serving-path-restore-rehearsal-20260916.json`](local-serving-path-restore-rehearsal-20260916.json).

The result is **partial**. The rehearsal created a disposable PostgreSQL
clone from the retained container, read all 11 existing destination-prefix
objects through the Files SDK, wrote the exact source sealed keys to a
disposable filesystem root, and verified every local readback. The restored
registry row remained at revision 232 with 91 references to 11 unique objects,
37,741 bytes, and the same aggregate key/digest/size digest as the earlier
composed proof. A real built Nitro Node process then served the authenticated
catalog and detail routes (`200`) and rejected an unauthenticated catalog
request (`401`).

The selected historical fixture is still marked `approved`, but its latest
required SkillsGuard evidence is older than the persisted 24-hour freshness
window. The real current-admission gate therefore returned `needs-rescan` /
`evidence-stale`: release files and resolve both returned `404 NOT_AVAILABLE`,
and no authorization, download descriptor, or transfer was minted. The probe
does not refresh scans, set `allowUnscanned`, rewrite registry metadata, or
claim an approved download. This is the concrete remaining application
serving gap for this retained recovery point.

Run after building the Node Nitro output with the repository's pinned
dependencies. The Vercel environment runner is needed only to provide the
already-authorized private Blob token to this one process; the script reads the
token in memory and never prints, persists, or passes it to the clone or Nitro
child:

```sh
PSKILLS_STORAGE_BUILD_PROFILE=filesystem \
PSKILLS_STORAGE_PROVIDER=filesystem \
PSKILLS_RUNTIME_PROFILE=node \
pnpm --filter @private-skills/web build

PSKILLS_RESTORE_EVIDENCE_PATH="$PWD/docs/evidence/local-serving-path-restore-rehearsal-$(date -u +%Y%m%d).json" \
vercel env run --non-interactive --cwd /path/to/targeted-private-skills-project -e production -- \
  node --import "$PWD/node_modules/tsx/dist/loader.mjs" \
  "$PWD/scripts/local-serving-path-restore-rehearsal.ts"
```

The script accepts `PSKILLS_RESTORE_SOURCE_CONTAINER`,
`PSKILLS_RESTORE_SOURCE_DATABASE`, `PSKILLS_RESTORE_BLOB_PROOF`, and
`PSKILLS_RESTORE_RUNTIME_BINARY` for an explicitly selected local fixture. It
uses `pg_dump` from the source container, `pg_restore` into a new
`pgvector/pgvector:pg18` container, and destroys both the clone and temporary
filesystem by default. `PSKILLS_RESTORE_KEEP_DISPOSABLES=true` retains only
the disposable clone/root for a separate local inspection; it never retains
or mutates the source container or hosted Blob prefix.

The application child receives an allowlisted process environment containing
only loopback PostgreSQL/filesystem settings, a generated reader bootstrap
token, and disabled Better Auth, billing, directory, worker, and external
scanner integrations. The retained policy and historical state are copied as
data and evaluated by the real runtime. No hosted rollback, coordinated
freeze, provider IAM/lifecycle restore, Better Auth session/SSO replay,
second-company denial proof, billing-provider restore, or external scanner
proof is included.
