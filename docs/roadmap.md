# Product roadmap and Tessl gap review

This roadmap records the product gaps identified by comparing Private Skills
with the official Tessl documentation and product pages checked on 9 September
2026. The evidence review used `docs.tessl.io` and `tessl.io`; `tessl.com` was
not used as evidence. It is a product planning document, not a parity promise.
The explicitly requested skills.sh catalog, source pullthrough, and cloud-view
delivery is tracked separately from the Tessl comparison in
[`skills-sh.md`](skills-sh.md). That review used the current skills.sh site,
its documented API, and the official `vercel-labs/skills` repository.
The current release baseline and its remaining production gates are recorded in
[`verification-v0.2.0.md`](verification-v0.2.0.md). The measurable exit gates
for this roadmap are in [`completion-criteria.md`](completion-criteria.md).
The Private Skills status column is based on [`README.md`](../README.md),
[`implementation.md`](implementation.md), the CLI and pack contract
([`cli-and-packs.md`](cli-and-packs.md)), semantic search
([`semantic-search.md`](semantic-search.md)), and the latest verification
record; proposed language in older design documents is not treated as shipped
behavior.

## Ordering

The v0.2.0 shipment remains the first priority. It is complete only when the
production gates in the verification record pass; Tessl parity work does not
silently expand that release. The later milestones below are ordered by the
amount of user value they add to a private registry and by their dependency on
new content and execution boundaries.

- **Now: close v0.2.0.** Finish the remaining GitHub Vercel integration,
  Git-triggered deployment evidence, final source-revision checks, and restore
  rehearsal. The Neon production integration, storage, secrets, authenticated
  production flow, and released CLI evidence are recorded as complete; the
  latest verification record identifies the remaining gates.
- **Current follow-up delivery: skills.sh cloud catalog.** Ship the authenticated,
  on-demand skills.sh catalog adapter, exact source mapping and pullthrough,
  and the Packs, Topics, Official, and external Audits views described in
  [`skills-sh.md`](skills-sh.md), including a metadata-only preview/link for
  user-supplied unlisted Packs. Existing private-pack management remains in
  scope; external batch migration is a later milestone. This is the explicitly
  requested next product delivery after G0; it does not retroactively expand
  the v0.2.0 launch gate or require a bulk mirror of the public catalog.
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

## Skills.sh current delivery

The skills.sh work has a different evidence status from the Tessl comparison:
the official API and site pages confirm concrete endpoints and view semantics,
while the current verification record has not yet accepted a production-complete
skills.sh adapter or cloud catalog views. The gap is therefore **targeted and
pending acceptance**, rather than a claim that in-flight implementation work is
absent. The full contract and source links are in [`skills-sh.md`](skills-sh.md).

| Priority | Confirmed skills.sh capability | Private Skills today | Current delivery target |
| --- | --- | --- | --- |
| Current | Versioned all/trending/hot pages, bounded search, curated Official data, detail snapshots, and per-skill audit results ([API reference](https://www.skills.sh/docs/api)). | Private `/v1/skills` and semantic search are authorization-scoped to this registry; no production-complete skills.sh adapter is verified yet. | Add and verify a server-side, authenticated v1 adapter with bounded page/search caching, stable external IDs, explicit unavailable/error states, and no browser-held upstream token. |
| Current | A listing row has a stable `source/slug`, `sourceType` (`github` or `well-known`), install URL/page URL, and optional duplicate flag; detail can return files plus an external hash or `null`. | `Provenance` models native/GitHub/registry sources; skills.sh identity, source type, snapshot hash, and detail status are not yet production-verified. | Preserve external ID/source/slug/install URL, separate external snapshot hash from the Private Skills artifact digest, and assign every enumerated row an explicit metadata/source/pullthrough status. |
| Current | Official CLI source code resolves GitHub trees/paths and well-known discovery, including preferred and legacy indexes and bounded archives ([`vercel-labs/skills` sources](skills-sh.md#official-clirepository-evidence-relevant-to-pullthrough)). | Existing acquisition safely imports approved GitHub/registry sources, but requires an administrator upstream and caller path/name/version; a public catalog resolver is not yet production-verified. | Resolve GitHub commit/tree/path and well-known v0.2/v0.1 sources on demand. Retain exact source provenance, never infer SemVer, never follow arbitrary credentials, and pass bytes through the existing validation/scanner policy. |
| Current | Site views expose unlisted Packs, curated Topics pages, maker-curated Official skills, and combined partner Audits ([Packs](https://www.skills.sh/docs/packs), [Topics](https://www.skills.sh/topic), [Official](https://www.skills.sh/official), [Audits](https://www.skills.sh/audits)). | Packs are private immutable org manifests and `AuditView` is an administrative history; production completion of the external cloud views is not yet verified. | Add and verify separate external views. Topics must retain its curated-page/source limitation because no documented JSON membership API exists. The Packs view accepts a user-supplied URL and renders an unlisted metadata-only manifest preview plus link; it does not enumerate packs, fetch member bytes, imply approval, or migrate members automatically. |
| Current | API docs require Vercel OIDC and document rate/error/cache behavior; no portable non-Vercel credential is documented. | Nitro is portable and currently has no skills.sh credential gateway. | Provide a server-side Vercel OIDC or explicitly configured supported gateway path; otherwise show a retryable unavailable state. Never assume undocumented anonymous API access. The Vercel OIDC destination approval is pending auto-review before live cloud acceptance. |
| Future P1 | An unlisted pack URL can contain multiple public, private, or GitHub-backed skills and can be updated or deleted ([Packs documentation](https://www.skills.sh/docs/packs)). | The current delivery previews external pack metadata and retains existing tenant-scoped private-pack management; it does not batch-migrate external members. | Add an explicit, separately authorized migration operation. Resolve every selected member to an immutable source, validate and scan every member, and create one private immutable pack only after all members pass; any unresolved/changed/deleted member leaves no partial private pack and records the failure. |
| Future P1 | Upstream CLI provides `find`, source grammar, lock provenance/check/restore, many agent adapters, selectors, `init`, telemetry, and optional `use` ([CLI parity review](skills-sh.md#cli-and-agent-compatibility-review)). | Current Rust CLI supports governed registry operations and three agent targets. | Prioritize these after the cloud contract; preserve registry authorization, immutable transfer, scanner gates, and non-execution boundaries. |

The current site’s install counts and catalog totals are dynamic. They are
observations, not roadmap constants. A live API total must never be confused
with the homepage’s aggregate install headline. Full coverage means every
enumerated row is represented with a status; it does not mean a refresh stores
every artifact.

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
visibility/automation to **M5**.

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
