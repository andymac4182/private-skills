# Completion criteria

These criteria turn [`roadmap.md`](roadmap.md) into checkable milestones. A
future feature is not complete because a route, CLI command, or design mockup
exists; the listed behavior and evidence must pass. G0 records the original
shipment gates; C1 records the explicitly requested catalog follow-up. Both
must be satisfied before the complete current goal can be marked achieved.
M1–M5 remain later product work. M6 editor/reviewer and M7 OpenClaw feed
interoperability are active implementation milestones selected for current
product work, but they remain separate from the G0/C1 release gates until
their own criteria and evidence pass. They do not silently expand the current
release checklist.

The latest source, portability, and deployment status is recorded in
[`verification-current.md`](verification-current.md). The current verified
delivery checkpoint is merged main source
`57bce92403af37e8303c654d7a03da634c63445f`, containing PR40 merge `8ed18be`,
PR39 merge `3e000aa`, and PR41 merge `57bce92`. Fresh root-coordinated Vercel
API evidence maps that exact source to READY Git-triggered production
deployments for the registry (`dpl_3gsnBMSPpdvpFdpJdcUwrD8aDVcy`), builder
(`dpl_6qo7B4evMTgxDg6Zt76LXQuXZcuy`), and upload-reviewer
(`dpl_CNTXXWDfppG7D8ZKuYVhVnhzmuhU`). The earlier `878c636` cascade remains a
historical checkpoint. Historical PR36 and PR34 records retain their original
source and read-only limits below.

Native CI was waived by explicit repository-owner instruction on 13 September
2026 for this delivery/review scope. Workflows remain enabled, the captured
provider billing/payment or spending-limit admission prevented runner steps, and
no native target pass is claimed. Seven reviewed nonsecret OpenClaw production
settings are active; the sanitized [settings-stage record](evidence/openclaw-production-settings-staged-20260910.json)
retains names and exit codes only. Active settings establish runtime
configuration but do not prove feed import or publication, and M7 remains
incomplete.

The published v0.2.0 CLI package lacks feed, directory, and current pullthrough
support. v0.3 packaging is in progress; no v0.3 publication is claimed.

The isolated hosted-edge proof from source `c7a0f03` passed through a temporary
Cloudflare Worker and Node gateway with required scanning, private storage,
semantic search, authentication negatives, revocation, and cleanup. Its
detailed record is maintained by the edge-proof workstream and will be linked
after that workstream's approved merge; it is a separate acceptance record and
does not replace release gates. M6 remains incomplete: terminal-session restart
PR39 (`0f71d4`) shipped in the verified `57bce924` checkpoint with its
browser-passed final UI guard; draft-resume and accessibility changes remain
pending. A new live Eve proposal is verified, while its apply, review, scan, and
publication steps remain pending. C1 telemetry/parser work is in progress;
physical GitHub/well-known source pullthrough remains open. No publication is
claimed.

The default daily reviewer schedule `0 22 * * *` UTC is temporarily replaced by
the dated `0 0 13 9 *` UTC schedule for the `00:00–01:05` UTC 13 September 2026
proof window. The short dated probe was inconclusive and the fuller proof is
being prepared. The earlier run is deployment-scoped temporal correlation until
an explicit scheduler/session identifier is captured. The
earlier PR32 activation and PR30 release-file records retain their own
source/deployment provenance below.

## G0 — v0.2.0 shipment

Close the remaining gates in [`verification-v0.2.0.md`](verification-v0.2.0.md):

- **verified:** the accepted Neon integration is provisioned and connected, and
  the main registry has a production database, private object storage, and
  configured secrets, as recorded in the current verification record;
- **verified:** a push of main commit `7c7a33e` produced READY deployment
  `dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH`. The sanitized [Git-main deployment
  evidence](evidence/production-git-main-deployment-dpl_AHgRgwcbEC2dzSBiw3aBf8GQAKVH.json)
  records the connected `andymac4182/private-skills` project, seven
  authenticated readback successes, the expected unauthenticated Topics 401,
  and zero registry writes;
- **verified for the recorded read-only release-file slice:** PR30 main commit
  `0f7b3f064fdfbdf30e71bd72fef80a3385fc5426` produced READY Git deployment
  `dpl_39j65TecJNinwh9o1Y5Y1PALvnR3`. The sanitized [M6 release-file evidence](evidence/production-m6-readonly-dpl_39j65TecJNinwh9o1Y5Y1PALvnR3.json)
  records authenticated manifest and selected text-file reads, digest
  verification, expected OpenClaw-disabled responses, unauthenticated 401, and
  zero private-registry writes. It does not replace the broader M6 browser
  editor/reviewer/builder acceptance or earlier browser-fixture provenance;
- **verified for the recorded fixtures:** the production-built registry passes
  an authenticated publish → required SkillsGuard scan → approval → semantic
  search → Rust CLI install/verify → analytics/review flow at its real URL;
- **verified for the recorded failure check:** the production worker/hosting
  boundary proves required scanner failures are fail-closed and does not expose
  artifact bytes, credentials, or reports;
- **recorded local Compose support:** the latest source-34e4f56 [reproducibility
  proof](evidence/local-compose-required-scan-34e4f56.json) records matching
  frozen-lockfile installs for the isolated host WorkerRunner and API image, a
  local PostgreSQL 17.6/Files SDK filesystem stack with SkillsGuard 1.1.1
  required, `allowUnscanned=false`, 2/2 files analyzed, approval, and a
  digest-matched 367-byte authorized transfer. It is loopback HTTP with an
  HTTPS-shaped local origin and is separate from the isolated hosted-edge
  acceptance record; it does not close provider, semantic-search, or native CI
  gates. The earlier 62c4a58 record remains historical in the current
  verification record;
- **E7 source review reported green:** source head `0f9da75` has 286 tests
  passed and two environment-dependent skips; TypeScript, five SDK probes,
  Files SDK checks, and the Cloudflare build pass, and two independent reviews
  approve. The private v0.2.0 archives/checksums and clean-consumer verification
  are complete in [`verification-v0.2.0.md`](verification-v0.2.0.md) and the
  retained [release evidence](../work/release-verification-v0.2.0-4E13vA/);
  the published v0.2.0 CLI package lacks feed, directory, and current
  pullthrough support; v0.3 packaging is in progress, and no v0.3 publication
  is claimed.
- **verified for the local rehearsal:** the recovery test resolves the original
  digest and preserves revocation, authorization, and tenant boundaries;
- **verified for the bounded hosted logical restore:** the sanitized [restore
  evidence](evidence/hosted-restore-20260910.json) records a PostgreSQL MVCC
  capture at source revision 114, five referenced objects totaling 10,381 bytes,
  an isolated target restored at revision 114, five target objects with exact
  digest/size readback, and post-restore disconnection and cleanup. The copy
  window records operator-quiescence attestation; this proof does not claim a
  provider lifecycle guarantee, a temporary restored-origin health/scanner run,
  or native CI.

The committed read-only PostgreSQL snapshot adapter's earlier revision-83 probe
is historical evidence that returned metadata/counts only. The later [hosted
logical-restore evidence](evidence/hosted-restore-20260910.json) closes the
bounded G0 database/object restore scope with exact MVCC and immutable blob-byte
hash checks. Its deletion/lifecycle record is an operator-quiescence attestation
rather than a provider availability guarantee; a temporary restored-origin
health/scanner run and native CI remain outside this proof. The optional
unfenced mode is not implemented and its mandatory-fence relaxation remains
separately approval-pending.

The historical Eve run used the default `0 22 * * *` UTC schedule (22:00 UTC,
subject to the hosting execution window) and has a sanitized production
[cron evidence record](../work/reviewer-cron-completion-evidence.json) for
deployment `dpl_4Jnh9PZj3YcXxGb59aRGFTXo3Q3e`. The cron path was observed at
2026-09-09 22:46:40 UTC; authoritative workflow analytics show the primary
`workflowEntry` and `turnWorkflow` runs completed, while
`sessionTimeoutWorkflow` was cancelled. Creation followed the observation by
2.067 seconds and completion by 14.353 seconds. This supports scheduled
execution within the deployment, but no explicit opaque scheduler/session
correlation was retained, and no proposal/prompt/report/event payload was
retained; it is not evidence of a new reviewer proposal.

No P1, P2, or P3 criterion below is a prerequisite for G0.

## C1 — skills.sh cloud catalog and pullthrough (current follow-up delivery)

C1 is the explicitly requested current follow-up delivery, sequenced after G0
in the roadmap but independently verifiable. It is intentionally separate
from the v0.2.0 launch gate above and does not retroactively make public-catalog
parity a prerequisite for shipping v0.2.0. The design,
limitations, and primary source links are in [`skills-sh.md`](skills-sh.md).
The criteria below are the acceptance contract for the current follow-up
delivery; implementation and production verification may proceed independently
of the completed bounded G0 hosted logical-restore scope.

C1 telemetry/parser work is in progress. Physical GitHub and well-known source
pullthrough, direct warm-path instrumentation, and tenant/secrecy acceptance
remain open. The current delivery's native CI waiver and deployment status are
recorded in [`verification-current.md`](verification-current.md).

Dependencies: an authenticated skills.sh gateway contract that works on the
selected Nitro deployment, a versioned external identity model, and a
server-side source resolver that can hand complete bytes to the existing
validation/scanner worker. The tenant feed registry supports multiple named
feeds, with one adapter/origin/credential/restriction configuration per feed;
the current feed kind is `skills-sh`. Per-repository mappings and manual aliases
are not dependencies. An administrator may add source restrictions or explicit
proxy mappings as an optional tightening policy. The C1 deployment may be
verified independently of the completed bounded G0 hosted logical-restore
scope.
The configured feed base must be the canonical skills.sh origin or an
operator-trusted gateway listed in `trustedSkillsShBaseUrls`; a caller-supplied
`credentialEnv` is rejected. An omitted feed auto-selects only when exactly one
enabled feed exists; with multiple enabled feeds the caller must select one
explicitly. Explicit feed selection still passes tenant, enabled, origin, and
policy checks before catalog access.
The owner authorized server-side forwarding of the Vercel project OIDC token to
skills.sh on 2026-09-10. The earlier guarded prebuilt rollout was
`dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE`, from merged main
`fecd6baa1411c2f3c2ad60b13c2c0e37761d2826` with artifact source
`b1d3b6d77162899491f742e2930abe0b36137d8e`. Its sanitized [rollout evidence](evidence/production-c1-feed-rollout-dpl_8ruEP3uXzmGwqAXpxjQD8d3yZbHE.json)
records 18 authenticated GETs, two unauthenticated negative GETs, one
metadata-only Pack preview POST, zero private-registry data mutations (no
feed, import, scan, install, role, or policy writes), fail-closed policy, and
path-only detail. It does not claim a feed, import, scan, or CLI install.

The prior `dpl_E7XXwDmCmduXKsdRKCMnMzkrYcd1` evidence records one quarantined
`find-skills` import with 30 high findings, including CI-004 command injection,
and no install override. Its corrected same-root CLI record proves unchanged
digests and one `upToDateChecks` increment. These are partial, deployment-
specific C1 evidence; they do not prove positive scanner-to-warm admission.
Local multi-feed and edge fixtures are recorded in
[`verification-current.md`](verification-current.md), with `allowUnscanned`
and provider limits preserved.

The production Pack preview returns schema `0.1.0`, three members, metadata-only
output, and unauthenticated 401. The browser manifest for its Pack replay
explicitly names the prior E7 route proof, while its Pack replay crossed a
stable-alias cutover and has unknown exact deployment attribution. Pack-preview
UI proof is complete. Full C1 still requires positive scanner-to-warm admission
and the remaining source, tenant, and provider checks.

Earlier evidence closes the bounded metadata-enumeration portion: 20 all-time
pages at `per_page=500` returned `totalDeclared=9738`, `totalObserved=9738`,
and `uniqueIds=9738`, with no duplicate rows/IDs or artifact writes. The
earlier OIDC/endpoint/ComputeSDK evidence and the current nested-route probe
are recorded with their own deployment provenance in [`verification-v0.3.0.md`](verification-v0.3.0.md).
Representative GitHub/well-known pullthrough, scanner admission, warm-cache,
and concurrent-deduplication evidence remains pending; a conditionally
approved isolated CLI folder is not import acceptance evidence. Optional source
restrictions must not become a prerequisite for the default catalog path.

The prior production [snapshot candidate record](evidence/production-candidate-web-design-guidelines-pullthrough-dpl_CpAApe78RJs3oXuuk4iPzbtdnczb.json)
closes the snapshot-admission slice for
`vercel-labs/agent-skills/web-design-guidelines`: the existing feed and
fail-closed policy were read back, one cold operation reached approved after
required SkillGuard evidence, and an isolated original-external-ID CLI install
and same-root repeat produced the expected analytics delta. Its server
reference remains `@snapshot/skills-sh/<externalId>`. The one warm request was
HTTP 200 with no new import operation, while its body-shape assertion was
preserved as `responseValidated:false` after a verifier mismatch; this record
does not claim direct zero-upstream instrumentation. The companion
[negative record](evidence/production-candidate-web-design-guidelines-negative-dpl_CpAApe78RJs3oXuuk4iPzbtdnczb.json)
proves unauthenticated and unknown-feed rejection. The prior `find-skills`
quarantine remains separate negative evidence.

Completion requires all of the following:

1. **C1-API — versioned discovery contract.** The server adapter uses the
   documented `/api/v1/skills` list endpoint for All/Trending/Hot,
   `/api/v1/skills/search` for bounded search, `/api/v1/skills/curated` for
   Official, `/api/v1/skills/{source}/{skill}` for detail, and
   `/api/v1/skills/audit/{source}/{skill}` for external audits. Fixtures cover
   `data`, pagination, search metadata, curated groups, detail `files`/`hash`,
   and audit entries. The upstream CLI's legacy `/api/search` shape is
   compatibility-only and cannot silently become the cloud contract.
2. **C1-PAGE — complete metadata coverage without mirroring.** The bounded
   pagination adapter can enumerate list pages from zero until `hasMore=false`
   for coverage verification or an on-demand catalog slice, uses the complete
   external `source/slug` ID as its coverage key, records duplicate rows/IDs,
   and deduplicates the unique coverage count without silently dropping a
   listing. A fixture of at least three pages, a duplicate row, a `files: null`
   row, and a well-known row completes without a silent drop.
   Normal browse/search fetches only requested pages/results; no user-triggered
   “refresh all” operation is required, and no artifact bytes or private blob
   writes occur until a user selects an import.
3. **C1-CACHE — limits and failure behavior.** Search rejects queries shorter
   than two characters and respects the documented 1–200 result bound; list
   requests respect `per_page` 1–500. Cache age, endpoint/query key, response
   status, and byte budget are observable. List/search and detail/curated use
   bounded TTLs no longer than the documented windows unless an operator
   chooses a shorter value. `401`, `404`, malformed response, `429` with
   `Retry-After`, `503`, timeout, and credential absence become explicit
   retryable/unavailable states with bounded backoff.
4. **C1-AUTH — portable server-side authentication.** A Vercel deployment uses
   the authorized request-scoped project OIDC token for skills.sh as documented;
   a non-Vercel deployment uses an explicitly configured supported
   gateway/credential provider. Browser requests never contain the upstream
   bearer credential. If no supported credential is configured, the cloud view
   reports unavailable and does not assume anonymous API access. Acceptance
   requires sanitized deployment evidence that the token is obtained and
   accepted by skills.sh, plus a negative check proving it is not exposed to
   browser responses or logs; source-level wiring or owner authorization alone
   is insufficient.
5. **C1-ID — external identity and version separation.** Every row preserves
   feed name, provider, complete stable ID, source, slug, name, source type, install URL,
   skills.sh page URL, install count, duplicate flag, and fetch time. Detail
   route construction validates parsed source/slug segments and rejects path
   traversal. The skills.sh hash is retained as an external snapshot hash;
   Private Skills computes and stores its own canonical artifact digest. No
   install count, branch name, or first-seen date is presented as an upstream
   SemVer; the server owns the verified provenance source reference,
   collision-resistant
   internal release reference, and immutable resolved revision, so a reader does
   not supply a manual alias, private name/version, or source mapping merely to
   install a catalog row. A verified GitHub reference is derived from
   `@github/owner/repo/<exact-skill-directory>`, a verified well-known reference
   from `@web/<authority>/<scope>/<entry>`, and snapshot-only metadata uses
   `@snapshot/skills-sh/<externalId>` without inventing a physical path.
   Current-head fixtures accept the valid nested ID
   `claude-office-skills/skills/facebook/meta-ads` and reject traversal,
   encoded-delimiter, and excessive-depth variants. The live upstream probe
   returned 400 `invalid_path` for direct/full-ID encoding, 200 with the wrong
   identity for one-slug-segment encoding, and 404 for double encoding; the
   current production nested probe returned 503 for detail/audit. This is an
   upstream compatibility/availability limitation, and does not count as a
   successful detail or import.
6. **C1-FEED — feed selection and isolation.** A tenant can configure at least
   two named feeds using the current `skills-sh` kind, with one
   adapter/origin/credential/restriction configuration and feed membership,
   provenance, and ACL context per feed. `GET /v1/feeds` returns readable
   id/name/kind/enabled/configured-prefix metadata without making that prefix
   the canonical source identity. The selected feed and complete source
   ID remain separate fields in provenance, and sharing a verified canonical
   source identity never shares an ACL grant. An artifact cache may be reused
   only after verified origin/repository/exact-path or well-known scoped
   identity, revision/digest, and current tenant policy checks; the external ID
   alone is not a cache key. Unknown or disabled feeds and cross-feed
   authorization guesses fail before catalog access or outbound fetch. A valid
   configured feed needs no per-repository mapping or manual alias. The
   source-derived reference and managed namespace policy remain separate from
   feed membership. Additional feed adapter kinds are future work; OpenClaw
   feed interoperability remains M7.
7. **C1-GITHUB — exact public GitHub source resolution.** For a GitHub row whose detail
   has no snapshot, a fixture resolves owner/repository, default or requested
   ref, immutable commit, recursive tree, exact `SKILL.md` path, selected tree
   SHA, and frontmatter identity. Multiple matching paths, changed source,
   truncated tree, missing frontmatter, or identity mismatch produce an
   explicit unresolved/changed/rejected state and cannot import another skill
   by display-name coincidence. This built-in resolver works without a
   per-repository mapping; an optional tenant administrator policy may narrow
   the permitted sources.
8. **C1-WELLKNOWN — well-known source compatibility.** Fixtures cover the
   official discovery v0.2 schema and legacy v0.1, preferred
   `/.well-known/agent-skills/index.json` and legacy
   `/.well-known/skills/index.json`, relative artifact URLs, supplied digest,
   bounded archive extraction, unsafe paths, unknown schema, and a scoped path.
   A scoped request never falls back to the host root catalog. SSRF, redirect,
   timeout, path, file-count, per-file, response, and expanded-size limits are
   enforced before bytes are retained; no source credential is forwarded. The
   default path does not require a custom well-known or per-repository mapping.
9. **C1-IMPORT — automatic transparent pullthrough.** The canonical resolve
   request is `POST /v1/proxy/resolve` with `{ feed?, externalId, refresh? }`, where
   `externalId` is the complete source ID or an exact supported skills.sh URL.
   An omitted `feed` auto-selects only when exactly one enabled feed exists;
   with multiple enabled feeds the caller must select one explicitly. A bare
   ID/URL is a convenience input; the CLI passes the original URL with
   `--feed` where needed. The response contains `{ feed, externalId, reference, operation |
   resolution }`; a `202` operation may omit `reference`, while a `200`
   resolution includes the verified source reference, and both echo the original
   ID and selected feed. The caller does
   not supply `name`, `version`, or `upstreamId`; the server owns its
   collision-resistant internal ID and immutable revision, including when the
   source reports `files: null` or no hash. A cold first install creates or
   joins one durable operation, fetches complete bytes, validates them, runs
   all required scanner/policy gates, and caches only the approved immutable
   release. A warm install uses an approved cache entry whose verified
   canonical source/revision matches the selected feed policy, without an
   upstream lookup after a fresh reader install authorization plus explicit
   `proxy:resolve` permission. Concurrent cold
   requests for one tenant, feed, external identity, and resolved revision join
   one operation and produce one source fetch, scan set, and sealed artifact;
   sharing that canonical source does not share an ACL grant.
   `refresh: true` or update rechecks upstream and reports failure rather than
   treating an older cache entry as freshly verified. A remote skills.sh audit
   `pass`/“Safe” never satisfies a required Private Skills scanner; missing,
   stale, incomplete, blocked, or failed scanner evidence denies installation.
10. **C1-OFFICIAL — maker-curated view.** The curated response is normalized into
   owner groups while retaining featured repository/skill and `generatedAt`.
   The UI labels the result maker-curated; arbitrary repository ownership,
   install count, or external audit status cannot set an Official/approved
   badge.
11. **C1-TOPICS — curated taxonomy view.** The Topics view exposes the current
    official category links and can render recognized `/topic/{slug}` page
    content, including skill links and related topics, while retaining source
    URL, fetch time, and parser/schema revision. Since no documented JSON topic
    membership API exists, a changed or unparseable page is marked stale or
    unavailable; the product must not invent persistent skill-topic relations
    or claim complete membership from category counts alone.
12. **C1-PACKS — unlisted external-pack preview.** Existing private pack
    management remains tenant-scoped and immutable. The cloud Packs view
    accepts a user-supplied `https://skills.sh/p/<pack-id>` link and renders a
    metadata-only manifest preview, including the unlisted/public state, member
    labels or source links returned by the external page, and a link to the
    external page/install command. It does not claim public enumeration, fetch
    member file bytes, batch-import members, create a private pack, or imply
    Private Skills approval. Deleted/404 links report unavailable rather than
    falling back.
13. **C1-AUDITS — external evidence view.** The external Audits view is
    separate from the Private Skills administrative audit log and local scan
    results. It renders 200, 404/no-audit, partial-provider, future-provider,
    stale-timestamp, and malformed-entry fixtures generically by returned
    provider/status/risk/summary/time. Unknown providers do not break the view.
14. **C1-TENANT — authorization, reader install, and secrecy.** Public external metadata may be
   shared, but external detail caches, import operations, private catalog
   rows, pack members, scanner reports, source credentials, and transfer
   descriptors remain organization-scoped. Browser/network and audit-log
   tests prove that no skills.sh/GitHub bearer, raw private source, or
   unapproved candidate content is exposed. A reader with install permission
   and the explicit `proxy:resolve` permission can install an already approved
   warm release and can start the bounded cold pullthrough operation. The
   default reader/publisher grant for `proxy:resolve` remains pending explicit
   product approval and production verification; owners/admins may exercise the
   route where their current grants allow it. Readers cannot change tenant source restrictions,
   scanner policy, publication state, or aliases. Publisher/admin permissions
   are required for those mutations, and every transfer still receives an
   actor-bound authorization.
15. **C1-EVIDENCE — representative end-to-end proof.** Evidence includes the
   page/search/detail/curated/audit fixtures, multi-feed selection and
   unknown/disabled-feed fixtures, source-derived identity/provenance and
   source-reference notes, GitHub root/nested/ambiguous
   mapping fixtures, both well-known schemas, React and Marketing topic-page
   fixtures, an unlisted/deleted pack manifest-preview fixture, an existing
   private-pack management/immutability fixture, a cold first install through
   source resolution and required scanner approval, a warm install with zero
   upstream requests, concurrent cold requests proving deduplication, a
   blocked/failed scan that denies installation, `refresh: true` failure that
   does not relabel old cache as fresh, changed-source provenance, trusted-base
   and caller-credential negative checks, 202/200 reference behavior, rate
   limiting, unavailable auth, reader/publisher/admin permissions, tenant
   isolation, and a metadata enumeration proving zero artifact writes for
   unselected rows.

The broader upstream CLI parity items — `find` ergonomics, source-selector
grammar, lock check/restore/sync, multi-agent adapters, multi-skill selection,
`init`/`validate`, optional history, node-module sync, and ephemeral `use` —
remain future P1/P2 work described in [`skills-sh.md`](skills-sh.md). They do
not become C1 completion gates and must not weaken registry authorization,
scanner enforcement, immutable digests, or the prohibition on executing
uploaded instructions, scripts, hooks, or MCP servers.

## M1 — context packages, manifests, and agent bridge (P1)

Dependencies: G0, a frozen package schema, and a selected agent configuration
policy. Completion requires all of the following:

1. A versioned package manifest can describe documentation, rules, and one or
   more Agent Skills without changing the meaning or bytes of upstream
   `SKILL.md`. Canonical bytes, file manifests, artifact digests, source
   provenance, and organization authorization remain immutable and are covered
   by TypeScript/Rust compatibility vectors.
2. The package validator rejects traversal, symlinks, agent-reserved paths,
   scripts, lifecycle hooks, bundled MCP servers, and unsupported plugin
   metadata by default. Enabling any additional content class requires an
   explicit organization policy and a separate review; installation never
   executes package content.
3. A project manifest and lock record exact package identity, version/source,
   artifact/tree digests, registry origin, selected agent target, and managed
   versus vendored mode. Re-running install/sync on an unchanged checkout is
   idempotent, and `--frozen` never re-resolves or substitutes a package.
4. Local `file:` packages are validated with the same canonical bundle and
   path rules as registry packages. Dependency-driven sync is explicit,
   reports additions/removals/outdated packages, and does not silently install
   network content.
5. An agent-facing MCP or equivalent context API supports authorized search,
   status, and context retrieval. Every result is filtered by organization,
   principal, namespace, approval state, and digest; tests prove that an
   unauthorized package, stale/revoked artifact, credential, raw transfer
   grant, or unapproved candidate content (including its instructions) cannot
   leak through the bridge or bypass its approval state.
6. If a workspace MCP gateway is offered, owners/managers can register only
   allowlisted upstream endpoints, credentials are stored and used only by the
   gateway, members are authorized per workspace, and proxy use is audited and
   revocable. No upstream secret is returned to an agent or member.
7. At least two real agent adapters pass discovery tests. Setup is idempotent,
   preserves user-managed configuration, supports project and user scope, and
   removes only entries owned by Private Skills.

Evidence: contract vectors, tenant-isolation tests, clean-consumer CLI tests,
real-agent discovery checks, and an authenticated browser/CLI flow.

### FUTURE M1-MCP-DISTRIBUTION — bidirectional authenticated MCP distribution

This is a future requirement inside M1. It is not an active implementation
milestone, a new bundle count, or a G0/C1/M6/M7 release gate. Completion
requires both directions of the contract:

1. A configured source adapter consumes skills and packs from an explicitly
   registered and allowlisted MCP server using only approved discovery and
   resource-read operations. It preserves the MCP server/resource identity and
   any upstream revision and digest that the provider supplies. If the source
   omits either value, it records a clearly labeled immutable local snapshot
   with a computed canonical digest; it never invents an upstream version or
   presents the local digest as a provider digest, and never executes an
   arbitrary tool, hook, server, or skill code.
2. Source reads are bounded, on demand, and authorization checked. Changed or
   missing bytes, digest mismatches, revoked or unauthorized resources,
   cross-tenant requests, transport errors, and stale cache entries fail closed
   before pullthrough can write or refresh a candidate. Warm-cache behavior is
   tested against the exact source revision and digest.
3. Every accepted MCP source result passes the existing canonical bundle
   validator, required scanner policy, quarantine behavior, immutable artifact
   provenance, and tenant authorization. MCP source status or publisher claims
   cannot bypass local admission or revocation.
4. A separate authenticated MCP distribution surface discovers and searches
   approved skills and packs, and retrieves immutable version manifests,
   canonical file/artifact bytes, digests, and provenance. It exposes no
   unapproved candidate contents, source credentials, raw transfer grants, or
   another tenant's metadata.
5. Client-controlled install, update, and restore integrate with the existing
   Rust CLI and distribution contracts. Mutations require explicit client
   consent and scoped short-lived transfer grants; the MCP server never writes
   arbitrary client files or chooses placement. The client/CLI owns placement,
   restore, and execution boundaries, and skill content is never executed by
   the MCP service.
6. Server-side MCP source credentials remain deployment-owned and never appear
   in browser/agent responses or leak across configured feeds or tenants.
   Install receipts and bounded analytics identify the client-controlled
   operation without retaining secrets or source content.
7. Real MCP client/server compatibility fixtures pass in both directions for
   valid discovery/resource reads, immutable distribution, changed
   source/digest, revoked, unauthorized, cross-tenant, warm-cache, and
   transport-error cases. The evidence records exact source identity,
   revision, digest, scanner/quarantine result, transfer authorization, and
   no-execution behavior.

## M2 — quality review and behavioral evaluation (P2)

Dependencies: M1 package identity and an explicitly isolated evaluation
runner. Completion requires:

1. Local/package lint deterministically reports Agent Skills and package
   structure errors with stable rule IDs and machine-readable output.
2. A bounded quality review records separate, explainable validation,
   description/activation, and content dimensions plus the model/reviewer revision,
   input digest, timestamp, and policy threshold. A review is advisory until
   calibration evidence supports a blocking threshold; accepting a suggestion
   never mutates an artifact or publishes a release.
3. Scenario evaluation accepts checked-in or generated scenarios, runs at least
   three declared scenarios through both a baseline and context-enabled
   comparator, records model/harness versions and exact package digests, and
   reports per-scenario and aggregate results. A rerun with the same immutable
   inputs is reproducible within the documented nondeterminism tolerance, and
   activation is reported separately from outcome quality.
4. Evaluation execution has no registry credentials, no access to unrelated
   tenant data, no arbitrary network by default, and no execution of uploaded
   skill scripts or package hooks. Timeouts, invalid results, and missing
   coverage remain incomplete evidence and cannot silently approve a release.
5. The web/CLI surface shows comparison evidence and regression status without
   presenting an impact score as a safety guarantee. Retention, redaction, and
   deletion behavior are documented and covered by a restore test.

Evidence: lint fixtures, review calibration set, malicious/untrusted-content
fixtures, isolated runner tests, before/after scenario reports, and a failed
threshold/timeout test.

## M3 — team governance and lifecycle (P1, after the current single-org gate)

Dependencies: an identity provider/recovery decision and durable membership
storage. Completion requires:

1. Owners can create, list, archive, unarchive, and (if retained) delete a
   workspace/organization with an audited reason. Archived spaces reject new
   reads, publishes, and installs while retaining recoverable metadata.
2. Owners/managers can add, list, change, and remove members. Member,
   publisher, administrator/manager, and owner capabilities are explicit;
   removal takes effect on a fresh authorization and cannot be bypassed by a
   cached transfer or lock.
3. Every resource, search result, scan report, evaluation, transfer grant,
   audit event, and review decision remains tenant-scoped. Cross-tenant timing,
   identifier, and artifact-digest leakage tests pass.
4. A distinct archive state prevents new installations while preserving
   existing immutable releases; a short-window unpublish/rollback operation
   and revoke operation have different documented effects. All transitions are
   idempotent and audited.
5. If device/OIDC authentication is selected, interactive credentials use an
   OS keyring or an explicit headless-token path, sessions are revocable, and
   provider failure cannot fall back to a weaker identity.

Evidence: multi-user browser/CLI tests, authorization matrix, concurrent
revocation/archive tests, audit export, and recovery rehearsal.

## M4 — author CI, standards, and library context (P1/P2)

Dependencies: M1 package identity and M2's review result contract. Completion
requires all of the following:

1. A clean GitHub repository fixture can run a documented, versioned author CI
   workflow that lints a package, runs the review threshold, and publishes only
   to the configured private namespace. A below-threshold review exits nonzero,
   publishes no release, and emits machine-readable evidence; a passing run
   records the source revision, package digest, reviewer revision, and scoped
   identity. The workflow is pinned or otherwise integrity-verifiable.
2. Quality and install policies have versioned schemas and explicit
   organization/workspace inheritance: a workspace may tighten an inherited
   requirement but cannot weaken it. Review thresholds, scanner/security gates,
   source allowlists, release-age restrictions, exceptions, expiry, approver,
   audit event, and fail-closed behavior are each covered by a passing and
   failing fixture.
3. A library-context resource records a stable PURL/package identity, version,
   source, license, provenance digest, and organization authorization. An
   authorized client can retrieve exact documentation by identity and version;
   an unauthorized, stale, revoked, or unverified source is rejected. Ingest
   does not execute package content, follows an explicit source allowlist, and
   records deletion/retention behavior.

Evidence: a clean-repository CI run with pass/fail threshold fixtures, policy
inheritance and exception matrix, signed or integrity-checked workflow/config
inputs, and a PURL/versioned documentation fixture with authorization and
revocation tests.

## M5 — organization-wide visibility and automation (P3 discovery)

This milestone depends on an approved Private Skills data, consent, retention,
and disable contract and threat model. The design review must first define
event schema, consent, redaction, retention, tenant ownership, deletion, and
external network destinations for each capability. Tessl's public claims and
documentation inform discovery; they do not substitute for our product
contract.

- Activation observability must distinguish published, installed, selected,
  and actually activated context without collecting raw prompts or repository
  content by default.
- GitHub inventory must use an allowlisted installation, record source/revision
  provenance, identify duplicates without cross-tenant disclosure, and handle
  unmanaged copies and repository removal.
- Required-skill/install/publish policies must identify the enforcement point,
  exception scope, expiry, approver, and failure behavior.
- Any autonomous operations agent must have a separate tool allowlist, scoped
  credentials, bounded sessions, human approval for mutations, and a hard
  prohibition on candidate execution or privilege escalation.

Completion requires an approved threat model, an opt-in pilot, a clean disable
path, and evidence that disabling the capability removes collection without
breaking registry distribution.

### COMMITTED FUTURE M5-SKILL-FEEDBACK — structured skill feedback

This is a committed later requirement inside M5. It is future-only, not an
active implementation milestone, a new current feature area, or a G0/C1/M6/M7
release gate. It cross-links the future M1 MCP client/distribution contract and
M2 quality review while keeping feedback separate from verified quality,
scanner, and install outcomes. Completion requires:

1. Authenticated CLI and MCP clients can submit a structured report classified
   as worked well, did not work well, broken, or improvement, bound to the
   canonical skill/source/version and artifact digest. The report may include
   optional agent, client, and platform metadata, a concise summary,
   expected-versus-actual outcome, and a bounded reproduction or evidence
   reference.
2. Submission is tenant- and principal-scoped, requires the applicable
   feedback permission, and enforces request, field, evidence, and rate bounds.
   An idempotency key and canonical request identity preserve one report across
   duplicate submissions, offline retries, and response loss without merging
   reports from different versions or tenants.
3. Feedback is an untrusted observation. It never becomes a scanner verdict,
   quality score, approval, release candidate, install authorization, or
   provenance assertion; exact version/digest binding is rechecked on write and
   read, and revoked or unauthorized resources cannot accept or reveal reports.
4. Default collection excludes secrets, raw prompts, repository content,
   credentials, and unrestricted logs. Optional diagnostics require explicit
   configured consent, are redacted and bounded before persistence, and are
   never forwarded automatically to an upstream vendor or model provider.
5. Skill detail exposes safe feedback list, filter, triage, and status views,
   with tenant/permission checks and bounded rendering. An Eve summary or
   pattern finder is advisory only; feedback cannot autopublish, edit, revoke,
   or otherwise mutate a skill, release, draft, or scanner decision.
6. Real CLI and MCP acceptance fixtures cover valid submissions, exact
   version/digest binding, changed or revoked versions, cross-tenant denial,
   unauthorized reads, duplicate and offline-retry preservation, idempotency
   conflicts, rate/size limits, diagnostic redaction and consent, and safe UI
   rendering. Reported outcomes are measured and displayed separately from
   install-receipt analytics.

Evidence: authenticated CLI/MCP write/read fixtures, tenant and authorization
matrix, retry/deduplication record, redaction/consent proof, safe browser
rendering, and a review showing that no feedback path can trigger publication,
editing, revocation, scanner bypass, or automatic vendor forwarding.

## M6 — full Diffs editor and upload/edit review (active implementation, incomplete; VIEW slice evidence delivered)

M6 is the editor and upload/edit reviewer requested for the Private Skills web
application. The editor and authoring API/source are shipped, and upload-review
configuration is enabled in the current deployment. The local synthetic
editor/browser fixture passes its bounded desktop/mobile checks, while hosted UI
acceptance, live Eve/model execution, and screenreader, contrast, and
reduced-motion evidence remain pending. Terminal-session restart PR39 (`0f71d4`)
shipped in the verified `57bce924` checkpoint with its browser-passed final UI
guard; draft-resume and accessibility changes remain pending. A new live Eve
proposal is verified, while its apply, review, scan, and publication steps
remain pending. Its read-only release-file VIEW
slice has delivered production GET evidence for manifest, selected text-file
retrieval, digest verification, and unauthenticated rejection; the full
composed editor, durable draft, upload/edit review, and builder evidence
criteria remain active and incomplete. It is not a G0 or C1 release
prerequisite. The concise API/type and ownership sketch is in
[`m6-authoring-contract.md`](m6-authoring-contract.md). The official
[Diffs home](https://diffs.com/) and [edit page](https://diffs.com/edit)
confirm an open source `@pierre/diffs` renderer and beta in-place edit mode;
the [official package source](https://github.com/pierrecomputer/pierre) and
[documentation](https://diffs.com/docs) do not provide our upload, auth,
tenant, persistence, release, scanner, or review service. The docs describe
retained edit state as bounded and in memory. The file tree is a separate
`@pierre/trees` package ([official README](https://raw.githubusercontent.com/pierrecomputer/pierre/main/packages/trees/README.md)).
These gates therefore distinguish Diffs UI primitives from orchestration that
Private Skills must own.

Dependencies: the existing authenticated web/API boundary, canonical bundle
validator, Files SDK/state repositories, scanner worker and policy; a pinned
and reviewed Diffs/Trees dependency recorded in the package manifest/lock and
primary release metadata; and a versioned draft/review result
contract with an explicit AI Gateway configuration. M6 may reuse M2 review
fields, but it has its own upload/edit queue and authorization boundary. The
existing daily common-skill consolidation Eve remains a separate agent and
workflow.

Completion requires all of the following:

1. **M6-EDITOR — full editor surface.** An authorized publisher/owner can open
   a private skill draft in the web UI, render a canonical file tree, select a
   file, edit it with the pinned `@pierre/diffs` edit integration, and switch
   between file and unified/split diff views. A fixture with at least 100
   paths, nested directories, and long lines retains correct selection,
   syntax highlighting, and file/diff identity while scrolling. The UI has a
   read-only fallback/error state if the beta editor cannot load; a dependency
   demo alone is not acceptance.
2. **M6-DRAFT — durable private drafts.** Starting from a new upload or an
   existing immutable release creates a tenant-scoped draft with a base release
   ID, monotonic draft revision, canonical content digest, file manifest, and
   actor/time audit record. Editing at least three files, leaving the page, and
   reloading restores the same draft revision and bytes. Concurrent edits
   produce an explicit conflict/rebase choice; last-writer-wins cannot silently
   discard a draft. Saving a draft never mutates a published release.
3. **M6-TREE-DIFF — inspectable changes.** The file tree and editor stay in
   sync by canonical relative path. The diff shows additions, deletions, and
   changes with stable path/line anchors; line annotations can display a
   finding or review note without executing its text. Accept/reject controls
   apply only an explicitly selected draft change and are auditable. Path
   traversal, duplicate normalized paths, symlinks, and unsupported files are
   rejected before rendering or persistence.
4. **M6-RELEASE — immutable new release.** An explicit author action creates
   a new private release from the accepted draft, computes the server-side
   canonical bundle digest, and records base release, draft revision, source,
   actor, and scanner/reviewer provenance. Required scanner evidence and the
   current policy must pass before the release is installable or publishable.
   The prior release remains byte- and metadata-identical; every retry is
   idempotent. No editor save or Eve result automatically publishes, merges,
   installs, or replaces a release.
5. **M6-UPLOAD-EVE — separate reviewer identity and queue.** Upload/edit Eve
   is a distinct agent deployment or service identity from the daily
   common-skill consolidation Eve, with separate route token, tool allowlist,
   queue/idempotency key, durable state, and model/reviewer configuration. It
   may use the configured AI Gateway provider/model and server-side credential
   boundary but must not share the daily Eve's mutation authority or candidate
   state. Upload completion and each saved draft revision can enqueue one
   idempotent review, and the editor can show that review's current status.
   A queued review receives only an authorized tenant snapshot and records job
   ID, draft ID/revision, exact content digest, base release, model/reviewer
   revision, policy revision, timestamps, and bounded status (`pending`,
   `running`, `passed`, `failed`, or `stale`). It never receives registry
   credentials or arbitrary network tools.
6. **M6-REVIEW — exact, asynchronous, actionable findings.** Review results
   are persisted independently of the browser and are bound to the exact
   draft/content digest and revision that was reviewed. While the author is
   editing, the editor side panel exposes pending, running, completed, failed,
   and stale states plus finding severity, path/line location where available,
   evidence summary, reviewer/model provenance, and human actions such as
   acknowledge, dismiss-with-reason, or request-rerun. Each action is
   tenant-scoped and audited and cannot rewrite the artifact.
   Changing bytes or draft revision, discarding the draft, revoking the base,
   changing scanner policy, or changing the reviewer contract marks the old
   result stale. A stale, missing, failed, or partial review cannot authorize
   publication or installation.
7. **M6-POLICY — scanner authority and no autonomous mutation.** The existing
   scanner policy remains authoritative for release admission. An Eve finding
   is advisory evidence unless a separately versioned product policy explicitly
   defines a review gate; even then, Eve cannot override a required scanner,
   policy revision, authorization check, or digest mismatch. The reviewer and
   editor have no ability to execute uploaded instructions, scripts, hooks,
   MCP servers, or package managers, and cannot publish, merge, install, or
   change policy without an explicitly authorized human/API action.
8. **M6-AUTH — tenant and role isolation.** Every draft, file read/write,
   review job/result, finding action, release transition, and audit event is
   checked against organization, namespace, principal, and role. Publishers
   can edit only permitted namespaces; readers are read-only; the reviewer
   service can read only the leased snapshot and write only its result. Guessing
   another tenant's draft or review ID returns an authorization-safe response
   and no content, digest, source, finding, or timing oracle. Browser bundles
   contain no upstream, scanner, storage, or AI Gateway secret.
9. **M6-SAFETY — hostile content boundary.** Uploads and review text are
   treated as untrusted data, including prompt-injection instructions and
   malicious markup. Archive/file/byte limits, safe-path and content-type
   validation, HTML/script escaping, bounded annotations, and origin/CSRF
   checks run before storage or display. Review and scanner work uses the
   existing isolated worker boundary with no candidate execution, source
   credential forwarding, arbitrary network, or cross-tenant access. Tests
   cover traversal, symlink, oversized, binary, HTML/script, prompt-injection,
   malformed, and concurrent-update fixtures.
10. **M6-A11Y — usable editor and review actions.** Keyboard-only users can
    open/search the tree, move focus into and out of the editor, select a file,
    inspect a diff, reach findings, and activate every action without a mouse.
    Tree rows, editor regions, diff controls, annotations, live review status,
    errors, and stale states have semantic roles, accessible names, focus
    visibility, and screen-reader announcements. Contrast, zoom/reflow,
    reduced-motion, and text alternatives pass at 390px and 1280px widths with
    no unintended horizontal overflow.
11. **M6-EVIDENCE — end-to-end proof.** A clean authenticated browser/API
    fixture proves upload → draft → reload → edit → diff → queued
    upload/edit review → persisted findings → stale invalidation →
    human action → required scanner decision → explicit immutable new
    release. Evidence includes dependency/version provenance, editor-load
    fallback, file-tree and diff fixtures, conflict/retry/idempotency,
    tenant isolation, hostile-content rejection, required-scanner failure,
    and the narrow/desktop accessibility checks. Daily consolidation Eve's
    existing flow remains a separately evidenced path.

12. **M6-VIEW — read-only release file view (delivered slice; full gate remains).** The
    recorded production [read-only evidence](evidence/production-m6-readonly-dpl_39j65TecJNinwh9o1Y5Y1PALvnR3.json)
    for main `0f7b3f064fdfbdf30e71bd72fef80a3385fc5426` proves authenticated
    health/principal/policy, approved-release metadata, a metadata-only
    paths-only manifest, selected `SKILL.md` retrieval with matching digest,
    expected OpenClaw-disabled responses, and unauthenticated release-file `401`,
    with zero private-registry writes. It is a production HTTP/API check,
    separate from the earlier browser Pack-preview fixture whose exact
    deployment attribution remains recorded independently. The remaining full
    gate is that an authorized
    reader can select an immutable release/version and see that release's
    server-returned canonical digest, file manifest/tree, and the full content
    of every allowed text/supporting file through the pinned `@pierre/diffs`
    read-only view. Retrieval is authorized per tenant, namespace, principal,
    and selected release; guessing a file, version, or digest from another
    tenant returns a safe error and no content. Binary, unsupported, and
    over-size files are represented by explicit bounded metadata/preview states
    and are never truncated into misleading text. The view never runs file
    contents, creates a draft, or changes the immutable release. A fixture
    proves at least one nested multi-file release, a binary/over-size file, a
    selected-version change, digest readback, unauthorized file/version access,
    and no browser exposure of storage or scanner credentials.

13. **M6-EDIT — explicit draft edit workflow.** Editing is a distinct
    authenticated action and route from the read-only release view. An
    authorized publisher explicitly starts an editable, tenant-scoped draft
    based on a selected immutable release/version/digest; opening or viewing a
    release alone cannot create one. The draft records its base release and
    monotonic revision, and saving at least three file changes followed by a
    page reload restores the same revision and bytes. The Diffs view compares
    the draft against the immutable base with stable path/line identity.
    Concurrent or stale-base writes produce an explicit conflict/rebase result,
    never silent last-writer-wins. A separate author action starts the required
    scanner and publication transition; save, preview, or reviewer output never
    publishes, merges, installs, or mutates the base release automatically.
    The route has explicit unauthorized, missing, stale, and rejected states,
    and its evidence proves the draft digest, base digest, scan decision, and
    immutable-release preservation end to end.

14. **M6-BUILDER — interactive authoring builder Eve.** An authorized
    publisher can start a builder conversation for a blank/validated
    upload-origin draft when that origin is enabled, or for a draft based on an
    existing immutable release. The conversation is durable and bound to the
    organization, draft, base release/digest, exact current draft
    revision/digest, Gateway/model, builder/tool revision, and bounded file and
    model-context limits. It is a separate workflow and service/tool identity
    from daily consolidation Eve and upload/edit reviewer Eve.

    Each builder turn receives only the authorized manifest and bounded text
    content from that exact revision. It can suggest `add`, `edit`, `rename`,
    and `delete` operations using canonical paths and file-digest preconditions,
    with rationale and a deterministic proposal/diff digest. A proposal is
    persisted without changing draft bytes, rendered as a reviewable Diffs/file
    tree change, and requires an explicit author apply or reject action.

    Apply requires the proposal ID, expected current revision, and an
    idempotency key. The server revalidates the bound digest and all operations
    under draft CAS; success creates one new draft revision and digest, while a
    changed revision/digest returns an explicit stale/conflict result with no
    auto-rebase, partial apply, or last-writer-wins behavior. Reject is audited,
    and the conversation must be rebound before proposing from the new
    revision. The immutable base release remains unchanged.

    A clean authenticated browser/API fixture proves **browser chat → proposal
    → view diff → explicit apply → saved reload → upload/edit review → required
    scanner decision → explicit immutable release**, including initial skill
    authoring and existing-skill refinement, stale-proposal conflict, replayed
    idempotency, cross-tenant denial, and no unintended writes. Builder Eve has
    no execution, package-manager, MCP, arbitrary-network, publish, install, or
    scanner-policy tool; required scanners and publication policy remain
    authoritative, and builder/reviewer output cannot authorize a release.

M6 implementation may proceed alongside the current G0/C1 work, but its
storage, policy, and external-source dependencies must be available before
the end-to-end gates pass. Its UI primitives can be prototyped earlier, but a prototype does not satisfy
the durable draft, exact-review, safety, authorization, or release gates.

## M7 — OpenClaw skills feed interoperability (active implementation, incomplete)

M7 is an active producer/consumer interoperability milestone. It does not
block G0, C1, or M6, and it must not turn the current release into a public-catalog
mirror. The pinned target is the official [ClawHub hosted catalog feed
specification](https://github.com/openclaw/clawhub/blob/main/specs/hosted-catalog-feed.md):
the skills route is `/v1/feeds/skills`, its feed ID is `clawhub-official`, and
its current wire contract is `schemaVersion: 1`. The specification defines
`type: "skill"` entries with `@publisher/slug` IDs, exact install/release
coordinates, `sha256:` integrity, `official` publisher trust, `available`
state, `generatedAt`, monotonic `sequence`, and `expiresAt`. It also defines
eligibility filters, deterministic publication, cache validators, and a
1,000-entry interim snapshot cap pending upstream pagination or sharding.

The [ClawHub GitHub-backed skills specification](https://github.com/openclaw/clawhub/blob/main/specs/github-backed-skills.md)
adds the immutable repository/path/commit/content-hash mapping and the
completed-current-content scan requirement. OpenClaw's [marketplace
documentation source](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/cli/plugins.md) and [official
catalog consumer source](https://raw.githubusercontent.com/openclaw/openclaw/main/src/plugins/official-external-plugin-catalog.ts)
are consumer-safety references: the generic plugin catalog currently accepts
schema versions 1 and 2, validates identity/timestamps/sequence, bounds
responses, caches snapshots, and supports DSSE when a trusted profile is
configured. The checked ClawHub skills-feed specification says its current
publication is unsigned and that signing still needs a production key and
trust-root decision. Therefore M7 must not claim that the skills route is v2
or signed; signing is conditional until the upstream skills contract and a
Private Skills trust configuration explicitly enable it.

Dependencies: C1's identity-preserving automatic source pullthrough and
individual on-demand ingestion, the
canonical bundle validator, existing required scanner/policy and immutable
transfer boundary, tenant-scoped auth/storage, a bounded server-side upstream
gateway, and a dated copy/reference of the upstream contract. A Private Skills
producer uses a separately assigned feed ID and cannot impersonate
`clawhub-official`. A private feed is tenant-scoped and authenticated; a public
feed contains only explicitly public records. No upstream feed credential,
private bytes, or scanner report is placed in a feed or browser response.

### Current composed implementation checkpoint

Seven reviewed nonsecret OpenClaw production settings are active in the current
deployment; the settings-stage record retains names and exit codes only. This
activation establishes runtime configuration, not feed import or publication.
Two hosted M7 candidates failed closed on artifact digest mismatches. The
public-GitHub M7 candidate failure was diagnosed as a PAX parser issue; a local
fix with the exact NVIDIA digest passed and awaits its PR. M7 therefore remains
an active, incomplete implementation milestone.

The current core/runtime composition exposes the following bounded consumer
surface when an operator configures an OpenClaw feed. `GET
/v1/feeds/skills/catalog` requires an authenticated reader with
`registry:read`; it refreshes a trusted, allowlisted feed and returns metadata
plus feed digest/validator state. `POST /v1/feeds/skills/import` accepts only
`{ "externalId": "..." }`, requires an authenticated reader with explicit
`proxy:resolve`, and returns a `202` operation. The server derives the source
candidate, internal record, revision, and worker target; callers do not submit
a source URL, private name, version, or upstream mapping. `POST
/v1/feeds/skills/refresh` remains administrator-only, and `GET
/v1/feeds/skills` is the authenticated tenant feed after current policy,
source-proof, namespace, and required-scan checks.

The Node runtime reads `PSKILLS_OPENCLAW_FEED_ID`,
`PSKILLS_OPENCLAW_FEED_URL`, `PSKILLS_OPENCLAW_NAMESPACE`, and
`PSKILLS_OPENCLAW_SOURCE_ORIGIN` for the private feed and worker source
boundary. `PSKILLS_OPENCLAW_TRUSTED_FEED_URL` and the optional
`PSKILLS_OPENCLAW_TRUSTED_FEED_ID` configure the server-side metadata feed; the
URL must be HTTPS without credentials, query, or fragment. Hosted worker
execution is separately enabled with `PSKILLS_HOSTED_WORKER=true`. Feed and
source credentials remain deployment-owned and are never returned to callers.
When hosted source acquisition is enabled, the Node worker uses the reviewed
default locator for supported public GitHub and ClawHub source identities. It
does not require a tenant administrator to create a per-skill mapping or enter
an artifact URL. `PSKILLS_OPENCLAW_SOURCE_LOCATOR_JSON` remains an optional,
operator-only restriction/override for deployments that need a narrower
source or artifact-origin policy. It is a bounded JSON object with
`sourceProviderOrigin`, an `allowedArtifactOrigins` array, and an explicit
`bindings` array of `{ "source": <normalized source identity>, "url":
<artifact URL> }`; each binding URL must be HTTPS and belong to the configured
artifact-origin allowlist. The worker matches the complete source identity and
the reviewed locator never derives an endpoint from an unverified package name,
repository, or path. The setting is never accepted from a request or exposed
to the browser. Unknown or unsupported source identities remain unavailable
and fail closed; the rest of the registry remains usable.

The checked-in composition fixture proves the protocol boundary with an
in-memory trusted feed, injected source bytes, and a deterministic local
scanner under the required-scan policy. It observes metadata refresh, one
deduplicated queue operation, worker acquisition, canonical bundle validation,
required scan completion, source-proof recording, private publication, and a
reference-consumer parse of the published bytes. It is not live ClawHub
traffic, a production scanner run, or production deployment evidence; the
hosted source-fetcher construction remains a deployment/worker concern.

Completion requires all of the following:

1. **M7-SPEC — pinned wire contract.** The implementation documentation and
   fixtures record the checked source URL, review date, and target
   `schemaVersion: 1`, `/v1/feeds/skills` route, `clawhub-official` reference
   identity, required top-level fields (`generatedAt`, `sequence`, `expiresAt`,
   and `entries`), skill entry type/ID, source profiles, integrity/trust/state,
   eligibility, ordering, cache behavior, and 1,000-entry limit. An upstream
   change creates a deliberate contract update and fixture review; the product
   never invents a v2 skill schema from the generic OpenClaw plugin parser.

2. **M7-PRODUCER — deterministic publication.** A producer can emit a
   schema-v1-compatible feed snapshot with a documented Private Skills feed ID,
   stable JSON/key and entry ordering, exact version/install coordinates,
   `sha256:` integrity, publisher trust/state, generated/sequence/expiry
   metadata, and no credentials, private bytes, hidden tenant metadata, or
   unverified entries. Eligible-record filters match the pinned contract. A
   public route serves unchanged bytes with ETag, Last-Modified, 304 handling,
   and bounded cache headers; a private route requires explicit tenant auth.
   The producer either rejects more than 1,000 entries or uses a separately
   documented upstream sharding contract; it does not silently drop entries.

3. **M7-CONSUMER — bounded safe refresh.** The consumer accepts only an
   allowlisted HTTPS feed URL without URL credentials, query, or fragment. It
   enforces a documented response-size, timeout, streaming UTF-8, and JSON
   depth/entry limit; validates schema version, expected feed ID, required
   fields, timestamps, nonnegative sequence, duplicate IDs, expiry, and
   conditional ETag/Last-Modified behavior; and retains a bounded
   last-known-good snapshot. Wrong-ID, unsupported, malformed, truncated,
   oversized, expired, replayed/equivocating, or failed snapshots become an
   explicit unavailable/error state and never write an artifact or grant
   install authority. A 304 reuses the exact previous bytes and digest.

4. **M7-PROVENANCE — exact source and digest mapping.** A selected hosted
   entry records its `public-clawhub` package/release identity and declared
   artifact SHA-256. A GitHub-backed entry records `public-github`, repository,
   path, immutable commit, and content hash. Pullthrough recomputes the fetched
   bytes and rejects missing, changed, removed, incomplete, or mismatched
   sources; it never substitutes a display-name match or infers SemVer from a
   branch, install count, or first-seen timestamp. The external feed hash is
   stored separately from the Private Skills canonical artifact digest.

5. **M7-ADMISSION — local gates remain authoritative.** Selecting a feed entry
   resolves one exact source and sends its complete bundle through canonical
   path/file validation, the required Cisco/NVIDIA/SkillsGuard and local scanner
   policy, authorization, and immutable transfer checks. Remote `official`,
   `available`, publisher, or audit values are advisory evidence and can never
   satisfy or override a required local scan, policy revision, authorization,
   or digest check. A stale, missing, failed, or suspicious source is not
   installable. Ingestion has no automatic execution, install, merge, publish,
   hook, MCP, or package-manager side effect.

6. **M7-AUTH — identity and tenant isolation.** Feed credentials and upstream
   source credentials remain server side and are absent from browser payloads,
   URLs, logs, and audit details. Private feed publication, snapshot/cache
   keys, candidate/source details, pullthrough operations, scanner evidence,
   and artifacts are scoped by organization, namespace, principal, and role.
   Cross-tenant feed/cache/source-ID guesses return an authorization-safe
   response with no content, digest, metadata, or timing oracle. A non-Vercel
   deployment uses an explicitly configured gateway/credential provider; no
   Vercel-only ambient assumption is accepted.

7. **M7-SIGNING — explicit signed/unsigned state.** Current ClawHub skills-feed
   fixtures and UI state identify the route as unsigned because the checked
   specification does not declare a deployed signing key/trust root. If the
   official skills route later declares a DSSE envelope, the consumer verifies
   the pinned media type, signature, expected feed ID, expiry, and configured
   trusted keys before a candidate can proceed. The feed cannot bootstrap its
   own trust keys, and an unavailable/invalid configured trust root fails
   closed. Unsigned status never bypasses local scanners or approval policy.

8. **M7-INTEROP — reference fixtures.** A checked-in, source-attributed fixture
   passes producer → consumer round-trip for a valid v1 feed, empty feed,
   multiple skills, GitHub-backed entry, 1,000-entry boundary, ETag/304, and
   last-known-good fallback. Negative fixtures cover missing fields, wrong
   schema/feed ID, invalid time/sequence, duplicate IDs, replay/equivocation,
   expiry, truncation/size/time limits, wrong artifact digest, changed or
   removed GitHub source, ineligible/soft-deleted entry, and unauthorized
   tenant access. DSSE fixtures are added only if the official skills contract
   enables signing. The compatibility check targets the documented OpenClaw
   parser/source; a plugin-only CLI command is not treated as a skills-feed
   test.

9. **M7-PORTABILITY — provider-independent operation.** Feed publication,
   refresh, cache, source resolution, validation, and scanner admission pass in
   supported Nitro node/edge modes and the configured provider gateway without
   relying on a Vercel-only API, global filesystem, ambient token, or local
   process. Provider-specific limits and credential setup are explicit in the
   deployment contract.

10. **M7-EVIDENCE — reviewable proof.** The implementation evidence records
    the pinned source URL/revision, producer payload digest and feed ID,
    consumer validation and cache result, exact source/commit mapping, local
    scanner decision, rejection cases, tenant-isolation result, and
    no-execution result for representative accepted and rejected entries. It
    records public endpoint availability separately from implementation
    readiness. Passing M7 does not alter the current G0/C1 release checklist.

M7 must remain a bounded interoperability layer: individual pullthrough is
on demand, feed metadata is not approval, and complete multi-shard catalog
coverage waits for an upstream versioned pagination/sharding contract.
