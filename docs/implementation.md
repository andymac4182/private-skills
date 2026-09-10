# Implementation status

This document describes the code that exists in the repository now. The earlier [architecture document](architecture.md) remains the original design intent and portability target; its former planning statements should not be read as a description of the current checkout. Command, browser, deployment, and recovery evidence is kept in [`verification.md`](verification.md), with the current v0.3.0 checkpoint in [`verification-v0.3.0.md`](verification-v0.3.0.md) and the historical v0.2.0 checkpoint in [`verification-v0.2.0.md`](verification-v0.2.0.md).

## Implemented baseline

| Boundary | Source | Implemented behavior | Status boundary |
| --- | --- | --- | --- |
| Web application | `apps/web/src` | TanStack Start/Router routes, sign-in, catalog, detail, publish, packs, operations, scanner policy, upstream import, and audit views | Browser verification is recorded separately |
| Nitro composition | `apps/web/server`, `apps/web/vite.config.ts` | Nitro catch-all delegates to the portable registry handler; runtime profile selects Node or edge infrastructure | A profile build does not prove a hosted deployment |
| Registry handler | `packages/core/src/index.ts` | Health, session exchange, catalog, publishing, operations, pack resolution, policy, scans, upstreams/imports, transfers, audit, and worker routes | The handler does not fetch upstreams or execute bundle content |
| Contracts | `packages/contracts/src/index.ts` | TypeScript records for skills, bundles, artifacts, policies, scans, jobs, packs, grants, and audit | Rust and TypeScript compatibility vectors remain release verification work |
| Authentication | `packages/auth/src/index.ts` | Hashed bootstrap tokens, scoped user/worker principals, signed short-lived sessions, `HttpOnly` cookie, same-origin mutation check | No OIDC, device flow, or interactive identity provider |
| Metadata | `packages/database/src` | Memory, atomic file, PostgreSQL JSONB transaction, and authenticated HTTP CAS repositories | The production registry is connected to Neon PostgreSQL; file and authenticated HTTP remain the other deployment profiles |
| Artifacts | `packages/storage/src` | Canonical bundle encoding/validation, SHA-256 digesting, random sealed object keys, read-back integrity, and transfer gateway | Provider credentials and backend conformance remain deployment work |
| Acquisition | `packages/upstreams/src` and `workers/runner/src/acquisition.ts` | GitHub and registry acquisition with immutable identity checks, bounded reads, redirects, retries, and provenance | Existing generic sources use approved mappings; the transparent `skills-sh` feed adapter and representative cold/warm pullthrough are follow-up acceptance work. An optional per-feed source policy may restrict the built-in adapter but is not its prerequisite |
| Scanners | `packages/scanners/src` | Cisco, NVIDIA, and SkillsGuard adapter contracts, normalized reports, coverage, policy modes, and executors | Installed scanner images and live findings are environment-specific |
| Worker | `workers/runner/src` | Claims scan/import jobs, verifies artifact digests, materializes a bounded bundle, executes scanners, and completes with fencing data | Run as a separate worker with a worker token |
| Intelligence and analytics | `packages/intelligence/src`, `packages/search/src`, `packages/core/src/index.ts`, `crates/pskills-cli/src` | Authorization-aware semantic search, rebuildable embeddings, digest rechecks, review routes, and client-confirmed install analytics | AI Gateway credentials and the selected PostgreSQL/state index are deployment inputs |
| Eve reviewer | `apps/reviewer`, `packages/reviews` | Separate bounded Eve reviewer records proposals and human decisions through fixed internal routes | Production evidence completed one run, accepted one suggestion, and preserved both artifact digests; it cannot publish, merge, edit source, authorize installs, or execute candidate content |
| Hosted worker | `workers/runner/src/hosted.ts`, `packages/scanners/src/sandbox-executor.ts` | Authenticated one-shot Node/Vercel Sandbox execution with immutable image or snapshot provenance | Production evidence approved two fixtures with SkillsGuard required and `allowUnscanned=false`; edge builds do not run it |
| CLI | `crates/pskills-core`, `crates/pskills-cli` | Rust package and binary `pskills` for login, health, catalog, publish, install, verify, remove, update, scans, and packs | Private v0.2.0 archives exist for Linux, macOS Apple Silicon, and Windows; the macOS archive was downloaded and SHA-verified |

The Node production runtime factory starts Cisco (`cisco-skill-scanner`) as
`required`, NVIDIA Skillspector as `advisory`, and SkillsGuard as `advisory`,
with `allowUnscanned=false`. Development and test runtime profiles start all
scanner modes as `disabled`; `pnpm setup:dev --allow-unscanned` is an explicit
disposable-demo override. The portable core's in-memory fallback also starts
with disabled scanners and `allowUnscanned=false` for tests and migration
shims; that fallback is not the production factory. The web application
surfaces the actual API response and does not ship catalog or operation
fixtures as pretend data.

The deployed production evidence used policy revision
`policy_44f241a8-2e94-4380-b5f2-55078b71deb0` with Cisco and NVIDIA disabled,
SkillsGuard required, and `allowUnscanned=false`. This explicit deployment
policy is recorded separately from the source factory defaults above.

## Runtime composition

The request boundary is `createRegistryHandler`, a host-neutral `Request` to `Response` function. `apps/web/server/runtime.ts` composes it with an environment-selected infrastructure factory and also exposes worker-only state, blob gateway, intelligence, and hosted-worker routes. Successful publish, import, and rescan mutations schedule a bounded two-job hosted-worker drain through Nitro's `waitUntil` hook when the platform provides it. The Node profile in `runtime-node.ts` supports local file state, PostgreSQL state, HTTP state, Files SDK providers, HTTP blob storage, pgvector search, StateRepository search fallback, and the optional hosted worker. The edge profile in `runtime-edge.ts` requires authenticated HTTP state and blob endpoints so the edge request process does not require native filesystem, PostgreSQL, provider SDK, or scanner execution.

`apps/web/vite.config.ts` selects `runtime-node.ts` by default and `runtime-edge.ts` when `PSKILLS_RUNTIME_PROFILE=edge` or a Cloudflare Nitro preset is selected. Provider imports stay behind the Node storage boundary; the edge bundle uses the HTTP adapters. Nitro's `serverDir` is `./server`, and the runtime entry delegates to the same core handler used by tests and other hosts.

## Web and API surface

The UI uses same-origin calls from `apps/web/src/lib/api.ts`. It handles pending, empty, success, and API error states and unwraps the core error envelope without fabricating fallback records.

The implemented public surface is:

| Route family | Purpose |
| --- | --- |
| `GET /health` | Minimal unauthenticated liveness response |
| `POST /auth/session`, `DELETE /auth/session` | Token-to-session exchange and cookie clearing |
| `GET /v1/me`, `GET /v1/capabilities` | Principal and protocol/capability discovery |
| `GET /v1/feeds` | Readable tenant feed metadata: id, name, kind, enabled state, discovery configuration, and configuration revision |
| `GET /v1/skills`, `GET /v1/skills/:id` | Authorized catalog and detail metadata |
| `POST /v1/publish` | Validate and queue a native bundle for scan/policy processing |
| `GET /v1/scans` | Authorized scan evidence for accessible artifacts |
| `POST /v1/skills/:id/rescan`, `POST /v1/skills/:id/revoke` | Queue current-policy reevaluation or revoke a release |
| `GET /v1/operations`, `GET /v1/operations/:id` | Job status and progress records |
| `GET /v1/packs`, `POST /v1/packs`, `GET /v1/packs/:id` | List and create exact-member immutable packs |
| `GET /v1/policy`, `PUT /v1/policy` | Read and revision the scanner policy |
| `GET /v1/upstreams`, `POST /v1/upstreams`, `POST /v1/imports` | Manage optional source restrictions/explicit proxy mappings and queue generic imports |
| `GET /v1/audit` | Read the organization audit trail |
| `GET /v1/search`, `GET /v1/search/status`, `POST /v1/search/reindex` | Query, inspect, and rebuild the authorization-aware semantic index |
| `POST /v1/install-authorizations`, `POST /v1/install-receipts`, `GET /v1/analytics` | Authorize transfers, record client-confirmed install telemetry, and read admin aggregates |
| `GET /v1/reviews`, `POST /v1/reviews/run`, `POST /v1/reviews/:id/decision` | Read bounded Eve proposals, trigger a review, and record human decisions |
| `POST /internal/reviewer/prepare`, `POST /internal/reviewer/complete` | Fixed, reviewer-token-protected Eve tool boundary |
| `GET /internal/worker/run` | CRON_SECRET-protected one-shot hosted scanner invocation |
| `GET /v1/transfers/:grant` | Serve a short-lived authorized artifact transfer |
| `/internal/jobs/*` | Worker claim, artifact download, and fenced completion |

Publishing accepts a `SkillBundle` record in the canonical JSON format. A publish response is a queued operation; approval occurs only after a worker returns valid evidence and the core re-evaluates the saved policy and digest. Pack creation resolves members and records their exact resource IDs, versions, and digests; a revoked or policy-stale member prevents a new approved pack.

The follow-up transparent skills.sh contract is additive and remains separate
from the implemented-surface table above until its live acceptance evidence is
recorded. `POST /v1/proxy/resolve` accepts `{ feed?, externalId, refresh? }`,
where `externalId` is the complete source ID or an exact supported skills.sh
URL. Omitted `feed` auto-selects only when exactly one enabled feed exists; with
multiple enabled feeds the caller must select one explicitly. A bare ID/URL is
a convenience input. The response contains
`{ feed, externalId, reference, operation | resolution }`; a 202 operation may
omit `reference`, while a 200 resolution includes the verified source reference,
and both echo the original external ID. The caller does not invent a mandatory alias, `name`,
`version`, or `upstreamId`; the server owns a collision-resistant internal
record and immutable resolved revision, including when source files or hash are
null. A cold first install fetches, validates, scans, and seals the candidate
before it can enter the approved artifact cache. The cache key uses verified
canonical origin/repository/exact-path or well-known scoped identity plus
revision/digest; feed membership remains an access/provenance context and is
not itself a canonical alias. A warm install uses an authorized cache entry
without upstream lookup; concurrent cold requests deduplicate per tenant/feed/source
revision. `refresh: true` or update
rechecks the selected feed and surfaces failure rather than labeling an older
cache entry fresh. One configuration exists per feed; explicit mappings and
source restrictions remain optional administrator controls. Unknown or disabled
feeds fail before catalog access or outbound fetch.
The feed base must be canonical skills.sh or an operator-trusted gateway listed
in `trustedSkillsShBaseUrls`; a caller-supplied `credentialEnv` is rejected.
An omitted feed auto-selects only when exactly one enabled feed exists; with
multiple enabled feeds the caller must select one explicitly.

The metadata-only directory views (`GET /v1/directory/skills`, `search`,
`official`, `detail`, and `audits`) accept an optional `feed` query parameter.
Without it, the injected global directory view is returned with `feedName: null`;
core does not infer a feed from that client. With it, the server resolves the
named organization feed and checks its enabled state, `skills-sh` kind,
operator-trusted base URL, and namespace ACL before constructing the bound
directory client. A selected response carries that server-owned `feedName` at
the response boundary and on cloned skill rows; provider rows remain unscoped
inside the directory adapter. Duplicate, unknown, disabled, unauthorized, or
untrusted feed selectors fail before catalog I/O. Detail responses remain
metadata-only and omit source file contents; directory freshness/status fields
are producer metadata and do not represent registry approval.

## Authentication boundary

`TokenAuthenticator` accepts startup token configuration through `PSKILLS_BOOTSTRAP_TOKEN`, `PSKILLS_BOOTSTRAP_TOKEN_HASH`, JSON token lists, and separate worker token settings. It hashes plaintext token material at startup and compares presented credentials in constant time. User tokens can be exchanged at `/auth/session` for an HMAC-signed browser session. Worker identities are bearer-only and cannot become browser sessions or use user routes.

Production requires a configured `PSKILLS_SESSION_SECRET` with at least 32 bytes. Cookie mutations require an allowed `Origin` matching `PSKILLS_PUBLIC_ORIGIN`; session cookies are `HttpOnly`, `SameSite=Lax` by default, and `Secure` in production. The Rust CLI currently uses `pskills login --token-stdin`; OIDC and device authorization are tracked as future work rather than implied by the sign-in form.

## Bundle and artifact invariants

`pskills-bundle-v1` is a bounded JSON object containing sorted safe relative paths and strict RFC 4648 padded base64 content. The validator rejects traversal, absolute paths, separators that are unsafe on Windows, path collisions after normalization/case folding, plugin-enabling files, malformed base64, and unsupported properties. The current limits are 2,000 files, 10 MiB decoded bytes per file, and 100 MiB expanded bytes.

The storage boundary computes a SHA-256 digest over the canonical bytes. `FilesSdkBlobStore` allocates a fresh random `sealed/` key, uploads once, reads the object back, verifies size and digest, and never uses a digest as a mutable provider key. The HTTP blob gateway transfers bytes with bounded bodies, origin checks, authorization, timeout handling, and digest/descriptor validation. Published metadata references the verified object and cannot be replaced in place through the registry API.

## State and storage profiles

Metadata has three durable deployment shapes:

1. **File, single process.** `FileStateRepository` stores one JSON state file per organization under `PSKILLS_STATE_PATH`, writes through a private temporary file plus rename, sets restrictive permissions, and serializes operations with an in-process organization mutex. Production file mode requires `PSKILLS_SINGLE_PROCESS=true`; it must not be shared by multiple API instances.
2. **PostgreSQL JSONB.** `PostgresStateRepository` auto-creates `private_skills_registry_state` when enabled, stores the complete organization state in `jsonb`, locks a row with `FOR UPDATE`, increments the revision inside the transaction, and rolls back on failure. Configure `DATABASE_URL` and use this profile for a multi-process Node deployment.
3. **Authenticated HTTP CAS.** `HttpStateRepository` talks to the internal metadata service using versioned read/transaction operations. The server applies an expected-version compare-and-set under its own repository transaction; conflicts replay the synchronous updater against the latest state. The client never falls back to an in-memory copy.

Blob storage has the corresponding Node and edge boundaries. Node loads the selected Files SDK adapter (`fs`, `s3`, `r2`, `gcs`, `azure`, or `vercel-blob`) only in the Node runtime. Edge and provider-isolated deployments use `HttpBlobStore` and the internal gateway, keeping provider credentials out of the web process. Private access is required; a public base URL is not accepted as a substitute for a grant or gateway.

The production registry has exercised the Neon PostgreSQL state path and the
PostgreSQL/pgvector search path with two indexed fixtures. File and
authenticated HTTP remain supported profiles; provider-specific credentials,
privacy checks, migration, and restore tests remain deployment work for any
profile not covered by the recorded evidence.

## Jobs, acquisition, and scanners

The core creates durable `scan` and `import` jobs with a captured policy revision, artifact identity, and lease metadata. `WorkerApiClient` claims through an authenticated internal route and sends a fencing token on artifact reads and completion. A stale lease cannot finalize evidence for a newer attempt.

The runner handles two job paths:

- an import resolves an approved GitHub or registry upstream, fetches the complete bounded source, validates immutable identity and provenance, then scans the resulting canonical bundle;
- a scan downloads the sealed artifact, verifies the expected digest, materializes it into a temporary workspace, and scans that exact content.

The target skills.sh pullthrough path uses the same worker boundary: its first
install resolves the original catalog identity, acquires complete bytes into
quarantine, validates provenance, runs every required scanner and policy gate,
and stores only an approved immutable release. A reader with install and
explicit `proxy:resolve` permission may start that bounded cold operation or
install an approved warm release; the default reader/publisher grant remains
pending product approval and production verification. Readers cannot change feed
configuration, source policy, publish state, or scanner settings. A required scanner failure,
incomplete coverage, blocked finding, or stale evidence denies installation;
there is no direct-upstream fallback. This is a contract and acceptance target,
not a claim that the current source has completed representative live import
verification.

`WorkerRunner` defaults to `DockerExecutor`, which uses a disposable container with no network, read-only input, a separate output directory, dropped capabilities, a non-root UID, bounded memory/CPU/PIDs, and bounded output. `TrustedLocalExecutor` exists for adapter tests and is not the production default. The worker logs metadata-only events and sanitizes errors; it does not print artifact bytes, lease tokens, source credentials, or scanner stderr.

The three normalized scanner IDs are `cisco-skill-scanner`, `nvidia-skillspector`, and `skillsguard`. Adapter code defines commands, pinned metadata, output parsers, coverage, findings, and limitations. A required scanner must return completed, current, fully covered evidence with no configured blocking severity. Advisory findings are recorded without blocking; disabled or unavailable evidence is never represented as a successful scan.

## Rust CLI and packs

The Cargo package and binary are both named `pskills`. The client uses the same canonical bundle and digest rules as the TypeScript side, stores registry credentials by exact origin, and exposes:

```text
health, login, logout, whoami, search, show, versions,
publish, install, list, verify, remove, update, doctor,
scan status, pack list/show/install/publish/remove
```

Install planning uses explicit project/global scope, target-agent adapters (`codex`, `claude`, and `universal`), local installation state, digest verification, and pack ownership. The Rust client does not contain provider SDK credentials; it consumes registry responses and transfer descriptors.

## Deployment profiles and current verification boundary

The repository includes a production Node image and compose profile, a Vercel
Nitro template, and a Cloudflare Workers template using the edge HTTP adapters.
The earlier guarded prebuilt registry rollout is
[`dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE`](https://private-skills-theta.vercel.app),
from merged main `fecd6baa1411c2f3c2ad60b13c2c0e37761d2826`. Its current
read-only probe and policy boundary are recorded in
[`verification-current.md`](verification-current.md); feed/import, scanner,
and install mutations were not part of that rollout. The GitHub workflow still
defines Node web checks, native Linux/macOS/Windows Rust jobs, and a container
build; the historical checkpoint result remains evidence only for its recorded
revision.

The v0.2.0 verification record reports passing root/Eve TypeScript checks, 110
tests with two optional integration suites skipped locally, Rust formatting/
compilation with 30 tests, and passing Nitro Vercel, Cloudflare, and Eve builds.
PostgreSQL/pgvector passed a separate real-service conformance test. The
production integration then authenticated against the deployed registry,
approved two fixtures with SkillsGuard required and `allowUnscanned=false`,
returned both through the real pgvector search path, completed an Eve review
with one accepted suggestion, and read back unchanged artifact digests. See
[`verification-v0.2.0.md`](verification-v0.2.0.md) for the command-level record
and its limits.

The production CLI installed a two-member pack, verified both member trees,
and repeated the install without changes. Its analytics delta was two
operations: zero direct skill installs, one pack install, and one up-to-date
check. The private v0.2.0 release contains Linux x86_64, macOS Apple Silicon,
and Windows x86_64 archives plus `SHA256SUMS`; the downloaded macOS archive
passed checksum verification. The separate member records keep per-skill
counts distinct from the pack count.

Vercel registered the reviewer cron at 22:00 UTC. The authenticated route
check requires `x-vercel-cron-schedule` and returned `200`; the unauthenticated
check returned `401`. This verifies the route boundary and handler, not a
calendar-trigger observation. A negative failed-scanner check returned `404`
before install authorization, demonstrating fail-closed behavior for a
required scan failure.

The existing Vercel project is connected to
`andymac4182/private-skills` on production branch `main` without an additional
grant. A push of main commit `7c7a33e` produced READY deployment
`dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH`, as recorded in the sanitized
[Git-main deployment evidence](evidence/production-git-main-deployment-dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH.json).
The earlier prebuilt rollout uses the authorized skills.sh project-OIDC path
for its read-only checks;
skills.sh discovery/import acceptance and ComputeSDK production execution
remain separately bounded in [`verification-current.md`](verification-current.md).
OIDC/device authentication for primary user login, if required, remains a
separate feature rather than an implied capability of bootstrap-token
authentication.

The old broad M0–M5 list in the architecture planning material remains design
intent. This file distinguishes implemented source and checkpoint evidence
from work that still needs deployment or environment evidence.
