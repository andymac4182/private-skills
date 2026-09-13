# Production resumption runbook

This is a bounded resumption plan for local `main` at `e2ef16e`. Pushes,
deployments, remote reads, and production credentials remain paused until the
owner lifts that pause and authorizes the next external action. The checkpoint
was 27 commits ahead of the cached `origin/main`; that cached relationship must
be refreshed before selecting a deployment source.

## 1. Reconcile the source

1. After the pause is lifted, perform a read-only remote reconciliation with
   `git fetch origin main`, then record `git rev-parse main origin/main`,
   `git log --oneline main..origin/main`, and `git diff --stat main...origin/main`.
   Do not reset, rebase, merge, or push as part of this step.
2. If remote `main` differs, stop and re-review the complete changed source.
   Select one exact commit for the release record and ensure the local tree is
   the intended source before any deployment.
3. Run only the bounded local builds needed for changed targets with the
   existing `scripts/platform-build.ts` entry point (`node`, `vercel`, or
   `cloudflare`). `scripts/build-vercel.mjs` is a local Vercel output and
   dependency-isolation check; neither script is deployment evidence.

## 2. Deploy the exact source through Git

Use the repository's source Git integration for the selected `main` commit and
verify all three projects independently:

1. `private-skills` (registry)
2. `private-skills-builder` (builder)
3. `private-skills-upload-reviewer` (upload reviewer)

Each deployment must be READY and report the selected commit and `main` ref.
Record the deployment IDs and stable aliases before starting browser or API
verification. The historical three-project shape is retained in
`evidence/production-release-checkpoint-34e4f56.json`; it is a reference for
what to record, not current deployment proof.

Keep the daily-reviewer project and its schedule as a separate historical
readback. If the selected source or deployment changes that service, verify its
project, schedule, and `/eve/v1/info` result independently; it is not a fourth
current source-Git target in this three-project deployment set.

Do not use a manual or prebuilt Vercel deployment to work around a quota or
rate-limit response. In particular, do not invoke `vercel deploy` or
`scripts/vercel-release.mjs` while the source-Git/quota gate is unresolved. If
any of the three Git-triggered deployments is rate-limited, queued, or serves a
different source, leave the aliases unchanged and stop.

## 3. Close the hosted C1 pullthrough slices

Use a disposable test source and separate authenticated tenant sessions. Keep
the existing authorization matrix: the default reader/publisher grant for
`proxy:resolve` is still pending explicit product approval and production
verification (`docs/completion-criteria.md`, C1-TENANT). Do not change grants as
part of this runbook; use an owner/admin or an already authorized principal.

For one representative physical GitHub source (including its exact root or
nested path) and one well-known source, capture the following in one sanitized
record:

1. **Cold:** `POST /v1/proxy/resolve` with the supported feed/external identity
   fields only. Confirm `202`, one durable operation, physical source fetch,
   complete-byte validation, required scanner approval, and the resulting
   approved reference/provenance digest.
2. **Concurrent cold:** use a distinct uncached identity/revision, or make this
   batch the first requests for the selected identity before any request is
   approved. Issue several identical requests for the same tenant, feed,
   identity, and revision. Confirm one operation, one source fetch, one scanner
   set, and one sealed artifact.
3. **Warm:** repeat after approval with fresh reader authorization and explicit
   `proxy:resolve`. Confirm `200`, the same approved digest/reference, and zero
   catalog/source upstream requests. Exercise `refresh: true` separately and
   record a failed refresh as failure rather than freshening old cache data.
4. **Tenant/secrecy:** repeat the cross-feed and cross-tenant guesses with a
   second session. Confirm an authorization-safe response with no source
   metadata, digest, bytes, scanner report, transfer descriptor, credentials,
   or additional upstream request. Check sanitized browser/network and audit
   output for the same redactions.

Local pullthrough fixtures prove composition and deduplication, but they do not
close these hosted physical-source checks. Keep the existing `allowUnscanned`
policy and required scanner configuration unchanged.

## 4. Verify current hosted M6 authoring

Against the three deployments from step 2, use a fresh authenticated browser
session and verify the current source, rather than replaying the historical
read-only viewer. Exercise builder chat → proposal → diff/file view → explicit
apply → saved reload, then upload/edit review, required scanner decision, and an
explicit immutable release. Include a changed-revision stale-proposal conflict,
cross-tenant denial, and a check that no candidate content executes or creates
an unintended write.

Record the exact deployment/source SHA and model/Gateway result for the builder
and upload-reviewer paths. Check keyboard and focus behavior, screenreader
semantics, contrast, reduced motion, and no-overflow at desktop and 390px
widths. A model-unavailable, stale alias, or pre-fix panel result leaves the
corresponding M6 gate open. `scripts/local-m6-fixture.mjs` remains a local
deterministic fixture; it cannot be promoted to hosted Eve evidence.

## 5. Verify M7 producer, consumer, and worker composition

1. **Producer:** read the configured private `/v1/feeds/skills` route with its
   separately assigned feed ID. Verify schema-v1 fields, deterministic bytes
   and digest, sequence/time/expiry bounds, ETag/Last-Modified, conditional
   `304`, bounded caching, and absence of credentials, private bytes, or scan
   reports. The public ClawHub metadata probe remains metadata evidence only.
2. **Consumer:** authenticate a reader for catalog refresh and selection,
   submit only `{ "externalId": "..." }` to
   `/v1/feeds/skills/import`, and verify cold `202` → worker completion →
   source proof → private publication. Verify warm reuse, administrator-only
   refresh, provenance/digest mismatch rejection, expired/wrong-ID/changed
   source rejection, and tenant-safe responses. Feed metadata never substitutes
   for local scanner approval.
3. **Worker/provider:** run the source-bound Node worker with the configured
   gateway, immutable scanner image, explicit credential bindings, and durable
   state/blob services. Verify GitHub/ClawHub source resolution, canonical
   validation, required scanner admission, proof recording, and private feed
   publication without executing skill content. For an edge Nitro deployment,
   verify HTTP state/blob and the external worker together; the edge request
   process does not run native scanners. The current sandbox adapter qualifies
   Vercel; a non-Vercel provider requires its own adapter and conformance proof.

The local PAX validation/cached-source composition (`485b1d8`, `7b4227f`) is
committed local proof, not held hosted evidence. Separately held PAX/edge export
approval artifacts, including the isolated hosted-edge record from `c7a0f03`,
remain held evidence. They do not authorize a retry, establish current
deployment provenance, or replace the provider/worker proof above.
`scripts/edge-local-smoke.ts` is likewise a local edge smoke check, not hosted
M7 acceptance.

## 6. Keep unresolved boundaries explicit

Remote-main reconciliation, the three source-Git deployments, hosted physical
C1 sources, C1 tenant/secrecy proof, current hosted M6 model/browser and
accessibility proof, M7 provider/worker execution, and any pending
`proxy:resolve` grant approval cannot progress in this local-only phase. Native
CI remains waived and no native target pass is claimed. The original G0
verification records remain accurate for their recorded source, deployment,
and limits; this runbook neither reopens nor broadens those historical claims.
