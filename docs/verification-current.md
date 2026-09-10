# Current verification checkpoint

**Date:** 2026-09-10

**Status:** current source, local portability, and production read-only evidence
recorded for the portable directory gateway work. The older deployment-specific
records in [`verification-v0.3.0.md`](verification-v0.3.0.md) remain historical
evidence and are not rewritten here.

## Source and artifact provenance

PR20 is merged on `origin/main` at `db2d886bb30a31cdffcd75394ddbd0236e17fc0c`.
The reviewed application artifact was built exactly from
`7df1ce6063f57bcf262c228ccde9483be5c2210d`, whose application code is
equivalent to `7c4c877fa7036517cb2a8563ad10ec273724606c`, with output fingerprint
`1c58e44151d6201437cc82e8abfe7a94b1441a8ce176f8e07e4791f9193b086c`.
The artifact inventory reports 2,057 files, 27 symlinks, and 19,596,584 bytes;
its output checks cover five SDK probes and 27 relocated links. The single
`CI=true pnpm check` result reports 47 test files passed with two skips and 374
tests passed with two skips. No v0.3 release tag or prerelease CLI package is
claimed.

The current production deployment is READY as
`dpl_E7XXwDmCmduXKsdRKCMnMzkrYcd1`, created at
`2026-09-10T05:40:51.645Z`, at
[`private-skills-theta.vercel.app`](https://private-skills-theta.vercel.app),
with unique URL
`https://private-skills-g9gp1gk6k-andrewmcclenaghan-6046s-projects.vercel.app`.
The sanitized production gateway rollout evidence at
`/private/tmp/private-skills-01a08524/work/production-gateway-rollout-evidence-dpl_E7XXwDmCmduXKsdRKCMnMzkrYcd1.json`
is a mode-`0600` local artifact. The pass made 12 GET requests: public health
200, ten authenticated requests 200 (including one policy-envelope correction),
and unauthenticated detail 401. Metadata routes are reported by HTTP status
only. The detail response retained the expected key shape and exposed file
paths without source contents.
The strongest policy shape is SkillsGuard `required`, the other scanners
`disabled`, and `allowUnscanned=false`. A bounded log query for
`05:40:51–05:45:53 UTC` returned zero error records, and deployment preflight
validated the project, organization, and deployment arguments. No custom
gateway was enabled. This read-only pass did not create feeds, import skills,
run scanners, install via the CLI, or change roles/configuration;
canonical `https://skills.sh` request-scoped Vercel OIDC remains the production
directory path.

## Local portability evidence

- The Node gateway E2E harness produced the sanitized local record at
  `/private/tmp/private-skills-directory-gateway/work/directory-gateway-evidence-1789018602440.json`
  (evidence SHA prefix `a65a05`, mode `0600`). It used the real Rust binary
  SHA prefix `6a048c`, built from source `8c8e41e`, and covered cold required
  admission through the deterministic fixture scanner plus warm reuse after
  the upstream was stopped. The 13 upstream fixture transport requests stayed
  within the disposable loopback HTTPS-shaped fixtures, with no external calls, source/artifact
  bearer forwarding, or uploaded-instruction execution. This is
  loopback/runtime evidence; the fixture scanner is not a live external
  scanner result.
- The native edge `workerd` record at
  `/private/tmp/private-skills-edge-portable-gateway-7c4c877.evidence.json`
  covers reader-only directory list/detail and unauthorized responses through
  an HTTPS mock with metadata-only detail. It does not prove Files SDK blob
  transfer, TLS certificate validation, a live provider, or a hosted Cloudflare
  deployment; the fixture made no external network calls and did not exercise
  a scanner. A separate earlier `2a0e212` edge fixture covers Files SDK gateway
  transfer under `allowUnscanned=true`; it is local portability evidence, not a
  live provider or hosted Cloudflare result.
- The earlier Docker production-mode Node/container run at source-equivalent
  `2a0e212` passed health/authentication and publish (`202`, queued), with
  Cisco required, NVIDIA Skillspector advisory, SkillsGuard advisory, and
  `allowUnscanned=false`. Its worker image built, but no completed scanner run
  was recorded; this remains historical container evidence.

## Remaining gates

The production read-only deployment check is complete for the routes listed
above. The remaining product/operational gates are:

- browser login and current hosted browser flow checks;
- a configured feed, representative source import, scanner-admission readback,
  production scanner execution, and production CLI installation;
- hosted Neon/object-storage backup and restore;
- Vercel repository-link/Git-triggered deployment setup, with native CI still
  constrained by GitHub billing/access;
- operator-supplied Packs preview and live nested-detail availability, subject
  to the upstream route limitations already recorded in the historical probe.

These records do not establish complete C1 catalog acceptance. Required
scanner policy remains authoritative, and no uploaded skill content is executed.
M6 Diffs file viewing/editing with immutable draft releases and a separate
upload/edit Eve reviewer, plus M7 OpenClaw feed interoperability, remain future
roadmap milestones and are not release gates here.
