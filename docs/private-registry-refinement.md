# Private registry refinement

The owner authorized server-side forwarding of the Vercel project OIDC token to
skills.sh on 2026-09-10, superseding the earlier disconnected deferral. Current
production deployment `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` is READY at the stable
alias with output fingerprint
`613f05b33f43aa449e28e3a0c65821b046524e43e50a2214b96f284910023662`; its
Cloudflare build fingerprint is
`a8b82a0dadb571106cd126d98039af579e04a8d45fa787f1b9b0a9358e884b31` with 35
server files and no executable SDK references. Earlier deployment artifacts
retain the detailed OIDC/ComputeSDK
and browser evidence. Vercel Sandbox authentication is a separately scoped
request-scoped OIDC path (or complete explicit provider credentials).

## Verified current pass

- Earlier production deployment `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi` proves the
  server-side skills.sh directory path with the authorized Vercel project OIDC
  token. `work/production-v03-evidence.json` records authenticated list/search/
  Official/detail/audits success: page zero returned two rows with
  `total=9736` and `hasMore=true`, search returned two rows, Official returned
  100 owners/5,497 skills, detail returned one file, and audits returned five
  partner entries. The same record covers private publish/search, pack/CLI, and
  analytics readback. It explicitly marks Topics `not_exposed` and packPreview
  `skipped`, so full pagination, imports, Topics JSON membership, and pack
  preview are not claimed complete.
- The previous API evidence for `dpl_3DgJ6ovpoESraFXCjVhiX39f1tRj` is retained in
  `work/production-c1-api-evidence-1788993090676-80975-dpl_3DgJ6ovpoESraFXCjVhiX39f1tRj.json`
  as stale-canonical regression evidence. The current API evidence for
  `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` is in
  `work/production-c1-api-evidence-1788993909280-85606-dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y.json`:
  eight GETs, no retries or mutations, no credential-pattern leakage, and
  verified health, authenticated `/me`, policy, list (`total=9738`), fuzzy
  search, fresh canonical React and Marketing Topics, and unauthenticated
  Topics rejection. Current browser proof remains pending.
- The same production path passed the required ComputeSDK scan recorded in
  `work/production-v03-scan-evidence.json`: `verified=true`, driver
  `computesdk`, scan `44cd2613-b29b-4b54-9c5a-4efc932afbe0`, job
  `job_fd182a70-9c73-45d8-9d1b-a1732d98d107`, one file analyzed, zero findings,
  approved digest unchanged, and `allowUnscanned=false`.
- Final CSS production deployment `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` is ready
  at the stable alias with output hash
  `665727f37999113a2d018eb348ad32b47d1cbd817d9c8b4762b35c0ea760549a`.
  Final 390px Packs, dashboard, and catalog captures and the 1280px Packs
  capture pass without horizontal overflow.
- Historical production deployment `dpl_3D4epeApMaBFmSFtuycVV9iAxrhi`, built
  from `bd03e25`, deliberately had skills.sh disconnected and returned
  `503 DIRECTORY_NOT_CONFIGURED` with `retryable:false`; it remains useful
  historical error-state evidence.
- User-approved native fallback deployment `dpl_9ywi8SygoxMotB5iZJcnNVf6pgS7`
  passed the replacement scan. Job `job_5562b593-6d5e-479b-a358-672b96bb78c7`
  / scan `b84ed69e-d770-488d-ab56-e2e2fc7c51cf` analyzed one file, found zero
  findings, approved the artifact, and left its digest unchanged under
  `allowUnscanned=false`. Native fallback is verified separately.
- Directory route checks cover cold queueing, warm reuse, authorization, exact
  source metadata, and a source found on catalog page 19. Production-ready
  browser captures pass for the recorded dashboard, catalog, directory,
  Official, Topics, Audits, and Packs desktop views and the recorded narrow
  catalog/dashboard checks. Final 390px Packs, dashboard, and catalog captures
  and the 1280px Packs capture also pass after the CSS fix.
- Existing private workflows and public links remain usable. Automatic external
  pack migration remains deferred.
- The current runtime review at source head `0f9da75` reports 286 tests passed
  with two environment-dependent tests skipped, plus four CLI, 25 core, and 11
  installation-safety Rust tests passed. TypeScript, five SDK probes, Files SDK,
  and Cloudflare checks pass, and two independent reviews approve. PR10 was
  explicitly authorized and merged to `origin/main` at `6e916d9`; PR11 remains
  a held draft while final acceptance is resolved. No
  v0.3 release tag or prerelease CLI packaging is represented as published.

## Unresolved work

- C1 is partially verified in production: the current deployment pointer and
  API probe prove authenticated health/me/policy/list/search behavior, fresh
  canonical React/Marketing Topics, and credential-pattern-negative handling;
  the earlier deployment artifacts prove authenticated skills.sh
  Official/detail/audits and the ComputeSDK scan. The earlier 20-page metadata
  enumeration is complete; selected GitHub/well-known pullthrough, local
  import readback, metadata-only Packs preview with an operator URL, browser
  proof, and tenant/secrecy evidence remain outstanding. The prior
  `503 DIRECTORY_NOT_CONFIGURED` result is historical evidence only.
- A fresh required production scan on the original deployment failed before
  scanner analysis because ComputeSDK authentication was read from environment
  state outside the request context. It produced no scanner verdict. The
  preserved failure remains a regression fixture; the current deployment's
  passing scan verifies the repaired path without deleting the failure evidence.
- Scanner-failure reason preservation in Rust directory/proxy polling is under
  independent core review. No fix is claimed until a completed operation with
  an error is observed end to end.
- Deployment `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` passes the final captured mobile
  layout checks. Storage-redaction and other infrastructure effects remain
  subject to their own evidence. The committed read-only PostgreSQL snapshot
  adapter's revision-83/counts probe did not copy blobs or complete a backup,
  restore, or hosted-recovery rehearsal. Hosted backup restoration is still
  required and remains excluded from this checkpoint.
- Git-triggered deployment still requires the account owner's GitHub Vercel
  app security-key step. CLI deployment evidence does not satisfy that gate.

## Next reliability work

1. Add bounded `publish --wait` or operation waiting so callers can explicitly
   wait for admission and get a nonzero result for scanner or policy failure.
   The current successful publish command confirms submission, not approval.
2. Implement and test actor/body-bound mutation idempotency. The design's
   `Idempotency-Key` requirement is not yet implemented by the publish path or
   Rust client. Cover concurrent retries and safe reconciliation of uploaded
   objects when a mutation fails; do not delete an object referenced by a
   committed release after an ambiguous persistence error.
3. Complete an isolated hosted Neon/object-storage restore rehearsal. The local
   [restore test](restore-rehearsal.md) proves application fences and digest
   preservation but not provider backup recovery or restored scanner evidence.
