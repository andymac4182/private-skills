# Private Skills

Private Skills is a registry, pull-through proxy, and cross-platform installer for AI agent skills and curated skill packs. The repository now contains an implemented baseline: a TanStack Start/Router web surface, a Nitro request handler, portable TypeScript contracts and services, a worker/scan boundary, Files SDK storage adapters, and a Rust `pskills` client.

## Current status

The baseline implementation and its recorded v0.2 checks were established on
9 September 2026. The v0.3 production checkpoint and its remaining gates are
tracked separately in [`docs/verification-v0.3.0.md`](docs/verification-v0.3.0.md);
that record distinguishes completed evidence from pending deployment/provider
checks. The private v0.2.0 archives/checksums and clean-consumer verification are
recorded as complete, but the published v0.2.0 CLI package lacks feed,
directory, and current pullthrough support. v0.3 packaging is in progress; no
v0.3 publication is claimed.

The latest delivery status is tracked in
[`docs/verification-current.md`](docs/verification-current.md). The latest
explicitly verified Git-triggered production cascade is sourced from merged main commit
`57bce92403af37e8303c654d7a03da634c63445f`, which includes PR40 merge
`8ed18be`, PR39 merge `3e000aa`, and PR41 merge `57bce92`. Fresh
root-coordinated Vercel API evidence reports exact source `57bce924` and READY
deployments for the registry (`dpl_3gsnBMSPpdvpFdpJdcUwrD8aDVcy`), builder
(`dpl_6qo7B4evMTgxDg6Zt76LXQuXZcuy`), and upload-reviewer
(`dpl_CNTXXWDfppG7D8ZKuYVhVnhzmuhU`). The earlier `878c636` cascade remains a
historical checkpoint with its source and deployment records retained in the
verification history.

Native CI was waived by explicit repository-owner instruction on 13 September
2026 for this delivery/review scope. The workflows remain enabled, the captured
provider billing/payment or spending-limit admission prevented runner steps, and
no native target pass is claimed. The authenticated [hosted M6 viewer evidence](docs/evidence/production-m6-hosted-viewer-34e4f56.json)
and local synthetic [editor-browser record](docs/evidence/m6-editor-browser-local-29f7.json)
remain source-specific, read-only or fixture evidence. M6 terminal-session
restart PR39 (`0f71d4`) shipped in the verified `57bce924` checkpoint with its
browser-passed final UI guard; draft-resume and accessibility changes remain
pending. A new live Eve proposal is verified, while its apply, review, scan, and
publication steps remain pending.

Seven reviewed nonsecret OpenClaw production settings are active. The sanitized
[settings-stage record](docs/evidence/openclaw-production-settings-staged-20260910.json)
retains names and exit codes only; activation is configuration evidence and does
not prove import or publication. The public metadata probe remains
interoperability evidence only. Two hosted M7 candidates failed closed on
artifact digest mismatches. The public-GitHub M7 candidate failure was diagnosed
as a PAX parser issue; a local fix with the exact NVIDIA digest passed and awaits
its PR. The isolated hosted-edge proof passed through a
temporary Cloudflare Worker and Node gateway with required scanning, private
storage, semantic search, authentication negatives, revocation, and cleanup;
the edge-proof workstream owns the detailed record; its repository link will be
added after that workstream's approved merge.

C1 telemetry/parser work is in progress and physical GitHub/well-known source
pullthrough remains open. No publication is claimed, and M7 remains incomplete.
The default daily reviewer schedule `0 22 * * *` UTC is temporarily replaced by
the dated `0 0 13 9 *` UTC schedule for the `00:00–01:05` UTC 13 September
2026 proof window. The short dated probe was inconclusive and the fuller proof
is being prepared. The earlier run remains temporal correlation only until an
explicit scheduler/session identifier is captured.

M1–M5 remain future product work. This status is separate from the G0, C1, M6,
and M7 verification gates; local or read-only fixtures do not mark a milestone
complete.

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
| CLI | Implemented Rust package and binary named `pskills`; an approved same-root record on the prior production deployment proves an unchanged warm repeat | The published v0.2.0 CLI package lacks feed, directory, and current pullthrough support; v0.3 packaging is in progress and no v0.3 publication is claimed. Release targets are Linux x86_64, macOS arm64, and Windows x86_64; multi-feed CLI evidence remains a loopback fixture, not current CI. Native CI is waived for this delivery/review scope and no native target pass is claimed |
| skills.sh directory | Directory routes, source mapping, Topics parser, bounded cache, enumeration, multi-feed selection, and security checks are implemented in the current source | C1 telemetry/parser work is in progress; physical GitHub/well-known source resolution, direct zero-upstream instrumentation, and tenant/secrecy acceptance remain open. The current Git-triggered registry/builder/upload-reviewer deployments are READY at exact source `57bce924`; prior release, viewer, Pack-preview, restore, and snapshot-candidate records remain linked in [`docs/verification-current.md`](docs/verification-current.md). |
| Sandbox providers | ComputeSDK abstraction with a tested Vercel adapter | Additional providers remain disabled until they pass the scanner isolation contract |

The repository includes Node production, Vercel, and Cloudflare/Nitro build profiles. A checked-in profile or a successful local build is not evidence of a live hosted deployment; live authenticated flows, provider conformance, and restore rehearsal belong in the verification record. The scanner runner is wired to real adapter and executor interfaces, but installed scanner images and their end-to-end findings must be verified in the target worker environment.

Historical deployment, catalog, browser, scanner, CLI, and restore records retain
their own source and provider limits in
[`docs/verification-current.md`](docs/verification-current.md) and
[`docs/verification-v0.3.0.md`](docs/verification-v0.3.0.md). The earlier
guarded prebuilt rollout remains recorded in its
[sanitized evidence](docs/evidence/production-c1-feed-rollout-dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE.json)
(deployment `dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE`); its former stable alias is now
shared by a later deployment. The earlier Git-link and Git-main records remain linked
([Git-link](docs/evidence/vercel-git-link-20260910T070859Z.json),
[Git-main deployment](docs/evidence/production-git-main-deployment-dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH.json)).
The prior reviewer run and its [cron evidence](work/reviewer-cron-completion-evidence.json)
remain deployment-scoped temporal correlation; the current schedule/probe status
is stated above. The bounded hosted restore remains recorded in the
[restore evidence](docs/evidence/hosted-restore-20260910.json).

See [`docs/skills-sh.md`](docs/skills-sh.md) and
[`docs/sandbox-providers.md`](docs/sandbox-providers.md) for configuration,
compatibility, and the distinction between implementation and live verification;
source-specific fixture limits remain in the verification records.

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
