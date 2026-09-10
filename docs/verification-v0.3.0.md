# v0.3.0 verification checkpoint

**Status note (2026-09-10):** The current deployment and portability pointer is
[`verification-current.md`](verification-current.md). This document retains
the earlier v0.3.0 deployment-specific evidence and is superseded for current
status.

Date: 2026-09-10. Status: current prebuilt production rollout plus historical E7
directory evidence and a local transparent-feed implementation review. The
current rollout is READY deployment `dpl_3ATQ46MCMBJTuLjbmdDuZnSAAA3Z` at the
stable alias, from merged main `0efd3583bb5902a77c48cbf98f6b7bff88338bcf` and
code artifact `8c8e41eb4ad172fc033bc5593f400874095ec656`; its live evidence is
limited to authenticated read-only checks. The historical E7 source/deployment
pair is source `0f9da75` and `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y`; its own
directory, OIDC, Topics, security, pagination, scan, and browser evidence is
identified below and does not describe the current rollout. The transparent-feed
fixture run is loopback-only, using runtime source and CLI build
`8c8e41eb4ad172fc033bc5593f400874095ec656`, and is not a production, current-CI,
native-release, or hosted-scanner result. Native fallback is also verified
separately as historical evidence; remaining gates are explicit below. The final
loopback E2E at `8c8e41e` covers the rescan, warm identity, and frozen reinstall
flows. Separate local browser evidence from UI source `91eb809` covers the
tested flows at a 390px viewport with a measured 390×4,078 full-page screenshot;
both records are local evidence and do not establish current hosted browser or
production-scanner proof.

## Implemented scope

- Source implementation includes authenticated skills.sh listing, search, Official,
  detail, external audit, governed import routes, Rust directory commands, and
  cloud views; the E7 deployment evidence below covers only the explicitly
  identified hosted paths.
- Source implementation links Topics to upstream pages and supports clearly
  labeled internal searches. Unlisted pack links support metadata preview;
  existing private packs remain installable. Automatic external pack migration is
  deferred.
- Source acquisition supports catalog snapshots, immutable GitHub resolution,
  and bounded well-known discovery. External identity and digests survive
  private release and CLI lock serialization; representative transparent-feed
  pullthrough is separately recorded as local fixture evidence below.
- ComputeSDK abstracts the hosted sandbox boundary. Vercel is the qualified provider; other providers require conformance evidence before enablement.

## Current deployment pointer

The current production deployment is `dpl_3ATQ46MCMBJTuLjbmdDuZnSAAA3Z` at
[`private-skills-theta.vercel.app`](https://private-skills-theta.vercel.app),
with unique URL
`https://private-skills-nyfgk0kyh-andrewmcclenaghan-6046s-projects.vercel.app`.
It is a Vercel CLI prebuilt deployment for merged main
`0efd3583bb5902a77c48cbf98f6b7bff88338bcf`, carrying code artifact
`8c8e41eb4ad172fc033bc5593f400874095ec656`. Its output fingerprint is
`fd71b9627eb0fd1a3bcd8d17ebbf867992516c14cb5f61327a9a1ff292a1169a`; the
manifest contains 2,057 regular files, 27 symlinks, and 19,585,540 bytes. No
Git-triggered deployment was found. The sanitized
[rollout evidence](../work/production-rollout-evidence-dpl_3ATQ46MCMBJTuLjbmdDuZnSAAA3Z.json)
records authenticated GETs for health, `/v1/me`, `/v1/policy`, `/v1/feeds`,
and directory list. The policy is fail-closed (`allowUnscanned=false`), the
feed registry is empty, and list returned two of 9,738 rows with more available.
No production feed setup, source import, or CLI installation was exercised.

The bounded Vercel log query for this deployment (2026-09-10
04:01:03.630Z–04:12:36.466Z) returned nine info-only records, with zero parse
errors, warnings, errors, or fatal records; raw messages were not retained.
The project API returned `link: null` (shown in the sanitized evidence as
`linkedRepository: null`). A documented `vercel git connect` attempt for
`andymac4182/private-skills` failed with `Make sure there aren’t any typos and
that you have access to the repository if it’s private`. Repository access setup
requires owner attention.

The historical E7 source `0f9da75` adds the canonical Topics page parser,
auth-before-hit metadata cache with bounded TTL/bytes, conflict/drift-aware
enumeration, and credential-negative security coverage. Its deployment-specific
OIDC/ComputeSDK, Topics, pagination, and browser artifacts remain below with
their own provenance; current browser proof for the prebuilt rollout is still
pending.

## Evidence collected

- Historical production deployment `dpl_3D4epeApMaBFmSFtuycVV9iAxrhi`, built
  from the web/server changes at `bd03e25`, is ready at
  https://private-skills-theta.vercel.app. That captured deployment deliberately
  disabled skills.sh and returned `503 DIRECTORY_NOT_CONFIGURED` with
  `retryable:false`; it predates the later OIDC authorization and remains
  separate from Vercel Sandbox request-scoped OIDC.
- Earlier production deployment `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi` proved the
  server-side skills.sh directory path with the authorized Vercel project OIDC
  token. The sanitized [production-v03 evidence](../work/production-v03-evidence.json)
  records authenticated list/search/Official/detail/audits success: list page
  zero returned two rows with `total=9736` and `hasMore=true`, search returned
  two rows, Official returned 100 owners/5,497 skills, detail returned one file,
  and audits returned five partner entries. It also records private publish,
  search, pack/CLI, and analytics readback. This earlier record does not prove
  complete pagination, selected-row import, a Topics JSON API, or an external
  pack preview: Topics is `not_exposed` and `packPreview` is `skipped` there.
- The previous deployment's [API probe](../work/production-c1-api-evidence-1788993090676-80975-dpl_3DgJ6ovpoESraFXCjVhiX39f1tRj.json)
  against `dpl_3DgJ6ovpoESraFXCjVhiX39f1tRj` made eight GET requests with zero
  retries or mutations and passed the credential-pattern-negative check, but
  authenticated React and Marketing Topics failed
  `provenance_not_fresh_canonical`. Its `verified:false` result is retained as
  regression evidence for the stale-canonical bug and is not a current failure.
- The [historical E7 API probe](../work/production-c1-api-evidence-1788993909280-85606-dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y.json)
  against `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` made eight GET requests with zero
  retries or mutations and `credentialPatternNegative=true`. It verified 200
  health, authenticated `/me`, fail-closed policy, list (`total=9738`), fuzzy
  search (`react`), fresh canonical React Topics (6 capabilities, 6 skills, 4
  FAQs, 3 related topics), and Marketing Topics (6 capabilities, 21 skills, 4
  FAQs, 2 related topics), plus a 401 unauthenticated Topics response. The
  artifact is `verified:true`; it is historical evidence for that E7 deployment,
  and browser proof for the current prebuilt rollout is still pending.
- Earlier deployment `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi` passed the required ComputeSDK scan recorded in
  [production-v03 scan evidence](../work/production-v03-scan-evidence.json):
  `verified=true`, driver `computesdk`, scan
  `44cd2613-b29b-4b54-9c5a-4efc932afbe0`, job
  `job_fd182a70-9c73-45d8-9d1b-a1732d98d107`, one file analyzed, zero findings,
  approved digest unchanged, and `allowUnscanned=false`.
- Earlier production directory deployment `dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC`
  has output fingerprint
  `b58fccb70827db007ff84d0ce4c776f6297dfc9cc3f552de353e614515b0586b`.
  The sanitized [pagination evidence](../work/production-c1-pagination-evidence-1788989595741-50223-dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC.json)
  verifies the all-time metadata traversal: 20 pages at `per_page=500`,
  `totalDeclared=9738`, `totalObserved=9738`, `uniqueIds=9738`, zero duplicate
  rows/IDs, and three nested IDs. It made no detail, artifact, or mutating
  requests, so the result proves complete metadata enumeration for that run
  without mass mirroring.
- The nested-ID evidence is intentionally split. The live upstream probe in
  [skills.sh nested evidence](../work/skills-sh-nested-probe-evidence.json)
  observed 400 `invalid_path` for direct/full-ID encoding, 200 with the wrong
  identity for one-slug-segment encoding, and 404 for double encoding. The
  current client supports bounded nested IDs and requires exact identity; it
  fails closed on those upstream mismatches. The [current production nested
  probe](../work/production-c1-nested-evidence-1788989719476-50915-dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC.json)
  for the three catalog rows returned 503 for detail/audit, with zero mutating
  requests, so upstream availability remains an import/detail gate.
- The earlier final CSS production deployment
  `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` is ready at the stable alias with output
  hash `665727f37999113a2d018eb348ad32b47d1cbd817d9c8b4762b35c0ea760549a`.
  It carries the enabled directory/ComputeSDK configuration. The final
  production browser proof passed for Packs, dashboard, and catalog at 390px,
  and Packs at 1280px; captures are retained as
  `docs/design/production-final-{packs-mobile,dashboard-mobile,catalog-mobile,packs-desktop}.png`.
- The historical user-approved native fallback deployment `dpl_9ywi8SygoxMotB5iZJcnNVf6pgS7`
  passed the replacement scan. Job `job_5562b593-6d5e-479b-a358-672b96bb78c7`
  / scan `b84ed69e-d770-488d-ab56-e2e2fc7c51cf` analyzed one file, found zero
  findings, approved the artifact, and left its digest unchanged under
  `allowUnscanned=false`. This verifies the native fallback path separately.
- Commit `2a5fe06` adds a read-only PostgreSQL snapshot source. Its reviewed
  probe succeeded at MVCC revision 83 and returned metadata/counts only; it did
  not copy blobs and is not backup, restore, or hosted-recovery evidence. The
  exact MVCC snapshot and immutable blob-byte hash checks remain integrity
  evidence for the source adapter, while deletion/lifecycle fencing is an
  availability guarantee for a hosted copy window. The optional unfenced mode
  is not implemented; the mandatory-fence relaxation was rejected by review
  and remains separately approval-pending.

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
  for regression coverage; the later passing scan evidence above supersedes it
  for the fixed path without deleting the failure evidence.
- Earlier production-ready browser captures pass for the recorded dashboard, catalog,
  directory all/search/detail, Official, Topics, Audits, and Packs desktop
  views, plus the final 390px Packs, dashboard, and catalog checks. The final
  deployment removed the previously observed mobile overflow in those captured
  surfaces. This does not turn the skipped operator-supplied Packs preview or
  undocumented Topics JSON membership into completed C1 behavior.
- The E7 source-head review at `0f9da75` reports 286 tests passed and two
  environment-dependent tests skipped. TypeScript, five SDK probes, Files SDK
  checks, and the Cloudflare build pass, and two independent reviews approve.
  This is source/build evidence for the historical E7 deployment pointer above;
  its API probe verifies the new Topics, cache, enumeration, and security paths.
  Browser proof for the current prebuilt rollout remains pending. The browser handoff only
  inventoried CUA browser surfaces; it found no dedicated registry tab,
  performed no registry navigation, and produced no new production screenshots.
  The private v0.2
  release archive/checksum and clean-consumer checks are complete in the
  historical release record; no v0.3 release tag or published prerelease is
  claimed. Earlier PR10 head `a4ea17c`/229-test evidence remains historical.
- **Historical native baseline (not current transparent-feed evidence):** Rust
  checks recorded four CLI tests, 25 core tests, and 11 installation safety
  tests (40 total), including the shared standard-skill metadata fixture.
- **Current local source/build checks (not hosted):** Source checkpoint
  `8c8e41eb4ad172fc033bc5593f400874095ec656` reports `CI=true pnpm check`
  with 317 passed and two environment-dependent skips. The Vercel build passed
  its 27-link/5-SDK output check; the output manifest contains 2,057 files,
  27 symlinks, and 19,585,540 bytes, with fingerprint
  `fd71b9627eb0fd1a3bcd8d17ebbf867992516c14cb5f61327a9a1ff292a1169a`.
  The current local Rust check inventory is 34 core-unit tests plus 8 CLI-unit
  tests; it is local evidence only.
  These are source/build checks for the local checkpoint, not current GitHub
  CI, native Windows/Linux release, browser, hosted deployment, or production
  scanner evidence.
- **Local transparent-feed/CLI acceptance (not production):** The sanitized
  [fixture evidence](../work/transparent-proxy-cli-final-evidence-1789011005495.json)
  is `verified:true` for loopback-only ephemeral HTTP fixtures containing a
  skills.sh-shaped catalog and local well-known v0.2 source. Runtime source and
  CLI build are both `8c8e41eb4ad172fc033bc5593f400874095ec656`, using binary
  SHA-256 `6a048cdcb190c2948226ea0efa0ec3a703aa659d535b1775864a348271c2b76a`.
  The run passed feed discovery guards (unknown feed 404, disabled feed 409,
  and zero upstream requests before either guard), concurrent cold
  deduplication with required approval, same-slug distinct source identity,
  null-hash refresh to a new approved revision, frozen reinstall using the
  original external ID plus `--feed community`, required scanner failure without
  activation, an authenticated pending rescan that joined the existing
  operation without a second proxy request and retained the exact resource/
  version/artifact pin, warm HTTP/CLI cache use after upstream stop, tenant-B
  descriptor/blob isolation, and no instruction execution. The required
  scanner was a deterministic `fixture-static-scanner` callback, including its
  deterministic failure case; this is not Cisco, NVIDIA, SkillsGuard,
  hosted-worker, production, or external-network scanner evidence. The run
  exercised explicit feed selection; omitted-feed behavior is not established.
  With multiple enabled feeds, callers must select one explicitly; only a
  single enabled feed can be auto-selected.
- Earlier [CI run 34389979645](https://github.com/andymac4182/private-skills/actions/runs/34389979645)
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
- **Local portability runtime evidence (sanitized):** A compiled Nitro
  `node-server` run (Node 24.20.0, Nitro 3.0.260903-beta) passed the smoke
  protocol with File state and the real Files SDK filesystem adapter: health and
  authentication, publish (202), worker claim/complete, CAS, resolve,
  authorization, digest-checked transfer, and a successful revoke followed by
  denied transfer (409). A local
  Wrangler `workerd` run (Wrangler 4.130.0) passed the edge smoke through an
  authenticated loopback gateway backed by memory state and the Files SDK:
  health/identity/capabilities/resolve (200), authorization (201), grant and
  transfer (200), including a 243-byte digest-checked transfer. Both runs used
  the explicit disposable development policy `allowUnscanned=true` with all
  scanners `disabled`; no scanner verdict or synthetic scan success is claimed.
  Docker runtime is unverified because Docker daemon access was unavailable and
  no container or infrastructure was started. The reviewed sanitized record is
  [`runtime-portability-evidence.json`](../work/runtime-portability-evidence.json).
- The Eve route and registered `0 22 * * *` UTC schedule (22:00 UTC, subject to
  the hosting execution window) have a sanitized [production cron evidence
  record](../work/reviewer-cron-completion-evidence.json) for deployment
  `dpl_4Jnh9PZj3YcXxGb59aRGFTXo3Q3e`. The cron path was observed at
  2026-09-09 22:46:40 UTC; authoritative workflow analytics show the primary `workflowEntry` and
  `turnWorkflow` runs completed, while `sessionTimeoutWorkflow` was cancelled.
  Creation followed the observation by 2.067 seconds and completion by 14.353
  seconds. This supports scheduled execution within the deployment, but no
  explicit opaque scheduler/session correlation was retained, and no
  proposal/prompt/report/event payload was retained; it is not evidence of a
  new reviewer proposal.

## Remaining acceptance gates

The owner authorized server-side forwarding of the Vercel project OIDC token to
skills.sh on 2026-09-10. The current prebuilt rollout
`dpl_3ATQ46MCMBJTuLjbmdDuZnSAAA3Z` carries the current source artifact and has
only the authenticated read-only checks recorded above; no feed is configured,
and no production import or CLI install was exercised. Historical deployment
`dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi` provides the detailed sanitized
list/search/Official/detail/audits and ComputeSDK evidence, while the earlier
`dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC` provides complete metadata pagination and
nested-row coverage evidence. The current record still has pending selected-row
GitHub/well-known imports, upstream nested detail availability,
scanner-admission readback, current browser proof for the new Topics/cache/
enumeration paths, and the operator-supplied Packs preview. The historical E7
API probe on `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` verifies credential-negative
handling, safe list/search behavior, and fresh canonical React/Marketing Topics;
the previous stale-canonical result is retained as regression evidence. The
earlier production record explicitly marks Topics `not_exposed` and pack
preview `skipped`; the live Packs preview is not claimed complete merely because
the latest source implements its route.

The Vercel Sandbox provider's request-scoped OIDC path is verified by the
earlier ComputeSDK scan evidence. Complete explicit provider credentials remain
supported, and the helper must still fail closed when request context is
unavailable.

The earlier final CSS deployment `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` is ready
and its final 390px Packs/dashboard/catalog plus 1280px Packs browser proof
passed. The record only claims those captured surfaces; it does not claim the
skipped operator-supplied Packs preview or undocumented Topics JSON membership.

The v0.3 production deployment replaces v0.2 at the stable URL. The earlier
ComputeSDK failure remains preserved as regression evidence. The passing
required ComputeSDK scan with zero findings and unchanged approved digest is
evidence for `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi`; the earlier `dpl_Bbpx...`
directory probe is metadata-only and does not add a scan verdict. The current
deployment pointer and source/build checks above are separate from those
versioned artifacts. Native fallback is verified separately. Two independent
reviews approve the current source, while hosted backup restoration and the
read-only snapshot-to-restore rehearsal remain unverified. PR10 was explicitly
authorized and merged to `origin/main` at `6e916d9`; this does not mean the
current PR11 source or a v0.3 release tag has updated. The project API returned
`link: null` (shown in the sanitized evidence as `linkedRepository: null`), and
a documented `vercel git connect` attempt for `andymac4182/private-skills` failed
with `Make sure there aren’t any typos and that you have access to the repository
if it’s private`. Repository access setup requires owner attention. CLI deployment
evidence does not satisfy the Git-triggered gate.

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
- **Pending:** repository access setup and a Git-triggered deployment for the
  final source revision. The project API returned `link: null` (shown in the
  sanitized evidence as `linkedRepository: null`); the documented `vercel git
  connect` attempt for `andymac4182/private-skills` failed with `Make sure there
  aren’t any typos and that you have access to the repository if it’s private`.
- **E7 source review:** `0f9da75` reports 286 tests passed and two
  environment-dependent skips; TypeScript, five SDK probes, Files SDK checks,
  and the Cloudflare build pass, and two independent reviews approve.
  The private v0.2.0 release archives/checksums and clean-consumer verification
  are complete in [`verification-v0.2.0.md`](verification-v0.2.0.md) and the
  retained [release evidence](../work/release-verification-v0.2.0-4E13vA/);
  no v0.3 archive is claimed published. **Pending for production:** hosted
  backup restoration and a reviewed storage-redaction/infrastructure
  checkpoint. The committed
  PostgreSQL snapshot adapter has only a read-only revision-83/counts probe;
  it has not completed blob copy, backup, restore, or hosted recovery. No v0.3
  release tag or prerelease CLI packaging is represented as published.

**v0.3 provider and UI gates**

- **Complete for earlier deployment evidence:** ComputeSDK request-context
  authentication and a real required production scan passed with one file,
  zero findings, unchanged digest, and `allowUnscanned=false`. The native
  fallback result remains a separately verified baseline.
- **Complete for the captured surfaces:** earlier deployment
  `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` passed the final 390px Packs, dashboard,
  and catalog checks plus the 1280px Packs check, with no horizontal overflow.
  The historical E7 deployment `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` is READY; its
  API artifact verifies list/search/auth and fresh canonical Topics. The current
  prebuilt rollout `dpl_3ATQ46MCMBJTuLjbmdDuZnSAAA3Z` is READY and verifies only
  authenticated read-only health, `/v1/me`, policy, feeds, and list (`feedCount=0`,
  `total=9738`); current browser proof for the latest directory changes is still
  pending.
- **Pending review:** Rust directory/proxy scanner-failure reason preservation
  must be observed end to end before being called fixed.

**C1 skills.sh follow-up**

- **Verified for earlier deployment evidence:** server-side Vercel project OIDC
  forwarding and authenticated skills.sh list/search/Official/detail/audits
  succeed on `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi`, as recorded in
  `work/production-v03-evidence.json`. The old disconnected
  `503 DIRECTORY_NOT_CONFIGURED` result remains historical evidence. Latest
  deployment `dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC` separately verifies 20-page,
  9,738-row metadata pagination with three nested IDs and no artifact writes.
- **Verified historical E7 deployment API evidence:** `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y`
  passes the read-only API health, authenticated `/me`, policy, list, search,
  fresh canonical React/Marketing Topics, and credential-negative checks in the
  [sanitized API artifact](../work/production-c1-api-evidence-1788993909280-85606-dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y.json).
  The previous `dpl_3DgJ6ovpoESraFXCjVhiX39f1tRj` stale-canonical result remains
  preserved as regression evidence. Browser proof for the current prebuilt
  rollout is still pending.
- **Verified current prebuilt rollout (read-only only):**
  `dpl_3ATQ46MCMBJTuLjbmdDuZnSAAA3Z` is the Vercel CLI prebuilt artifact for
  merged main `0efd3583bb5902a77c48cbf98f6b7bff88338bcf`, with code artifact
  `8c8e41eb4ad172fc033bc5593f400874095ec656`. The sanitized rollout evidence
  records 200 responses for health, authenticated `/v1/me`, fail-closed policy,
  `/v1/feeds`, and directory list; feeds are empty and list reports two of
  `total=9738` rows with more available. No production feed setup, source import,
  or CLI installation was exercised, so this does not close C1.
- **Verified snapshot candidate admission and install:** deployment
  `dpl_CpAApe78RJs3oXuuk4iPzbtdnczb` from source `e6a4b33` used the existing
  `skills-sh` feed to resolve `vercel-labs/agent-skills/web-design-guidelines`.
  Required SkillGuard evidence analyzed one file with zero findings while
  `allowUnscanned=false`; the server returned the snapshot-only reference
  `@snapshot/skills-sh/vercel-labs/agent-skills/web-design-guidelines`. An
  isolated Rust CLI install changed once, the identical same-root repeat was
  up to date, `verify` exited zero, and analytics increased by two operations,
  one install, and one up-to-date check. The [sanitized candidate evidence](evidence/production-candidate-web-design-guidelines-pullthrough-dpl_CpAApe78RJs3oXuuk4iPzbtdnczb.json)
  preserves the warm response's HTTP 200/no-new-operation result and its
  `responseValidated:false` verifier limitation; it does not claim direct
  zero-upstream instrumentation or physical GitHub/well-known resolution.
- **E7 implementation, awaiting current browser proof:** source `0f9da75` includes the
  canonical Topics parser, auth-before-hit bounded cache, conflict/drift-aware
  enumeration, and credential-negative tests. The historical E7 deployment
  carries this code, and its API acceptance artifact is verified; the current
  prebuilt rollout's browser acceptance artifact has not yet been captured.
- **Transparent-feed implementation, locally verified only:** the loopback
  fixture evidence above proves the source/worker/Files SDK/Rust CLI seam for
  the recorded runtime and CLI SHAs, including cold/warm/refresh, feed guards,
  tenant isolation, and fail-closed deterministic scanner behavior. It does not
  prove a hosted deployment, real scanner, current branch, or browser flow.
- **Pending:** representative physical GitHub and well-known source
  pullthrough/import, concurrent cold deduplication and direct warm-path
  upstream instrumentation (the restricted-source approval is separate),
  upstream nested detail availability, current browser proof for
  Topics/cache/enumeration,
  metadata-only Packs preview with an operator URL, browser/log credential-negative checks,
  error/rate handling, and tenant/secrecy evidence. No pack preview is claimed
  from the skipped fixture.

**Later roadmap, not current ship gates:** M1 context packages and agent
bridges, M2 quality/scenario evaluation, M3 team governance, M4 author CI and
library context, M5 visibility/automation, deferred M6 Diffs editor plus
upload/edit Eve review, and future M7 OpenClaw feed interoperability remain
future milestones in
[`roadmap.md`](roadmap.md) and [`completion-criteria.md`](completion-criteria.md).

See [completion criteria](completion-criteria.md), [catalog design and review](skills-sh.md), and [sandbox provider contract](sandbox-providers.md) for the full remaining scope.
