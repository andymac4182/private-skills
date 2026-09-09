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

| Area | Current status | Boundary |
| --- | --- | --- |
| Web registry surface | Implemented with TanStack Start/Router, React, and native CSS | Uses live same-origin API data and reports loading, empty, and error states |
| Registry API | Implemented as a portable `Request`/`Response` handler with Nitro adapters | Directory lookups are bounded; workers acquire and scan release artifacts, and uploaded content is never executed |
| Authentication | Implemented bearer-token bootstrap and signed `HttpOnly` browser sessions | Primary user login remains token-based; server-side skills.sh Vercel project OIDC forwarding is verified for the current directory evidence, and device flow/interactive identity providers are not part of this baseline |
| Artifacts | Implemented bounded canonical `pskills-bundle-v1` JSON, digest checks, private sealed-object storage, and transfer grants | Bundle content is data; the registry never runs skill scripts or install hooks |
| State | Implemented file state for a single API process, PostgreSQL JSONB transactions, and an authenticated HTTP CAS repository | The selected state provider and recovery procedure are deployment configuration |
| Storage | Implemented Files SDK filesystem/provider adapters and an authenticated HTTP gateway | Each provider still needs its own credentials and conformance evidence before production use |
| Jobs and scanning | Implemented leased worker protocol, fencing tokens, scanner adapters, policy evaluation, and Docker executor boundary | Scanner images, credentials, and external executor infrastructure are deployment inputs |
| Semantic search | Implemented authorization-aware embedding search, rebuildable indexes, and catalog search/status controls | Opt-in model credentials and the selected PostgreSQL/state index require deployment configuration |
| Install analytics | Implemented client-confirmed install receipts, bounded retention, and an admin report | Counts are best-effort telemetry; failed receipt delivery is not an install failure |
| Eve reviewer | Implemented a separate bounded Eve 0.52.3 reviewer that records human-review proposals | Eve cannot publish, merge, edit source, authorize installs, or run candidate content |
| CLI | Implemented Rust package and binary named `pskills`; native OS CI passes | Release targets are Linux x86_64, macOS arm64, and Windows x86_64 |
| skills.sh directory | Directory routes, source mapping, Topics parser, bounded cache, enumeration, and security checks are implemented at source `0f9da75`; current READY deployment is `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` | The current read-only API probe verifies list/search, fail-closed auth, and fresh-canonical Topics; current browser proof, selected imports, nested upstream detail, Packs preview, and tenant/secrecy evidence remain pending. The earlier `dpl_3DgJ6ovpoESraFXCjVhiX39f1tRj` probe is retained as stale-canonical regression evidence, and `dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC` proves metadata-only pagination across 9,738 rows and 20 pages |
| Sandbox providers | ComputeSDK abstraction with a tested Vercel adapter | Additional providers remain disabled until they pass the scanner isolation contract |

The repository includes Node production, Vercel, and Cloudflare/Nitro build profiles. A checked-in profile or a successful local build is not evidence of a live hosted deployment; live authenticated flows, provider conformance, and restore rehearsal belong in the verification record. The scanner runner is wired to real adapter and executor interfaces, but installed scanner images and their end-to-end findings must be verified in the target worker environment.

The current registry checkpoint is deployed at
[`private-skills-theta.vercel.app`](https://private-skills-theta.vercel.app),
with Neon PostgreSQL/pgvector, private Blob storage, and required SkillsGuard
scanning. The current READY deployment is
`dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` with output fingerprint
`613f05b33f43aa449e28e3a0c65821b046524e43e50a2214b96f284910023662`.
Its Cloudflare build fingerprint is
`a8b82a0dadb571106cd126d98039af579e04a8d45fa787f1b9b0a9358e884b31` with
35 server files and no executable SDK references. The checked-in all-time
pagination record is from the earlier `dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC`;
OIDC/ComputeSDK and browser evidence also remains identified by its own
deployment in the v0.3.0 verification record. The current source review reports
286 tests passed and two environment-dependent skips, TypeScript and the edge
bundle checks pass, and two independent review approvals are recorded. The
previous deployment's [sanitized API probe](work/production-c1-api-evidence-1788993090676-80975-dpl_3DgJ6ovpoESraFXCjVhiX39f1tRj.json)
records safe list/search and credential-negative behavior but stale-canonical
Topics. The [current API probe](work/production-c1-api-evidence-1788993909280-85606-dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y.json)
is verified for health, authenticated `/me`, policy, list, fuzzy search, fresh
canonical React and Marketing Topics, and unauthenticated Topics rejection;
current browser proof for the new deployment is still pending. The
recorded authenticated publishing,
search, CLI pack installation, analytics, and Eve review flows are
carried forward from the verified private-registry evidence. The separate reviewer runs at
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
Git-triggered deployment verification, full C1 catalog acceptance, and hosted
restore remain pending.
See [`docs/verification-v0.3.0.md`](docs/verification-v0.3.0.md).

The v0.3.0 checkout adds the external directory and ComputeSDK integration. The
current source head `0f9da75` has the Topics canonical-page parser, bounded
metadata cache, conflict-aware enumeration, and credential-negative tests; its
review reports 286 tests passed and two environment-dependent skips. The current
READY deployment carries the enabled directory and ComputeSDK configuration;
earlier deployment artifacts verify the authenticated directory endpoints, scan,
pagination, and captured 390px/1280px browser surfaces. Full C1 acceptance
remains open while current browser proof, selected import, nested detail, Packs
preview, and tenant/secrecy checks are completed; the earlier deployment's
stale-canonical Topics result remains preserved as regression evidence, while the
current API result is verified. The historical
disconnected deployment and the prior ComputeSDK pre-analysis failure remain
preserved in the verification record.
See [`docs/skills-sh.md`](docs/skills-sh.md) and
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
- [`docs/verification-v0.3.0.md`](docs/verification-v0.3.0.md) records the directory and sandbox implementation checkpoint and remaining acceptance gates.
- [`docs/install-directories.md`](docs/install-directories.md) documents absolute-root and agent/scope selection for isolated CLI installs.
- [`docs/roadmap.md`](docs/roadmap.md) records the source-linked Tessl comparison and prioritized product gaps.
- [`docs/completion-criteria.md`](docs/completion-criteria.md) turns the roadmap into measurable, non-blocking future milestones.
- [`docs/architecture.md`](docs/architecture.md) is the original architecture and portability design intent. Its planning language remains useful context; this README and the implementation status document describe what exists in the repository now.
- [`docs/product.md`](docs/product.md) records the product roles, journeys, and explicit scope boundaries.
- [`docs/api-and-data.md`](docs/api-and-data.md), [`docs/storage.md`](docs/storage.md), and [`docs/scanning-and-hooks.md`](docs/scanning-and-hooks.md) hold the detailed contracts and operating constraints.

The repository is private and has no open-source license. Scanner and provider licenses remain deployment and release concerns.
