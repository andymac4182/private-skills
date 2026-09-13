# Product roadmap, competitor gaps, and editor review

This roadmap records the product gaps identified by comparing Private Skills
with the official Tessl documentation and product pages checked on 9 September
2026. The evidence review used `docs.tessl.io` and `tessl.io`; `tessl.com` was
not used as evidence. It is a product planning document, not a parity promise.
The explicitly requested skills.sh catalog, source pullthrough, and cloud-view
delivery is tracked separately from the Tessl comparison in
[`skills-sh.md`](skills-sh.md). That review used the current skills.sh site,
its documented API, and the official `vercel-labs/skills` repository.
The current delivery baseline and its remaining production gates are recorded in
[`verification-current.md`](verification-current.md), with the historical v0.3.0
and v0.2.0 checkpoints retained separately. The measurable exit gates for this
roadmap are in [`completion-criteria.md`](completion-criteria.md).
The Private Skills status column is based on [`README.md`](../README.md),
[`implementation.md`](implementation.md), the CLI and pack contract
([`cli-and-packs.md`](cli-and-packs.md)), semantic search
([`semantic-search.md`](semantic-search.md)), and the latest verification
record; proposed language in older design documents is not treated as shipped
behavior.

The Diffs review was added on 10 September 2026 from the official
[`diffs.com`](https://diffs.com/) pages and the linked
[`pierrecomputer/pierre` source](https://github.com/pierrecomputer/pierre).
M6 and M7 are now active implementation milestones selected for the current
product work, while remaining separate from the G0/C1 release gates until
their evidence passes. The concise M6 authoring contract is in
[`m6-authoring-contract.md`](m6-authoring-contract.md).

## Ordering

The v0.2.0 shipment remains the first priority. It is complete only when the
production gates in the verification record pass; Tessl parity work does not
silently expand that release. The later milestones below are ordered by the
amount of user value they add to a private registry and by their dependency on
new content and execution boundaries.

- **Now: close the remaining C1 evidence.** Merged main is
  `499b64fd22ab2ab149a6bf51f77949c0ed004934`, including PR48 (`fa56c21`),
  PR49, and PR50. The latest production READY source is PR48 `fa56c21`; Vercel
  rate limiting delayed deployments containing PR49 and PR50. C1
  telemetry/parser implementation is shipped in PR42/43; the root-reviewed
  snapshot warm-cache proof records same-resource/digest reuse with zero
  catalog/source upstream requests, and PR48 adds scoped v0.2 composed-fixture
  coverage. Source-scoped upstream GitHub/well-known fixtures pass, while
  hosted physical source pullthrough, concurrent cold deduplication, and
  tenant/secrecy acceptance remain open. Native CI was waived by explicit
  repository-owner instruction on 13 September 2026 for this delivery/review
  scope; workflows remain enabled and no native target pass is claimed. The
  published v0.2.0 CLI package lacks feed, directory, and current pullthrough
  support. The private v0.3.0 release at PR46 (`973b34a`) is published with
  archive/fresh-download verification; Linux-container and Windows-Wine checks
  are not native CI. The isolated hosted-edge proof passed separately with its
  disposable resources cleaned up; it does not close the remaining product
  gates.
- **Current follow-up delivery: skills.sh cloud catalog.** The authenticated,
  on-demand catalog adapter, identity-preserving pullthrough, approved-cache
  behavior, and Packs, Topics, Official, and external Audits views remain the
  scoped C1 delivery described in [`skills-sh.md`](skills-sh.md). Telemetry and
  parser implementation is shipped in PR42/43. The root-reviewed snapshot warm-cache proof
  records same-resource/digest reuse with zero catalog/source upstream requests;
  source-scoped upstream GitHub/well-known fixtures pass, while hosted physical
  source resolution, concurrent cold deduplication, and tenant/secrecy
  acceptance remain open. Existing private-pack management is in scope; external
  batch migration remains future work.
- **M6 authoring source shipped; composed browser/review evidence remains active and incomplete.**
  The current READY service set and historic [hosted read-only viewer evidence](evidence/production-m6-hosted-viewer-34e4f56.json)
  establish the viewer boundary only. The [local synthetic editor/browser
  evidence](evidence/m6-editor-browser-local-29f7.json) passes bounded
  desktop/mobile draft checks. Terminal-session restart PR39 (`0f71d4`) shipped in
  the verified `a4c12d5` checkpoint with its browser-passed final UI guard;
  full hosted accessibility and authenticated-control checks remain pending. The
  API flow applied the proposal,
  passed review and required scanning, and published through the stable registry
  alias. Its preflight deployment was source-`57bce924` /
  `dpl_3gsnBMSPpdvpFdpJdcUwrD8aDVcy`; the alias changed during the mutation
  window, so the exact deployment serving each mutation is unknown. No skill was
  installed or executed. PR45 (`9c16407`) is merged with 21 focused
  accessibility checks and public browser contrast/reduced-motion checks passing.
  The Eve workstream's safer exact-form-bound [readback evidence](evidence/production-m6-terminal-restart-release-20260913.json)
  passed isolated login, released `SKILL.md` content, full scan, upload-review
  state, and the exact publish-draft URL's revision-2 file/review browser
  readback. The pre-fix Eve panel reported `revision and digest are required for
  the selected draft`; post-fix panel validation is blocked while Vercel
  rate-limits deployment of PR49 and PR50. Full hosted builder UI and post-fix
  Eve-panel validation remain pending. The
  upload-origin editor route remains unverified because this draft has no
  release base. Its verifier diff (`verify-m6-post-proposal-reviewed.diff`)
  binds required scan evidence to approved skill IDs and scanner
  rules/freshness checks; no PR or production deployment is claimed for that
  doc commit. Bearer and cookie API/session diagnostics passed. PR47 (`a4c12d5`)
  now has all three Git-triggered production deployments READY. Its direct-draft
  evidence records the same identity/revision with two file contents, 19 focused
  draft-resume tests, 93 web tests, TypeScript/build green, and no registry
  writes; existing production secret configuration was preserved and no secret
  values are recorded. Complete M6 still requires the composed editor, durable drafts, upload/edit reviewer,
  builder, and their end-to-end evidence. This milestone is active
  implementation work, but it is not a G0 or C1 release gate until its criteria
  and evidence pass.
- **Active implementation, incomplete: M7 OpenClaw skills feed interoperability.**
  Seven reviewed nonsecret production settings are active. Two hosted M7
  candidates failed closed on artifact digest mismatches. The public-GitHub M7
  candidate failure was diagnosed as a PAX parser issue; a local fix with the
  exact NVIDIA digest passed and awaits its PR. No feed import or publication is
  claimed. The later **M7** milestone below covers the versioned producer/consumer
  contract, exact source/digest mapping, bounded refresh, tenant-safe
  publication, local scanner admission, and fixtures. It remains an
  interoperability milestone, not a requirement to mirror the public catalog or
  a G0, C1, or M6 release gate.
- **P1: CLI compatibility after the cloud contract.** Add registry-mediated
  `find`/source selectors, lock check/restore/sync, source-aware lock
  provenance, multi-skill selection, and a data-driven agent registry only
  after the cloud contract is stable. These are future compatibility work, not
  claims about the current Rust CLI.
- **P1: make the registry an agent-context package manager.** Add a safe
  package model for rules and documentation, a project manifest/lock and
  dependency sync, an agent-facing MCP/context bridge, and the first native
  integrations. Add workspace membership and lifecycle controls where the
  one-organization baseline becomes a team-hosted service.
- **FUTURE M1-MCP-DISTRIBUTION — bidirectional authenticated MCP distribution.**
  Support consuming skills and packs from an explicitly registered and
  allowlisted MCP server as a source, preserving server/resource identity and
  any upstream revision and digest that the provider supplies. If the source
  omits either value, record a clearly labeled immutable local snapshot with a
  computed canonical digest; never invent an upstream version or present the
  local digest as a provider digest. Reads are bounded and on demand; changed
  or missing source bytes, invented versions, transport errors, and stale cache
  entries fail closed before existing bundle validation, required scans, quarantine,
  provenance, and tenant authorization. The source adapter permits only the
  approved discovery/resource-read operations and never executes arbitrary MCP
  tools, hooks, or skill code. In the other direction, provide a narrow
  authenticated MCP distribution surface for approved immutable versions,
  manifests, files, and packs with canonical digest and provenance. Integrate
  client-controlled install, update, and restore through the existing Rust CLI
  and distribution contracts; require explicit mutation consent and use only
  scoped, short-lived transfer grants without raw secrets. Server-side source
  credentials and authorization remain private to the configured source and
  never leak across feeds or tenants. Required scanner evidence, revocation,
  tenant authorization, and install-receipt analytics remain authoritative.
  Acceptance requires real MCP-client/server fixtures in both directions,
  including changed-source/digest, revoked, unauthorized, cross-tenant,
  warm-cache, and transport-error cases. The MCP server never writes arbitrary
  client files or executes skill content; placement and execution boundaries
  remain with the client and CLI. This is a future requirement inside M1, not
  an active implementation milestone or a new bundle count.
- **P2: measure context quality.** Add deterministic skill linting and
  explainable quality review, then scenario evaluations that compare agent
  behavior with and without a package. These depend on an explicitly isolated
  evaluation runner and a defined model/harness provenance contract.
- **P2/P1: publish safely and govern context.** Add author CI, organization
  and workspace review/install policies, and a first-class library-context
  catalog. These are separate from the v0.2.0 launch gate and must have
  explicit source, version, authorization, and provenance contracts.
- **P3: organization-wide visibility and automation.** Investigate activation
  telemetry, repository inventory, and a conversational operations agent only
  after privacy, retention, consent, and tenant boundaries are specified.
- **COMMITTED FUTURE M5-SKILL-FEEDBACK — structured skill feedback.** Add a
  later, opt-in feedback capability that lets authenticated CLI and MCP clients
  submit structured reports for what worked well, did not work well, is broken,
  or should improve. Bind each report to the canonical skill/source/version and
  artifact digest, with optional agent/client/platform metadata, a summary,
  expected-versus-actual outcome, and bounded reproduction or evidence. Scope
  writes by tenant and principal, make retries idempotent and deduplicated, and
  enforce rate and size bounds. Reports are untrusted observations, never
  verified quality or scanner verdicts. Default collection excludes secrets,
  raw prompts, and repository content; redacted diagnostics require explicit
  configured consent and are never forwarded automatically to an upstream
  vendor. Web skill detail needs safe feedback list/filter/triage/status views
  plus an advisory Eve summary/pattern finder; feedback can never
  autopublish, edit, or revoke a skill. CLI and MCP fixtures must prove exact
  version binding, cross-tenant denial, duplicate/offline-retry preservation,
  redaction, safe rendering, and reported outcomes kept separate from install
  analytics. This is a committed later M5 requirement, not active
  implementation and not a new current feature area.

## Skills.sh current delivery

The skills.sh work has a different evidence status from the Tessl comparison:
the official API and site pages confirm concrete endpoints and view semantics,
while the current verification record has not yet accepted a production-complete
skills.sh adapter or cloud catalog views. The gap is therefore **targeted and
pending acceptance**, rather than a claim that in-flight implementation work is
absent. The owner has authorized server-side forwarding of the Vercel project
OIDC token; source `0f9da75` and READY deployment
`dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` are recorded, but authorization and a READY
deployment do not by themselves count as complete live acceptance. The full
contract and source links are in
[`skills-sh.md`](skills-sh.md).

| Priority | Confirmed skills.sh capability | Private Skills today | Current delivery target |
| --- | --- | --- | --- |
| Current | Versioned all/trending/hot pages, bounded search, curated Official data, detail snapshots, and per-skill audit results ([API reference](https://www.skills.sh/docs/api)). | Source `0f9da75` implements the authenticated adapter and current READY deployment exposes it; the current API artifact verifies list/search, fail-closed auth, and fresh-canonical Topics, while browser and import evidence remain open. | Complete and verify a server-side, authenticated v1 adapter with bounded page/search caching, stable external IDs, explicit unavailable/error states, and no browser-held upstream token. |
| Current | A listing row has a stable `source/slug`, `sourceType` (`github` or `well-known`), install URL/page URL, and optional duplicate flag; detail can return files plus an external hash or `null`. | `Provenance` and the directory contract preserve external identity/source type/snapshot hash; detailed nested identity and selected pullthrough remain limited by the upstream route and pending live import evidence. | Preserve feed membership separately from external ID/source/slug/install URL, separate external snapshot hash from the Private Skills artifact digest, and assign every enumerated row an explicit metadata/source/pullthrough status. Derive a canonical source reference only from verified origin/repository/exact path or well-known scoped identity; snapshot-only detail must not invent a path. The server owns an internal collision-resistant release reference and immutable revision, while the original external ID remains unchanged. |
| Current | Official CLI source code resolves GitHub trees/paths and well-known discovery, including preferred and legacy indexes and bounded archives ([`vercel-labs/skills` sources](skills-sh.md#official-clirepository-evidence-relevant-to-pullthrough)). | Existing worker acquisition safely imports approved GitHub/registry sources; the transparent skills.sh adapter and representative import evidence are still pending acceptance. | Resolve GitHub commit/tree/path and well-known v0.2/v0.1 sources on demand from a complete skills.sh identity without a per-source mapping or manual alias. Retain exact source provenance, never infer SemVer, and pass bytes through the existing validation/scanner policy. Optional tenant source restrictions may narrow the built-in adapter. |
| Current | Site views expose unlisted Packs, curated Topics pages, maker-curated Official skills, and combined partner Audits ([Packs](https://www.skills.sh/docs/packs), [Topics](https://www.skills.sh/topic), [Official](https://www.skills.sh/official), [Audits](https://www.skills.sh/audits)). | Source `0f9da75` implements separate views/parser paths. Current API proof verifies authenticated React/Marketing fresh-canonical Topics; browser proof, Packs preview, and tenant/secrecy evidence remain open. | Complete and verify separate external views. Topics must retain its curated-page/source limitation because no documented JSON membership API exists. The Packs view accepts a user-supplied URL and renders an unlisted metadata-only manifest preview plus link; it does not enumerate packs, fetch member bytes, imply approval, or migrate members automatically. |
| Current | API docs require server-side authentication and document rate/error/cache behavior; the official integration path is Vercel request-scoped OIDC. | Nitro is portable; the current READY deployment carries server-side request-scoped OIDC. The current API probe passes credential-negative checks, while non-Vercel configuration and complete live acceptance remain open. | Accept canonical skills.sh or an operator-trusted gateway listed in `trustedSkillsShBaseUrls`; reject caller-supplied `credentialEnv`, and otherwise show a retryable unavailable state. Never assume undocumented anonymous API access. Authorization supersedes the prior deferral but does not satisfy complete live cloud acceptance. |
| Future P1 | An unlisted pack URL can contain multiple public, private, or GitHub-backed skills and can be updated or deleted ([Packs documentation](https://www.skills.sh/docs/packs)). | The current delivery previews external pack metadata and retains existing tenant-scoped private-pack management; it does not batch-migrate external members. | Add an explicit, separately authorized migration operation. Resolve every selected member to an immutable source, validate and scan every member, and create one private immutable pack only after all members pass; any unresolved/changed/deleted member leaves no partial private pack and records the failure. |
| Future P1 | Upstream CLI provides `find`, source grammar, lock provenance/check/restore, many agent adapters, selectors, `init`, telemetry, and optional `use` ([CLI parity review](skills-sh.md#cli-and-agent-compatibility-review)). | Current Rust CLI supports governed registry operations and three agent targets. | Prioritize these after the cloud contract; preserve registry authorization, immutable transfer, scanner gates, and non-execution boundaries. |

The current site’s install counts and catalog totals are dynamic. They are
observations, not roadmap constants. A live API total must never be confused
with the homepage’s aggregate install headline. Full coverage means every
enumerated row is represented with a status; it does not mean a refresh stores
every artifact.

## M6 — Diffs editor and upload/edit review (active implementation, incomplete)

This milestone is a product request recorded on 10 September 2026 and is now
selected for implementation. The official Diffs material confirms an open source
`@pierre/diffs` renderer and beta edit mode. It does not establish a hosted
editor service or provide Private Skills' release, identity, scanner, storage,
or review orchestration.

| Evidence status | Official capability | Private Skills implication |
| --- | --- | --- |
| Confirmed | Diffs renders arbitrary files, file versions, patches, and diffs in React or vanilla JavaScript, with split or stacked layouts, syntax highlighting, line selection, annotations, and accept/reject UI hooks ([home](https://diffs.com/), [official package README](https://raw.githubusercontent.com/pierrecomputer/pierre/main/packages/diffs/README.md)). | Use it as the rendering substrate for a skill editor/review surface. The application owns file identity, data loading, authorization, and action semantics. |
| Confirmed, beta/experimental | Edit mode attaches an `Editor` to `File`, `FileDiff`, `MultiFileDiff`, `PatchDiff`, or `CodeView` items. The official edit page documents in-place editing, undo/redo, find/replace, markers, selection actions, unified/split views, virtualized files, and mobile/a11y behavior ([edit page](https://diffs.com/edit), [docs](https://diffs.com/docs)). | Test and pin the dependency, preserve a read-only fallback, and build the surrounding draft/version workflow. Diffs' edit state is a client editing session; it is not a persisted release. |
| Confirmed, separate package | The official source describes `@pierre/trees` as a path-first web file-tree UI with search, selection, virtualization, and React/SSR entry points ([Trees README](https://raw.githubusercontent.com/pierrecomputer/pierre/main/packages/trees/README.md)). Diffs says it pairs with Trees for agentic UI experiences. | Compose the file tree and Diffs editor, then enforce canonical safe paths and tenant-scoped content in the registry. A Diffs dependency alone does not provide a tree, routing, or source model. |
| Confirmed limitation | Diffs docs describe retained edit state as bounded and in memory; the documented editor APIs expose change/completion callbacks and application-owned initial state ([docs](https://diffs.com/docs)). | Durable drafts, reload/resume, optimistic concurrency, exact content digests, and immutable releases are Private Skills responsibilities. |
| Unverified/absent in checked official material | The checked Diffs pages and linked source do not document upload handling, authentication, workspace tenancy, server persistence, immutable release/version semantics, scanner policy, or an Eve/review job service. | Do not attribute these to Diffs. The M6 contract below supplies them through existing Private Skills storage, auth, worker, scanner, and AI Gateway boundaries. |

The current checkout uploads complete folders for new releases and now includes
the authoring/editor, durable draft, builder, and upload/edit review services.
Its local synthetic editor/browser fixture passes the bounded draft workflow;
hosted UI, live Eve/model execution, and screenreader/contrast/reduced-motion
acceptance remain separate gates. M6 must keep the read-only release view and
the editing workflow separate:
viewing a skill opens an authorized, immutable version through a Diffs file view,
while editing is an explicit action that creates a draft route. The new reviewer
must remain distinct from the daily
common-skill consolidation Eve: it receives an exact upload/draft snapshot,
uses its own least-privilege tool boundary and configurable AI Gateway model,
and returns advisory findings for a human. Neither Eve may execute candidate
content, publish, merge, install, or change scanner policy automatically.

The proposed delivery order is:

| Slice | Later acceptance target | Dependencies and rationale |
| --- | --- | --- |
| M6-VIEW | **Delivered slice:** the recorded production read-only route proves authenticated release metadata, a metadata-only manifest, selected text-file retrieval with digest verification, expected OpenClaw-disabled responses, and an unauthenticated 401 boundary in [sanitized evidence](evidence/production-m6-readonly-dpl_39j65TecJNinwh9o1Y5Y1PALvnR3.json). The full gate still requires an authorized reader to browse the complete canonical tree and every allowed file through Diffs, including binary/oversize bounded states, selected-version changes, and no candidate execution. | Existing release authorization, Files SDK retrieval, canonical manifest, and `@pierre/diffs`; the delivered slice makes inspection useful without creating an editable copy, while the remaining fixtures complete the gate. |
| M6-EDIT | An authorized publisher takes an explicit edit action from an immutable release, creating a tenant-scoped draft route with base release/version/digest. Saving and reloading restores draft revisions and bytes; a Diffs comparison shows changes against the base, and a separate author action starts the scanner/publication transition. | Depends on M6-VIEW, draft persistence, canonical digesting, and the existing scanner/publish boundary; an editor save is never a release. |
| M6-UI | Authenticated publishers can open a private draft, browse a canonical file tree, edit files, switch file/diff views, and see line/path annotations. | Existing web auth, bundle validator, `@pierre/diffs`, and `@pierre/trees`; the UI value arrives before release automation. |
| M6-RELEASE | An explicit **Queue release scan** action creates a new immutable release candidate with a server-computed canonical digest, base/draft provenance, and explicit scan/publish transition; saving a draft only persists a new draft revision and never creates a release. Previous releases remain byte-identical. | Existing Files SDK, state, worker, and scanner policy; keeps draft save separate from publication. |
| M6-REVIEW | Upload/edit Eve runs asynchronously against the exact draft digest/revision, persists findings and status, marks results stale when content or policy changes, and exposes human actions. | Existing AI Gateway/Eve patterns plus a separate queue and review-result schema; daily consolidation remains independent. |
| M6-SAFE | Malicious or untrusted uploaded content is treated as data, validated and scanned in the existing isolated worker; no script, hook, MCP, or candidate instruction executes or escapes tenant boundaries. | Existing canonical bundle and scanner controls are authoritative; Diffs annotations/rendering cannot weaken them. |
| M6-A11Y | File tree, editor, diff, findings, and actions pass keyboard/focus/screen-reader/contrast/reduced-motion checks at 390px and desktop widths. | Requires browser evidence for the complete route, including narrow layouts; current production catalog mobile overflow is a known separate verification gap. |

### M6-BUILDER — interactive authoring builder Eve (active implementation, incomplete)

The editor now includes a separate product requirement for an Eve agent that
helps an author build a skill. Builder Eve is a conversational design
assistant, distinct from daily consolidation Eve and from upload/edit reviewer
Eve. It works against an authorized blank or validated upload-origin draft when
that origin is enabled, or against a draft based on an existing immutable
release. The assistant proposes changes; it does not become an alternate
publisher, scanner, or execution environment. The portable route/type seam and
the explicit stale/CAS rules are recorded in
[`m6-authoring-contract.md`](m6-authoring-contract.md#interactive-authoring-builder-eve).

| Slice | Active implementation target | Owner and boundary |
| --- | --- | --- |
| M6-BUILDER-0 | Persist an organization-scoped conversation bound to `draftId`, base release/digest, current draft revision/digest, Gateway/model, builder/tool revision, bounded-context limits, and an auditable state. | The skill-builder service and app persistence own the types and route integration; use existing draft authorization and no secret-bearing browser state. |
| M6-BUILDER-1 | Provide a bounded chat context from the exact draft manifest and allowed text files, with proposal-only tools for add/edit/rename/delete. Persist generation/job provenance and idempotency without exposing credentials or arbitrary network/content execution. | The builder/Eve workflow owns its separate tool allowlist and configurable AI Gateway/model; daily consolidation and upload-review queues remain separate. |
| M6-BUILDER-2 | Render each proposal as a reviewable Diffs/file-tree change with canonical paths, per-file preconditions, rationale, and deterministic proposal/diff digest. No proposal mutates draft bytes. | The web editor owns the chat/proposal panel and loading/error/stale states; `@pierre/diffs` remains a renderer, not the persistence or policy layer. |
| M6-BUILDER-3 | Apply or reject only after an explicit author action. Apply requires proposal ID, expected revision, and idempotency key; server-side CAS creates one new draft revision or returns an explicit stale/conflict result. | Draft/CAS integration owns proposal apply/reject; no silent rebase, partial apply, base-release mutation, autopublish, or scanner-policy change. |
| M6-BUILDER-4 | Prove browser chat → proposal → view diff → explicit apply → saved reload → upload/edit review → required scanner decision → explicit immutable release, including a changed-revision stale proposal and cross-tenant denial. | The authenticated end-to-end evidence workflow owns proof; existing scanner and publication gates remain authoritative and builder output remains advisory. |

The initial useful slice is authoring a new skill and refining an existing one;
it must preserve exact file context and draft provenance in both cases. A
conversation or proposal cannot authorize a release, and builder Eve cannot
execute skill content, scripts, hooks, MCP servers, package managers, or
arbitrary network calls. M6 remains active and incomplete while this builder,
the Diffs view/editor, durable drafts, upload/edit review, safety, and release
evidence are implemented. M7 proceeds in parallel and is not folded into this
builder gate.

M6 is incomplete until all checkable gates in
[`completion-criteria.md`](completion-criteria.md) pass. Diffs features are
the UI substrate; draft durability, release identity, review persistence,
tenant isolation, safety, and policy behavior remain Private Skills product
criteria.

## M7 — OpenClaw skills feed interoperability (active implementation, incomplete)

M7 is an active interoperability milestone for producing and consuming a
versioned OpenClaw skills feed. It is not a G0, C1, or M6 release prerequisite
and does not require a mirror of the public catalog. The source review found a concrete
primary contract in ClawHub's hosted-feed specification: the ClawHub skills
feed uses feed ID `clawhub-official`, `schemaVersion: 1`, and the
`/v1/feeds/skills` route. It uses the same envelope as the hosted plugin feed,
but emits `type: "skill"` entries with `@publisher/slug` identities, exact
release/install coordinates, SHA-256 integrity, `official` publisher trust,
`available` state, and `generatedAt`, monotonic `sequence`, and `expiresAt`
metadata. The contract says the current skills feed is unsigned and caps a
snapshot at 1,000 eligible entries until pagination or sharding is defined;
those facts must remain visible in our implementation status.

The ClawHub contract is the target for M7's skills path. OpenClaw's official
marketplace documentation and [consumer source](https://raw.githubusercontent.com/openclaw/openclaw/main/src/plugins/official-external-plugin-catalog.ts)
describe a generic hosted plugin-catalog consumer that currently accepts
schema versions 1 and 2, validates feed identity and timestamps, bounds the
response, supports conditional snapshots/fallback, and can verify DSSE when a
trusted profile is configured. That is evidence for consumer safety and
compatibility behavior, not evidence that the ClawHub skills route is v2 or
signed. The checked ClawHub contract says signing still requires a production
key-management decision. M7 must pin the skills contract at v1 and treat
signing as conditional on an explicit upstream declaration and configured trust
root.

| Evidence status | Primary source | Confirmed capability | Private Skills gap |
| --- | --- | --- | --- |
| Confirmed | [ClawHub hosted catalog feed specification](https://github.com/openclaw/clawhub/blob/main/specs/hosted-catalog-feed.md) | Canonical producer contract: feed ID, schema version, `/v1/feeds/skills`, skill entry identity/type, exact version/integrity/trust/state, expiry/sequence, eligibility filters, deterministic bytes/order, cache validators, and the 1,000-entry interim cap. | Source `c7a0f03` includes the OpenClaw feed producer/consumer, schema adapter, bounded cache, and source/provenance mapping. Feed activation, hosted artifact import/private publication, and live producer/consumer acceptance remain unverified. |
| Confirmed | [ClawHub GitHub-backed skills specification](https://github.com/openclaw/clawhub/blob/main/specs/github-backed-skills.md) | A GitHub-backed skill remains tied to the upstream repository/path and immutable commit/content hash; current content must complete the required scan before normal install/update. | Source `c7a0f03` includes the OpenClaw GitHub acquisition adapter and commit/content-hash mapping; hosted GitHub source resolution and live admission remain unverified. |
| Confirmed, scoped | [OpenClaw marketplace documentation source](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/cli/plugins.md) and [official catalog consumer](https://raw.githubusercontent.com/openclaw/openclaw/main/src/plugins/official-external-plugin-catalog.ts) | Hosted consumer behavior includes HTTPS URL restrictions, bounded UTF-8 JSON, schema/id/time/sequence validation, expiry, expected SHA, ETag/Last-Modified snapshots, offline fallback, and DSSE/feed-ID binding when signing is configured. The command surface is documented for plugin catalogs. | The skills-specific adapter and admission mapping are implemented in source `c7a0f03`; hosted activation, live producer/consumer, artifact import, and private publication remain unverified. Do not equate plugin-catalog install authority or generic v2 support with the ClawHub skills-feed contract. |
| Confirmed, separate format | [OpenClaw skills documentation source](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/skills.md), [ClawHub skill format](https://docs.openclaw.ai/clawhub/skill-format), and [ClawHub product spec](https://github.com/openclaw/clawhub/blob/main/specs/spec.md) | Individual skills are `SKILL.md` folders with supporting files and versioned releases; third-party skill content is untrusted and local policy applies. These pages do not replace the hosted-feed envelope. | Feed ingestion must transfer metadata or selected bytes only to the canonical validator and scanner. It must never execute a skill, hook, MCP server, or OpenClaw package manager. |
| Conditional/unverified | [ClawHub hosted feed specification](https://github.com/openclaw/clawhub/blob/main/specs/hosted-catalog-feed.md) and [OpenClaw catalog consumer](https://raw.githubusercontent.com/openclaw/openclaw/main/src/plugins/official-external-plugin-catalog.ts) | The checked ClawHub spec describes an unsigned current publication; OpenClaw supports DSSE for configured generic feeds. A production signing key/trust root for the skills route was not established by this review. | Store and display signed/unsigned status. Verify DSSE only after the skills publisher declares the envelope and our trusted keys are explicitly configured; never bootstrap trust from the feed. |

M7's product contract has these boundaries:

- The consumer fetches only configured, allowlisted HTTPS feeds. A feed row is
  a candidate and provenance record; selecting it resolves one exact source
  release or GitHub commit/path and pulls through the existing canonical
  validator, required scanner policy, and immutable transfer path.
- The producer emits schema-v1-compatible JSON with a Private Skills feed ID
  assigned by this product. It must never claim the reserved
  `clawhub-official` identity unless Private Skills is actually the ClawHub
  authoritative publisher. A private tenant feed is authenticated and
  tenant-scoped; a deliberately public feed contains only deliberately public
  records and no private metadata, bytes, credentials, or scanner reports.
- Feed trust, remote audit state, and `available` status never override local
  authorization, source allowlists, digest checks, scanner evidence, or policy.
  Expired, malformed, unsupported, replayed, or digest-mismatched entries are
  unavailable and cannot become installable.
- Snapshot caching and individual pullthrough are bounded and on demand. M7
  does not silently bulk-import or mirror all entries. The upstream 1,000-row
  interim cap is recorded; complete multi-shard coverage requires a later
  versioned upstream contract rather than an invented pagination scheme.

| Slice | Future acceptance target | Dependencies and rationale |
| --- | --- | --- |
| M7-SPEC | Freeze a dated copy/reference of the ClawHub skills-feed schema-v1 contract, including feed ID, route, required envelope fields, skill entry shape, source profiles, eligibility, cap, expiry, cache, and unsigned status. Record a review whenever the upstream contract changes; do not infer v2 fields from the generic plugin consumer. | Requires a versioned adapter and an explicit product decision about supported external feed IDs. This is the compatibility anchor. |
| M7-PRODUCER | Generate deterministic schema-v1 snapshots from eligible records with stable entry/key ordering, exact release/version and `sha256:` integrity, publisher trust/state, generated/sequence/expiry metadata, and no secrets/private bytes. Serve unchanged bytes with ETag/Last-Modified/304 and bounded cache headers. | Requires an approved feed publication policy, public/private visibility model, and tenant-aware storage. It does not require public marketplace launch. |
| M7-CONSUMER | Fetch with HTTPS/no-credential/query/fragment restrictions, body/timeout/UTF-8 limits, required-field/schema/feed-ID/timestamp/sequence validation, expiry, duplicate handling, conditional revalidation, and a bounded last-known-good snapshot. Malformed or wrong-ID snapshots never write artifacts. | Reuses existing upstream gateway and durable state patterns; the generic OpenClaw parser is a reference for safety, while the skills adapter owns skill semantics. |
| M7-PROVENANCE | Preserve `public-clawhub` release identity and `public-github` repository/path/commit/content-hash identity. Recompute downloaded bytes and reject a source or artifact that differs from the declared digest. Keep external feed hash separate from the Private Skills canonical digest. | Depends on C1 automatic identity-preserving pullthrough and immutable artifact storage. It prevents feed metadata from silently substituting another skill. |
| M7-ADMISSION | Route selected entries through canonical bundle validation, existing Cisco/NVIDIA/SkillsGuard/local scanner policy, authorization, and immutable transfer. Remote publisher trust or audit is advisory and cannot admit a release or install. No execution, install, merge, publish, hook, MCP, or package-manager side effect occurs during feed ingestion. | Reuses the current fail-closed worker/scanner contract and preserves the current release boundary. |
| M7-AUTH | Keep feed credentials server side; expose no bearer, source token, private feed metadata, or cross-tenant cache entry to a browser or other tenant. Private feed responses and candidate/source details are scoped to organization and principal, with safe unauthorized responses. | Requires the existing tenant/role model and portable gateway configuration; do not assume Vercel-only hosting. |
| M7-INTEROP | Ship producer/consumer fixtures and a reference parse check for valid v1, empty, duplicate, wrong schema/id, missing fields, invalid time/sequence, expired, replayed, oversized/truncated, wrong digest, changed/removed GitHub source, conditional 304, fallback, and the 1,000-entry boundary. Add signed DSSE fixtures only if the official skills-feed contract enables them. | Requires a pinned source contract and fixture provenance. The OpenClaw CLI plugin command is not itself a skills-feed acceptance test. |
| M7-PORTABILITY | Run feed publication, refresh, cache, source resolution, and local admission through the Nitro deployment modes and supported provider gateway without a Vercel-only API or filesystem assumption. | Keeps the interop surface portable and preserves explicit credentials for provider-specific infrastructure. |
| M7-EVIDENCE | Capture the source URL and contract revision, producer bytes/digest, consumer result, cache/conditional behavior, exact source mapping, scanner decision, tenant isolation, and no-execution evidence for a representative accepted and rejected entry. Record public feed availability separately from implementation readiness. | Makes upstream drift and deployment gaps visible without promoting this future milestone into G0 or C1. |

## Confirmed comparison

“Confirmed” below means the linked Tessl documentation describes a concrete
workflow, command, or file contract. “Partial” means Private Skills already
has a related primitive but not the same user-facing capability. “Missing” is a
documented Tessl capability with no current implementation in this checkout.

| Priority | Tessl capability confirmed in official docs | Private Skills today | Gap and intended milestone |
| --- | --- | --- | --- |
| P1 | A package can contain rules, skills, and documentation; current configuration docs also describe bundled MCP servers and hooks in a plugin manifest ([creating tiles](https://docs.tessl.io/create/creating-tiles), [configuration](https://docs.tessl.io/reference/configuration)). | The registry accepts canonical skill bundles and exact-member packs. The validator deliberately rejects plugin-enabling/MCP paths, and packs do not carry docs/rules metadata. | **Missing context-package model.** Introduce an additive package schema for docs/rules/skills first; keep MCP/hook payloads disabled by default and require a separate reviewed policy before any agent-side installation. |
| P1 | Tessl maintains a project `tessl.json`, supports managed or vendored package content, dependency-driven synchronization, and local `file:` packages ([configuration](https://docs.tessl.io/reference/configuration), [repository tiles](https://docs.tessl.io/distribute/repository-tiles), [CLI reference](https://docs.tessl.io/reference/cli-commands)). | `pskills.json`/`pskills.lock.json`, packs, ownership journals, and explicit `install`, `update`, `doctor`, and `verify` behavior exist for registry skills and packs. There is no dependency scan/sync or local context-package source. | **Partial package-manager workflow.** Add a project manifest/lock schema for context packages and an explicit sync mode that records exact source, version, digest, and agent target. Keep registry authorization and local-file validation separate. |
| P1 | Tessl's registry MCP is a local stdio server started with `tessl mcp start`; the current tool list covers registry search/install/update/status, workspace and publish operations, review, and schedules ([MCP tools](https://docs.tessl.io/reference/mcp-tools), [custom agent setup](https://docs.tessl.io/reference/custom-agent-setup)). | The app has authorization-aware catalog and semantic search endpoints for the web/CLI. It has no MCP server, agent-facing context query contract, or automatic context sync/status bridge. | **Missing agent context bridge.** Add a narrow MCP/HTTP surface that returns only approved, authorized, digest-bound package content and never executes package scripts, hooks, or MCP servers. |
| P1/P3 | Tessl also documents a workspace MCP gateway: workspace owners/managers register an external MCP endpoint and members use `tessl mcp proxy` with shared OAuth/credentials ([MCP gateway](https://docs.tessl.io/reference/mcp-gateway)). | The app has no workspace-level external MCP registry, credential broker, or proxy. | **Missing shared MCP gateway.** Treat upstream registration, credential storage, member authorization, audit, and revocation as a separate reviewed capability; it is not required for v0.2.0. |
| P1 | Tessl supports workspaces, member roles, member management, workspace archive/unarchive, and package lifecycle operations ([workspaces](https://docs.tessl.io/reference/workspaces), [roles](https://docs.tessl.io/reference/roles), [CLI reference](https://docs.tessl.io/reference/cli-commands)). | The baseline is one organization per deployment with configured bearer tokens, signed browser sessions, scoped principals, namespace permissions, audit records, revocation, and scanner policy. It does not provide a user-managed workspace/member lifecycle or device/OIDC identity. | **Partial governance.** Add durable membership and role administration before claiming multi-team tenancy. Keep device/OIDC login optional until an identity provider and recovery policy are selected. |
| P1 | Tessl documents package lint, publish, unpublish within a short window, and archive with a reason; archiving prevents new installations while retaining existing content ([CLI reference](https://docs.tessl.io/reference/cli-commands)). | Private Skills has immutable versions, policy re-evaluation, and audited revoke. Revoke denies future resolution/transfer; there is no distinct reversible archive or publish rollback state. | **Missing lifecycle states.** Add an audited archive/unpublish model with explicit effects on new resolution, transfer, existing locks, and retained installations. Do not weaken the current revoke semantics. |
| P1 | Tessl provides a GitHub Action that sets up the CLI and supports lint, review-threshold checks, and publishing ([review, lint & publish with GitHub Actions](https://docs.tessl.io/distribute/review-and-publish-with-github-actions)). | GitHub acquisition/proxy and repository CI exist; author publishing is a CLI/API flow. No supported author repository action publishes to a Private Skills namespace or reports a quality gate. | **Missing author CI integration.** Add a pinned, provenance-preserving action or documented generic CI contract after package/review APIs exist. It must never publish public content by default and must use scoped credentials. |
| P1 | Tessl describes automatic setup for several coding agents and materializes context into the consuming agent's native configuration ([custom agent setup](https://docs.tessl.io/reference/custom-agent-setup), [CLI reference](https://docs.tessl.io/reference/cli-commands)). | The Rust client currently targets `codex`, `claude`, and `universal` directories. It does not configure MCP or test native discovery for Cursor, Gemini, Copilot, or other agents. | **Partial cross-agent support.** Add integrations one agent at a time, with real discovery tests, idempotent config reconciliation, and preservation of user-managed entries. |
| P1/P2 | Tessl's package manager includes documentation for exact library/package context and searches by package URL/HTTP URL ([creating documentation](https://docs.tessl.io/create/creating-documentation), [CLI reference](https://docs.tessl.io/reference/cli-commands)). | Upstream acquisition covers approved GitHub and registry sources for skill artifacts. It does not model library documentation, PURL identity, or dependency-version context as a first-class resource. | **Missing library-context catalog.** Add an opt-in, provenance/licence-aware docs resource with PURL/version identity and authorization-aware retrieval. Do not fetch arbitrary package registries or execute package content. |
| P2 | Tessl reviews skills with separate validation, description/activation, and content dimensions; the score is shown in the registry and can be gated in CI ([reviewing skills](https://docs.tessl.io/improving-your-skills/reviewing-skills)). | Cisco/NVIDIA/SkillsGuard scanner evidence, policy decisions, and the bounded Eve common-skill review are implemented. Eve proposes consolidation and records human decisions; it does not score skill quality or activation likelihood. | **Missing quality review.** Add deterministic Agent Skills lint plus bounded, explainable quality dimensions. Keep review advisory until score calibration and threshold behavior are tested. |
| P2 | Tessl generates or accepts scenario evals and compares agent results with and without the skill; scenarios can be saved with a plugin as regression coverage and activation can be measured separately ([scenario evaluation](https://docs.tessl.io/improving-your-skills/evaluate-skill-quality-using-scenarios)). | No agent task/eval harness or before/after impact metric is implemented. Install receipts measure local installation outcomes only. | **Missing behavioral evaluation.** Add a sandboxed runner, scenario fixtures, baseline/comparator results, model/harness provenance, activation evidence, and regression thresholds. Candidate content must remain untrusted and isolated. |
| P1/P2 | Tessl documents custom review rubrics, review thresholds, organization/workspace policy inheritance, security-score install gates, and source/release-age restrictions ([codifying and enforcing skill standards](https://docs.tessl.io/tutorials/codifying-and-enforcing-skill-standards), [reviewing skills](https://docs.tessl.io/improving-your-skills/reviewing-skills)). | Private Skills has scanner policy, required/advisory toggles, and hooks, but no organization/workspace quality rubric, source/release-age install policy, or documented inherited policy model. | **Missing standards and policy contract.** Define versioned quality and install policy semantics, including inheritance, tightening, exceptions, audit, and fail-closed behavior. Keep this additive to the current scanner controls. |

The comparison rows map to the completion criteria as follows: context package,
manifest, MCP, and native-agent work to **M1**; quality review and scenario
evaluation to **M2**; memberships and artifact lifecycle to **M3**; author CI to
**M4-1**, standards to **M4-2**, and library context to **M4-3**; and
visibility/automation to **M5**. The active Diffs editor and upload/edit
review slices map to **M6-EDITOR**, **M6-DRAFT**, **M6-TREE-DIFF**,
**M6-RELEASE**, **M6-UPLOAD-EVE**, **M6-REVIEW**, **M6-POLICY**,
**M6-AUTH**, **M6-SAFETY**, **M6-A11Y**, and **M6-EVIDENCE**; the explicit
read-only and edit workflows map to **M6-VIEW** and **M6-EDIT**; the
interactive authoring builder maps to **M6-BUILDER**. OpenClaw
skills feed production and consumption map to **M7-SPEC**, **M7-PRODUCER**,
**M7-CONSUMER**, **M7-PROVENANCE**, **M7-ADMISSION**, **M7-AUTH**,
**M7-INTEROP**, **M7-PORTABILITY**, and **M7-EVIDENCE**.

## Advertised or unresolved capabilities

The current Tessl overview and product pages advertise activation observability,
GitHub organization inventory, Snyk security scoring, and a Tessl Agent in open
beta ([Tessl overview](https://docs.tessl.io/), [product page](https://tessl.io/)).
The documentation confirms the
registry MCP, workspace MCP gateway, custom standards, and install-policy
building blocks in the rows above; it does not give a complete API contract
for telemetry, retention, consent, event identity, tenant isolation, or the
agent's permissions. These remain discovery items, not implementation
requirements:

- The checked documentation index and targeted searches did not expose a
  concrete activation-telemetry, GitHub-inventory, or Tessl-Agent API/data
  contract. Keep those capabilities marked advertised/unverified until such a
  contract is available.
- Define activation telemetry collection, opt-in/consent, redaction,
  retention, and whether raw prompts or repository content leave the user's
  environment before adding usage observability.
- Define GitHub inventory scope, installation permissions, duplicate matching,
  unmanaged-copy handling, and deletion behavior before adding organization
  scanning.
- Treat the Tessl Agent as a separate privileged product surface. No
  autonomous agent may publish, authorize installs, change policy, or execute
  candidate content without an explicit threat model and human approval.

The site and docs currently use both “tile” and “plugin” terminology. The
roadmap uses “context package” as a neutral Private Skills term until the
compatible subset and any deliberate incompatibilities are frozen.

## Non-goals for the current shipment

The current v0.2.0 release does not need public marketplace support, Tessl's
public catalog scale, activation telemetry, repository inventory, scenario
evals, or autonomous optimization in order to ship. Its existing fail-closed
scanner policy, private storage, authorization-aware search, Vercel Sandbox
boundary, CLI install recovery, analytics receipts, and human-only Eve review
remain the launch contract. Future parity work must preserve those boundaries.
