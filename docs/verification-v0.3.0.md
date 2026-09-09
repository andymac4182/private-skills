# v0.3.0 verification checkpoint

Date: 2026-09-10. Status: private-registry production checkpoint; the current
skills.sh directory and ComputeSDK scan evidence are verified; native fallback
is also verified; remaining gates are explicit below.

## Implemented scope

- Authenticated skills.sh listing, search, Official, detail, external audit, and governed import routes; Rust directory commands and cloud views.
- Topics link to upstream topic pages and launch clearly labeled internal searches. Unlisted pack links support metadata preview; existing private packs remain installable. Automatic external pack migration is deferred.
- Import acquisition supports catalog snapshots, immutable GitHub resolution, and bounded well-known discovery. External identity and digests survive private release and CLI lock serialization.
- ComputeSDK abstracts the hosted sandbox boundary. Vercel is the qualified provider; other providers require conformance evidence before enablement.

## Evidence collected

- Historical production deployment `dpl_3D4epeApMaBFmSFtuycVV9iAxrhi`, built
  from the web/server changes at `bd03e25`, is ready at
  https://private-skills-theta.vercel.app. That captured deployment deliberately
  disabled skills.sh and returned `503 DIRECTORY_NOT_CONFIGURED` with
  `retryable:false`; it predates the later OIDC authorization and remains
  separate from Vercel Sandbox request-scoped OIDC.
- Current production deployment `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi` proved the
  server-side skills.sh directory path with the authorized Vercel project OIDC
  token. The sanitized [production-v03 evidence](../work/production-v03-evidence.json)
  records authenticated list/search/Official/detail/audits success: list page
  zero returned two rows with `total=9736` and `hasMore=true`, search returned
  two rows, Official returned 100 owners/5,497 skills, detail returned one file,
  and audits returned five partner entries. It also records private publish,
  search, pack/CLI, and analytics readback. This does not prove complete
  pagination, selected-row import, a Topics JSON API, or an external pack
  preview: the record marks Topics `not_exposed` and `packPreview` `skipped`.
- The same current deployment passed the required ComputeSDK scan recorded in
  [production-v03 scan evidence](../work/production-v03-scan-evidence.json):
  `verified=true`, driver `computesdk`, scan
  `44cd2613-b29b-4b54-9c5a-4efc932afbe0`, job
  `job_fd182a70-9c73-45d8-9d1b-a1732d98d107`, one file analyzed, zero findings,
  approved digest unchanged, and `allowUnscanned=false`.
- The final CSS production deployment
  `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` is ready at the stable alias with output
  hash `665727f37999113a2d018eb348ad32b47d1cbd817d9c8b4762b35c0ea760549a`.
  It carries the enabled directory/ComputeSDK configuration. The final
  production browser proof passed for Packs, dashboard, and catalog at 390px,
  and Packs at 1280px; captures are retained as
  `docs/design/production-final-{packs-mobile,dashboard-mobile,catalog-mobile,packs-desktop}.png`.
- The user-approved native fallback deployment `dpl_9ywi8SygoxMotB5iZJcnNVf6pgS7`
  passed the replacement scan. Job `job_5562b593-6d5e-479b-a358-672b96bb78c7`
  / scan `b84ed69e-d770-488d-ab56-e2e2fc7c51cf` analyzed one file, found zero
  findings, approved the artifact, and left its digest unchanged under
  `allowUnscanned=false`. This verifies the native fallback path separately.

- Directory route tests cover cold queueing, warm reuse, authorization, exact
  source metadata, and a source found on catalog page 19.
- End-to-end fixtures exercise the registry, worker, acquisition, and storage
  together: scan approval precedes resolution, warm requests avoid upstream
  fetches, and revocation or a missing required scanner denies installation.
- Acquisition regressions cover bounded decompression, archive integrity,
  symlinks, public CDN artifacts without catalog credentials, and private-network
  rejection.
- Real Vercel sandboxes through ComputeSDK scanned benign and inert malicious
  fixtures using the pinned scanner snapshot. Both completed and were stopped;
  the malicious fixture produced findings.
- The earlier required ComputeSDK production attempt failed before scanner
  analysis because authentication was read from environment state outside the
  request context. It produced no scanner verdict. The preserved failure record
  in `work/production-v03-scan-failure-mtuiaj5q-ac0e1d792e.json` remains useful
  for regression coverage; the current deployment evidence above supersedes it
  for the fixed path without deleting the failure evidence.
- Production-ready browser captures pass for the recorded dashboard, catalog,
  directory all/search/detail, Official, Topics, Audits, and Packs desktop
  views, plus the final 390px Packs, dashboard, and catalog checks. The final
  deployment removed the previously observed mobile overflow in those captured
  surfaces. This does not turn the skipped operator-supplied Packs preview or
  undocumented Topics JSON membership into completed C1 behavior.
- The latest runtime review reports 207 tests passed and two
  environment-dependent tests skipped; application TypeScript checks pass. All
  five SDK trace checks and Cloudflare checks pass. The final release/archive
  and clean-consumer checks remain separate evidence gates.
- Rust checks pass: four CLI tests, 25 core tests, and 11 installation safety
  tests (40 total), including the shared standard-skill metadata fixture.
- [CI run 34389979645](https://github.com/andymac4182/private-skills/actions/runs/34389979645)
  passed for `be59ece45ea574a7398974076f34d1c23dce83c6`: web checks/builds,
  native macOS ARM64/Linux x64/Windows x64 Rust checks and binary smoke tests,
  and the Node container build. A platform-agent confirmation reports all CI
  checks green for PR10 head `78c6db0`, including refinement Rust checks; later
  changes require their own checks. Neither result represents prerelease
  packaging as a published release.
- Earlier Vercel and Cloudflare builds pass with the YAML metadata parser.
  Vercel output verification resolves all four sandbox SDKs from an isolated
  directory and validates 29 relocated output links. Hosted backup restoration
  remains unverified and is excluded from this checkpoint.

## Remaining acceptance gates

The owner authorized server-side forwarding of the Vercel project OIDC token to
skills.sh on 2026-09-10, and current deployment `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi`
now provides sanitized authenticated directory evidence. The evidence covers
list/search/Official/detail/audits, but full catalog pagination, selected-row
GitHub/well-known imports, browser/log credential-negative checks, and the
Topics/Packs product surfaces remain incomplete. The production record
explicitly marks Topics `not_exposed` and pack preview `skipped`; neither is
claimed complete.

The Vercel Sandbox provider's request-scoped OIDC path is verified by the
current ComputeSDK scan evidence. Complete explicit provider credentials remain
supported, and the helper must still fail closed when request context is
unavailable.

The final CSS deployment `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` is ready and the
final 390px Packs/dashboard/catalog plus 1280px Packs browser proof passed.
The record only claims the captured surfaces; it does not claim the skipped
operator-supplied Packs preview or undocumented Topics JSON membership.

The v0.3 production deployment replaces v0.2 at the stable URL. The earlier
ComputeSDK failure remains preserved as regression evidence, while the current
deployment has a passing required scan with zero findings and an unchanged
approved digest. The native fallback deployment above is verified separately.
Storage/infrastructure remediation and the independent core review remain
subject to their own evidence; hosted backup restoration is still excluded from
this checkpoint. PR10 head `78c6db0` has green CI, while Git-triggered
deployment still requires the account owner's GitHub Vercel app security-key
step. CLI deployment evidence does not satisfy that separate gate.

### Authoritative current checklist

The current delivery has two separately tracked layers. G0 is the original
private-registry shipment; C1 is the explicitly requested skills.sh follow-up.
The statuses below mirror the completion criteria and do not promote deferred
roadmap features into release blockers.

**G0 private-registry shipment**

- **Complete for recorded evidence:** Neon/PostgreSQL, private object storage,
  configured secrets, authenticated private publish/search/CLI/pack/analytics/
  Eve flow, and fail-closed required-scanner behavior.
- **Complete separately:** the user-approved native fallback deployment and
  replacement scan passed with one file, zero findings, unchanged digest, and
  `allowUnscanned=false`.
- **Pending:** the account owner's GitHub Vercel app security-key step and a
  Git-triggered deployment for the final source revision.
- **Pending:** final CI/release evidence for the latest source revision,
  clean-consumer archive/checksum verification, hosted backup restoration, and
  independently reviewed storage-redaction/infrastructure evidence. No
  prerelease CLI packaging is represented as a published release.

**v0.3 provider and UI gates**

- **Complete for current deployment evidence:** ComputeSDK request-context
  authentication and a real required production scan passed with one file,
  zero findings, unchanged digest, and `allowUnscanned=false`. The native
  fallback result remains a separately verified baseline.
- **Complete for the captured surfaces:** deployment
  `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` passed the final 390px Packs, dashboard,
  and catalog checks plus the 1280px Packs check, with no horizontal overflow.
- **Pending review:** Rust directory/proxy scanner-failure reason preservation
  must be observed end to end before being called fixed.

**C1 skills.sh follow-up**

- **Verified for current deployment evidence:** server-side Vercel project OIDC
  forwarding and authenticated skills.sh list/search/Official/detail/audits
  succeed on `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi`, as recorded in
  `work/production-v03-evidence.json`. The old disconnected
  `503 DIRECTORY_NOT_CONFIGURED` result remains historical evidence.
- **Pending:** full C1 pagination/count reconciliation, representative GitHub
  and well-known source pullthrough/import, local scanner-admission readback,
  Topics page behavior, metadata-only Packs preview with an operator URL,
  browser/log credential-negative checks, error/rate handling, and tenant/
  secrecy evidence. No pack preview is claimed from the skipped fixture.

**Later roadmap, not current ship gates:** M1 context packages and agent
bridges, M2 quality/scenario evaluation, M3 team governance, M4 author CI and
library context, M5 visibility/automation, deferred M6 Diffs editor plus
upload/edit Eve review, and future M7 OpenClaw feed interoperability remain
future milestones in
[`roadmap.md`](roadmap.md) and [`completion-criteria.md`](completion-criteria.md).

See [completion criteria](completion-criteria.md), [catalog design and review](skills-sh.md), and [sandbox provider contract](sandbox-providers.md) for the full remaining scope.
