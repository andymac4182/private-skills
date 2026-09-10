# Private Skills

Private Skills is a registry, pull-through proxy, and cross-platform installer for AI agent skills and curated skill packs. The repository now contains an implemented baseline: a TanStack Start/Router web surface, a Nitro request handler, portable TypeScript contracts and services, a worker/scan boundary, Files SDK storage adapters, and a Rust `pskills` client.

## Current status

The baseline implementation and its recorded v0.2 checks were established on
9 September 2026. The v0.3 production checkpoint and its remaining gates are
tracked separately in [`docs/verification-v0.3.0.md`](docs/verification-v0.3.0.md);
that record distinguishes completed evidence from pending deployment/provider
checks. The private v0.2.0 archives/checksums and clean-consumer verification
are recorded as complete; any archive/checksum publication for the current
source remains a separate release step, and in-flight or prerelease packaging
is not represented as a published release.

The latest portable directory-gateway evidence is tracked in
[`docs/verification-current.md`](docs/verification-current.md). PR23 is merged
on `origin/main` at `7c7a33e`; the earlier guarded prebuilt rollout
`dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE` is READY. Its current probes are read-only:
18 authenticated GETs, two unauthenticated negative GETs, one metadata-only
Pack preview POST, and zero private-registry data mutations (no feed, import,
scan, install, role, or policy writes). The connected GitHub project
then produced the READY Git-triggered deployment
`dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH` from that main commit; its separate
readback records seven authenticated GETs, the expected unauthenticated Topics
401, and zero private-registry data mutations. This closes the Git-trigger
observation while keeping the earlier prebuilt and browser evidence
source-specific. Pack-preview UI proof passed
during a stable-alias cutover whose exact deployment attribution is unknown;
positive scanner-to-warm evidence, hosted restore, and native CI remain
pending. M6 Diffs/editor/upload-review Eve and M7 OpenClaw
remain future milestones.

| Area | Current status | Boundary |
| --- | --- | --- |
| Web registry surface | Implemented with TanStack Start/Router, React, and native CSS | Uses live same-origin API data and reports loading, empty, and error states |
| Registry API | Implemented as a portable `Request`/`Response` handler with Nitro adapters | Directory lookups are bounded; workers acquire and scan release artifacts, and uploaded content is never executed |
| Authentication | Implemented bearer-token bootstrap and signed `HttpOnly` browser sessions | Primary user login remains token-based; the current guarded rollout uses the existing server-side skills.sh Vercel project OIDC path, while device flow/interactive identity providers are not part of this baseline |
| Artifacts | Implemented bounded canonical `pskills-bundle-v1` JSON, digest checks, private sealed-object storage, and transfer grants | Bundle content is data; the registry never runs skill scripts or install hooks |
| State | Implemented file state for a single API process, PostgreSQL JSONB transactions, and an authenticated HTTP CAS repository | The selected state provider and recovery procedure are deployment configuration |
| Storage | Implemented Files SDK filesystem/provider adapters and an authenticated HTTP gateway | Each provider still needs its own credentials and conformance evidence before production use |
| Jobs and scanning | Implemented leased worker protocol, fencing tokens, scanner adapters, policy evaluation, and Docker executor boundary | Scanner images, credentials, and external executor infrastructure are deployment inputs |
| Semantic search | Implemented authorization-aware embedding search, rebuildable indexes, and catalog search/status controls | Opt-in model credentials and the selected PostgreSQL/state index require deployment configuration |
| Install analytics | Implemented client-confirmed install receipts, bounded retention, and an admin report | Counts are best-effort telemetry; failed receipt delivery is not an install failure |
| Eve reviewer | Implemented a separate bounded Eve 0.52.3 reviewer that records human-review proposals | Eve cannot publish, merge, edit source, authorize installs, or run candidate content |
| CLI | Implemented Rust package and binary named `pskills`; an approved same-root record on the prior production deployment proves an unchanged warm repeat | Release targets are Linux x86_64, macOS arm64, and Windows x86_64; multi-feed CLI evidence remains a loopback fixture, not current CI or a published release. GitHub native CI admission currently fails before any job step because recent account payments failed or the spending limit needs to be increased |
| skills.sh directory | Directory routes, source mapping, Topics parser, bounded cache, enumeration, multi-feed selection, and security checks are implemented in the current source | The current `dpl_8ru…` rollout proves authenticated read-only API/detail/policy and metadata-only Pack preview with zero private-registry data mutations. Pack-preview UI proof passed during a stable-alias cutover with unknown exact deployment attribution. Prior production evidence covers a quarantined `find-skills` import and a same-root CLI repeat; local multi-feed and edge records cover fixture-only behavior. Positive scanner-to-warm admission, hosted restore, and tenant/secrecy acceptance remain pending |
| Sandbox providers | ComputeSDK abstraction with a tested Vercel adapter | Additional providers remain disabled until they pass the scanner isolation contract |

The repository includes Node production, Vercel, and Cloudflare/Nitro build profiles. A checked-in profile or a successful local build is not evidence of a live hosted deployment; live authenticated flows, provider conformance, and restore rehearsal belong in the verification record. The scanner runner is wired to real adapter and executor interfaces, but installed scanner images and their end-to-end findings must be verified in the target worker environment.

The earlier guarded prebuilt registry rollout is
[`dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE`](https://private-skills-theta.vercel.app),
at the stable alias [`private-skills-theta.vercel.app`](https://private-skills-theta.vercel.app)
and unique URL
`https://private-skills-pvsgvckvq-andrewmcclenaghan-6046s-projects.vercel.app`.
It is from merged main `fecd6baa1411c2f3c2ad60b13c2c0e37761d2826`, with
artifact source `b1d3b6d77162899491f742e2930abe0b36137d8e` and manifest
fingerprint `64d3833b2c107546011efc38e34bddea9df519a0e17e36f506b5674c46a504bf`.
The [sanitized rollout evidence](docs/evidence/production-c1-feed-rollout-dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE.json)
records the read-only probes, fail-closed policy (`allowUnscanned=false`),
SkillsGuard required, Cisco/NVIDIA disabled, metadata-only detail, and zero
private-registry data mutations. It does not claim a feed, import, scan, or
CLI install.

The existing Vercel project is connected to GitHub repository
`andymac4182/private-skills` on production branch `main`, without an additional
grant, as shown by the sanitized [Git-link readback](docs/evidence/vercel-git-link-20260910T070859Z.json).
The sanitized [Git-main deployment evidence](docs/evidence/production-git-main-deployment-dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH.json)
records a push of main commit `7c7a33e` producing READY deployment
`dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH`; its eight-request readback had seven
authenticated successes, the expected unauthenticated Topics 401, and no
registry writes. The earlier guarded prebuilt rollout remains a separate
source-specific record.

Prior deployment-specific OIDC, Topics, security, pagination, browser, feed
quarantine, and CLI evidence remains linked from
[`docs/verification-current.md`](docs/verification-current.md) and
[`docs/verification-v0.3.0.md`](docs/verification-v0.3.0.md); it is not silently
promoted to current `dpl_8ru…` proof. The current rollout is read-only, and the
local multi-feed/edge records remain fixture evidence.

Previously recorded authenticated publishing, search, CLI pack installation,
analytics, and Eve review flows remain evidence from the verified private
registry run; they were not re-exercised by this read-only rollout. The
separate reviewer runs at
[`private-skills-reviewer.vercel.app`](https://private-skills-reviewer.vercel.app)
with a registered daily `0 22 * * *` UTC schedule (22:00 UTC, subject to the
hosting execution window). The sanitized [production cron evidence](work/reviewer-cron-completion-evidence.json)
for deployment `dpl_4Jnh9PZj3YcXxGb59aRGFTXo3Q3e` observed the cron path at
2026-09-09 22:46:40 UTC; authoritative workflow analytics show the primary `workflowEntry`
and `turnWorkflow` runs completed, with the `sessionTimeoutWorkflow` run
cancelled. The primary run was created 2.067 seconds after the cron observation
and completed 14.353 seconds after it. This is deployment-scoped temporal
correlation; no explicit opaque scheduler/session correlation or
proposal/prompt/report/event payload was retained.
Full C1 catalog acceptance and hosted restore remain pending.
See [`docs/verification-v0.3.0.md`](docs/verification-v0.3.0.md).

The v0.3.0 and C1 records preserve earlier deployment-specific source, scan,
pagination, browser, and Topics evidence with their own provenance. Current
C1 remains open because the new rollout is read-only and the positive
scanner-to-warm and hosted restore gates are not
complete. Pack-preview UI proof is complete, with exact deployment attribution
left unknown by the stable-alias cutover. See [`docs/skills-sh.md`](docs/skills-sh.md) and
[`docs/sandbox-providers.md`](docs/sandbox-providers.md) for configuration,
compatibility, and the distinction between implementation and live verification.

## Quickstart

Use Node 24 and pnpm 11.19.0, matching [`.node-version`](.node-version) and `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm setup:dev --allow-unscanned
pnpm dev
```

`pnpm setup:dev --allow-unscanned` creates random local credentials and explicitly permits unreviewed releases for a disposable demo. Keep that mode local only. For a fail-closed setup, run `pnpm setup:dev` without the flag and configure the scanner worker before publishing releases; production must use a reviewed token, session secret, durable state provider, private storage, and scanner policy.

The development server normally listens on `http://localhost:5173`. Check the public route in another shell:

```sh
curl --fail http://localhost:5173/health
```

The root scripts are the supported local entry points:

```sh
pnpm build                         # TanStack/Nitro production output
pnpm check                         # TypeScript and Vitest
pnpm worker                        # external job and scanner worker
pnpm cli --help                    # Rust CLI through Cargo
cargo run -p pskills -- --help     # same CLI, package name is pskills
```

`pnpm worker` loads the optional local `.env` and requires `PSKILLS_API_URL`, `PSKILLS_WORKER_TOKEN`, and optionally `PSKILLS_WORKER_ID`, scanner image references, and polling settings. The worker is intended to run beside the API or as a separate service. See [`docs/operations.md`](docs/operations.md) for the environment, storage, worker, and recovery procedures.

## Authentication and API

The browser sign-in form exchanges a configured user token with `POST /auth/session`. The server hashes configured token material at startup, signs a short-lived session, and returns it as an `HttpOnly` cookie. Cookie mutations require the configured origin. `DELETE /auth/session` clears the session. The CLI uses a scoped bearer token; `pskills login` currently accepts it through `--token-stdin`, so credentials do not appear in shell history.

The web surface calls the same-origin API and exposes the implemented registry areas:

- `GET /health`, `GET /v1/me`, and `GET /v1/capabilities`;
- catalog, skill detail, scan reports, publish, rescan, and revoke under `/v1/skills`, `/v1/scans`, and `/v1/publish`;
- operations under `/v1/operations`;
- exact-member packs under `/v1/packs`;
- external catalog browsing, official collections, audits, individual imports, and unlisted pack preview under `/v1/directory`;
- scanner policy under `/v1/policy`;
- approved upstream mappings and queued imports under `/v1/upstreams` and `/v1/imports`;
- audit records under `/v1/audit`;
- authorization-aware semantic search under `/v1/search`, `/v1/search/status`, and `/v1/search/reindex`;
- client-confirmed install telemetry under `/v1/install-authorizations`, `/v1/install-receipts`, and the admin-only `/v1/analytics` report;
- human review proposals under `/v1/reviews`; the separate Eve app calls only the fixed `/internal/reviewer/prepare` and `/internal/reviewer/complete` routes;
- worker-only claim, artifact, and completion routes under `/internal/jobs`.

The production state factory starts Cisco as `required`, NVIDIA Skillspector as
`advisory`, and SkillsGuard as `advisory`, with `allowUnscanned=false`.
Development starts all scanners as `disabled`; `pnpm setup:dev --allow-unscanned`
is an explicit disposable-demo override. Administrators can set each scanner
to `disabled`, `advisory`, or `required`; required evidence must be complete,
current, digest-bound, and free of configured blocking findings before a
release becomes approved.

## Search, analytics, and review

Semantic search is opt-in. Set `PSKILLS_AI_ENABLED=true` and configure the
embedding Gateway credentials and optional model/dimension settings. A Node
deployment uses pgvector when it has PostgreSQL metadata and otherwise uses the
exact StateRepository fallback; the current implementation has no libSQL/Turso
adapter. Search indexes only approved, authorized skill text and rechecks the
artifact and content digests before returning a result. See
[`docs/semantic-search.md`](docs/semantic-search.md) for the profile, limits,
reindex, and edge gateway boundaries.

Install analytics is based on receipts submitted by the CLI after its local
transaction commits. The admin report counts changed skill/pack resolutions
and up-to-date checks, with bounded one-retry delivery. It does not count
downloads or infer installs from transfer grants. See
[`docs/analytics.md`](docs/analytics.md) for the receipt contract and
retention limits.

The Eve reviewer compares a bounded approved-skill snapshot and records
suggestions for a human. Accepting a suggestion records a decision only: there
is no model auto-merge, publish, source edit, install authorization, or
candidate execution. See [`docs/eve-reviewer.md`](docs/eve-reviewer.md).

For Vercel Node deployments, the optional hosted worker route
`GET /internal/worker/run` requires `Authorization: Bearer $CRON_SECRET` and
returns queue metadata only. The root Vercel fallback cron is `0 21 * * *`
UTC; successful publish/import/rescan requests also schedule a bounded drain of
up to two jobs through Nitro's `waitUntil` hook. Configure immutable scanner
image references, including a source-revision/artifact-digest snapshot for
SkillsGuard when used. This route is not available in the Cloudflare edge
runtime; see [`docs/operations.md`](docs/operations.md).

## Data and trust boundaries

Published content is a canonical JSON document with format `pskills-bundle-v1`. Each file contains a safe relative path and padded base64 content. The validator bounds the bundle at 2,000 files, 10 MiB per decoded file, and 100 MiB expanded. Stored bytes are hashed as `sha256:<hex>`, uploaded to a fresh sealed object key, read back, and verified before the metadata record references them.

The HTTP request limit defaults to 3,000,000 bytes, including base64 overhead. This smaller inline upload limit also applies to worker import completion; increase `PSKILLS_MAX_BODY_BYTES` only on hosts whose request limits support it. Large multipart uploads are not implemented in this release.

The request handler owns authorization, resolution, policy state, and audit records. A worker performs upstream acquisition and scanner execution after claiming a durable job. Worker completion carries a lease/fencing token, the artifact digest, the policy revision, and normalized scan evidence. Required failures remain unavailable or quarantined; they cannot be turned into approved content by a client-side flag.

## Documentation

- [`docs/implementation.md`](docs/implementation.md) describes the implemented components, route families, state/storage profiles, and operating boundaries.
- [`docs/operations.md`](docs/operations.md) is the checkable local/production runbook, including storage backups and recovery.
- [`docs/analytics.md`](docs/analytics.md) documents client-confirmed install receipts, admin aggregates, retention, and retry behavior.
- [`docs/semantic-search.md`](docs/semantic-search.md) documents the authorization-aware index and PostgreSQL/state adapter boundary.
- [`docs/eve-reviewer.md`](docs/eve-reviewer.md) documents the separate Eve app, fixed tools, schedule, and human-only decision boundary.
- [`docs/verification.md`](docs/verification.md) records command, browser, deployment, scanner, and restore evidence.
- [`docs/verification-v0.2.0.md`](docs/verification-v0.2.0.md) records the historical v0.2.0 release evidence.
- [`docs/verification-current.md`](docs/verification-current.md) records the latest source, portability, and production-gate checkpoint.
- [`docs/verification-v0.3.0.md`](docs/verification-v0.3.0.md) records the directory and sandbox implementation checkpoint and remaining acceptance gates.
- [`docs/install-directories.md`](docs/install-directories.md) documents absolute-root and agent/scope selection for isolated CLI installs.
- [`docs/roadmap.md`](docs/roadmap.md) records the source-linked Tessl comparison and prioritized product gaps.
- [`docs/completion-criteria.md`](docs/completion-criteria.md) turns the roadmap into measurable, non-blocking future milestones.
- [`docs/architecture.md`](docs/architecture.md) is the original architecture and portability design intent. Its planning language remains useful context; this README and the implementation status document describe what exists in the repository now.
- [`docs/product.md`](docs/product.md) records the product roles, journeys, and explicit scope boundaries.
- [`docs/api-and-data.md`](docs/api-and-data.md), [`docs/storage.md`](docs/storage.md), and [`docs/scanning-and-hooks.md`](docs/scanning-and-hooks.md) hold the detailed contracts and operating constraints.

The repository is private and has no open-source license. Scanner and provider licenses remain deployment and release concerns.
