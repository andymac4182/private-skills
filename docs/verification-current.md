# Current verification checkpoint

**Date:** 2026-09-10

**Status:** PR23 is merged on `origin/main` at
`7c7a33ec57ead2365cddcf83c93b2992bd92f201`. The earlier PR22 guarded prebuilt
production rollout is READY as `dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE`; the current read-only
API and metadata-only Pack checks are recorded below. A subsequent push of
that main commit produced READY Git-triggered deployment
`dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH` at its unique URL
`https://private-skills-m5eqoug51-andrewmcclenaghan-6046s-projects.vercel.app`,
as recorded in the sanitized [Git-main
deployment evidence](evidence/production-git-main-deployment-dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH.json).
The browser UI proof is complete; its Pack-preview window crossed a stable-alias
deployment cutover, so the exact deployment attribution is recorded as unknown.
Positive scanner-to-warm evidence and hosted recovery remain open. M6
Diffs/editor plus upload-review Eve and M7 OpenClaw remain
future milestones.

## Earlier prebuilt rollout checkpoint

The reviewed artifact source is `b1d3b6d77162899491f742e2930abe0b36137d8e`,
with the rollout record reporting only `tests/multi-feed-e2e.test.ts` as a
post-build delta from reviewed head `ad65ae5cb51c49fc86eaa44175dce1f65d58f765`.
Its manifest fingerprint is
`64d3833b2c107546011efc38e34bddea9df519a0e17e36f506b5674c46a504bf`, with
2,057 files, 27 symlinks, five SDK probes, and Node 24.x. The deployment uses a
guarded prebuilt path; it is not Git-trigger evidence.

The deployment is READY at
[`private-skills-theta.vercel.app`](https://private-skills-theta.vercel.app),
with unique URL
`https://private-skills-pvsgvckvq-andrewmcclenaghan-6046s-projects.vercel.app`.
The sanitized [rollout evidence](evidence/production-c1-feed-rollout-dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE.json)
records 18 authenticated GET requests across the route readback and C1 API
probe, two unauthenticated negative GETs, one metadata-only Pack preview POST,
and zero private-registry data mutations (no feed, import, scan, install, role,
or policy writes). The policy returned 200 with SkillsGuard
required, Cisco and NVIDIA disabled, and `allowUnscanned=false`; detail
returned 200 with file paths only, while unauthenticated detail was rejected
with 401. The deployment error-log window returned zero parsed error events.

The rollout made no feed, import, scan, install, role, or policy changes. The
sanitized [Git-link readback](evidence/vercel-git-link-20260910T070859Z.json)
confirms the existing Vercel project is connected to
`andymac4182/private-skills` on production branch `main` without an additional
grant. The separate Git-main deployment record proves the push-triggered READY
deployment and its seven authenticated plus one unauthenticated readback; it
does not change the source-specific provenance of the earlier prebuilt rollout.

## Partial C1 evidence and portability

The prior production record for
`dpl_E7XXwDmCmduXKsdRKCMnMzkrYcd1` records one owner-authorized `skills-sh`
feed, one resolve, and one `vercel-labs/skills/find-skills` import. Required
SkillsGuard analyzed one file and quarantined the release with 30 high
findings, including the reported CI-004 command-injection finding. No install
was attempted and no `allowUnscanned` override was used. The sanitized
[quarantine record](evidence/production-feed-quarantine-dpl_E7XXwDmCmduXKsdRKCMnMzkrYcd1.json)
is negative scanner evidence; it does not prove a positive cold-scan-to-warm
path.

The corrected [same-root CLI record](evidence/production-cli-same-root-dpl_E7XXwDmCmduXKsdRKCMnMzkrYcd1.json)
verifies an approved beta skill after its fresh install and a different pack
root owner was added. The same-root repeat completed with unchanged artifact
and tree digests, `changed:false`, and one `upToDateChecks` increment. Direct
and pack ownership remained in the same root; credentials and source contents
are excluded.

The current source follow-ups are local evidence: `cd50e1f` has a 48-file,
403-test, two-skip baseline. Worker compatibility `0f4e00c` has a focused
9-test verification; final reviewed head `ad65ae5` has a focused two-file,
10-test check (nine worker tests plus one integration test). The committed
multi-feed E2E records at `293abfa` and
`4f15e9b` cover two custom origins, origin-bound selection, sealed bundle
contents, and warm reuse with zero upstream HTTP calls. Their deterministic
SkillsGuard fixture uses `allowUnscanned=false`; it is not a production
scanner result. The [native edge record](evidence/edge-portability-cd50e1ff.json)
proves reader-only list/detail/auth for two gateway profiles; it does not prove
TLS validation, live Cloudflare, production data, or scanner execution.

The production [Pack preview record](evidence/production-pack-preview-dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE.json)
passed the authenticated POST contract for
[`https://skills.sh/p/nuK9jo3sTCZGB2Ul`](https://skills.sh/p/nuK9jo3sTCZGB2Ul),
schema `0.1.0`, three members, canonical `www.skills.sh` provenance, and
metadata-only output; unauthenticated access returned 401.

The [browser manifest](evidence/production-browser-pack-preview-dpl_E7XXwDmCmduXKsdRKCMnMzkrYcd1-20260910.json)
records the earlier ten-route desktop/mobile proof as `dpl_E7XXwDmCmduXKsdRKCMnMzkrYcd1`
from source `7df1ce6`, with no horizontal overflow. Its Pack-preview replay
and result-card screenshots passed with 200, 15 successful requests plus the
expected pre-login 401, and zero console errors or private-registry data
mutations. The expected auth-session and metadata-preview requests occurred,
with no imports, publishes, private-pack creations, installs, reviews, or
settings changes. That
replay crossed the stable-alias deployment cutover; the manifest deliberately
leaves its exact deployment/source attribution null. Pack-preview UI proof is
complete, but it is not promoted as `dpl_8ru…` evidence.

## Remaining gates

- Prove a clean representative source import through required scanning and a
  warm approved-cache install. The quarantined CI-004 record proves fail-closed
  denial, not positive admission.
- Complete hosted Neon/object-storage backup and restore. Native CI admission
  currently stops before any job step with the account payments/spending-limit
  message; no test failure is claimed.
- Recheck nested upstream detail and any remaining provider limits recorded in
  the C1 criteria.

These records do not establish complete C1 catalog acceptance. Scanner policy
remains authoritative, and uploaded skill content is never executed. M6 Diffs
file viewing/editing with immutable draft releases and a separate upload/edit
Eve reviewer, plus M7 OpenClaw feed interoperability, remain future roadmap
milestones and are not release gates here.
