# Completion criteria

These criteria turn [`roadmap.md`](roadmap.md) into checkable milestones. A
future feature is not complete because a route, CLI command, or design mockup
exists; the listed behavior and evidence must pass. The v0.2.0 criteria are the
only criteria that gate the current shipment.

## G0 — v0.2.0 shipment

Close the remaining gates in [`verification-v0.2.0.md`](verification-v0.2.0.md):

- **verified:** the accepted Neon integration is provisioned and connected, and
  the main registry has a production database, private object storage, and
  configured secrets, as recorded in the current verification record;
- **pending:** the account owner completes the GitHub Vercel app security-key
  step and a Git-triggered deployment is observed for the final source
  revision;
- **verified for the recorded fixtures:** the production-built registry passes
  an authenticated publish → required SkillsGuard scan → approval → semantic
  search → Rust CLI install/verify → analytics/review flow at its real URL;
- **verified for the recorded failure check:** the production worker/hosting
  boundary proves required scanner failures are fail-closed and does not expose
  artifact bytes, credentials, or reports;
- **pending for the latest source revision:** final CI is green on Linux, macOS,
  and Windows, the latest source revision is covered, and v0.2.0
  archives/checksums are published and tested by a clean consumer;
- **pending:** a restore rehearsal resolves the original digest and preserves revocation,
  authorization, and tenant boundaries.

No P1, P2, or P3 criterion below is a prerequisite for G0.

## C1 — skills.sh cloud catalog and pullthrough (current follow-up delivery)

C1 is the explicitly requested current follow-up delivery, sequenced after G0
in the roadmap but independently verifiable. It is intentionally separate
from the v0.2.0 launch gate above and does not retroactively make public-catalog
parity a prerequisite for shipping v0.2.0. The design,
limitations, and primary source links are in [`skills-sh.md`](skills-sh.md).
The criteria below are the acceptance contract for the current follow-up
delivery; implementation and production verification may proceed independently
of the remaining G0 GitHub deployment gate.

Dependencies: an authenticated skills.sh gateway contract that works on the
selected Nitro deployment, a versioned external identity model, and a
server-side source resolver that can hand complete bytes to the existing
validation/scanner worker. The C1 deployment may be verified independently of
the remaining G0 GitHub integration step.
The Vercel OIDC destination approval is pending auto-review at this checkpoint;
fixture or gateway tests do not count as live Vercel cloud acceptance until
that approval is recorded.

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
   for coverage verification or an on-demand catalog slice, records observed
   count versus response `total`, and deduplicates by complete external
   `source/slug` ID. A fixture of at least three pages, a duplicate row, a
   `files: null` row, and a well-known row completes without a silent drop.
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
   request-scoped Vercel OIDC as documented. A non-Vercel deployment uses an
   explicitly configured supported gateway/credential provider. Browser
   requests never contain the upstream bearer credential. If no supported
   credential is configured, the cloud view reports unavailable and does not
   assume anonymous API access.
5. **C1-ID — external identity and version separation.** Every row preserves
   provider, complete stable ID, source, slug, name, source type, install URL,
   skills.sh page URL, install count, duplicate flag, and fetch time. Detail
   route construction validates parsed source/slug segments and rejects path
   traversal. The skills.sh hash is retained as an external snapshot hash;
   Private Skills computes and stores its own canonical artifact digest. No
   install count, branch name, or first-seen date is presented as an upstream
   SemVer; a private import requires an explicit private release version or a
   separately specified immutable revision mode.
6. **C1-GITHUB — exact public GitHub mapping.** For a GitHub row whose detail
   has no snapshot, a fixture resolves owner/repository, default or requested
   ref, immutable commit, recursive tree, exact `SKILL.md` path, selected tree
   SHA, and frontmatter identity. Multiple matching paths, changed source,
   truncated tree, missing frontmatter, or identity mismatch produce an
   explicit unresolved/changed/rejected state and cannot import another skill
   by display-name coincidence.
7. **C1-WELLKNOWN — well-known source compatibility.** Fixtures cover the
   official discovery v0.2 schema and legacy v0.1, preferred
   `/.well-known/agent-skills/index.json` and legacy
   `/.well-known/skills/index.json`, relative artifact URLs, supplied digest,
   bounded archive extraction, unsafe paths, unknown schema, and a scoped path.
   A scoped request never falls back to the host root catalog. SSRF, redirect,
   timeout, path, file-count, per-file, response, and expanded-size limits are
   enforced before bytes are retained; no source credential is forwarded.
8. **C1-IMPORT — governed pullthrough.** Selecting a cloud row creates or
   joins one durable import operation for the selected individual catalog skill,
   keyed by external identity and resolved revision. The operation records
   source URL/path/index, ref/commit/tree when available, external hash/digest,
   local artifact digest, fetch time, and scanner IDs. Canonical validation,
   required scanner evidence, local policy, authorization, and immutable
   transfer checks all pass before a private release is installable. A remote
   skills.sh audit `pass`/“Safe” never satisfies a required Private Skills
   scanner; missing or stale remote audits are evidence states, not local scan
   failures.
9. **C1-OFFICIAL — maker-curated view.** The curated response is normalized into
   owner groups while retaining featured repository/skill and `generatedAt`.
   The UI labels the result maker-curated; arbitrary repository ownership,
   install count, or external audit status cannot set an Official/approved
   badge.
10. **C1-TOPICS — curated taxonomy view.** The Topics view exposes the current
    official category links and can render recognized `/topic/{slug}` page
    content, including skill links and related topics, while retaining source
    URL, fetch time, and parser/schema revision. Since no documented JSON topic
    membership API exists, a changed or unparseable page is marked stale or
    unavailable; the product must not invent persistent skill-topic relations
    or claim complete membership from category counts alone.
11. **C1-PACKS — unlisted external-pack preview.** Existing private pack
    management remains tenant-scoped and immutable. The cloud Packs view
    accepts a user-supplied `https://skills.sh/p/<pack-id>` link and renders a
    metadata-only manifest preview, including the unlisted/public state, member
    labels or source links returned by the external page, and a link to the
    external page/install command. It does not claim public enumeration, fetch
    member file bytes, batch-import members, create a private pack, or imply
    Private Skills approval. Deleted/404 links report unavailable rather than
    falling back.
12. **C1-AUDITS — external evidence view.** The external Audits view is
    separate from the Private Skills administrative audit log and local scan
    results. It renders 200, 404/no-audit, partial-provider, future-provider,
    stale-timestamp, and malformed-entry fixtures generically by returned
    provider/status/risk/summary/time. Unknown providers do not break the view.
13. **C1-TENANT — authorization and secrecy.** Public external metadata may be
    shared, but external detail caches, import operations, private catalog
    rows, pack members, scanner reports, source credentials, and transfer
    descriptors remain organization-scoped. Browser/network and audit-log
    tests prove that no skills.sh/GitHub bearer, raw private source, or
    unapproved candidate content is exposed.
14. **C1-EVIDENCE — representative end-to-end proof.** Evidence includes the
    page/search/detail/curated/audit fixtures, GitHub root/nested/ambiguous
    mapping fixtures, both well-known schemas, React and Marketing topic-page
    fixtures, an unlisted/deleted pack manifest-preview fixture, an existing
    private-pack management/immutability fixture, an individual selected-row
    import through local scanner approval, a blocked scan, a changed source,
    rate limiting, unavailable auth, tenant isolation, and a metadata
    enumeration proving zero artifact writes for unselected rows.

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
