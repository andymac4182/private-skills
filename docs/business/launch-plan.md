# Private Skills launch plan

**Status:** launch strategy and pricing hypotheses, not a committed offer

**Planning date:** 2026-09-15

**Product source reviewed:** repository `08b0e6e` (`fix(web): preserve draft context and admission state`)

This plan chooses engineering teams as the first customer and describes a
launchable service around the capabilities that exist in the reviewed
checkout. It is deliberately narrower than a general agent marketplace or an
enterprise compliance product. Pricing below is a testable assumption; it
must not be published until identity, billing, hosted scanner capacity, and
the live cost model are verified.

## Launch decision

The first offer should be a private, governed registry for teams that already
use coding agents and need to distribute internal skills consistently. The
buyer is paying for a controlled path from a skill source to a developer's
agent directory:

```text
source or upload -> validate -> required scan evidence -> policy decision
                 -> immutable release -> authorized CLI install -> revoke/rescan
```

Start with an invitation-only beta/demo signup for direct private publishing
and the small set of source paths that pass hosted acceptance. Do not charge
while the legal entity, support contact, payment account, and billing flow are
unconfigured; use the beta to validate willingness to pay and usage. Add the
paid Team pilot and self-serve checkout after the hosted path, account model,
billing, and usage controls are real. Defer broad public-catalog and enterprise
claims until their evidence gates pass.

The working promise is:

> Ship the skills your engineering agents can trust.

Supporting copy:

> Private Skills gives engineering teams one governed registry for versioned
> agent skills and packs. Validate and scan before distribution, preserve
> source and digest provenance, install the same approved bytes across supported
> coding agents, and revoke a release when policy changes.

Suggested calls to action are **Run the local proof** and **Request a team
pilot**. A public “start free” flow should wait for a real account and billing
path. The homepage must say that scanner approval is evidence under a named
policy, not a guarantee that a skill is harmless or that an agent will behave
as intended.

## Ideal customer and buying motion

The initial ICP is a 5–50 person engineering organisation with a platform,
DevEx, or staff engineer who already maintains shared coding-agent
instructions. The team may use Codex, Claude Code, Cursor, OpenCode, or several
agents at once. It has enough internal guidance to care about versioning and
review, but not enough dedicated registry and security infrastructure to build
one.

The champion is usually a staff/principal engineer, platform lead, or DevEx
owner. The economic buyer can be an engineering manager or VP Engineering; a
security/platform owner is a reviewer or co-sponsor. A good first deal has one
team, one policy owner, a small set of internal skills, and a clear install
workflow. It does not require a company-wide identity migration on day one.

The painful job is concrete:

- Internal skills are scattered across repositories, home directories, and
  public directories. Developers install different revisions into different
  agents.
- A team cannot quickly answer which source, revision, digest, files, and scan
  evidence produced an installed skill.
- A public skill or upstream change can introduce a new finding after a team
  has adopted it. The team needs a review, rescan, and revoke path rather than
  another informal announcement.
- Packs and lockfiles need to resolve to an exact, reproducible member set
  while preserving local edits and supported agent directories.

The first discovery call should test these recent events rather than ask
whether a prospect likes the concept. Ask for the last time a skill was
copied, updated, blocked, revoked, or found in two different versions; who
approved it; how they know what bytes developers received; and what existing
tool they would stop using if a registry handled the job.

Do not lead with this product for a solo developer who only needs a public
skill directory, a team that needs a full agent runtime and model platform, a
regulated buyer whose first requirement is SSO, residency, or a contractual
SLA, or a customer looking for a general npm/pip/container registry. Those are
valid later markets or adjacent alternatives, but they make the first promise
unnecessarily broad.

## What exists and what the launch can say

The reviewed README and product documents support the following product
description:

| Launch proof point | Truthful wording | Boundary to show beside it |
| --- | --- | --- |
| Versioned private artifacts | “Publish bounded canonical bundles, content digests, immutable versions, and exact-member packs.” | Bundles are data; the registry does not execute skill scripts, hooks, MCP servers, or package lifecycle code. |
| Governed distribution | “Issue a short-lived authorized transfer only after current authorization, revocation, and policy checks.” | Existing installed files cannot be atomically retracted; the final check has a bounded race with local activation. |
| Required scanning | “Run configured scanner adapters and keep normalized, digest-bound evidence and coverage.” | Missing, stale, unsupported, timed-out, or degraded required evidence blocks distribution. The recorded production checkpoint uses a 24-hour SkillsGuard evidence window ([evidence](../evidence/production-m6-terminal-restart-release-20260913.json)), so rescans are a real cost and availability concern. |
| Private access | “Keep artifact bytes, reports, credentials, and metadata behind server-side authorization.” | The baseline is one organization per deployment with configured bearer tokens and signed browser sessions; interactive identity, durable membership lifecycle, and OAuth are not shipped. Hosted tenant isolation still needs the launch proof at the target deployment. |
| Cross-agent installation | “Use the Rust `pskills` client for governed install, update, verify, doctor, and pack workflows.” | v0.4.0 release verification proves fresh assets and a Mac arm64 smoke check; Linux QEMU and Windows Wine evidence are nonnative and native CI is waived. Current native agent coverage is limited. |
| Source pull-through | “Resolve selected upstream identities through server-owned adapters and preserve source provenance.” | Local adapters and a bounded ClawHub preflight exist. Broad hosted provider acceptance, approved warm cache, transfer, and CLI install evidence remain open; a representative ClawHub import was quarantined by required scanning. |
| Search, analytics, review | “Offer authorization-aware search, client-confirmed install receipts, and bounded human review proposals.” | Semantic search is opt-in. Analytics are best-effort client receipts. Eve is advisory and cannot publish, merge, install, edit source, or execute candidate content. |
| Portable deployment | “Run the web/API through Nitro with Files SDK storage and an external worker boundary.” | Each state, storage, scanner image, model, and executor provider still needs its own credentials and conformance evidence. |

The initial site should show a benign local or hosted fixture that walks through
publish, required scan, approval, immutable install, warm repeat, and revoke or
rescan. It should label synthetic and local evidence as such. Do not use a
quarantined sample as a positive security testimonial, and do not imply that
the current source-catalog work is a general marketplace launch.

## Positioning against alternatives

Private Skills is a control plane for distributing approved skill bytes into
engineering workflows. It sits between a public directory or internal source
and the agent's local skill directory. The comparison is about the job the
buyer is hiring the product to do; it is not a claim that the alternatives are
unsafe or incomplete in their own markets.

| Alternative | What its official material confirms | Positioning implication |
| --- | --- | --- |
| [Tessl Registry and workspaces](https://docs.tessl.io/distribute/distributing-via-registry) | Private workspace plugins, member roles, versioned installs, archive/unpublish, and usage statistics. Tessl also documents reviews, evals, packages, MCP, and agent setup. | Closest direct comparison. Private Skills should win a narrower choice where a team wants an artifact and policy boundary around private Agent Skills, digest-bound transfer, fail-closed required evidence, provenance, and a portable registry/CLI. Do not claim Tessl lacks governance; its official docs describe substantial governance. |
| [Tessl pricing](https://tessl.io/pricing) | Free at $0 with 1,000 monthly credits; Team at $100/month with 5,000 credits and workspace role management; Enterprise is custom with policies, audit, SSO, BYOK, self-hosting, and SLAs. Credits cover reviews, evals, and agent runs; publish/install is free. | Use $100/month as a market anchor for a small governed team, but keep Private Skills' first plan simpler and make scanner/storage/model cost visible rather than hiding it in an opaque credit balance. |
| [skills.sh documentation](https://www.skills.sh/docs) and [API](https://www.skills.sh/docs/api) | Open `skills` CLI, public leaderboard/catalog, anonymous install telemetry, authenticated API access for Vercel projects, and broad agent-directory support. | Treat it as an acquisition and compatibility surface. Its docs say it does not guarantee the quality or security of every listed skill; Private Skills adds private authorization, immutable release state, local policy, scan evidence, provenance, and revocation. The current source adapter is an integration target, not a claim of hosted parity. |
| [skills.sh Packs](https://www.skills.sh/docs/packs) | Packs combine public, private, and GitHub-backed skills, but are unlisted and not access-controlled: anyone with the URL can view and install. | A concise contrast for the buyer: a share link is useful for distribution, while a private registry is needed for team authorization, scan state, version pinning, and revocation. Do not describe packs as a security failure; use the documented boundary accurately. |
| [ClawHub/OpenClaw](https://docs.openclaw.ai/clawhub) and [security audits](https://docs.openclaw.ai/clawhub/security-audits) | Public OpenClaw registry with semver releases, files, downloads, stars, scan summaries, moderation, and audit signals. | Position Private Skills as private and cross-agent, with selected upstream pull-through through local policy and required scans. Do not imply OpenClaw's public scans are equivalent to the registry's local approval decision. |
| [AWS Agent Registry](https://aws.amazon.com/about-aws/whats-new/2026/08/aws-agent-registry-generally-available/) | Private governed catalog for agents, tools, skills, MCP servers, and custom resources with approval workflows, semantic/keyword search, CloudTrail, IaC, cross-account sharing, and discovery integrations. | Adjacent enterprise platform and a credible long-term benchmark. Private Skills is narrower: distribution and reproducibility of skill files across coding agents, not a runtime or general agent catalog. Do not claim AWS parity or multi-account governance. |
| [AWS Agent Registry pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) | Usage pricing based on records and Search/List/Get calls, with stated free tiers and published rates above them. | Usage-based registry pricing is a useful precedent, but Private Skills' expensive events are scanner execution, repeated freshness rescans, model review, storage, and egress. Installs should not be the primary meter. |
| [Microsoft Agent Store](https://learn.microsoft.com/en-us/microsoft-365/copilot/copilot-agent-store) | Organization agents are submitted for review and are not visible until an administrator approves them. | Shows that admin approval is a familiar enterprise buying pattern. It publishes agents into the Microsoft ecosystem; Private Skills should own file-level skill release and CLI portability. |
| [LangSmith workspace agents](https://docs.langchain.com/langsmith/fleet/manage-agent-settings) | Agents can be private to a creator, shared with people, or shared in a workspace; workspace agent details and credentials have explicit visibility boundaries. | Adjacent private-agent collaboration and observability. Private Skills should stay focused on governed skill artifacts, not claim to replace agent deployment, tracing, or runtime hosting. |
| [npm products](https://www.npmjs.com/products) and [private packages](https://docs.npmjs.com/about-private-packages/) | Pro is listed at $7/month for unlimited private packages; Teams at $7/user/month with team permissions. Private packages require paid accounts and scoped access. | Low-price package-registry anchor. Private Skills can charge for policy and scan operations that npm does not provide, while keeping storage and transfer transparent. |
| [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages) and [pricing calculator](https://github.com/pricing/calculator) | GitHub Team includes 2GB package storage and 10GB transfer monthly; Enterprise Cloud includes 50GB and 100GB. The calculator lists additional storage at $0.25/GB and transfer at $0.50/GB. | Existing GitHub repositories are a strong substitute for raw storage. Private Skills must earn its price through governed release, scanner evidence, provenance, packs, and agent-aware install, not artifact storage alone. |
| [Cloudsmith billing](https://docs.cloudsmith.com/support/billing) | Core is free with modest allowances; paid plans include artifact data and package delivery allowances, with on-demand GB billing, usage limits, and free uploads. | Supports a pooled allowance plus metered delivery model. Preserve hard spending controls and distinguish source fetch, stored bytes, scan work, and client egress. |
| [JFrog pricing](https://jfrog.com/pricing/) | Artifactory Pro is listed at $150/month with included consumption and tiered GB charges; Enterprise X starts at $950/month, with support and SLA options. | Upper bound for a broader supply-chain system. Do not enter a feature or procurement comparison before Private Skills has durable identity, support, and hosted operational evidence. |

## Business model and pricing hypotheses

Use a hybrid model: a predictable organization subscription pays for the
control plane, and explicit pooled allowances cover the variable work. Charge
for a team workspace rather than every install. Make overage opt-in with a
hard budget; an exhausted allowance queues work or leaves a release blocked
under policy rather than silently bypassing a required scan.

These figures are planning anchors to test with design partners. They are not
prices, entitlements, or a billing implementation:

| Planned offer | Target | Provisional allowance | Pricing hypothesis |
| --- | --- | --- | --- |
| Evaluation | One engineer or a small trial team validating the workflow | One organization; at most 3 human identities once membership exists; 10 active release versions; 1GB artifact storage; 50 scanner-engine executions; 1 Eve review/month; no SLA or production support | Free, time-limited or local evaluation. Do not offer hosted private data until account, retention, and abuse controls exist. |
| Team | 5–20 engineers with one platform/policy owner | Up to 10 human identities; 20 active release versions; 10GB artifact storage; 750 scanner-engine executions/month; 10 Eve review sessions/month; 50GB egress; 90-day audit retention | Around **$99/org/month** as a test anchor, with one-click budget cap and separately approved usage packs. The $100 Tessl Team tier is the nearest direct published anchor; npm/GitHub package pricing is a lower infrastructure baseline. |
| Team Plus | Several squads sharing one governed registry | Up to 25 identities; 100 active release versions; 50GB storage; 4,000 scanner-engine executions/month; 50 Eve sessions/month; 250GB egress; 12-month audit retention; source restrictions and richer reports when implemented | Around **$249/org/month** as a test anchor. Raise or narrow the allowance after measuring required-scan and support costs. |
| Enterprise / self-managed | Multiple teams with identity, retention, or deployment requirements | Custom storage, worker/scanner capacity, model choice, retention, source policy, SSO/SCIM, residency, support, and deployment topology | Custom annual contract only after those features and operational obligations are real. No SLA, SOC 2, residency, BYOK, or single-tenant claim belongs on the first launch page. |

The Team allowance assumes one required scanner refreshed at the current 24
hour evidence window. A workspace with 20 active releases can consume roughly
600 freshness refreshes in a 30-day month before new versions, a second
required scanner, retries, or changed policy are counted. Each required
scanner-engine execution should count separately in internal cost accounting.
This arithmetic is a planning model, not a promise that 750 runs are enough
for every policy.

Do not meter a successful install as if it were a scan. A warm transfer of an
already approved digest is cheap compared with the first import, a required
rescan, or an Eve model run. Show customers a forecast with these dimensions:

| Cost driver | Why it moves cost | Product/billing control |
| --- | --- | --- |
| Required scanner execution | Engine image CPU, memory, startup time, file count, and retries. A 24-hour evidence expiry can make a quiet catalog consume work every day. | Count each engine/artifact execution, expose next expiry, schedule bounded worker capacity, and allow a hard monthly cap. Never use a client flag to bypass missing evidence. |
| Artifact and report storage | Immutable releases, old versions, packs, sealed objects, and tighter-permission raw reports accumulate. Current bundle limits are up to 2,000 files, 10MiB per decoded file, and 100MiB expanded per bundle. | Price by retained GB-month or include a bounded allowance; make retention and deletion/revocation semantics explicit. Keep raw reports out of public logs. |
| Egress and upstream fetch | Cold pull-through fetches source bytes; authorized CLI installs and repeated machines create egress. Warm cache can avoid a new upstream lookup but still transfers bytes. | Include a practical egress allowance, show bytes, cache approved digests, and require explicit refresh for changed upstream content. |
| Eve/model review | Current Eve review is bounded to 100,000 input tokens, 10,000 output tokens, a 10-minute session, and a USD 0.50 model-cost limit in the app contract. | Include a small session allowance; model selection and overage must be opt-in. Do not represent Eve's proposal as an automated security verdict. |
| Search/indexing | Semantic search is opt-in and may require embedding Gateway calls and a PostgreSQL/pgvector or state index. | Keep disabled by default in evaluation; include a bounded indexing allowance and record model/provider choice before pricing it. |
| Worker and provider operations | PostgreSQL, private object storage, scanner images, gateways, and managed sandbox capacity are deployment inputs with independent availability and billing. | Use provider-specific cost traces and a reserve for retries/incident work. Do not price from install counts alone. |

The first commercial experiment should sell the Team workflow, not promise an
unlimited free tier. A paid pilot tests whether scan evidence, provenance, and
reproducible installs are valuable enough to cover real operational work. If a
prospect only values raw storage, GitHub Packages or an existing registry is a
better fit.

Set a margin guardrail before choosing the final allowances. As a planning
target, variable hosted cost should stay at or below 30% of subscription
revenue: roughly $30/month against the $99 Team anchor and $75/month against
the $249 Team Plus anchor. Count scanner compute and image pulls, model calls,
storage, egress, database, worker/sandbox capacity, retries, and payment fees;
keep human support and acquisition costs in the wider operating model. If the
24-hour rescan case breaks that guardrail, reduce active-release or scanner
allowances, change the freshness policy only through an explicit product and
risk decision, or move the customer to a custom capacity quote. Never market
unlimited scans or unlimited retained versions before a measured cost trace.

## Validation and customer discovery

Run a two to three week discovery sprint with 8–12 engineering/platform teams.
No outreach, spend, customer logos, or traction should be implied by this
plan. Use the conversations to falsify these hypotheses:

| Hypothesis | Test | Pass signal before self-serve pricing |
| --- | --- | --- |
| H1: scattered skills create a recurring release problem | Ask for the last two skill updates or installs and reconstruct source, review, and rollback steps. | At least 6 of 10 teams report a repeated manual step or incident and can name the owner. |
| H2: policy evidence matters | Show a blocked/stale scan and a clean approved release; ask what their current decision record contains. | At least 5 teams say a fail-closed gate, digest, or revocation record would change their workflow. |
| H3: the CLI solves a cross-agent problem | Install one benign internal skill into two supported agent targets and compare current setup time with `pskills`. | At least 4 teams complete the two-agent workflow and repeat it on another machine/project. |
| H4: the buyer will pay for the control plane | Offer the proposed Team anchor after a pilot with no promise of a discount or roadmap commitment. | At least 3 teams request a paid pilot or give a concrete procurement path and objection; “interesting” alone is not validation. |
| H5: usage can be forecast | Capture release count, bytes, required engines, rescan frequency, Eve usage, and egress from each pilot fixture. | A 30-day projection has a defensible gross-margin buffer and a clear allowance/cap policy. |

Instrument the product around value, not vanity:

- Activation: organization configured, first approved release, first install,
  second human install, second machine/project install, and first pack install.
- Trust: time from upload to decision, required evidence coverage, stale/rescan
  events, quarantine outcomes, revoke drill completion, and provenance shown in
  the lockfile.
- Retention: a team publishes or updates a release in month two and continues
  to use the same policy; a one-time demo install is not retention.
- Conversion: trial-to-paid decision, stated budget, deployment model, and
  missing capability. Keep customer identifiers and private skill content out
  of public analytics.

The minimum pilot artifact is a short, anonymized run record containing the
source identity, release/digest, policy and scanner revisions, decision,
install result, and cost dimensions. It must not contain credentials, raw
skill text, scanner reports, or customer repository content.

## Acquisition, docs, and demo

The first acquisition loop should be documentation-led and integration-led:

1. Publish a five-minute local proof with a benign fixture: configure a
   disposable registry, publish a bundle, run required scanning, inspect the
   approval, install through `pskills`, repeat from the lockfile, then revoke
   or force a rescan. Mark every local result and every unverified hosted
   dependency.
2. Publish focused guides for “private skills registry,” “internal coding-agent
   skills,” “governed Codex/Claude/Cursor skills,” “skills.sh private
   pull-through,” and “agent skill scan and revoke.” Each guide should include
   a limitation box and a copy-paste install path.
3. Add one integration page per supported agent target and one page for
   GitHub/CI source provenance. Preserve user-managed files and show the
   project lockfile so the benefit is reproducibility rather than a new hidden
   directory.
4. Offer a shareable private-pack manifest to help one engineer bring a second
   teammate into the pilot. This is an invitation path, not a public marketplace
   or an access-control claim for skills.sh packs.
5. Reach platform/DevEx and security engineering communities through useful
   examples, design-partner conversations, and source-linked technical notes.
   Do not buy ads or imply partners, customers, or endorsements before they
   exist.

The live demo should take under ten minutes:

- The administrator selects a required scanner policy and shows that
  `allowUnscanned=false` leaves an incomplete or stale release blocked.
- The author uploads a complete folder. The worker stores a sealed object and
  produces digest-bound coverage and findings.
- A clean release becomes an immutable version with source, policy, and scan
  metadata. A finding leaves the candidate quarantined and offers a rescan or
  explicit human exception path.
- A developer installs a pinned skill or pack with the Rust CLI into two
  supported targets. A second install receives the same approved digest.
- The presenter changes policy or revokes the digest, then shows the next
  authorization denied. The demo states that bytes already activated locally
  cannot be remotely retracted atomically.

Avoid showing live third-party credentials or unreviewed public content. The
current ClawHub record is a useful rejection-path demo, not a positive import
claim. The skills.sh catalog and broader provider adapters should be shown only
after the corresponding hosted source and install gates are recorded.

## Privacy, terms, and commercial inputs

This is a launch content outline, not legal advice or a completed policy. Have
counsel and the selected infrastructure/payment providers review it before
accepting paid customers. Keep the first beta private until the required
identity, contact, billing, retention, and incident details are filled in.

The privacy notice should explain these data categories and purposes in plain
language:

| Data flow | What the product may handle | Required disclosure or decision |
| --- | --- | --- |
| Account and access | Principal/organization identifiers, role and namespace grants, hashed bootstrap token material, signed session cookies, CLI tokens, audit actor IDs | State who controls the organization, how access is recovered or revoked, and where credentials are stored. Never record raw tokens in logs or send them to upstream sources. |
| Skill and release data | Names, descriptions, safe paths, versions, source IDs/revisions, file/member metadata, canonical digests, immutable release and pack records | State that this is customer content and identify the storage/processing purpose. Define customer ownership/licence responsibilities and deletion/retention effects on immutable releases. |
| Artifact and scan data | Sealed artifact bytes, scanner inputs, normalized findings, bounded/redacted evidence, policy and rules revisions, job/lease metadata | Explain that worker/scanner services process selected content to validate and evaluate distribution. List each provider only after it is actually configured; do not imply that scanner reports are public. |
| Source and provider data | Server-side upstream credentials, source requests, source metadata, cache keys, gateway/provider responses, storage/database records | Identify source providers and regions, keep credentials server-side, and state that a caller cannot supply an arbitrary credential environment or URL. Mark optional skills.sh, ClawHub, GitHub, model, and sandbox paths as conditional until live. |
| Review and model data | Eve review snapshots, bounded prompts/results, model/provider identifiers, review proposals, embedding requests when semantic search is enabled | State whether candidate content leaves the deployment, which model/provider receives it, how export/logging is disabled or bounded, and the tenant-consent switch. Current Eve is advisory and cannot publish or execute content. |
| Usage and support | Client-confirmed install receipts, up-to-date checks, scan/storage/egress counters, error/support records, diagnostic metadata | Explain that install analytics are best-effort and do not infer installs from downloads. Define whether any support diagnostic includes customer content; default to metadata-only. |
| Billing (future until configured) | Customer billing identity, subscription, invoices, tax, payment-provider tokens and events | Name the actual processor, merchant/legal entity, currency, tax treatment, cancellation/refund rules, and webhook retention only after the account exists. Do not collect or promise payment handling before this is configured. |

The terms should cover organization and role authority, permitted use,
customer content and upstream licences, source-provider terms, immutable
release/revocation behavior, scanner and model limitations, support and
availability, billing/renewal/cancellation/refunds, acceptable content and
abuse/takedown handling, suspension, termination and data export/deletion,
third-party services, changes, governing law, liability/indemnity, and a
security-reporting contact. Say explicitly that scan evidence is a policy
input and not a guarantee that content or downstream agent behavior is safe.

Before a paid launch, fill these named inputs and record who approved them:

| Input | Owner | Launch state |
| --- | --- | --- |
| Legal entity, registered address, jurisdiction, contracting name | Founder/counsel | **Required; value not supplied** |
| Support email, privacy/security contact, escalation owner and response target | Operations | **Required; value not supplied** |
| Payment processor/account, merchant descriptor, currency, tax/VAT handling, invoice and refund policy | Finance/operations | **Required; billing is currently test-mode/unconfigured** |
| Hosting, database, object storage, scanner, model/Eve, gateway and monitoring providers; regions and subprocessors | Engineering/operations | **Required; deployment-specific and partly conditional** |
| Retention/deletion periods for account, artifacts, reports, audit, receipts, logs, backups and abandoned trials | Counsel/operations | **Required; do not invent periods** |
| Data residency, cross-border transfer, DPA/subprocessor terms, incident notice and customer export process | Counsel/operations | **Required before enterprise or regulated claims** |
| Trial eligibility, abuse limits, content/takedown rules, suspension and restore policy | Product/operations | **Required; draft only** |

The first launch page should link to “Privacy (draft)” and “Terms (draft)” only
inside an invitation-only pilot if those documents are still being completed.
Do not claim SOC 2, HIPAA, GDPR certification, residency, encryption level,
uptime, SLA, or any named compliance outcome until the relevant technical,
contractual, and legal evidence exists.

## Launch checklist and evidence gates

Use three launch stages. Every stage needs a dated, reproducible record rather
than a route existing in source.

### Stage 0: internal proof

- [ ] A clean-consumer build can install the published CLI assets and verify
  their checksums and member shape. State the Mac arm64, Linux QEMU, Windows
  Wine, and native-CI limits exactly.
- [ ] The local or disposable hosted fixture proves upload/publish, complete
  required scan coverage, approved transfer, frozen pack reproduction, and
  revoke/rescan behavior. No uploaded content executes.
- [ ] The two-organization authorization fixture is green, and a hosted
  deployment proves that private catalog, scan, audit, operation, and transfer
  responses do not cross the tenant boundary. Do not call a local fixture a
  hosted isolation guarantee.
- [ ] Storage read-back, database snapshot, and bounded restore are rehearsed;
  retention and deletion owners are named.
- [ ] Scanner images, rules, source revisions, report retention, and the
  24-hour required SkillsGuard evidence expiry are documented. Worker capacity
  and rescan cost are measured under concurrent cold requests.

### Stage 1: closed design-partner beta and demo signup

- [ ] A real hosted origin has configured identity, private storage, durable
  state, worker credentials, scanner policy, and incident access. The current
  token bootstrap is a pilot mechanism, not durable team identity.
- [ ] One positive end-to-end path is recorded for a benign allowed artifact,
  including approved warm resolve/transfer and CLI install. Keep the prior
  ClawHub quarantine as negative evidence.
- [ ] One negative path is recorded for stale/missing required evidence,
  scanner error/timeout, digest mismatch, unauthorized tenant, revoked release,
  and changed upstream bytes.
- [ ] Usage telemetry distinguishes scanner-engine executions, Eve sessions,
  storage, upstream fetch, egress, and successful client receipts. The product
  has a visible budget cap and no silent overage.
- [ ] Terms, privacy/data handling, acceptable-content policy, support contact,
  backup/restore runbook, abuse/takedown route, and data deletion behavior are
  ready. Do not claim SOC 2, HIPAA, a regulated deployment, or an SLA.
- [ ] A test-mode billing flow can create, change, cancel, refund, and reconcile
  a subscription. Actual account configuration, legal entity, support contact,
  and tax/invoice treatment must be completed before charging a customer. Until
  then, the CTA is a beta/demo signup and the pilot has no paid entitlement.

### Stage 2: self-serve Team launch

- [ ] Durable organization membership, role administration, account recovery,
  and a supported sign-in path are live; document that CLI tokens are scoped to
  the exact registry origin.
- [ ] The Team allowance is calibrated against at least 30 days of scanner,
  storage, model, worker, and egress traces, including the 24-hour rescan case.
  Published limits must be enforceable and explain what happens at the cap.
- [ ] Hosted skills.sh and any other source advertised on the homepage have
  current physical source resolution, cold deduplication, approved-cache,
  transfer, install, changed-source, unauthorized, and cross-tenant evidence.
  Otherwise describe them as planned or supported only in local/source tests.
- [ ] Native Windows and Linux validation is obtained before claiming broad
  cross-platform support. Existing nonnative QEMU/Wine evidence does not close
  this gate.
- [ ] Support has an owner and response target for blocked scans, stale
  evidence, failed imports, revoked releases, restore requests, billing, and
  source outages. Publish a status/incident communication path before paid
  signup.

The launch decision should remain **beta only** when a required platform check,
mutation, billing path, positive hosted install, or tenant isolation proof is
failed, cancelled, skipped, or queued. A ready deployment or healthy endpoint
alone is reachability evidence, not product acceptance.

## Operational and product gaps to close

The following gaps are commercial blockers or should be visible in the first
pilot agreement:

- **Identity and tenancy:** the baseline uses one organization per deployment,
  bearer-token bootstrap, and signed browser sessions. Durable member lifecycle,
  OIDC/device flow, SSO/SCIM, account recovery, and self-serve workspace
  administration are future work. Hosted tenant isolation needs a current
  authenticated proof.
- **Billing:** billing/payment is not configured for a real account. Usage
  metering, trial lifecycle, tax, invoices, refunds, spending caps, overage
  packs, and subscription deletion/reconciliation are not launch facts.
- **Scanner operations:** scanner runtime, image licensing, per-engine cost,
  concurrency, retries, and 24-hour freshness rescans need production
  measurements. Required failures remain closed, which is correct behavior but
  has direct availability and support consequences.
- **Source acceptance:** local multi-source adapters and the bounded ClawHub
  preflight do not establish broad hosted provider acceptance. The representative
  ClawHub item was quarantined; approved cache, transfer, and install acceptance
  for an allowed representative remain open. The hosted skills.sh physical
  pull-through path has the same boundary until its evidence is current.
- **Storage and recovery:** Files SDK/provider credentials and conformance,
  PostgreSQL/state recovery, report retention, orphan cleanup, and operator
  quiescence need a documented production runbook per deployment topology.
- **Client support:** v0.4.0 package evidence is Mac arm64 plus nonnative
  Linux/Windows checks; native Windows/Linux CI and wider agent discovery need
  proof before being used as a broad compatibility claim.
- **Review and AI cost:** Eve is bounded and advisory; live model/OIDC
  credentials are deployment inputs. Candidate content must stay out of model
  logs and third-party destinations unless a tenant policy explicitly allows it.
- **Legal and trust operations:** licensing/provenance review, abuse and
  takedown process, data-processing terms, retention/deletion, incident response,
  and customer support are needed. No compliance certification, residency,
  uptime SLA, or security guarantee is currently established.
- **Future scope:** MCP distribution, a richer context-package model, quality
  scores/evals, author CI, workspace membership, and a public marketplace are
  roadmap items. Keep them out of first-launch entitlements.

## Source notes

Competitor and pricing observations above were checked against primary sources
on 2026-09-15. Published prices and product surfaces are live and may change;
the links are the source of truth at the time of a pricing review. Internal
capability claims are bounded by [`README.md`](../../README.md),
[`product.md`](../product.md), [`roadmap.md`](../roadmap.md),
[`scanning-and-hooks.md`](../scanning-and-hooks.md),
[`eve-reviewer.md`](../eve-reviewer.md), and
[`verification-current.md`](../verification-current.md) in this checkout.
