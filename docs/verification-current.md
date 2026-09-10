# Current verification checkpoint

**Date:** 2026-09-10

**Status:** PR31 is merged on `origin/main` at
`9caf2c178e92821cb9f3176a91a8ff5dafe2942f`. Its Git-triggered registry and
upload-reviewer deployments are READY as
`dpl_DEgATrBE5jp4itwS4bH1QUkyCXvq` and `dpl_GPEcNFJe1uymD9yWcPfkfVZziE3g`.
The sanitized [activation evidence](evidence/production-activation-rotation-dpl_DEgATrBE5jp4itwS4bH1QUkyCXvq.json)
records upload-review enablement/configuration, the credential-rotation
boundary, 12 read-only registry checks, zero registry writes, and no scanner
policy change; it records no secret values and no live model session. The
earlier [M6 read-only release-file evidence](evidence/production-m6-readonly-dpl_39j65TecJNinwh9o1Y5Y1PALvnR3.json)
retains its own source/deployment provenance. The editor API and authoring
source are shipped. A local synthetic [editor-browser record](evidence/m6-editor-browser-local-29f7.json)
from source `29f7eeab8f4743873ce5e91be6ee5b67eef1b9f7` passes the desktop/mobile
draft flow, reload, stale-CAS, binary/oversize, keyboard, guard, and overflow
checks; it does not prove hosted UI behavior, a live Eve/model session, or
screenreader/contrast/reduced-motion acceptance. One snapshot-only production
candidate still has recorded required-scan admission, isolated CLI
install/repeat, and install analytics. Physical GitHub/well-known source
resolution, direct upstream-zero instrumentation, and native CI remain pending.
A bounded hosted Neon/object-storage logical restore is verified in the
sanitized [restore evidence](evidence/hosted-restore-20260910.json): source
revision 114, five referenced objects totaling 10,381 bytes, exact target
revision 114, five digest/size-verified target objects, and post-restore target
cleanup. The copy window uses operator-quiescence attestation and does not
claim a provider lifecycle guarantee or a restored-origin health/scanner run.
The OpenClaw backend is shipped but remains disabled, with no live
interoperability evidence. M6 and M7 remain outside the current C1 release
gate.

## Current Git-triggered M6 read-only release-file checkpoint

The earlier READY registry deployment `dpl_39j65TecJNinwh9o1Y5Y1PALvnR3` was
built from main commit `0f7b3f064fdfbdf30e71bd72fef80a3385fc5426`. The
sanitized [production M6 read-only evidence](evidence/production-m6-readonly-dpl_39j65TecJNinwh9o1Y5Y1PALvnR3.json)
made 12 bounded GET checks: health, authenticated principal, policy,
capabilities, feeds, OpenClaw-disabled feed/catalog behavior, approved-release
metadata, a metadata-only release manifest, a selected `SKILL.md` read, and
unauthenticated release-file/OpenClaw requests. Normal authenticated routes
returned 200, OpenClaw-disabled routes returned 503, and unauthenticated
requests returned 401. The manifest contained no file contents, the selected
file's server-reported digest matched its transiently read contents, response
bodies and credentials were not retained, and the pass recorded zero
private-registry writes. This is production HTTP/API evidence for the M6
read-only release-file slice; it does not prove the full editor/reviewer/builder
workflow or browser acceptance. The current PR31 registry and upload-reviewer
deployments are recorded in the [activation evidence](evidence/production-activation-rotation-dpl_DEgATrBE5jp4itwS4bH1QUkyCXvq.json);
upload review is enabled/configured, but no live model session has started.

## Current M6 local editor/browser checkpoint

The sanitized [local editor-browser evidence](evidence/m6-editor-browser-local-29f7.json)
records a synthetic 123-file fixture from source `29f7eeab8f4743873ce5e91be6ee5b67eef1b9f7`.
The local API/browser flow passed at 1280px and 390px: metadata-only manifest,
selected text reads, draft creation, revision-2 save/reload, stale CAS conflict,
add/rename/remove, binary and 3.5 MiB oversize bounded states, keyboard and
navigation/close guards, and zero mobile overflow or console warnings/errors.
The fixture made no production writes and executed no candidate content. Browser
captures were inspected inline only; no portable PNG was committed, and an
unrelated prior screenshot was excluded. This is local synthetic evidence only:
hosted UI behavior, live upload-review/model execution, and screenreader,
contrast, and reduced-motion acceptance remain open.

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

## Snapshot candidate admission and install evidence

Deployment `dpl_CpAApe78RJs3oXuuk4iPzbtdnczb` from source
`e6a4b33e3a0077d716ee455e31d8c077839b730b` used the existing `skills-sh` feed
(`feed_eaa83418-bc50-443c-a3f4-e13792331f28`) and made no feed or policy
mutation. The authenticated metadata read selected
`vercel-labs/agent-skills/web-design-guidelines`; its detail returned one
`SKILL.md` path and no file contents. The [detail record](evidence/production-candidate-web-design-guidelines-detail-dpl_CpAApe78RJs3oXuuk4iPzbtdnczb.json)
keeps the provider snapshot hash as opaque metadata.

The [pull-through record](evidence/production-candidate-web-design-guidelines-pullthrough-dpl_CpAApe78RJs3oXuuk4iPzbtdnczb.json)
records the single cold operation `job_705564e4-e555-41f9-bde6-02aa15a095f1`,
approved resource `skill_976be6b7-1dc6-4ab0-b64a-e7c7f9192be0`, and artifact
digest `sha256:700a9450535b6ae3dd21cd4ec453148deb1fed25c97fcd8dd5d749e46e0bacb4`.
The production policy kept `allowUnscanned=false` with SkillGuard required;
its evidence analyzed one file with zero findings. The server-owned reference
is `@snapshot/skills-sh/vercel-labs/agent-skills/web-design-guidelines`, so
this record closes snapshot admission only. The one warm request returned
HTTP 200 and created no new import operation, but the initial verifier had a
member-shape assertion bug; the response was not replayed, and the record
preserves `responseValidated:false` rather than claiming a direct body-shape
check. The Rust binary was SHA-verified before use; its isolated first install
changed once, the identical same-root repeat was up to date, `verify` exited
zero, and analytics increased by two operations, one skill install, and one
up-to-date check. The [negative record](evidence/production-candidate-web-design-guidelines-negative-dpl_CpAApe78RJs3oXuuk4iPzbtdnczb.json)
records unauthenticated `401` and unknown-feed `404 FEED_NOT_FOUND` without an
accepted import.

The production record does not claim a real external scanner provider beyond
the deployed SkillGuard result, does not execute candidate content, and does
not claim zero upstream HTTP calls from a 200 cache response. The prior
`find-skills` quarantine remains separate negative evidence.

## Remaining gates

- Prove representative physical GitHub and well-known source resolution,
  concurrent cold deduplication, and direct instrumentation that a warm cache
  path makes no upstream request. The snapshot candidate record above closes
  snapshot admission/install/analytics only; the quarantined CI-004 record
  remains separate fail-closed evidence.
- Native CI admission currently stops before any job step with the account
  payments/spending-limit message; no test failure is claimed. The bounded
  hosted Neon/object-storage logical restore is complete for source revision 114
  and five referenced objects, as recorded in the [sanitized restore
  evidence](evidence/hosted-restore-20260910.json). Its operator-quiescence
  attestation, isolated target checks, and cleanup do not establish a provider
  lifecycle guarantee or a restored-origin health/scanner run.
- Recheck nested upstream detail and any remaining provider limits recorded in
  the C1 criteria.
- M6 editor/authoring API and source are shipped, and the local synthetic
  editor/browser fixture passes. Complete hosted UI acceptance, live
  upload-review/model execution, durable draft/CAS and publication flow,
  cross-tenant denial, and screenreader/contrast/reduced-motion checks. The
  next 22:00 UTC Eve run still needs an explicit causal scheduler/session
  identifier; the earlier cron record is only deployment-scoped temporal
  correlation.
- M7 OpenClaw backend code is shipped, but the feed remains disabled. Keep it
  disabled until its explicit feed/trust configuration and bounded producer /
  consumer interoperability evidence are ready.

These records do not establish complete C1 catalog acceptance. SkillsGuard and
the other configured scanner policy remain authoritative, and uploaded skill
content is never executed. The current unfinished product inventory has three
areas: builder Eve, upload/edit Eve, and OpenClaw feed interoperability. Seven
later product bundles remain separate: M1 context packages/agent bridge, M2
quality/evaluation, M3 team governance/lifecycle, M4 author CI/standards/library
context, M5 organization-wide visibility/automation, CLI parity, and external
pack migration. This feature count is separate from the G0, C1, M6, and M7
verification gates. M6's local synthetic browser proof passes, but its hosted,
model, and accessibility gates remain incomplete. M7's source slices are
current, but its OpenClaw feed remains disabled and has no live interoperability
evidence. Both remain outside the current release gates here.
