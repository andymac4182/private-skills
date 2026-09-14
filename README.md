# Private Skills

Private Skills is a registry, pull-through proxy, and cross-platform installer for AI agent skills and curated skill packs. The repository now contains an implemented baseline: a TanStack Start/Router web surface, a Nitro request handler, portable TypeScript contracts and services, a worker/scan boundary, Files SDK storage adapters, and a Rust `pskills` client.

## Current status

The private [v0.4.0 release](https://github.com/andymac4182/private-skills/releases/tag/v0.4.0)
is published at tag `84f712720dba74508d56f0bcb532393dad24324d`. Fresh downloads
of all four assets passed checksum and member-shape verification, the release
verifier, and the Mac arm64 smoke check. Linux QEMU and Windows Wine evidence
remain nonnative; native CI was waived by explicit repository-owner
instruction, so no native Linux or Windows CI pass is claimed. The
source-capable v0.4.0
revision has READY Git-linked deployments for registry
(`dpl_BZ16uezNRrXDVyQgK8uRqvbtvPHh`), builder
(`dpl_3uZbigT5xiku53WYMsMxYoXhx7r3`), and upload-reviewer
(`dpl_3CSVps6nbgFeMb4tG2bnZdw7g64J`); all three report health 200. The owner
lifted the prior deployment pause. Authenticated source GET/resolve proof is
still pending, so these results establish release/deployment reachability only
and do not establish hosted source acceptance. Current local checks are in
[`docs/evidence/local-refinement-20260913.md`](docs/evidence/local-refinement-20260913.md).

Native CI was waived by explicit repository-owner instruction on 13 September
2026 for this delivery/review scope. Workflows remain enabled and no native
Linux or Windows CI pass is claimed; the v0.4.0 verification covers the local
Mac package, Linux QEMU, and Windows Wine evidence and their compatibility
limits.

M6 and M7 remain incomplete, and the future MCP/context and other product work
is tracked in [`docs/roadmap.md`](docs/roadmap.md). Detailed C1, M6, M7,
deployment, scanner, schedule, and restore evidence is kept in
[`docs/verification-current.md`](docs/verification-current.md).

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
| Multi-source catalog proxy | Local v1 source descriptors, bounded metadata search, optional all-source fanout, exact `sourceId`/`externalId` resolution, typed acquisition contracts, a server-only 13-adapter runtime factory wired into the core handler, a passing local 3/3 full required-scan transfer fixture, and local public search/resolve evidence for five providers plus four curated GitHub sources | No new provider is claimed live in the hosted registry. `skills-directory` and `skillhub-pro` require API keys; GitHub-wide search requires `GITHUB_TOKEN`/`GH_TOKEN`; `github-custom` requires an administrator repository/ref allowlist. Hosted authenticated source acceptance remains pending. See [`docs/source-catalog.md`](docs/source-catalog.md) |
| CLI | Implemented Rust package and binary named `pskills`; the published [v0.4.0 release](https://github.com/andymac4182/private-skills/releases/tag/v0.4.0) passed fresh-download checksum/member-shape verification for all four assets, release verification, and the Mac arm64 smoke check. A separate local Mac source-selector alias install/update/verify fixture preserved physical provenance and `sourceSelectors` | Linux QEMU and Windows Wine checks remain nonnative; native CI is waived for this delivery/review scope and no native Linux or Windows CI pass is claimed. The v0.4.0 package's source-selector behavior does not establish hosted provider acceptance; skills.sh/feed compatibility remains separately bounded |
| skills.sh directory | Directory routes, source mapping, Topics parser, bounded cache, enumeration, multi-feed selection, and security checks are implemented in the current source | C1 telemetry/parser implementation is shipped in PR42/43; snapshot warm-cache reuse and source-scoped upstream fixtures are recorded, while hosted physical source resolution, concurrent cold deduplication, and tenant/secrecy acceptance remain open. Detailed deployment and evidence limits are in [`docs/verification-current.md`](docs/verification-current.md). |
| Sandbox providers | ComputeSDK abstraction with a tested Vercel adapter | Additional providers remain disabled until they pass the scanner isolation contract |

Implementation, deployment, scanner, schedule, and restore boundaries are
documented in [`docs/verification-current.md`](docs/verification-current.md).
Configuration and compatibility details remain in the linked component
documents; local fixtures do not replace live acceptance evidence.

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
- source catalog contract routes under `/v1/sources`, `/v1/sources/search`, and `/v1/sources/:sourceId/resolve`; local core/runtime/client wiring exists, while hosted provider acceptance remains pending;
- worker-only claim, artifact, and completion routes under `/internal/jobs`.

Source catalog configuration is server-only: `PSKILLS_SOURCES_ENABLED` defaults
to `true`, `PSKILLS_SOURCES_JSON` accepts an envelope or direct source map, and
`PSKILLS_GITHUB_CUSTOM_REPOSITORIES` accepts bounded exact repository/ref
specs. Unknown, malformed, or out-of-bound settings fail closed; provider
credentials never come from browser or CLI requests. Missing key-only
credentials keep their sources explicitly unavailable; they are conditional
deployment inputs rather than a requirement for the verified public adapters.

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

Native ClawHub acquisition treats its version-file manifest as the integrity
authority. The documented download may include one root `_meta.json` provider
wrapper; the worker bounds and validates that JSON identity metadata, removes
only that reserved member, and rejects duplicate, malformed, mismatched, or
other extra members. The wrapper is data-only, and the OpenClaw compatibility
archive hash remains separate from native ClawHub identity.

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
- [`docs/source-catalog.md`](docs/source-catalog.md) records the multi-source proxy contract, source inventory, configuration, trust limits, and acceptance boundary.
- [`docs/completion-criteria.md`](docs/completion-criteria.md) turns the roadmap into measurable, non-blocking future milestones.
- [`docs/architecture.md`](docs/architecture.md) is the original architecture and portability design intent. Its planning language remains useful context; this README and the implementation status document describe what exists in the repository now.
- [`docs/product.md`](docs/product.md) records the product roles, journeys, and explicit scope boundaries.
- [`docs/api-and-data.md`](docs/api-and-data.md), [`docs/storage.md`](docs/storage.md), and [`docs/scanning-and-hooks.md`](docs/scanning-and-hooks.md) hold the detailed contracts and operating constraints.

The repository is private and has no open-source license. Scanner and provider licenses remain deployment and release concerns.
