# Implementation plan

This task creates the private planning repository. No server, scanners, CLI binaries, cloud infrastructure, or deployment exists yet. The next implementation work should follow the milestones below, preserving their acceptance gates.

## Planned repository structure

```text
apps/web/                 Next.js UI, API, auth and web deployment
packages/contracts/       Frozen JSON Schema/OpenAPI, generated types/test vectors
packages/core/            Resolution, policy, persistence interfaces
packages/workflows/       Durable ingestion/scan orchestration
packages/scanners/        Engine adapters and normalized output parsers
packages/database/        Schema, migrations, scoped repositories
cmd/pskills/              Go CLI entry point
internal/                 Go registry client, installer, keyring, target adapters
workers/images/           Reproducible pinned scanner environments
fixtures/                 Benign/malicious inert bundles and contract vectors
docs/                     Product and operational documentation
```

The current root `contracts/` is a draft design folder. Move it into `packages/contracts/` when M1 establishes the actual build. Pin supported Node, package-manager, Go, Python, scanner, and image versions during the implementation spike; no speculative toolchain version is locked by this document.

## Milestones and dependencies

| Milestone | Deliverable | Dependencies | Completion evidence |
| --- | --- | --- | --- |
| M0 — Platform and scanner spike | Small authenticated API; private Blob transfer; Workflow → ephemeral Sandbox proof; build/run all 3 scanner adapters on fixtures | This plan | Actual deployable API; one complete fetch/store/scan/digest/download round trip; inspect egress, suppression behavior, limits, costs, and output schemas |
| M1 — Contracts and private registry | Auth/memberships, namespace ACL, immutable skill publishing, archive validator, artifact grants, API/DB migrations | M0 decisions | Anonymous/cross-organization denial, authorized native publish, digest-verified private download, upload limit/immutability enforcement |
| M2 — Proxy and policy gate | GitHub source adapter, source credentials, quarantine, async jobs, engine adapters, policy modes, reports, rescan/revoke, hook API | M1; scanner acceptance from M0 | Cache-miss and cache-hit behavior, required failure closure, retry recovery, policy-change races, byte-for-byte scan/distribution binding |
| M3 — CLI | Go native releases; login, registry config, search/show/publish/install/update/remove/list/verify/doctor; target adapters | M1 contracts; M2 install gates | Real clean Windows/macOS/Linux smoke tests and filesystem-failure tests; no language runtime prerequisite |
| M4 — Packs | Draft editor/CLI, exact published membership, project manifest/lock, ownership, conflict checks, recoverable multi-skill update | M2 and M3 | Deterministic cross-platform installs, shared-member retention, blocked-member abort, incompatible-version failure |
| M5 — Web administration and release | Catalog, reports, policies, source management, audit, backups, observability, distribution docs | M1–M4 | Real Git-triggered Vercel deployment, authenticated complete flows, restore rehearsal, documented rollout and operating cost measurements |

After M1 contracts freeze, CLI and web UI work can run in parallel with scanner/proxy implementation. Packs depend on the installer ownership model; define it in M1 even if the UI comes later. An experienced implementation team could use roughly 4–6 focused engineering weeks as an initial planning envelope, but M0 should replace this estimate using actual integration complexity and scanner results.

## Backlog by acceptance area

**Private registry and sources**

- Invitation/allowlist authorization separate from GitHub sign-in; owner/admin/publisher/reader scopes.
- Organization-owned GitHub App and namespace source routing; no credential-bearing URLs or public fallback.
- Complete bundle validation; provenance and license notices; immutable semantic versions and source revisions.
- Signed private upload/download grants and digest verification; fresh authorization for every grant.

**Proxy and jobs**

- Single fetch for concurrent requests, independent of client cancellation.
- Durable job progress, lease expiry, retries/backoff, dead letters, orphan cleanup.
- Moving refs mapped to pinned revisions; explicit cached-outage behavior and retention.
- Blocking policy reevaluation when scans expire, rules change, or versions are revoked.
- Registry-to-registry adapter with scoped tokens, bounded hops, cycle detection, independent local policy.

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

These are meaningful application acceptance tests to implement with their features, not claims that tests currently exist or pass.

## Decisions to validate during M0

The preferred design is already chosen; these are implementation checks rather than reasons to stop planning: actual Vercel service/plan access, private Blob signed grants, ephemeral network controls, scanner release compatibility, private-source licensing/retention defaults, target-agent path/discovery behavior, signing availability for releases, and whether separate container execution is cheaper for expected scan volume.

Public download distribution and code-signing credentials may require owner-managed resources. Start native CLI distribution from the private GitHub repository; do not publish binaries or source publicly as an incidental step.
