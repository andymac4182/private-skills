# Completion criteria

These criteria turn [`roadmap.md`](roadmap.md) into checkable milestones. A
future feature is not complete because a route, CLI command, or design mockup
exists; the listed behavior and evidence must pass. The v0.2.0 criteria are the
only criteria that gate the current shipment.

## G0 — v0.2.0 shipment

Close the pending gates in [`verification-v0.2.0.md`](verification-v0.2.0.md):

- the account owner accepts the Neon integration terms and the main registry
  has a production database, private object storage, and configured secrets;
- the account owner completes the GitHub Vercel app security-key step and a
  Git-triggered deployment is observed for the final source revision;
- the production-built registry passes an authenticated publish → required
  SkillsGuard scan → approval → semantic search → Rust CLI install/verify →
  analytics/review flow at its real URL;
- the production worker/hosting boundary proves required scanner failures are
  fail-closed and does not expose artifact bytes, credentials, or reports;
- final CI is green on Linux, macOS, and Windows, the latest source revision is
  covered, and v0.2.0 archives/checksums are published and tested by a clean
  consumer;
- a restore rehearsal resolves the original digest and preserves revocation,
  authorization, and tenant boundaries.

No P1, P2, or P3 criterion below is a prerequisite for G0.

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
