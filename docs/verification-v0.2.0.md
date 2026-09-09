# v0.2.0 verification record

Recorded 10 September 2026. This record keeps the historical checkpoint checks
separate from the subsequent production deployment and authenticated evidence.

## Historical automated and platform checks

- Root and Eve TypeScript checks pass.
- Latest local suite: 110 tests passed; two optional integration suites skipped. The upstream fixture requires loopback networking. CI passed 112 tests with both real PostgreSQL transaction and pgvector tests enabled; only the separately exercised optional Files SDK filesystem suite was skipped.
- Rust formatting, compilation and 30 tests pass. A built v0.2.0 CLI was exercised against the running registry.
- [Checkpoint CI](https://github.com/andymac4182/private-skills/actions/runs/34353519074) passed on Linux x86_64, macOS arm64 and Windows x86_64. [Scanner acceptance CI](https://github.com/andymac4182/private-skills/actions/runs/34353518771) also passed. These runs cover commit `41b92e8`; later changes require another green run.
- Nitro Vercel and Cloudflare builds and the Eve Vercel build pass.
- A real PostgreSQL 18 / pgvector 0.8.1 disposable service passed semantic-index migration, ranking, tenant/resource/profile isolation and revocation checks. The integration test is now included in CI with a pinned service image.

## Historical isolated integration

These checks used task-owned local metadata and files, real Vercel AI Gateway requests, and real Vercel Sandbox scanning. They are not production-registry tests.

1. Configured SkillsGuard as required with `allowUnscanned=false`.
2. Published two harmless skill fixtures. Both were scanned by the hosted worker and approved.
3. Reindexed their actual text through AI Gateway using 1,536-dimensional embeddings and found both through semantic search.
4. Triggered the actual local Eve service through the registry. The review completed with one consolidation suggestion; an acceptance decision persisted. Acceptance records the decision and does not merge or mutate skill artifacts.
5. Used the compiled Rust CLI to install, repeat the unchanged installation and verify its tree. The measured analytics delta was two completed operations, one skill install and one up-to-date check.

Scanner acceptance additionally ran benign and inert malicious instruction text through the same isolated snapshot adapter: zero and 15 findings respectively, with complete one-file evidence. Fixture instructions were never executed. The snapshot pins SkillsGuard commit `7badb5157f8f9e4dd9ee2acb6e0129636e3147e3` and runtime artifact digest `sha256:b13362de4598007678c8371bc26e9ce2284f1d3c21e4f8c386a614c24df6de53`.

The actual Files SDK Vercel Blob adapter passed private-object write, exact-byte read and deletion of its disposable test object. Browser checks covered the new analytics, reviews and semantic-search views at desktop and 390-pixel mobile width, with no horizontal overflow or final console errors in the checked flow.

## Current production verification

The main registry is deployed at [private-skills-theta.vercel.app](https://private-skills-theta.vercel.app). The recorded Vercel deployment is `dpl_9hojtmSKjjUGi8AqEaeauPJEhqja`; the Neon free PostgreSQL integration is provisioned and connected, and the private object store is configured. The production health check returned `200`. Authenticated access returned `200`, while the unauthenticated auth check returned `401`.

The live policy revision was `policy_44f241a8-2e94-4380-b5f2-55078b71deb0`, with `allowUnscanned=false`, Cisco and NVIDIA disabled for this deployment, and SkillsGuard required. Two production fixtures were approved under that policy:

- `@acme/production-alpha-mtuchdsd-ws3c9j@1.0.0`, resource `skill_67654349-c1e3-435e-bb05-b75444a2573a`, digest `sha256:8242faebc3007ee0a1dee7f47ad2451c4efdf3efc0be2893c711a695f43648e2`;
- `@acme/production-beta-mtucsw5u-wokpof@1.0.0`, resource `skill_3f1ae70b-baac-46b3-9420-90671aae376b`, digest `sha256:a199b0366e283815a0ca094f13b44828f76bca908a0fa8b4671c16a6257005be`.

Both fixtures were read back by resource ID and exact artifact digest. The real PostgreSQL/pgvector search provider indexed two records and returned two matching records for those same resources. The deployed Eve reviewer completed one run, persisted one suggestion, and recorded an accepted decision; the artifact readback remained unchanged after that decision.

A negative failed-scanner check returned `404` before install authorization for the affected resource. That is evidence that a missing or failed required scan remains fail-closed before a transfer is authorized; it is not evidence of a successful failed-scanner recovery.

Vercel registered the production cron schedule as `0 22 * * *` (22:00 UTC). The authenticated route check required the `x-vercel-cron-schedule` header and returned `200`; the unauthenticated check returned `401`. This verifies the route authorization and handler response. It does not claim that a real calendar cron invocation was observed when the check was manually equivalent.

The merged implementation revisions are [PR #7](https://github.com/andymac4182/private-skills/pull/7), commit `5c466a3`, and [PR #8](https://github.com/andymac4182/private-skills/pull/8), commit `cecc21e`; the latter carries the relative-link and SDK-tracing deployment fixes.

## Production CLI and release verification

The released private v0.2.0 GitHub Release contains Linux x86_64, macOS Apple Silicon, and Windows x86_64 archives plus `SHA256SUMS`. The macOS archive was downloaded and checksum-verified, and the compiled binary passed the authenticated production pack flow.

Against `@acme/production-verification-pack@0.2.0`, the production CLI installed one pack containing two separately reported skill members, verified both trees, and repeated the install without changes. The analytics delta was two operations: zero direct skill installs, one pack install, and one up-to-date check. The separate member records preserve per-skill counts instead of counting the pack as direct skill installs.

## Remaining verification boundary

- GitHub's Vercel app installation still awaits the account owner's security-key confirmation. Git-triggered deployment remains unverified; the recorded production deployment is evidence of the deployed result, not of a Git-triggered path.
- `skills.sh` discovery and Compute SDK features remain under development and are not completed or claimed as part of v0.2.0.

Secrets, service credentials and raw local evidence stay outside tracked files. The production claims above are limited to the sanitized evidence records and do not imply that unobserved calendar cron delivery or unimplemented integrations succeeded.
