# skills.sh cloud catalog and pullthrough review

**Date:** 2026-09-10
**Status:** recorded v0.3.0 production evidence is from source `0f9da75` and
earlier deployments. The current feed contract is represented by source
commits `e00d48f` (core), `4ecb850` (runtime), `6d38a64` (proof), `4f94541`
(tests), and feed-aware web work at `80c41f5`; these are local/source evidence
only and are not claimed as a new hosted deployment. The current READY
production deployment is `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` with output
fingerprint
`613f05b33f43aa449e28e3a0c65821b046524e43e50a2214b96f284910023662`; the
corresponding Cloudflare build has fingerprint
`a8b82a0dadb571106cd126d98039af579e04a8d45fa787f1b9b0a9358e884b31` and 35
server files with no executable SDK references. The E7 source review reports 286 tests passed and two
environment-dependent skips, TypeScript, five SDK probes, Files SDK checks,
and two independent review approvals. Feed-aware resolve, job pinning, and
CLI/UI follow-ups remain pending production verification. The earlier
`dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC` deployment (fingerprint
`b58fccb70827db007ff84d0ce4c776f6297dfc9cc3f552de353e614515b0586b`) verifies
metadata-only full pagination. Earlier deployment evidence verifies the
server-side Vercel project OIDC path, ComputeSDK scan, and captured browser
surfaces; the current API artifact verifies the directory and Topics paths,
and current browser proof is still pending, so full C1 acceptance remains
partial.
**Scope:** the current skills.sh site, its documented API, and the public
`vercel-labs/skills` repository. The review uses official sources only. It does
not use Tessl pages or GitHub issues as evidence.

This is a bounded design for the requirement that Private Skills support every
skill listed by skills.sh as an on-demand pullthrough source and expose cloud
views for Packs, Topics, Official, and Audits. “Every” means every current
catalog row is discoverable and assigned an explicit pullthrough state. It does
not mean copying every artifact into the private registry during metadata
traversal.

## Current configuration

The owner authorized connecting skills.sh with the Vercel project request-scoped
OIDC token on 2026-09-10, superseding the earlier disconnected deferral. The
current READY deployment is `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y`; it carries the
enabled directory and request-scoped OIDC/ComputeSDK configuration. Earlier
production deployment `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi` proves authenticated
directory access and the ComputeSDK scan. The earlier directory deployment
`dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC` supplies the metadata-only pagination
evidence described below. The earlier captured deployment
`dpl_3D4epeApMaBFmSFtuycVV9iAxrhi` remains historical disabled-configuration
evidence: it returns HTTP 503 with
`DIRECTORY_NOT_CONFIGURED` and `retryable: false`, while actual upstream
outages retain `DIRECTORY_UNAVAILABLE`.

The directory client, authenticated registry routes, Rust commands, cloud views,
and governed import worker are implemented. Source `0f9da75` additionally
contains the canonical Topics page parser, auth-before-hit metadata cache with
bounded TTL/bytes, conflict/drift-aware enumeration, and credential-negative
security tests. `PSKILLS_DIRECTORY_ENABLED=false` describes the historical
disconnected capture; the current production deployment has the enabled,
authenticated directory path. Full metadata pagination is verified for one
earlier bounded run; the current read-only API probe verifies list/search,
fail-closed auth, and fresh canonical Topics. Selected-row import, nested detail
availability, feed-aware resolve/job pinning, current browser proof, and external
Packs preview remain separate acceptance gates. The later feed contract commits
have local test/design evidence only until a deployment and authenticated
end-to-end probe record them.

The feed contract accepts only a canonical skills.sh base URL or an operator
trusted gateway configured through `trustedSkillsShBaseUrls`; a caller-supplied
`credentialEnv` is rejected. When `feed` is omitted, the server auto-selects
only when exactly one enabled feed exists; with multiple enabled feeds the
caller must select one explicitly. Explicit feed selection remains
tenant-scoped and must pass the feed's enabled/trust/ACL checks before catalog
access. These source-contract rules are not asserted as new hosted behavior
here.

### Portable directory gateway configuration

The portable directory gateway is an operator-controlled configuration for
hosts where request-scoped Vercel OIDC is unavailable. When the canonical
`https://skills.sh` URL is selected, the catalog uses request-scoped project
OIDC and never uses the gateway token. Configure the gateway explicitly for a
noncanonical destination:

```sh
PSKILLS_DIRECTORY_ENABLED=true
PSKILLS_DIRECTORY_GATEWAY_URL=https://directory-gateway.example/skills
PSKILLS_DIRECTORY_GATEWAY_TOKEN=replace-with-server-secret
```

The gateway URL must be an operator-trusted HTTPS base without userinfo, query,
or fragment data. Requests are bound to its exact origin and path. Gateway
catalog authentication is stripped on redirects; existing private-source
authentication is retained only for an allowed same-origin request. The token
is available only to the server/worker request path, is bounded and redacted,
and must never reach browser code, job data, logs, source acquisition, or
redirects. Invalid or incomplete settings fail closed with directory unavailable
behavior. Legacy ambient directory-token settings, including `DIRECTORY_TOKEN`
and `PSKILLS_DIRECTORY_TOKEN`, are ignored; use the explicit URL/token pair.
Deployment enablement and runtime evidence are tracked separately.

`PSKILLS_PACK_DIRECTORY_ENABLED=true` independently enables public, unlisted
pack metadata preview. It sends no directory credential and fetches no member
artifacts. Pack preview runs through Web APIs on both Node and edge profiles.
Private pack creation and installation continue to use existing approved local
releases. Automatic external pack migration is a future feature.

## Current production evidence

- Current production deployment `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` is READY at
  the stable alias, with output fingerprint
  `613f05b33f43aa449e28e3a0c65821b046524e43e50a2214b96f284910023662`. The
  platform checkpoint reports the enabled skills.sh directory and
  request-scoped OIDC/ComputeSDK path, directory/search/CLI/analytics, and Files
  SDK checks. The [current API probe](../work/production-c1-api-evidence-1788993909280-85606-dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y.json)
  adds eight GET requests with zero retries or mutations and no credential-pattern
  leakage: health, authenticated `/me`, policy, list (`total=9738`), fuzzy
  search, and fresh canonical React/Marketing Topics pass; unauthenticated
  Topics is 401. The artifact is `verified:true`; browser proof for the current
  deployment remains pending, and the previous stale-canonical result remains
  preserved as regression evidence.
- The E7 source review at `0f9da75` reports 286 tests passed and two
  environment-dependent skips, with TypeScript, five SDK probes, the Files SDK,
  and Cloudflare checks passing and two independent reviews approving. The
  Topics parser, bounded cache, conflict/drift-aware enumeration, and
  credential-negative security coverage are implementation/test evidence. The
  current API result above verifies fresh canonical Topics; current browser
  proof and the other acceptance gates remain pending.
- The sanitized [earlier v0.3 production record](../work/production-v03-evidence.json)
  from `dpl_BHfkYTgcJfpWQJdg4xtDgM5MQbfi` records authenticated list/search,
  Official, detail, and audit responses. It observed list page zero with
  `total=9736` and `hasMore=true`, two search results, 100 Official owners with
  5,497 skills, one detail file, and five audit entries. Topics is explicitly
  `not_exposed` and the pack preview is explicitly `skipped` because no
  operator-supplied unlisted URL was present.
- The [earlier pagination evidence](../work/production-c1-pagination-evidence-1788989595741-50223-dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC.json)
  from `dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC` (fingerprint
  `b58fccb70827db007ff84d0ce4c776f6297dfc9cc3f552de353e614515b0586b`)
  verifies 20 all-time pages at `per_page=500`, with 9,738 declared,
  observed, and unique IDs, zero duplicate rows/IDs, and three nested IDs.
  It is metadata-only: no detail, artifact, or mutating requests occurred.
- The [earlier scan record](../work/production-v03-scan-evidence.json) is
  `verified=true` for driver `computesdk`: one file analyzed, zero findings,
  unchanged approved digest, and `allowUnscanned=false`. Scan
  `44cd2613-b29b-4b54-9c5a-4efc932afbe0` ran as job
  `job_fd182a70-9c73-45d8-9d1b-a1732d98d107` on the earlier deployment.
- The nested compatibility evidence is split between the live upstream and
  our client. [The upstream probe](../work/skills-sh-nested-probe-evidence.json)
  saw 400 `invalid_path` for direct/full-ID encoding, 200 with wrong identity
  for one-slug-segment encoding, and 404 for double encoding. The current
  client supports bounded nested IDs and rejects identity mismatches; the
  [current production nested probe](../work/production-c1-nested-evidence-1788989719476-50915-dpl_BbpxHqggbg7nYvfjxQp63C1SW1fC.json)
  received 503 for detail/audit on all three nested rows, with no mutation.
  This is an upstream availability/route limitation, not evidence that the
  client accepts a wrong skill.
- Earlier CSS deployment `dpl_4NsLDbtJ9R4ZDcQAyZMTTA58JgFF` is ready with
  output hash `665727f37999113a2d018eb348ad32b47d1cbd817d9c8b4762b35c0ea760549a`.
  Its 390px Packs, dashboard, and catalog captures pass without horizontal
  overflow, as does the 1280px Packs capture; the evidence is linked from
  `docs/design/production-final-*.png`.

These results prove one earlier metadata-pagination run and preserve the
provenance of the earlier authenticated endpoint, sandbox-scan, and browser
evidence. The current deployment is READY and carries the new implementation;
the current API artifact verifies the current read-only directory and Topics
checks, and current browser proof is still pending. The results do not by themselves
prove representative GitHub/well-known imports, upstream nested detail
availability, or metadata-only Packs preview.

The transparent skills.sh path uses a built-in catalog adapter: a selected
catalog `id` is sufficient to request pullthrough, and the server keeps that
original `source/slug` identity as the external primary key. It must not require
the reader to create a per-source mapping, invent a private alias, or provide a
private name/version before the first install. A reader also needs install and
explicit `proxy:resolve` permission to start the pullthrough; the default
reader/publisher grant remains pending explicit product approval and production
verification, while owner/admin grants may exercise the route. The server may derive its release
reference only after the source origin/repository/exact path or
well-known scoped identity is verified; a snapshot hash alone is insufficient.
That internal reference must never replace or rewrite the skills.sh identity.

Each tenant can configure multiple named feeds. A persisted feed has a unique
name, readable ID, `kind` (currently `skills-sh`), enabled state, a configured
prefix field, configuration revision, trusted origin, and optional source
restrictions. Feed membership/configuration is separate from source identity:
in the current design a feed is a tenant-scoped discovery list plus adapter and
policy configuration, not a namespace or a physical source path.
The full upstream source ID remains unchanged in provenance. The server-owned
source reference is provenance metadata, not an assumed CLI input, and is
derived only after verification: a GitHub source
may use `@github/owner/repo/<exact-skill-directory>`, a well-known source may
use `@web/<authority>/<scope>/<entry>`, and a catalog snapshot without physical
source proof remains `@snapshot/skills-sh/<externalId>`. The local artifact
digest and resolved revision are separate fields. A feed never renames a skill
or supplies a canonical namespace by itself; managed namespace/ACL policy is
independent from feed membership.

Administrators may add an optional skills.sh source policy per feed for
exact-source allowlists, custom well-known bases, credentials, or other
restrictions. Such a policy tightens that feed and denies rows outside it; a
per-repository mapping or manual alias is not a prerequisite for an otherwise
valid public catalog row. An unknown or disabled feed fails before any outbound
fetch and reveals no source credentials or cross-tenant metadata. A remote
Official label or partner audit never grants approval. The current feed kind is
`skills-sh`; additional feed adapter types are a future extension, and the
OpenClaw feed remains the separate future M7 interoperability milestone.

The frozen install-resolution contract is additive `POST /v1/proxy/resolve`
with `{ feed?: string, externalId, refresh? }` and a response containing
`{ feed, externalId, reference, operation | resolution }`. `feed` selects the
configured tenant feed; when omitted, the server auto-selects only when exactly
one enabled feed exists. With multiple enabled feeds, the caller must select
one explicitly. A bare full source ID or exact supported skills.sh URL is a
convenience input, while the CLI may pass the original URL with `--feed`; the
server reference is output metadata and direct canonical-reference input is not
assumed. A `202` operation may omit `reference`; a `200` resolution includes
the server-owned source-derived reference. The registry echoes the original ID
and selected feed; it does not invent a mandatory private alias, `name`,
`version`, or `upstreamId`. The server owns a collision-resistant internal
record and immutable resolved revision, including when the catalog reports
`files: null` or a missing hash. Default installation uses an approved cache
only after matching verified source/revision/digest and current feed/tenant
policy checks; it does not perform an upstream lookup. An explicit
`refresh: true` or update rechecks that feed and reports failure if the recheck
fails; it does not silently present an older cache entry as freshly verified.
One tenant-level configuration exists for each feed; explicit
mapping/proxy mode remains an advanced administrator restriction.

## Decision summary

Private Skills should add a server-side `skills.sh` catalog adapter with four
separate responsibilities:

1. **Metadata discovery:** call the versioned skills.sh API only when a user
   browses or searches a selected configured feed. Use bounded leaderboard-page
   traversal for complete catalog coverage when needed; deduplicate catalog
   rows by `(tenant, feed, externalId)` for metadata. Artifact reuse is
   determined later by verified source identity/revision/digest and policy, not
   by feed membership or external ID alone.
   The product need not expose a user-triggered bulk-refresh operation.
2. **Transparent pullthrough:** a first install of a selected row automatically
   fetches the detail snapshot or resolves its public GitHub/well-known source,
   stores the complete candidate in isolated quarantine, and starts the normal
   validation/scanner/policy job. Provenance records tenant, feed membership,
   and external identity; the artifact cache key is derived only after verified
   canonical source identity, revision/digest, and current policy. A reader
   never receives upstream bytes or credentials. An approved warm install
   reuses a matching registry cache entry after a fresh reader authorization
   and current-policy/scan check; it does not contact the upstream again. A
   cold resolve also requires the caller's explicit `proxy:resolve` permission;
   the default reader/publisher grant remains pending product approval and
   production verification.
3. **Private admission:** convert the selected files to a canonical bundle,
   preserve the external identity, run the existing required scanners and
   policy, then publish only an approved private release. A skills.sh audit is
   evidence shown to a reader; it is never a replacement for our policy.
4. **Cloud views:** model Official and Audits as remote provenance/evidence
   views, Topics as a remote taxonomy view, and Packs as a metadata-only
   preview of a user-supplied unlisted link. None of these should be confused
   with the existing private pack or administrative audit-log resources.

The adapter must run behind the Private Skills API. The skills.sh API
documentation describes Vercel OIDC authentication and a 600-request/minute
limit per `(team, project)`, but it does not document a portable non-Vercel
credential. A Vercel deployment can use request-scoped OIDC. A non-Vercel
deployment needs an operator-provisioned gateway or other documented
skills.sh-supported credential; the browser must never hold or forward it. If
no supported credential is configured, the cloud view reports “unavailable”
with a retryable reason instead of falling back to an undocumented anonymous
API contract.

## What the official sources establish

The current API documentation describes these versioned endpoints:

| Capability | Documented contract | Design consequence |
| --- | --- | --- |
| All/trending/hot catalog | `GET /api/v1/skills` with `view=all-time\|trending\|hot`, zero-based `page`, and `per_page` from 1 to 500. The response contains `data` and `pagination` with `total` and `hasMore`. | Use leaderboard pages for complete enumeration. Do not treat one search response as “all skills”. |
| Search | `GET /api/v1/skills/search` with `q` of at least two characters, `limit` 1–200, and optional GitHub `owner`. Results contain `searchType`, `count`, and a `data` array. | Reject too-short queries locally, preserve fuzzy/semantic metadata, and do not assume search has a page cursor: no search pagination is documented. |
| Official | `GET /api/v1/skills/curated` returns owner groups with `totalInstalls`, `featuredRepo`, `featuredSkill`, nested skill rows, `totalOwners`, `totalSkills`, and `generatedAt`. The docs say this is the same dataset as `/official`. | Preserve the group and featured fields. “Official” means first-party makers teaching their products, not a generic verified or safe badge. |
| Detail | `GET /api/v1/skills/{id}` returns the stable `id` (`source/slug`), source, slug, installs, a `hash`, and `files` (`path` + `contents`) or `null` when no snapshot exists. The listing shape also includes `name`, `sourceType` (`github` or `well-known`), `installUrl`, `url`, and optional `isDuplicate`. | Store the external snapshot hash separately from our artifact digest. A row with `files: null` remains discoverable but needs source resolution before pullthrough. |
| Audits | `GET /api/v1/skills/audit/{id}` returns an `audits` array of partner results. The documented normalized status is `pass`, `warn`, or `fail`; entries can include provider, partner slug, summary, audit time, risk level, and categories. `404` means no partner has audited the skill yet. | Treat a missing audit as unknown evidence. Display provider data generically because partner availability can change. Never use a remote `pass` as a Private Skills approval. |
| Rate/error behavior | Authenticated requests expose `X-RateLimit-*`; `429` includes `Retry-After`; documented errors include 400, 401, 404, 429, and 503. List/search cache for 30–60 seconds; detail/curated cache for five minutes. | Proxy and cache server-side, obey `Retry-After`, use bounded retries, surface stale metadata, and retain source response time/age. |

The Private Skills `GET /v1/directory/detail` route uses the exported
`SkillDetailMetadataResponse` projection. It preserves the external identity,
install count, snapshot hash, and `files: null` state; non-null file entries
contain paths only. The injected directory client and worker retain the full
bounded `SkillDetailResponse` for source acquisition, but reader-facing JSON
never exposes file `contents` before scanner and policy admission. Partner
audit responses remain separate external evidence.

The API examples contain dynamic install and total values. They are examples,
not schema constants. Earlier live spotchecks on 2026-09-10 observed
`pagination.total = 9,735` from `/api/v1/skills?per_page=2` and `total=9,736`
on page zero of an earlier production deployment. The latest bounded production
traversal observed `total=9,738` and 9,738 unique rows across 20 pages. The
homepage displayed an approximately 1.4-million install headline. These are
different measures (skill-row count versus aggregate installs), so the apparent
disparity is not a catalog integrity finding. The adapter must read the
response's `total` at request time and never bake any number into code or
completion criteria.

The current site also exposes these views:

- [`/packs`](https://www.skills.sh/packs) describes Packs as unlisted
  collections that can combine public skills, private files/folders/archives,
  and GitHub sources. The packs documentation says anyone with the URL can
  view/install it, no authentication is needed to install, and deleting a pack
  disables its link. The site exposes a user's/team's packs; it does not expose
  a public enumeration API.
- [`/topic`](https://www.skills.sh/topic) is a curated domain taxonomy. The
  current page links categories such as React, Next.js, Design & UI, Mobile,
  Agent workflows, Databases, Testing, and Marketing. A category page such as
  [`/topic/react`](https://www.skills.sh/topic/react) contains explanatory
  text, a list of skill links, compatible-agent text, FAQs, and related topics.
  No documented JSON topic-membership endpoint was found.
- [`/official`](https://www.skills.sh/official) is the maker-curated view. The
  page currently groups creator, repository, and skill counts; those counts
  are dynamic and must not become product constants.
- [`/audits`](https://www.skills.sh/audits) is a combined security-audit page.
  The page currently displays Gen Agent Trust Hub, Socket, and Snyk columns,
  while the API documentation also names Runlayer and ZeroLeaks as possible
  partners. The UI and API should accept unknown/future providers rather than
  hard-code the page's current three columns.

The skills CLI documentation says install telemetry is enabled by default and
contains the skill name, skill files, and timestamp, with an opt-out variable.
Private Skills must not silently forward or imitate that telemetry. Its own
analytics receipts remain the source of truth for Private Skills installs.

## Official CLI/repository evidence relevant to pullthrough

The [official `vercel-labs/skills` README](https://github.com/vercel-labs/skills/blob/main/README.md)
documents GitHub shorthand, full GitHub URLs, direct tree paths, GitLab, any
git URL, local paths, and direct `SKILL.md` or archive URLs. It also documents
`find`, `use`, `add`, `list`, `remove`, and `update`, plus project/global
installation and agent selection. The cloud adapter only needs public
catalog-backed sources for the first release; it must not silently add private
Git or arbitrary credential forwarding.

The pinned repository sources provide the exact mapping rules to reproduce or
adapt:

- [`src/types.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/types.ts)
  defines `ParsedSource` as GitHub, GitLab, git, local, well-known, or download
  and defines `RemoteSkill` fields including display name, full content,
  install name, source URL, provider ID, and source identifier. Its current
  `AgentType` union is much larger than Private Skills' three install receipt
  targets (`codex`, `claude`, `universal`).
- [`src/source-parser.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/source-parser.ts)
  parses GitHub tree URLs into repository, ref, and subpath; supports
  `owner/repo/path`, `owner/repo@skill`, fragments such as `#ref@skill`, and
  treats arbitrary non-GitHub/GitLab HTTPS URLs as well-known sources. It
  rejects unsafe subpaths.
- [`src/blob.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/blob.ts)
  fetches a recursive GitHub tree, discovers `SKILL.md` paths, reads
  frontmatter from `raw.githubusercontent.com`, and then tries the skills.sh
  snapshot endpoint `/api/download/{owner}/{repo}/{slug}`. Its `BlobSkill`
  carries `repoPath`, `snapshotHash`, and the tree SHA. This is the strongest
  documented reference for mapping a skills.sh row to a repository path; it is
  not a semantic-version source.
- [`src/providers/wellknown.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/providers/wellknown.ts)
  implements the two discovery paths, preferring
  `/.well-known/agent-skills/index.json` and falling back to
  `/.well-known/skills/index.json`. It accepts the discovery schema
  `https://schemas.agentskills.io/discovery/0.2.0/schema.json` with
  `skill-md`/`archive`, URL, and `sha256:` digest entries, plus legacy entries
  with a safe `files` list containing `SKILL.md`. It rejects unknown schemas,
  unsafe paths, and invalid entries. Its bounded defaults are a 10-second
  discovery timeout, 50 MiB unpacked archive size, and 1,000 archive files.
- [`src/download-source.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/download-source.ts)
  bounds direct downloads at 10 MiB, extracted content at 25 MiB, and archives
  at 1,000 files, and checks archive paths before extraction.
- [`src/telemetry.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/telemetry.ts)
  confirms that upstream install/audit telemetry is fire-and-forget and that a
  failed/slow remote audit does not block the CLI install. Private Skills has a
  stricter rule for private admission: an external audit may be advisory, but
  our required scanner evidence remains fail-closed.
- [`src/find.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/find.ts)
  currently calls the legacy `/api/search?q=...&limit=20` shape and sorts the
  returned `skills` array. This is useful CLI compatibility evidence, but it is
  not the documented v1 cloud contract (`/api/v1/skills/search` with `data`).
  The adapter must pin the v1 contract and cover any compatibility path with an
  explicit fixture rather than silently relying on the legacy response.

The current long-tail page
[`prime-skills/runcomfy-agent-skills/video-edit`](https://www.skills.sh/prime-skills/runcomfy-agent-skills/video-edit)
rendered with a GitHub repository, install command, and audit status. This
demonstrates that a catalog row can have a multi-component `source/slug` ID and
an install URL that points to a repository. Direct page opens for the
well-known examples `open.feishu.cn/lark-doc` and the API-doc example
`mintlify.com/mintlify` were refused by the browsing layer's safe-open guard;
that is an unresolved browser access result, not evidence that either page is
404. The API schema and the official provider source are the evidence used for
well-known support.

## Current Private Skills coverage

| Area | Current implementation | Status for skills.sh support |
| --- | --- | --- |
| Private catalog | `packages/core` serves authorized `/v1/skills`; `apps/web` renders approved private releases and semantic search. The directory adapter and `/v1/directory` cloud routes are implemented separately. | **Partial integration.** Current production evidence proves the metadata directory path and complete bounded pagination; it does not prove private admission for every source row. |
| Enumeration/cache/security | `packages/directory` provides conflict/drift-aware enumeration, auth-before-hit bounded metadata caching, and negative credential/security coverage. | **Implemented in source; API proof verified.** These paths are present at `0f9da75` and included in the current test review; the current API artifact proves credential-negative/list/search behavior and fresh-canonical Topics, while browser proof remains pending. |
| Provenance | `packages/contracts` carries skills.sh provider, complete external ID, source/slug/type, source/page URLs, snapshot hash, source resolution fields, and the separate local `sourceDigest`. | **Implemented with live limits.** Current-head tests preserve bounded nested IDs and exact identity checks; the live upstream route returned invalid or wrong-identity responses for the nested probe, so no detail/import success is claimed. |
| Acquisition | `packages/upstreams` implements skills.sh snapshot parsing plus GitHub and well-known source resolution with bounded files, archives, paths, and local canonical digesting. | **Implemented as a worker primitive; transparent install evidence pending.** The target feed adapter resolves a selected catalog identity without a per-source mapping; each tenant feed has its own origin/restriction/membership/provenance/ACL context. Artifact reuse waits for verified origin/repository/exact-path or well-known scoped identity plus revision/digest and current policy. No representative production pullthrough is claimed here. |
| Imports/proxy | `packages/core` exposes governed `/v1/directory/import` and carries external ID/type/hash through the import job and provenance checks; existing `/v1/imports` and `/v1/proxy/resolve` remain authorization and scanner bounded. | **Partial.** The target contract makes a configured feed plus skills.sh external ID sufficient to start a cold pullthrough, deduplicates concurrent operations per tenant/feed/source revision, and serves later approved cache hits only after canonical source/ACL checks. The current code/evidence has not yet accepted a representative GitHub/well-known import. Do not derive a SemVer from installs, first-seen date, or a Git branch. |
| Packs | `PackVersion` is an immutable private org pack with approved private skill members and a manifest digest. `PacksView` creates/lists private packs and has a remote unlisted-pack preview route. | **Partial verification.** The current code keeps external previews metadata-only and separate from private packs; production evidence still lacks an operator-supplied preview URL, and no public enumeration or automatic member migration is claimed. |
| Audit | `AuditView` remains the Private Skills administrative change log; scanner reports are tenant-scoped, and `/v1/directory/audits` supplies external evidence. | **Partial.** External audit view is implemented and earlier production evidence returned five partner entries; negative-credential and tenant/secrecy proof remain open. |
| UI navigation | `RegistryShell` exposes Cloud directory, Official makers, Topics, external Audits, and Packs alongside private registry views. | **Partial verification.** Earlier CSS deployment captures prove the recorded browser surfaces; the latest directory deployment is a metadata probe, and no current deployment claim is made for every view. |
| Agent targets | `InstallReceiptAgent` and the Rust client currently cover `codex`, `claude`, and `universal`; the web install command is Codex-oriented. | **Partial ecosystem coverage.** The official CLI's current agent union is substantially larger. Catalog coverage can ship independently, but “all agent targets” needs an explicit later adapter matrix and discovery tests. |

## Proposed external catalog contract

The following is a design contract, not a request to edit `packages/contracts`
in this review. Keep external metadata separate from an approved
`SkillVersion` until a user requests an import.

```ts
type SkillsShSourceType = 'github' | 'well-known'

interface SkillsShCatalogSkill {
  provider: 'skills.sh'
  id: string                 // opaque stable source/slug; never slug-only
  source: string             // owner/repo or provider domain
  slug: string
  name: string
  installs: number
  sourceType: SkillsShSourceType
  installUrl: string | null
  pageUrl: string
  isDuplicate?: boolean
  view?: 'all-time' | 'trending' | 'hot' | 'search' | 'official'
  fetchedAt: string
}

interface SkillsShSourceResolution {
  status: 'unresolved' | 'resolved' | 'changed' | 'unavailable' | 'rejected'
  sourceUrl: string
  repository?: string
  skillPath?: string       // repo-relative directory/SKILL.md parent
  requestedRef?: string
  resolvedCommit?: string  // GitHub immutable commit when applicable
  resolvedTree?: string    // selected skill folder tree SHA when available
  wellKnownIndexUrl?: string
  artifactUrl?: string
  externalSnapshotHash?: string | null
  externalDigest?: string // well-known v0.2 digest, if supplied
  frontmatterName?: string
  frontmatterDescription?: string
  reason?: string
}

interface SkillsShDetail {
  catalog: SkillsShCatalogSkill
  files: Array<{ path: string; contents: string }> | null
  externalSnapshotHash: string | null
  resolution?: SkillsShSourceResolution
}
```

Rules:

- `id` is the external primary key. Preserve the complete source portion and
  slug; do not collapse `owner/repo/skill` to a skill name. For detail/audit
  requests, use the API's parsed `{source}/{slug}` path form from the trusted
  listing fields rather than blindly URL-encoding the whole ID as one segment;
  validate each field and reject traversal. A listing's `isDuplicate` is
  display metadata, not proof that bytes are equal.
- `externalSnapshotHash` is the skills.sh detail hash. Our `sha256:<hex>`
  artifact digest is computed over the canonical Private Skills bundle. Store
  both and record whether any comparison was made; do not assert that a skills.sh
  snapshot hash is a Git tree SHA or our serialized-bundle digest.
- GitHub source resolution records repository, selected `SKILL.md` path,
  requested ref, resolved commit, selected tree SHA, frontmatter name, and
  source URL. If multiple paths match the same slug/name, mark the row
  ambiguous instead of guessing.
- Well-known source resolution records the base URL, the exact discovery index
  URL, schema version, relative/absolute artifact URL, supplied digest when
  present, and computed local digest. It must prefer `agent-skills` and only
  fall back to legacy `skills` when the preferred index is unavailable.
- A skills.sh row has no upstream SemVer. Automatic pullthrough may use a
  server-owned internal release reference or immutable source revision, but
  the reader does not supply an alias merely to start installation. The
  external ID and source revision/hash remain the immutable source identity;
  installs, first-seen time, display name, and mutable branch names never become
  an upstream release version.

## Discovery and paging design

1. The server-side adapter calls `GET /api/v1/skills` for All, Trending, and
   Hot. It requests a bounded `per_page` (maximum 500), exposes the returned
   `page`, `perPage`, `total`, and `hasMore`, and stops only when `hasMore` is
   false. A complete coverage traversal has a page/time/byte budget and need not
   be exposed as a user-triggered bulk-refresh operation; a normal browse
   fetches only the visible page.
2. Search calls the v1 search endpoint with the user's query, optional owner,
   and a bounded `limit` (maximum 200). Because no search pagination contract is
   documented, the UI must label results as a search result set, not a complete
   owner catalog. Owner-wide “all” uses leaderboard paging or a separately
   verified future API contract.
3. Normalize every response to one external row type and use the complete `id`
   as the coverage key. The traversal records duplicate rows/IDs explicitly,
   deduplicates its unique coverage count, and retains the source row and
   `isDuplicate` metadata for review rather than silently dropping a listing.
   The `source`, `slug`, `sourceType`, install URL, and direct page URL remain
   visible. Dynamic install counts are display values, not release identity.
4. Keep only bounded metadata cache entries, keyed by endpoint plus normalized
   query/page. Respect the documented cache windows for list/search and curated
   responses and record cache age. Detail snapshots are fetched on demand and
   intentionally bypass the metadata cache because a response may contain file
   text, despite the upstream's recommended five-minute detail window. Metadata
   traversal does not fetch or store `files` for every row.
5. A user selecting a row fetches detail on demand. The adapter stores no file
   bytes in the catalog metadata cache. A first install of the selected row
   automatically creates or joins a durable pullthrough operation; the worker
   retains the selected external identity and fetch evidence while it validates,
   scans, and caches the complete bundle. A later install resolves the approved
   cached release without an upstream fetch, subject to a fresh install
   authorization and current policy/scan checks. Only an explicit refresh or
   update rechecks the source, and a failed recheck is reported rather than
   silently serving the old cache as current.
6. `401`, `429`, `503`, timeout, malformed response, and rate-limit exhaustion
   become explicit retryable/unavailable states. No stale detail is silently
   presented as current source bytes, and no browser call contains a bearer
   credential.

“Full catalog coverage” is therefore measurable without mass mirroring: the
latest bounded enumeration run observed all 9,738 declared rows across 20 pages,
recorded 9,738 unique IDs and zero duplicates, and performed no detail/source
or artifact writes. Only selected rows incur detail/source traffic and private
object storage.

## Pullthrough and source resolution

### Preferred path: skills.sh snapshot

For a selected row, call the detail endpoint and, when `files` is non-null:

1. Verify the response identity still matches the requested `id`, source, and
   slug; reject path confusion or duplicate IDs.
2. Validate all relative paths, file count, per-file bytes, total expanded bytes,
   and the required `SKILL.md` frontmatter. Preserve binary/supporting files in
   the bundle representation where the current contract permits them; do not
   execute any file, script, hook, MCP server, or instruction during import.
3. Compute the Private Skills canonical digest, retain the external hash as
   provenance, and run the existing scanner worker and policy. A remote audit
   result can be shown alongside local scans but does not satisfy a required
   scanner.

### Null-snapshot metadata hydration in the worker

The documented detail response may contain `files: null` and omit the
presentation `installUrl` that identifies a scoped well-known source. The
durable worker must not turn a repository-shaped `source` string into a guessed
host or silently lose that scope. When the detail has no files or install URL,
the imported source type is `well-known`, and no explicit operator mapping is
configured, the worker performs a fresh catalog metadata lookup before source
acquisition:

1. Recheck the selected upstream's organization, namespace, enablement, and
   source allowlist first. Catalog metadata cannot broaden an administrator's
   mapping. An explicit `wellKnownBaseUrl` remains authoritative and skips
   rehydration; GitHub candidates with an explicitly configured GitHub API base
   continue through the GitHub resolver.
2. For a slug of at least two characters, query the authenticated
   `/api/v1/skills/search` endpoint with `limit=200`. If there is no exact match,
   walk `/api/v1/skills?view=all-time&page=N&per_page=500` from page zero, up to
   100 pages, stopping at `hasMore=false`.
3. Accept exactly one row whose complete `id`, `source`, and `slug` match the
   detail identity, whose `id` is the canonical `${source}/${slug}`, and whose
   `sourceType` is `well-known`. A valid absolute `installUrl` is copied into
   the worker's in-memory detail; metadata lookup never downloads source bytes.
   Duplicate exact rows, malformed pagination, invalid URLs, or a source-type
   mismatch fail closed.

The source-location precedence is explicit: operator `wellKnownBaseUrl`, then
the exact catalog `installUrl` (preserving its path scope), then a safe
host-shaped `source` fallback. A repository-shaped source without a safe origin
is unavailable. Discovery tries the preferred and legacy well-known indexes at
the selected scoped base and never widens a scoped path to that host's root.
The catalog bearer is sent only to skills.sh catalog requests. On the canonical
`https://skills.sh` origin, a request-scoped `getSkillsShToken` credential (the
Vercel project OIDC path) takes precedence over an ambient environment token;
callback failure is terminal and does not fall back to a stale token. An
explicit operator-managed `credentialEnv` may remain a legacy server
configuration for a trusted non-canonical/private catalog destination when no
callback is provided; it is not a caller input and is never a fallback after
callback failure. Neither form is forwarded to
source, artifact, or redirect requests.

The worker metadata lookup has a 30-second aggregate cap, parent cancellation,
non-retryable search/list requests, a 200-result search bound, a 500-row page
bound, and a 100-page bound. With the default acquisition profile, each HTTP
request is limited to 20 seconds and each response to 20 MiB; a lower operator
profile can tighten those limits. Only catalog `404`/`410` responses are
treated as an empty search/list result; authorization, outage, malformed-data,
and rate-limit errors remain unavailable/fail-closed. The API admission path
uses the same exact-identity rule and a separate 30-second, 100-page bound
before queueing a null-snapshot import.

This is a source-level worker contract with fixture coverage; it is not current
production pullthrough evidence. The current production API artifact verifies
read-only directory list/search/detail routes, but no production selected-row
`files: null` well-known import, scoped source readback, or scanner admission
has yet been captured. Keep the pullthrough acceptance state pending until that
evidence exists.

### GitHub fallback and exact mapping

The detail API does not document a repository path, branch, or commit. For a
GitHub row with no snapshot, use a public-only resolver equivalent to the
official CLI's tree path:

1. Resolve `source` as `owner/repo`; treat `installUrl` as a repository hint,
   not as a credential-bearing fetch URL.
2. Resolve the repository's default branch/ref to an immutable commit; fetch a
   recursive tree and reject a truncated tree. Search case-insensitively for
   `SKILL.md` using the official priority directories and match the row slug
   and frontmatter name. Preserve the exact repository-relative path.
3. Fetch the selected directory's blobs with existing bounded acquisition
   rules, validate the canonical bundle, and record commit/tree/file hashes.
4. If source, path, frontmatter, or snapshot hash cannot be reconciled, mark
   `changed`, `ambiguous`, or `unavailable` with a reason. Never silently import
   another skill with the same display name.

The existing GitHub upstream worker and the skills.sh identity resolver now
resolve commits and recursive trees, enforce path/size/redirect/SSRF limits,
validate bundles, and emit a local source digest. A configured skills.sh feed
may resolve any catalog row through this bounded server-side path; an
administrator can optionally narrow that feed's policy or select an explicit
proxy mapping. Unknown or disabled feeds fail before acquisition. Neither mode
permits a direct client fetch or bypasses the registry scanner gate.

### Well-known fallback

For `sourceType: well-known`, use the official provider's compatibility rules:

- Try `https://host/.well-known/agent-skills/index.json`, then the legacy
  `https://host/.well-known/skills/index.json`.
- Accept discovery schema v0.2 only when `$schema` is the documented schema,
  every selected entry has a valid name/description/type/url/`sha256:` digest,
  and the artifact URL remains same-origin to the provider's advertised base
  unless an explicit safe redirect policy permits otherwise.
- Accept legacy v0.1 only when each selected entry has a safe relative `files`
  list containing `SKILL.md`. Do not fall back from a scoped path to the host's
  root index, because that could install an entire unrelated catalog.
- Apply our own response, archive, path, file, and expansion limits even when
  the official CLI's limits are larger. Unknown discovery schemas and invalid
  entries are visible as unsupported, never silently skipped.

This path must use no skills.sh catalog bearer or unrelated upstream
credential. It is public source acquisition with the same SSRF, redirect,
timeout, and bundle validation boundary as other upstreams. An optional
administrator-configured source credential is scoped to the exact configured
origin and never changes the original catalog identity.

## Cloud views and semantics

The proposed UI can add a “Cloud catalog” group or tabs without changing the
current private sections:

| View | Data source | Required behavior |
| --- | --- | --- |
| All / Trending / Hot | v1 leaderboard pages | Show page state, count, cache age, source type, duplicate flag, install count, and explicit metadata-only/source-resolved/pullthrough status. |
| Official | v1 curated response | Group by owner; show featured repository/skill and `generatedAt`; label “maker-curated”, never “trusted” or “approved”. |
| Topics | `/topic` and `/topic/{slug}` official pages | Show the current category links, explanatory copy, related topics, and parsed skill links only when the page shape is recognized. Since no JSON membership API is documented, retain page URL/fetch time/parser version and display “membership unavailable” on parse failure rather than inventing tags. |
| Audits | v1 audit endpoint per selected row, plus external audits page semantics | Show one row per returned provider, status, risk, summary, and `auditedAt`; map 404 to “no external audit yet”. Keep this visibly separate from the Private Skills administrative audit log and local scanner findings. |
| Packs | Existing private pack API plus user-supplied skills.sh pack URL | Keep private immutable packs and external unlisted packs in separate sections. A supplied `https://skills.sh/p/<pack-id>` renders a metadata-only manifest preview and a link to the external page/install command. Do not promise public enumeration, download member bytes, batch-import members, create a private pack, or imply approval. Show that anyone with the URL can install the external pack. |

Pack preview accepts an HTTPS `skills.sh` or `www.skills.sh` `/p/<pack-id>` input and returns the canonical `https://www.skills.sh/p/<pack-id>` in manifest metadata and resolved relative member URLs. It requests the scoped `/.well-known/agent-skills/index.json` first, then the same pack's `/.well-known/skills/index.json` legacy index when the preferred index is missing or malformed; redirects remain denied and the lookup never widens to a host-wide path. The publicly published [`smixs/visual-skills` pack](https://github.com/smixs/visual-skills/blob/main/README.md) validated this adapter path as a metadata-only v0.1 manifest with three members; this is upstream fixture evidence, not authenticated production-preview success.

An external skill card should link to the skills.sh page and source repository,
show the source resolution state, and expose an install action that uses the
complete external ID. The action must not require a per-source mapping or a
manual alias. On a cold path it returns an operation ID and shows pending,
quarantined, or scan-error outcomes; on a warm path it uses the approved cache
after reader authorization. It must never redirect a reader directly to
upstream bytes as a substitute for registry approval. A Pack card only previews
its manifest and external link in the current delivery; batch migration is a
later milestone.

## Acceptance criteria

These criteria are the current follow-up cloud-catalog milestone acceptance
contract. They do not add a requirement to the current v0.2.0 shipment.

### CATALOG — complete on-demand coverage

- **CAT-1 API fixture contract:** checked-in fixtures cover v1 list, search,
  curated, detail, and audit success/error shapes. The adapter uses `/api/v1`
  and treats the CLI's `/api/search` shape as compatibility-only. Query bounds,
  `sourceType`, `files: null`, unknown fields, `429/Retry-After`, and `503`
  are tested.
- **CAT-2 complete enumeration:** bounded list-page traversal can walk pages
  from zero until `hasMore=false`, use complete `id` values as its coverage key,
  retain duplicate-row evidence, and record observed count versus response
  `total`. It passes with a fixture spanning at least three pages and a
  duplicate row; no row disappears without a recorded reason. The latest
  production run recorded 9,738 declared/observed/unique rows across 20 pages,
  with zero duplicate rows/IDs and no artifact writes.
  This is a coverage/adapter verification path, not a required user-triggered
  “refresh all metadata” operation. Search results expose their query/search
  type and are not mislabeled as complete enumeration.
- **CAT-3 cache/budget:** normal browse fetches only the requested page;
  metadata traversal writes metadata only. No artifact blob, detail file, or
  private release is written until an explicit selected-row import. Cache age,
  endpoint/query key, byte count, and source response status are observable;
  list/search and detail/curated TTLs follow the documented windows unless an
  operator chooses a shorter bounded TTL.
- **CAT-4 stable identity:** round-trip fixtures preserve complete `id`, source,
  slug, source type, install URL, page URL, and duplicate flag. Same slug under
  different sources cannot collide. IDs are treated as bounded path components;
  detail/audit route construction cannot allow traversal or encoded-delimiter
  confusion. Current-head fixtures accept the valid nested ID
  `claude-office-skills/skills/facebook/meta-ads` and fail closed for unsafe
  variants; the live upstream's 400/wrong-identity/404 behavior remains an
  external compatibility limitation, not a trusted mapping.
- **CAT-5 source status:** every enumerated row receives `snapshot-available`,
  `source-resolved`, `metadata-only`, `changed`, `unavailable`, or `rejected`,
  with a bounded human-readable reason. The UI never calls a row installable
  merely because it is listed.

### SOURCE — feed-aware exact pullthrough

- **SRC-0 feed identity and isolation:** a tenant can configure at least two
  named feeds using the current `skills.sh` adapter, with one origin,
  credential/restriction set, and membership/provenance/ACL context per feed.
  The selected feed and full source ID are retained separately; the same
  external ID under two feeds never grants cross-feed access. An artifact cache
  may be reused only after verified canonical source identity, revision/digest,
  and current tenant policy checks; the external ID alone is not a cache key.
  Unknown or disabled feeds fail before catalog access or any outbound request.
  No
  per-repository mapping or manual alias is needed for a valid configured feed.
  The server-owned source reference is derived only after verification:
  `@github/owner/repo/<exact-skill-directory>` for GitHub,
  `@web/<authority>/<scope>/<entry>` for a well-known source, or
  `@snapshot/skills-sh/<externalId>` when physical source proof is absent.
  Feed membership never renames a skill, and managed namespace/ACL policy stays
  independent. Additional feed adapter types are future work; this criterion
  covers the current skills.sh adapter only.
- **SRC-1 skills.sh snapshot:** a fixture with non-null `files` validates all
  paths/frontmatter, computes a local canonical digest, retains the external
  hash separately, and queues a scan. A malformed file list, missing
  `SKILL.md`, traversal path, excessive file/byte count, or hash/identity
  mismatch cannot produce an approved release.
- **SRC-2 GitHub fallback:** fixtures cover root, `skills/`, nested catalog,
  multiple matching `SKILL.md`, default branch, and explicit ref. A successful
  result records owner/repo, exact skill path, requested ref, resolved 40-hex
  commit, selected tree SHA, frontmatter name, and local digest. Ambiguous or
  changed mappings are rejected with a reason; no SemVer is inferred.
- **SRC-3 well-known:** fixtures cover discovery v0.2 and legacy v0.1, preferred
  and fallback index paths, relative artifact URLs, archive entries, supplied
  digest verification, unsafe file paths, unknown schemas, scoped paths, and a
  missing index. A scoped request never installs the host root catalog. Limits
  and same-origin/redirect/SSRF rules are enforced before bytes are retained.
- **SRC-4 automatic private admission:** `POST /v1/proxy/resolve` accepts an
  optional configured `feed`, complete external ID (or an exact supported
  skills.sh URL), and optional `refresh`; omitted feed selects the configured
  default. It needs no per-source mapping, manual alias, caller-supplied
  private name/version, or `upstreamId`. A cold request creates or joins one
  durable pullthrough operation, fetches and validates complete bytes, runs the
  required scanner policy, and caches only an approved immutable release. A
  warm request uses that approved cache without an upstream lookup after a fresh
  reader install authorization and explicit `proxy:resolve` permission.
  Concurrent cold requests for the same tenant,
  feed, external identity, and resolved revision join one operation and produce one
  source fetch, scan set, and sealed artifact for that feed/source revision. A
  required scanner error,
  incomplete coverage, blocked finding, policy denial, or stale evidence never
  yields an installable result.
- **SRC-5 exact provenance and identity:** the `202` operation and `200`
  resolution echo the original external ID and selected feed. A `202` may omit
  `reference`; a `200` carries the verified server-owned source reference.
  Server-owned internal IDs and immutable revisions may be collision-resistant,
  but never replace or rewrite the skills.sh source identity. The record retains tenant, feed, source type,
  source/page/index URLs, external snapshot hash/digest (including null),
  resolved commit/tree or well-known digest when available, local canonical
  artifact digest, fetch time, scanner IDs/revisions, policy revision, feed
  restriction revision, ACL context, and cache status. When verified, the
  reference records the provider/origin, repository/exact path, or well-known
  scope; when the catalog snapshot lacks physical proof it uses the
  `@snapshot/skills-sh/<externalId>` status/reference and does not invent a
  path. If the catalog snapshot
  omits files or a verified source path, provenance records that absence/status
  and never invents a repository path or physical file location. `refresh: true` or update
  must report source failure and must not relabel an older cache entry as
  freshly verified; no install count, display name, branch, or first-seen date
  becomes an upstream SemVer.

### VIEW — cloud product surfaces

- **VIEW-1 Official:** the curated response is normalized into owner groups,
  retains featured fields and `generatedAt`, and displays a maker-curated
  explanation. Arbitrary repository ownership cannot set this badge.
- **VIEW-2 Topics:** fixtures for at least React and Marketing parse category
  title, description, skill links, related topics, and compatible-agent copy
  from the official pages. A parser/schema version and source URL are retained;
  a changed page shape makes the view stale/unavailable rather than silently
  assigning wrong memberships.
- **VIEW-3 Audits:** 200, 404, partial-provider, future-provider, stale-time,
  and malformed-entry fixtures render correctly. Remote `pass`/“Safe” never
  changes local scanner policy, and an audit 404 is not a scan failure.
- **VIEW-4 Packs:** private pack rows remain tenant-scoped and immutable. A
  user-provided external pack URL is visibly unlisted/public, never globally
  enumerated, and renders a metadata-only manifest preview plus an external
  page/install link. The preview downloads no member bytes, creates no private
  pack, and implies no Private Skills approval. Deleted/404 links are reported
  as unavailable.
- **VIEW-5 isolation:** public external metadata may be shared across users,
  but private catalog rows, pack members, source credentials, scanner reports,
  import operations, and cloud cache keys remain organization-scoped. Browser
  network traces contain no skills.sh or GitHub bearer credential.

### Future P1 — external pack migration

This is a separate roadmap milestone, after the current metadata-only Packs
view. **PACK-MIGRATION-1:** an explicit, separately authorized action resolves
every selected external-pack member to an immutable source, validates and scans
each member through the existing policy, and creates one private immutable pack
only after every member passes. A changed, unavailable, deleted, ambiguous, or
blocked member leaves no partial private pack and records the operation failure;
the migration never implies that the unlisted external pack was approved merely
because its manifest could be previewed.

### AUTH, OPS, and AGENTS — deployment and ecosystem boundaries

- **OPS-1 authentication portability:** current Vercel deployment evidence
  obtains and accepts a request-scoped project OIDC credential for skills.sh.
  A non-Vercel deployment test still uses an explicitly configured supported
  gateway/credential provider; absent configuration returns a retryable
  unavailable state. No undocumented public API assumption is required. The
  current record still requires browser/log credential-negative evidence and
  does not treat the prior disconnected 503 as current behavior.
- **OPS-2 rate/error behavior:** tests honor `Retry-After`, back off boundedly,
  cap concurrent page/detail requests, expose response status/request
  correlation, and never retry a malformed or unauthorized request forever.
- **OPS-3 no mass mirror and cache behavior:** a complete metadata enumeration
  of a fixture with at least 1,000 rows causes zero artifact writes and only
  bounded metadata storage. `POST /v1/proxy/resolve` for one selected row
  causes one cold detail/source fetch and at most one private pullthrough
  operation; concurrent repeats join it. After approval, a default install
  performs no upstream lookup and uses the approved cache. Only explicit
  `refresh: true` or update rechecks upstream, and a failed recheck is surfaced
  without marking the old cache fresh.
- **AGENT-1 target matrix:** the adapter records source catalog coverage
  independently from install-agent coverage. A future agent milestone derives
  an explicit table from the pinned upstream `AgentType` union and tests each
  selected project/global path; unsupported agents are labeled unsupported.
  It must not claim the current three Private Skills receipt targets cover the
  official CLI's larger ecosystem.
- **AGENT-2 tool parity (later):** if Private Skills exposes cloud CLI parity,
  `find`, `use` (ephemeral prompt without publication), `add`, `list`,
  `update`, and `remove` each have an authorization/provenance contract and
  clean-consumer tests. This is later than the catalog API and is not a v0.2.0
  launch gate.

## Dependencies and non-goals

The near-term implementation dependency is now partially satisfied: an earlier
production evidence run covers complete metadata pagination, while earlier
evidence covers the authenticated Vercel OIDC directory path and a required
ComputeSDK scan. The current source contains the Topics parser, bounded cache,
enumeration conflict handling, and credential-negative tests. The current API
artifact verifies safe list/search, fail-closed auth, and fresh canonical Topics;
browser proof for those paths is still pending. Remaining C1
dependencies are representative GitHub/well-known source resolution and import
readback,
upstream nested-detail availability, current browser proof for Topics/cache/
enumeration, an operator-supplied
Packs preview, browser/log credential-negative evidence, error/rate handling,
and tenant/secrecy checks. A non-Vercel Nitro deployment still needs an
explicitly configured supported gateway/credential provider.
The current-head client supports bounded nested identities and fails closed on
wrong upstream identities; that does not substitute for successful live detail
and scanner-admission evidence.

This work must not silently turn the current release into a public marketplace
or bulk mirror. It does not require importing all catalog rows, copying
skills.sh telemetry, accepting third-party audit passes as policy decisions,
enumerating unlisted Packs, inferring source SemVer, or supporting every agent
target in the first cloud-catalog milestone. Those are separate, measurable
milestones above.

## Sources checked

Primary official pages and files used for this review:

- [skills.sh API reference](https://www.skills.sh/docs/api)
- [skills.sh documentation](https://www.skills.sh/docs)
- [skills.sh CLI reference](https://www.skills.sh/docs/cli)
- [skills.sh Packs documentation](https://www.skills.sh/docs/packs)
- [skills.sh Customize repo pages](https://www.skills.sh/docs/customize)
- [skills.sh Packs view](https://www.skills.sh/packs)
- [skills.sh Topics index](https://www.skills.sh/topic) and [React topic](https://www.skills.sh/topic/react)
- [skills.sh Official view](https://www.skills.sh/official)
- [skills.sh Security Audits view](https://www.skills.sh/audits)
- [skills.sh long-tail skill page](https://www.skills.sh/prime-skills/runcomfy-agent-skills/video-edit)
- [vercel-labs/skills README](https://github.com/vercel-labs/skills/blob/main/README.md)
- [`src/types.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/types.ts)
- [`src/source-parser.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/source-parser.ts)
- [`src/blob.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/blob.ts)
- [`src/providers/wellknown.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/providers/wellknown.ts)
- [`src/download-source.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/download-source.ts)
- [`src/find.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/find.ts)
- [`src/telemetry.ts`](https://raw.githubusercontent.com/vercel-labs/skills/main/src/telemetry.ts)
- [Private Skills isolated install-directory guide](install-directories.md)

The report is a design and evidence record. Current production evidence covers
metadata-only full catalog pagination; earlier deployment evidence covers the
authenticated directory endpoints and ComputeSDK scan above. Representative
pullthrough, nested live detail, remaining cloud views, and CLI parity are not
claimed until their remaining acceptance criteria pass.

## CLI and agent compatibility review

The requested cloud catalog/source/view work is the current delivery slice.
The wider upstream CLI comparison below is a future compatibility roadmap. It
must consume the registry-owned contract and must not add a client-side direct
fetch or scanner bypass.

### Current Private Skills CLI boundary

The Rust binary currently exposes registry `search`/`show`/`versions`,
`publish`, registry-mediated `proxy`, `install`, `list`, `verify`, `remove`,
`update`, `doctor`, scan status, and pack operations. Its install path obtains
an authorization, validates the final authorization, verifies the transfer
descriptor and digest, and commits local files, the journal, and lock
transactionally. The current install receipt targets are `codex`, `claude`,
and `universal`. These are existing foundations, not gaps to reopen while
adding skills.sh.

Relevant implementation files are
[`crates/pskills-cli/src/main.rs`](../crates/pskills-cli/src/main.rs),
[`crates/pskills-core/src/client.rs`](../crates/pskills-core/src/client.rs),
[`crates/pskills-core/src/install.rs`](../crates/pskills-core/src/install.rs),
[`crates/pskills-core/src/bundle.rs`](../crates/pskills-core/src/bundle.rs),
and [`crates/pskills-core/src/model.rs`](../crates/pskills-core/src/model.rs).
The existing `proxy` command deliberately requires an administrator-approved
upstream, path, registry name, and version for generic/private proxy imports.
The transparent skills.sh catalog path is separate: a complete external ID or
exact supported skills.sh URL uses the built-in adapter without that mapping or
manual alias prerequisite.

### Confirmed upstream CLI capabilities and future mapping

The [official CLI README](https://github.com/vercel-labs/skills/blob/main/README.md)
and source files show the following capabilities. The “Private Skills plan”
column is explicitly future work.

| Upstream capability | Official source evidence | Private Skills today | Private Skills plan |
| --- | --- | --- | --- |
| `find` and `use` plus `add`, `list`, `remove`, `update`, and `init` | [CLI source](https://github.com/vercel-labs/skills/blob/main/src/cli.ts), [find](https://github.com/vercel-labs/skills/blob/main/src/find.ts), [use](https://github.com/vercel-labs/skills/blob/main/src/use.ts) | Registry search and governed install/update exist; there is no skills.sh discovery command or ephemeral use flow. | Add `find`/`discover` against the normalized cloud endpoint. Consider a non-executing `show --prompt` or temporary export later; never launch an agent or execute package content implicitly. |
| Source grammar | [source parser](https://github.com/vercel-labs/skills/blob/main/src/source-parser.ts) accepts GitHub/GitLab/generic Git, tree refs/subpaths, well-known URLs, and direct downloads. | The CLI sends registry names and approved upstream references; it does not parse arbitrary external source URLs. | Add a pure source identity parser only when the server contract is ready. Send normalized identity to the registry; never send upstream credentials from the CLI. |
| Lock and update provenance | [local lock](https://github.com/vercel-labs/skills/blob/main/src/local-lock.ts), [skill lock](https://github.com/vercel-labs/skills/blob/main/src/skill-lock.ts), [update](https://github.com/vercel-labs/skills/blob/main/src/update.ts) retain source/ref/path and hashes. | `pskills.lock.json` already records registry, owner, version, artifact/tree identity and targets, but it lacks first-class external source type/URL/path fields and dedicated check/restore/sync commands. | Extend the existing lock with optional source provenance and add read-only check plus deterministic restore/update planning. Do not introduce a second ungoverned lock format. |
| Agent registry and scopes | [agent registry](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) is data-driven and covers many agent directories, project/global roots, and universal targets. | Three install target values are supported and the web flow is Codex-oriented. | Later, add a data-driven adapter registry and repeatable multi-agent/project/global planning. Preserve current path safety and whole-batch transactions. |
| Multi-skill selection | [add](https://github.com/vercel-labs/skills/blob/main/src/add.ts) and [skills discovery](https://github.com/vercel-labs/skills/blob/main/src/skills.ts) support selectors, `--all`, full-depth discovery, and multiple skills. | A registry resolution and `proxy` request select one approved source path at a time; local pack installation is already transactional. | Add selected-member/wildcard import only through a complete server resolution. One blocked or ambiguous member must leave the destination, journal, and lock unchanged. |
| Well-known/archive providers | [well-known provider](https://github.com/vercel-labs/skills/blob/main/src/providers/wellknown.ts) and [download source](https://github.com/vercel-labs/skills/blob/main/src/download-source.ts) implement bounded discovery and extraction. | Acquisition supports approved GitHub/private registry sources; arbitrary skills.sh/well-known/archive sources are not enabled. | Keep provider fetching in the server/worker lane. The CLI consumes a provider-neutral authorized transfer descriptor and never falls back to direct downloads. |
| Local authoring | [CLI init](https://github.com/vercel-labs/skills/blob/main/src/cli.ts) creates required frontmatter; existing Private Skills bundle validation checks the same safety boundary. | No `pskills init` or standalone `validate` command. | Add idempotent authoring and machine-readable validation later, reusing the existing bundle validator and never executing hooks/package managers. |
| Telemetry and audits | [telemetry](https://github.com/vercel-labs/skills/blob/main/src/telemetry.ts) sends optional install/find/update/remove/sync events and partner audit lookups; failures do not block upstream CLI installation. | Private Skills sends a receipt after a committed registry install/update and keeps local journal state; it does not call the upstream beacon. | Keep Private Skills analytics and privacy controls independent. Any optional history must be bounded, redacted, opt-out, and never change install success. External audits remain advisory evidence. |
| Ephemeral `use` | [use implementation](https://github.com/vercel-labs/skills/blob/main/src/use.ts) writes a temporary prompt and can launch supported agents. | The product boundary does not execute uploaded instructions, hooks, scripts, package managers, or MCP servers. | If requested, add non-executing authorized export only. Agent launch requires a separate threat model and explicit approval. |

The upstream source review therefore changes the future roadmap, not the
current security boundary. The cloud catalog must be able to represent the
upstream source types and agent ecosystem accurately, but catalog coverage does
not imply that Private Skills supports every upstream agent target or direct
source-install command today.

### Future CLI acceptance criteria

These criteria are subordinate to the current cloud catalog criteria in
`CATALOG`, `SOURCE`, `VIEW`, and `AUTH/OPS/AGENTS` above:

- `pskills find [query] [--owner <owner>] --json` consumes the authenticated
  Private Skills discovery endpoint, returns bounded sanitized rows, and never
  fetches a skills.sh URL or installs bytes directly. Selecting a result creates
  a registry-mediated operation that retains external identity and enters the
  existing authorization, scanner, digest, and transaction path.
- Source parser vectors cover supported source kinds, refs, subpaths, URL
  encoding, and rejection of credentials, traversal, unsupported schemes, and
  ambiguous fragments. The server decides whether a source is configured and
  approved; the CLI cannot override it.
- A lock check reports missing, tampered, revoked, stale, unauthorized, and
  out-of-lock files with deterministic nonzero status. Dry-run update produces
  a stable plan; restore/sync is authorized and all-or-nothing.
- A data-driven agent registry exposes stable IDs, project/global capability,
  detection state, and adapter versions. Multi-target planning completes all
  preflights before writing and preserves the existing Codex/Claude fixtures.
- `init` and `validate` reuse canonical bundle rules; source/archive fixtures
  reject traversal, unsafe paths, oversize extraction, symlinks, and executable
  package side effects. No direct source fallback is added to the Rust client.

The broad CLI items remain future roadmap work. They do not gate the current
v0.2.0 release and do not weaken the skills.sh cloud catalog's requirement for
server-side acquisition, local policy, and immutable private bytes.
