# skills.sh cloud catalog and pullthrough review

**Date:** 2026-09-10
**Status:** v0.3.0 implementation is at source head `0f9da75`. The current READY
production deployment is `dpl_E7rSQAa1cbm85fKGTgKbwE9Ats7y` with output
fingerprint
`613f05b33f43aa449e28e3a0c65821b046524e43e50a2214b96f284910023662`; the
corresponding Cloudflare build has fingerprint
`a8b82a0dadb571106cd126d98039af579e04a8d45fa787f1b9b0a9358e884b31` and 35
server files with no executable SDK references. The current source review reports 286 tests passed and two
environment-dependent skips, TypeScript, five SDK probes, Files SDK checks,
and two independent review approvals. The earlier
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
availability, current browser proof, and external Packs preview remain separate
acceptance gates.

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
- The current source review at `0f9da75` reports 286 tests passed and two
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

An administrator can configure a `skills-sh` upstream with `repositories: ["*"]`
to admit any public catalog source into an authorized namespace, or list exact
sources. This wildcard does not apply to generic GitHub upstreams. Importing a
skill still requires an explicit private name/version and current scan approval;
official status and partner audits do not grant approval.

## Decision summary

Private Skills should add a server-side `skills.sh` catalog adapter with four
separate responsibilities:

1. **Metadata discovery:** call the versioned skills.sh API only when a user
   browses or searches. Use bounded leaderboard-page traversal for complete
   catalog coverage when needed; deduplicate by the stable skills.sh `id`.
   The product need not expose a user-triggered bulk-refresh operation.
2. **Detail pullthrough:** fetch a selected skill's file snapshot from the
   detail endpoint. If `files` is `null`, resolve the public source according
   to its `sourceType` and fetch the selected source with the same bounded,
   non-executing acquisition rules already used for upstreams.
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
| Acquisition | `packages/upstreams` implements skills.sh snapshot parsing plus GitHub and well-known source resolution with bounded files, archives, paths, and local canonical digesting. | **Implemented, import evidence pending.** The safe worker primitive and identity resolver are present, but representative production pullthrough awaits the separately requested restricted-source approval and scanner-admission readback. |
| Imports/proxy | `packages/core` exposes governed `/v1/directory/import` and carries external ID/type/hash through the import job and provenance checks; existing `/v1/imports` and `/v1/proxy/resolve` remain authorization and scanner bounded. | **Partial.** A selected cloud row can enter the private import gate, but no representative GitHub/well-known import is accepted as complete yet. Do not derive a SemVer from installs, first-seen date, or a Git branch. |
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
- A skills.sh row has no upstream SemVer. Import requires an explicit private
  registry SemVer chosen by the publisher, while the external revision/hash
  remains the immutable source identity. A future ephemeral pullthrough mode
  may use an explicitly named revision identifier; it must not label it as an
  upstream release version.

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
   query/page. Respect the documented cache windows (30–60 seconds for list and
   search; five minutes for detail and curated) and record cache age. Metadata
   traversal does not fetch or store `files` for every row.
5. A user selecting a row fetches detail on demand. The adapter stores no file
   bytes in the catalog metadata cache. If the user requests import, a durable
   operation retains the selected external identity and fetch evidence while the
   worker validates and scans the complete bundle.
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
validate bundles, and emit a local source digest. The remaining work is live
representative pullthrough and admission evidence; an administrator must still
authorize the source policy rather than allowing an arbitrary direct fetch.

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

This path must use no upstream credentials. It is public source acquisition
with the same SSRF, redirect, timeout, and bundle validation boundary as other
upstreams.

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
show the source resolution state, and expose “Request private import” only when
the source can be resolved or the user can provide an approved fallback. Import
must return an operation ID and show pending/quarantined/scan-error outcomes;
it must never redirect a reader directly to upstream bytes as a substitute for
registry approval. A Pack card only previews its manifest and external link in
the current delivery; batch migration is a later milestone.

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

### SOURCE — exact pullthrough mapping

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
- **SRC-4 private admission:** an explicit import preserves external ID,
  provider, source URL, source path/index, source revision/hash, local artifact
  digest, fetch time, and scanner IDs. The operation is idempotent for the same
  external identity and local version; a changed source cannot replace an
  existing immutable private release. Required scanner failure, incomplete
  coverage, or stale evidence remains fail-closed.
- **SRC-5 version separation:** import UI/API requires a private SemVer or an
  explicitly designed future revision identifier. Tests prove that installs,
  first-seen time, display name, and mutable branch names cannot become a
  claimed upstream SemVer.

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
- **OPS-3 no mass mirror:** a complete metadata enumeration of a fixture with
  at least 1,000 rows causes zero artifact writes and only bounded metadata
  storage. Selecting one row causes one detail/source fetch and at most one
  private import operation, with repeat selection joining the same operation.
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
readback (subject to the separately requested restricted-source approval),
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
upstream, path, registry name, and version. That rule remains in force for
cloud imports.

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
