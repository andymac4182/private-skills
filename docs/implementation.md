# Implementation plan

This task creates the private planning repository. No server, scanners, CLI binaries, cloud infrastructure, or deployment exists yet. The next implementation work should follow the milestones below, preserving their acceptance gates.

## Planned repository structure

```text
apps/web/                 TanStack Start/Router React UI, Nitro HTTP API and auth
packages/contracts/       Frozen JSON Schema/OpenAPI, generated Rust/TS types/vectors
packages/core/            Resolution, policy, host-neutral service interfaces
packages/jobs/            Durable job state machine, leases, outbox, adapter interface
packages/storage/         Files SDK-backed BlobStore and capability-aware transfers
packages/infrastructure/  Host, metadata transport, queue and executor adapters
packages/scanners/        Engine adapters and normalized output parsers
packages/database/        Schema, migrations, scoped repositories
crates/pskills-cli/        Rust CLI command surface
crates/pskills-core/       Rust registry client, installer, keyring, target adapters
workers/runner/           Portable job dispatcher and isolated scanner executor
workers/gateway/          Optional Node transfer/metadata service for limited hosts
workers/images/           Reproducible pinned scanner environments
fixtures/                 Benign/malicious inert bundles and contract vectors
docs/                     Product and operational documentation
```

The current root `contracts/` is a draft design folder. Move it into `packages/contracts/` when M1 establishes the actual build. Add a root Cargo workspace and committed Cargo.lock for the CLI crates. Pin TanStack/Nitro/Files SDK, supported server runtimes, package manager, Rust toolchain/MSRV, Python, scanners, and images during the spike. Select provider dependencies at build time; Node-only packages must not leak into edge API bundles.

## Milestones and dependencies

| Milestone | Deliverable | Dependencies | Completion evidence |
| --- | --- | --- | --- |
| M0 — Platform and scanner spike | TanStack/Nitro API on Node, Vercel and Workers; Files SDK private storage; portable worker; all 3 scanner adapters | This plan | Full round trip with S3-compatible storage and a backend requiring gateway fallback; runtime/provider compatibility, egress, suppression, restart, limits, costs, output schemas |
| M1 — Contracts and private registry | Auth/memberships, namespace ACL, immutable skill publishing, archive validator, artifact grants, API/DB migrations | M0 decisions | Anonymous/cross-organization denial, authorized native publish, digest-verified private download, upload limit/immutability enforcement |
| M2 — Proxy and policy gate | GitHub source adapter, source credentials, quarantine, async jobs, engine adapters, policy modes, reports, rescan/revoke, hook API | M1; scanner acceptance from M0 | Cache-miss and cache-hit behavior, required failure closure, retry recovery, policy-change races, byte-for-byte scan/distribution binding |
| M3 — CLI | Rust native releases; login, registry config, search/show/publish/install/update/remove/list/verify/doctor; target adapters | M1 contracts; M2 install gates | Rust/TS contract vectors, Cargo checks, real Windows/macOS/Linux smoke and filesystem-failure tests; no compiler/runtime prerequisite |
| M4 — Packs | Draft editor/CLI, exact published membership, project manifest/lock, ownership, conflict checks, recoverable multi-skill update | M2 and M3 | Deterministic cross-platform installs, shared-member retention, blocked-member abort, incompatible-version failure |
| M5 — Web administration and release | Catalog, reports, policies, source management, audit, backups, observability, portable deployment and storage docs | M1–M4 | Live Node/container, Vercel and Workers flows; Git-triggered Vercel deployment; backend conformance and migration/restore rehearsal; measured operating costs |

After M1 contracts freeze, CLI and web UI work can run in parallel with scanner/proxy implementation. Packs depend on the installer ownership model; define it in M1 even if the UI comes later. An experienced implementation team could use roughly 4–6 focused engineering weeks as an initial planning envelope, but M0 should replace this estimate using actual integration complexity and scanner results.

## Backlog by acceptance area

**Private registry and sources**

- Invitation/allowlist authorization separate from GitHub sign-in; owner/admin/publisher/reader scopes.
- Organization-owned GitHub App and namespace source routing; no credential-bearing URLs or public fallback.
- Complete bundle validation; provenance and license notices; immutable semantic versions and source revisions.
- Files SDK storage factory with provider selection, private uploads/downloads, qualified signing or gateway fallback, and digest verification; fresh authorization for every grant.
- Backend capability checks at startup; no silent public access, unsafe overwrite fallback, or hidden buffering beyond memory limits.
- Runtime-compatible metadata repository transport, with transactional behavior identical across Node and edge hosts.

**Proxy and jobs**

- Single fetch for concurrent requests, independent of client cancellation.
- Durable job progress, lease expiry, retries/backoff, dead letters, orphan cleanup.
- Moving refs mapped to pinned revisions; explicit cached-outage behavior and retention.
- Blocking policy reevaluation when scans expire, rules change, or versions are revoked.
- Registry-to-registry adapter with scoped tokens, bounded hops, cycle detection, independent local policy.
- PostgreSQL outbox/leased worker as the portable baseline, plus optional managed queue/workflow/executor integrations. Complete operation without a Vercel account is an acceptance requirement.
- Package caching through explicit Nitro handlers and jobs; never substitute a CDN route-rule proxy rewrite.

**Scanner adapters and hooks**

- Reproducible pinned images for Cisco, NVIDIA, and SkillsGuard; preserve license notices/SBOMs.
- Evidence normalization and schema validation; complete file coverage accounting, redaction, bounded output.
- Verify artifact-owned config/inline-ignore behavior before allowing blocking mode.
- Network denial and isolated inputs; separate opt-in OSV/LLM settings with clear data destinations.
- Revisioned scanner configuration, required/advisory/disabled modes, threshold/coverage handling.
- Custom adapter and signed webhook hooks; authenticated callbacks, replay protection, deadlines and outbox delivery.

**CLI and packs**

- Device/browser authentication, scoped automation tokens, OS keyring storage and redacted diagnostics.
- Native downloads, signature/checksum verification, platform release matrix.
- Same-volume staging, per-file integrity, installation journal and crash recovery.
- Scope-specific ownership, local-edit protection, pack/direct dependency conflict messages.
- Stable project intent and lock formats; no credentials, temporary URLs, timestamps, or absolute paths in committed locks.
- Rust CLI handles provider-neutral signed/gateway transfer descriptors and optional ranges; it contains no storage-provider SDK or credentials.

## Required end-to-end checks

1. Publish a private skill, see its scan result, install it with each OS binary, and prove the target agent discovers it.
2. Proxy an allowed GitHub skill. Confirm no artifact access exists until the entire bundle is stored and required scans complete. The CLI never contacts GitHub.
3. Make the upstream unavailable. Install an already approved exact digest from the cache; an uncached ref must fail clearly.
4. Move an upstream tag. The old lock still installs old bytes; requesting the new revision creates a new scan; an existing version cannot be overwritten.
5. Run 20 simultaneous cache-miss requests. Observe one immutable artifact and one effective publication, including a worker crash/retry.
6. Return blocking findings, scanner timeout, corrupt JSON, skipped required files, or network errors. No required result can be mistaken for a successful scan.
7. Change policy or revoke the version between resolution and download. New grants fail; already-issued grants expire within the documented window.
8. Install a pack with a blocked fifth member. No new files activate. Interrupt a later update mid-rename and recover the previous consistent installation through the journal.
9. Remove one of two packs sharing a skill. Retain the shared member; preserve edited files and unrelated skills even after removing the final owner.
10. Reject archive traversal, symlink/reparse escapes, case/Unicode collisions, Windows reserved names, decompression bombs, and changed digests on server and all CLI platforms.
11. Verify anonymous/cross-organization object/report/search requests, off-origin credential redirects, callback replay, and SSRF attempts fail.
12. Push a reviewed commit to GitHub and observe Vercel `source: git`, correct commit/branch, READY deployment, and authenticated CLI-to-storage-to-scan-to-install success. A local build or CLI-triggered deploy alone does not prove Git deployment automation.
13. Restore database and artifact evidence into an isolated environment and prove a pinned pack still resolves; scanner rule/config/image revisions remain traceable.
14. Publish identical bytes under two namespaces with different permissions/policies and revoke one release. Authorization for the other context must not make the revoked/private context installable. Revoke a pack after resolution and prove final online validation blocks activation even when every member is cached.
15. Run authenticated publish, cold/hot proxy, scan denial, pack install, and recovery against production-built Node/container, Vercel, and Workers profiles. Node dev success alone is insufficient. Include a fully self-hosted PostgreSQL, worker, and S3-compatible deployment with no Vercel services.
16. Run Files SDK backend conformance for S3-compatible, R2, GCS, Azure Blob, Vercel Blob, and filesystem profiles. Test privacy, byte integrity, failed uploads, immutable published objects, expiry, pagination/cleanup, and actual capability gaps. Qualify additional adapters through the same suite; do not list untested combinations as verified.
17. Prove private transfer works for a backend without signed URLs and on an API host whose body/time limits require an external gateway. Unsupported range requests cannot corrupt resumptions; unsupported conditional writes cannot overwrite published bytes.
18. Migrate artifacts between two Files SDK backends: rehash every copied object, retain provenance and scan evidence, atomically switch logical references, and reproduce a frozen pack without changing artifact digests. Roll back using the old references if validation fails.

These are meaningful application acceptance tests to implement with their features, not claims that tests currently exist or pass.

## Decisions to validate during M0

The required stack is already chosen: TanStack with Nitro, Rust CLI, and Files SDK storage. M0 verifies runtime/backend combinations, Nitro/SDK binding compatibility, private signed-transfer semantics versus gateway fallback, provider buffering and size limits, portable durable transactions/jobs, executor isolation, scanner compatibility, and target-agent discovery. Optional Vercel Workflow/Sandbox integrations must pass the same contracts; they cannot become dependencies of the portable baseline. Revisit the earlier effort estimate after these portability spikes.

Public download distribution and code-signing credentials may require owner-managed resources. Start native CLI distribution from the private GitHub repository; do not publish binaries or source publicly as an incidental step.
