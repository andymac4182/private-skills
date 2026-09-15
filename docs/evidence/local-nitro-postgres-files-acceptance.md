# Local Nitro, PostgreSQL, and Files SDK tenant acceptance

This opt-in test exercises the composed Node Nitro runtime over HTTP. It is a
loopback-only proof and does not establish hosted or production acceptance.

Run it with a disposable PostgreSQL URL supplied by a local password-file
wrapper. The test refuses non-loopback URLs and is skipped unless the explicit
opt-in flag is present:

```sh
PSKILLS_NITRO_POSTGRES_ACCEPTANCE=true \
PSKILLS_NITRO_POSTGRES_URL="$LOOPBACK_POSTGRES_URL" \
node_modules/.bin/vitest run tests/e2e/nitro-postgres-files-acceptance.test.ts
```

The test builds `apps/web` with the Node Nitro preset, starts the generated
`.output/server/index.mjs`, and configures that process with PostgreSQL state,
Better Auth, and the `files-sdk@2.4.0` filesystem provider. Better Auth users,
organizations, memberships, sessions, and the current `ssoProvider` mirror
table are seeded through the Better Auth adapter in a unique disposable
schema. The private company SSO table is created in that same Better Auth
schema. The registry creates each company state row through its normal HTTP
route; no registry data is inserted directly by the fixture.

The verified journey is:

1. Two Better Auth owner sessions read separate tenant policies. Each policy
   has `allowUnscanned=false` and `skillsguard` as the required scanner.
2. Company A and Company B publish different canonical bundles. Before a scan,
   each resolve request remains pending, proving that the required-scan gate is
   active.
3. The tenant worker credential claims each matching job through the actual
   `WorkerRunner`. The runner downloads the artifact through the internal
   route, verifies its digest, materializes the canonical bundle, and invokes a
   deterministic local `skillsguard` adapter that reads and hashes every
   materialized file before submitting completion. The adapter supplies
   complete two-file coverage, no findings, the job digest, and the current
   policy revision. It is a local scanner adapter fixture; it does not run a
   scanner image or contact a scanner service. The other configured advisory
   engines remain unsupported and do not weaken the required `skillsguard`
   gate.
4. Each company resolves its approved release, creates an install
   authorization, obtains a gateway transfer descriptor, and downloads through
   the running Nitro process. The downloaded bytes and SHA-256 digest exactly
   match the published Files SDK object.
5. Company B cannot read, authorize, describe, or transfer Company A's
   artifact. After Company A revokes the release, its old resolution,
   authorization, descriptor, and transfer are denied by the current-release
   policy fence.

The extended acceptance case in the same file adds a second journey on the
same composed runtime and Better Auth schema shape:

1. Both companies publish the same skill name and create the same pack name
   and version. The resolved pack members point to different company-owned
   skill IDs, each pack list contains only its own pack, and a foreign pack
   lookup or install authorization returns 404.
2. Each authenticated owner/editor creates a draft, edits it to revision 2,
   reads the draft again from PostgreSQL, and reads `SKILL.md` through the
   draft-file route. The persisted revision and file manifest are nonempty;
   foreign draft and file reads return 404.
3. Search reindex and query run through the configured AI Gateway SDK against
   a loopback HTTP protocol fixture. The fixture returns deterministic vectors
   and counts requests, while the runtime still verifies approved artifacts
   and applies the tenant resource allowlist. Each company receives only its
   own same-name skill result. This is not external model or provider
   acceptance.
4. Each company confirms one pack install receipt from its own authorization.
   The analytics response records one pack install and one install operation,
   and its top-skill resource ID is limited to that company's pack member.

An actual filtered execution on 16 September 2026 passed the extended case
against loopback PostgreSQL and the Files SDK filesystem provider (`1 passed,
1 skipped` because the unchanged baseline case was intentionally filtered):

```sh
PSKILLS_NITRO_POSTGRES_ACCEPTANCE=true \
PSKILLS_NITRO_POSTGRES_URL="$LOOPBACK_POSTGRES_URL" \
node_modules/.bin/vitest run tests/e2e/nitro-postgres-files-acceptance.test.ts \
  -t "same-name packs" --reporter=verbose
```

The proof is intentionally bounded. It does not cover hosted Eve, an external
AI Gateway/model, a real scanner provider, S3/R2/GCS/Azure/Vercel Blob, a
deployed origin, or production credentials. Better Auth and worker identities
are local seeded/bootstrap fixtures. The retained fixture path below creates a
real API-token bearer credential for Company B so a native client can exercise
the same tenant-bound route. The existing API-token, identity, billing, and
registry-only PostgreSQL tests remain separate evidence; this test adds the
composed Nitro HTTP path and does not replace those scopes.

For a native CLI/browser handoff, set both the opt-in flag and (optionally) a
new absolute metadata path:

```sh
PSKILLS_NITRO_POSTGRES_ACCEPTANCE=true \
PSKILLS_NITRO_POSTGRES_RETAIN_FIXTURE=true \
PSKILLS_NITRO_POSTGRES_RETAIN_FIXTURE_PATH=/private/tmp/nitro-fixture.json \
PSKILLS_NITRO_POSTGRES_URL="$LOOPBACK_POSTGRES_URL" \
node_modules/.bin/vitest run tests/e2e/nitro-postgres-files-acceptance.test.ts
```

The test writes a mode-0600 JSON file containing the loopback origin, Company B
organization and approved skill digest, session cookie, bearer API token, and
local cleanup identifiers. The child Nitro process is detached and the
disposable PostgreSQL rows and Files SDK root remain available for the handoff.
Read the file programmatically; its credential fields must never be printed or
committed. Stop the listed local PID and remove the metadata/storage/database
rows after the native proof. The default mode remains unchanged: it stops the
runtime, removes the Files SDK root, deletes the rehearsal token rows, and
drops the unique Better Auth schema after each test.

When the opt-in variables are absent, the test must report skipped. A skipped
run is missing evidence, not a successful tenant or provider acceptance.
