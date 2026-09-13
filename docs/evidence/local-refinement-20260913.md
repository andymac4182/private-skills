# Local refinement evidence — 2026-09-13

This is local-only evidence from the isolated refinement worktree. It includes
no production API calls, deployment, remote catalog enumeration, credentials,
or claims about production milestones. No live registry state was changed.

## Initial local checkpoint

- The durable C1 source pull-through proof composes the registry handler,
  worker, deterministic scanner fixture, file-backed state, and Files SDK
  filesystem storage across cold, concurrent, warm, stale-policy, and tenant
  isolation cases. It covers GitHub and scoped well-known source fixtures.
- The local M7 composition reads the real cached NVIDIA archive, validates the
  PAX source path, runs the deterministic scanner fixture, seals the artifact,
  and exercises the private producer/consumer path. It is opt-in cached-source
  evidence and does not claim provider scanner execution or hosted acceptance.
- The root build and TypeScript checks passed. The root full suite reported
  744 passing tests; the sandbox loopback issue was resolved in a focused
  rerun with 8/8 passing.
- Search health and the local Compose provider correction were integrated in
  `851b331`; the local harness retains the corresponding proof.
- The local PostgreSQL proof covered eight transaction cases, one durable
  state case, and one Files SDK case. The isolated macOS CLI proof covered
  install, warm repeat, tree verification, and analytics readback.
- The pinned local PostgreSQL image does not provide pgvector. No pgvector
  result is claimed here.
- The local Eve browser check used Nitro and a deterministic builder service.
  It reached login, exact draft URL hydration, Eve initialization, and proposal preview/
  apply through draft revision 2. The review service was disabled; the
  required scan was queued, then the local verifier compared the wrong digest
  field and the runner stopped, so scan/publication completion is not claimed.

## Deliberate limits

The full Eve review flow remained pending at that checkpoint. This note does not advance or close
any hosted C1, M6, M7, release, scanner, or production milestone. Existing
quarantine, scanner, authorization, digest, tenant, and no-execution rules
remain authoritative. The evidence is limited to the local fixtures and
checks listed above; no sweeping roadmap or status-document edits were made.

## Subsequent verification on local main

- Real pgvector persistence and fresh-connection checks passed against
  `docker.io/pgvector/pgvector@sha256:ced026f3d5bc5d6b46663fc6fb0b213b174fe15278cac4e4c7a80798ffed843c`.
  This separate test image does not change the default Compose image.
- The configured Rust CLI regression now verifies real loopback installation,
  an unchanged reinstall, exact file bytes, list/verify output, and analytics
  against disposable PostgreSQL tables and Files SDK storage. Its fixture
  explicitly permits unscanned publication; it is not scanner evidence.
  The combined pgvector and CLI/persistence run passed all four tests.
- The [real SkillsGuard OpenClaw check](local-m7-real-skillsguard-rejection.json)
  verified rejection: 237 findings, six reported analyzed files in a seven-file
  source bundle, quarantine, and no private feed entry or distribution.
  The deterministic positive OpenClaw flow remains separate evidence.
- The [local Eve browser and worker flow](local-eve-builder-required-scan-20260913.json)
  reached proposal apply, required SkillsGuard scanning (2/2 files, no findings),
  and an approved release. Its builder service was deterministic and its upload
  reviewer was disconnected; it does not prove hosted AI Gateway or M6 acceptance.
- Root TypeScript and diff checks passed. The local app, builder, and disposable
  pgvector database were stopped after verification. All changes stay on local
  `main`; no push or Vercel deployment occurred during this continuation.
