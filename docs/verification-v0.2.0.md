# v0.2.0 verification record

Recorded 9 September 2026. This is an implementation checkpoint, not a claim that the main registry is deployed end to end.

## Automated and platform checks

- Root and Eve TypeScript checks pass.
- Latest local suite: 110 tests passed; two optional integration suites skipped. The upstream fixture requires loopback networking. CI passed 112 tests with both real PostgreSQL transaction and pgvector tests enabled; only the separately exercised optional Files SDK filesystem suite was skipped.
- Rust formatting, compilation and 30 tests pass. A built v0.2.0 CLI was exercised against the running registry.
- [Checkpoint CI](https://github.com/andymac4182/private-skills/actions/runs/34353519074) passed on Linux x86_64, macOS arm64 and Windows x86_64. [Scanner acceptance CI](https://github.com/andymac4182/private-skills/actions/runs/34353518771) also passed. These runs cover commit `41b92e8`; later changes require another green run.
- Nitro Vercel and Cloudflare builds and the Eve Vercel build pass.
- A real PostgreSQL 18 / pgvector 0.8.1 disposable service passed semantic-index migration, ranking, tenant/resource/profile isolation and revocation checks. The integration test is now included in CI with a pinned service image.

## Live isolated integration

These checks used task-owned local metadata and files, real Vercel AI Gateway requests, and real Vercel Sandbox scanning. They are not production-registry tests.

1. Configured SkillsGuard as required with `allowUnscanned=false`.
2. Published two harmless skill fixtures. Both were scanned by the hosted worker and approved.
3. Reindexed their actual text through AI Gateway using 1,536-dimensional embeddings and found both through semantic search.
4. Triggered the actual local Eve service through the registry. The review completed with one consolidation suggestion; an acceptance decision persisted. Acceptance records the decision and does not merge or mutate skill artifacts.
5. Used the compiled Rust CLI to install, repeat the unchanged installation and verify its tree. The measured analytics delta was two completed operations, one skill install and one up-to-date check.

Scanner acceptance additionally ran benign and inert malicious instruction text through the same isolated snapshot adapter: zero and 15 findings respectively, with complete one-file evidence. Fixture instructions were never executed. The snapshot pins SkillsGuard commit `7badb5157f8f9e4dd9ee2acb6e0129636e3147e3` and runtime artifact digest `sha256:b13362de4598007678c8371bc26e9ce2284f1d3c21e4f8c386a614c24df6de53`.

The actual Files SDK Vercel Blob adapter passed private-object write, exact-byte read and deletion of its disposable test object. Browser checks covered the new analytics, reviews and semantic-search views at desktop and 390-pixel mobile width, with no horizontal overflow or final console errors in the checked flow.

## Hosted resources and remaining release gates

- Private GitHub repository and [PR #7](https://github.com/andymac4182/private-skills/pull/7) exist.
- Vercel registry project and private Blob storage are provisioned.
- [Eve service](https://private-skills-reviewer.vercel.app/eve/v1/health) is deployed: public health returns 200; unauthenticated session creation and service information return 401. Vercel's project API confirms the active deployment has its cron registered for 22:00 UTC daily (08:00 Brisbane).
- Main registry deployment awaits the account owner's Neon integration terms acceptance. No production registry publication, search, CLI install or scheduled Eve review is claimed yet.
- GitHub's Vercel app installation awaits the account owner's security-key confirmation. Git-triggered deployment has not been established.
- The final source revision still needs production deployment, authenticated end-to-end checks, a green final CI run and v0.2.0 release archives. The active shipping goal remains incomplete until those gates are satisfied.

Secrets, service credentials and raw local evidence stay outside tracked files. Provider availability and successful local checks do not substitute for the remaining production gates.
