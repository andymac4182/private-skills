# Local refinement evidence — 2026-09-13

This is local-only evidence from the initial isolated refinement worktree and subsequent work on local `main`. It includes
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

## Scanner coverage correction on local main

The real provider check exposed a file-accounting defect: a scanner could omit
a file and report a self-consistent clean count for the smaller set. The worker
now uses its own regular-file count as the denominator and degrades mismatched
reports. Required scan admission also checks the stored artifact file count,
so previously persisted incomplete evidence cannot authorize new downloads or
reuse an already-issued transfer grant. The standalone OpenClaw projection
applies the same admission check.

- The [real SkillsGuard before/after check](local-skillsguard-coverage-regression-20260913.json)
  preserves the positive two-file case. Adding a harmless signature/binary file
  previously passed with reported 2/2 coverage; after the fix it reports 3
  enumerated / 2 analyzed, degrades, and denies required approval. The before
  execution used a verified tag; the after execution used the immutable image ID.
- The [updated real OpenClaw source check](local-m7-real-skillsguard-coverage-rejection-20260913.json)
  now retains all seven input files in normalized coverage. Its six analyzed
  files produce `scan-error`, with no source proof, feed entry, or distribution.
  The earlier quarantine record above remains historical evidence.
- Core regressions cover native and imported completion, invalidation of
  persisted underreported and overreported evidence, and denial of an existing
  transfer grant before reading blob bytes. The authoring and GitHub worker
  test scanners now count their actual input files, including nested files.
- Final root verification passed: 757 tests, seven opt-in tests skipped,
  TypeScript, and whitespace checks. Separate real Docker provider checks
  above cover the positive and expected-negative scanner paths.

These checks are local only and do not advance hosted acceptance or native
Windows/Linux CI. No remote push or deployment was performed.

## Editor and upload-review continuation

The review panel now collects and submits the required dismissal reason and
shows the persisted decision reason. Mutation responses are fenced to the
selected draft revision/digest; retries display only their attached result,
and pending reviews have a bounded refresh path. Stale findings have no
decision actions. Rendered React tests exercise the reason payload, delayed
response after a draft switch, pending-to-complete retry behavior, manual
refresh of an existing pending review, and dismissal focus handling.

The composed `tests/authoring-e2e.test.ts` fixture now includes the separate
upload-review prepare/complete HTTP handlers. It proves exact snapshot review,
an audited dismissal, edit-triggered staleness, denial of a stale decision,
current-revision review, explicit required-scanner queueing, and approved file
retrieval. The reviewer completion and scanner are deterministic fixtures;
this does not claim a model invocation or hosted acceptance.

Snapshot validation uses the builder's deterministic path ordering instead of
host locale ordering. A regression verifies mixed-case/accented paths and
idempotent replay of a legacy persisted snapshot without rewriting it.

Editor tabs now have roving keyboard focus and named tab/panel relationships.
The builder proposal diff reuses the existing Pierre accessibility hook.
A disposable local browser fixture on port 3001 verified ArrowRight/Home/End,
one tabbable tab, panel labels, builder-unavailable output, and review error
announcements. The fixture used source `08987af` plus this working tree and
isolated file/blob state; its server was stopped afterward. No screenshot or
trace was saved. The browser did not exercise a live busy mutation or rendered
builder proposal diff, so these observations do not close full M6-A11Y.

Root verification passed: 763 tests, seven opt-in tests skipped, the full
TypeScript command, the production web build, and whitespace checks. No push,
production call, or deployment was performed.

## Connected review browser flow and explicit rerun

An authenticated disposable Nitro fixture connected the real upload-review HTTP
handlers and file persistence to a deterministic local reviewer. The browser
verified dismissal reason focus, whitespace refusal, Cancel focus restoration,
keyboard submission, and persisted decisions. Editing README.md saved revision
2, made the old review stale, and produced a current review. At a 390px viewport
the document and body remained 390px wide; tabs and the persistent polite review
status region retained their accessibility semantics.

The browser explicitly queued release `0.0.1-review-flow`. The real worker then
used the immutable cached SkillsGuard image through DockerExecutor: the exact
revision-2 digest was approved with 2 enumerated / 2 analyzed files and zero
findings. Read-only browser and API checks then confirmed the approved release,
completed operation, two-file manifest, and exact edited README content.
The [sanitized record](local-upload-review-browser-skillsguard-20260913.json)
contains the job, digest, image identity, coverage, source provenance, and limits.
The reviewer was a fixture, not a hosted Eve/Gateway model invocation. Its 25ms
completion prevented observation of manual pending refresh in the browser;
rendered tests cover that transition. No screenshot or trace was saved.

This browser pass also exposed an idempotent request being described as a newly
queued review. The final implementation now routes an explicit terminal rerun
through the retry endpoint, retains historical results, rejects active duplicate
attempts, and reports the returned state accurately. Current binding and reviewer
contract checks still fence retries. Rendered, persistence, and HTTP regression
tests verify the fix; the browser pass preceded this rerun fix and is not proof
of its final browser behavior.

Final combined checks passed: 768 tests, seven opt-in tests skipped, TypeScript,
and the production web build. Work remains on local main; no push, production
connection, or deployment was performed. Hosted acceptance and native
Windows/Linux evidence remain separate.

## Combined authoring regression and file-tree synchronization

The composed HTTP regression now connects the builder session/prompt/proposal
contract to explicit apply, upload review, required scanner admission, and
approved manifest/file retrieval. The builder callback uses a separate scoped
principal. The test rejects stale apply and checks that a proposal leaves draft
bytes unchanged until an author applies it. Both the model and scanner are
deterministic fixtures in this test; it is not real scanner or hosted evidence.

The Pierre tree hook initializes its model once, so the editor now explicitly
resets changed paths and synchronizes controlled selection. The installed tree
model test verifies retained selection during reset; a rendered boundary fixture
verifies selecting an added path among 100 nested paths, current callbacks, and
null selection. These tests do not prove large-tree browser scrolling or syntax
highlighting. Builder lifecycle and proposal transitions now have polite status
announcements, including pending-to-applied rendered coverage. Existing shared
styles already handle reduced motion and visible focus.

Combined validation: 773 tests passed and seven opt-in tests skipped. The new
composition initially exposed nullable test assertions during TypeScript checks;
an explicit runtime guard corrected them, and the focused seven-test authoring
suite plus full TypeScript check passed. The reusable combined browser fixture
is still being prepared; no combined live browser or provider result is claimed
for this checkpoint. No remote push or deployment occurred.
