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
schema. The registry creates each company state row through its normal HTTP
route; no registry data is inserted directly by the fixture.

The verified journey is:

1. Two Better Auth owner sessions read separate tenant policies. Each policy
   has `allowUnscanned=false` and `skillsguard` as the required scanner.
2. Company A and Company B publish different canonical bundles. Before a scan,
   each resolve request remains pending, proving that the required-scan gate is
   active.
3. The tenant worker credential claims each matching job. A deterministic local
   `skillsguard` result supplies complete two-file coverage, no findings, the
   job digest, and the current policy revision. This is a scanner result
   fixture; it does not run a scanner image or contact a scanner service.
4. Each company resolves its approved release, creates an install
   authorization, obtains a gateway transfer descriptor, and downloads through
   the running Nitro process. The downloaded bytes and SHA-256 digest exactly
   match the published Files SDK object.
5. Company B cannot read, authorize, describe, or transfer Company A's
   artifact. After Company A revokes the release, its old resolution,
   authorization, descriptor, and transfer are denied by the current-release
   policy fence.

The proof is intentionally bounded. It does not cover hosted Eve, an external
AI Gateway/model, a real scanner provider, S3/R2/GCS/Azure/Vercel Blob, a
deployed origin, or production credentials. Better Auth and worker identities
are local seeded/bootstrap fixtures. Native CLI and browser installation still
need their own run against an approved fixture. The existing API-token,
identity, billing, and registry-only PostgreSQL tests remain separate evidence;
this test adds the composed Nitro HTTP path and does not replace those scopes.

When the opt-in variables are absent, the test must report skipped. A skipped
run is missing evidence, not a successful tenant or provider acceptance.
