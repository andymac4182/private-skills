# Market and launch decision brief

**Prepared:** 16 September 2026 AEST (15 September 2026 UTC)

**Working brand:** Private Skills. No replacement name, domain, or customer
validation is approved by this brief.

This is the short application of the fuller [market research](market-research.md),
[launch plan](launch-plan.md), and [brand/domain shortlist](brand-domain-shortlist.md).
Competitor capabilities below come from the linked primary materials. They are
not independent quality, adoption, or willingness-to-pay assessments.

## Decision in one page

- **Positioning to test first:** Private Skills gives an engineering team a
  clear path from an AI-agent skill source to a reviewed, repeatable install.
- **Initial buyer:** a platform or developer-experience lead who owns the
  team's skill workflow and can sponsor a small evaluation. Application
  security or compliance is an approver or influencer when policy evidence is
  required. The daily user is a platform engineer or skill maintainer.
- **First use case:** bring one internal skill and one approved upstream skill
  through source identity, required checks, a policy decision, an immutable
  release or pack, and a `pskills` install that another engineer can verify.
- **Offer:** a guided evaluation or team pilot with no public firm price,
  checkout, or payment claim. The public page should keep the current pricing
  preview until value, cost-to-serve, and support inputs are known.
- **Distribution:** documentation and CLI examples first, then named agent
  integration notes and consented evaluation sessions. No outreach, paid
  placement, or public launch post is part of this decision.

## Three positioning options

| Rank | Message to test | Best fit | Evidence it must show | Risk to watch |
| --- | --- | --- | --- | --- |
| **1 — recommended** | **A clear path from an AI-agent skill source to a reviewed, repeatable install.** | Platform/DevEx lead and maintainer who must answer where a skill came from and what was installed. | Source identity and revision; content digest; required checks and configured policy result; release or pack; repeat install or verification. | “Reviewed” must allow for a policy that admits automatically. A human step applies only when that review gate is configured. |
| **2 — category first** | **A private registry for teams to review and distribute AI-agent skills.** | Buyer who is first searching for a private skill registry. | Private access, release versions, source record, policy state, and the documented CLI path. | Tessl, JFrog, and general artifact platforms make registry or governance alone a weak differentiator. |
| **3 — proof first** | **Know where a skill came from, what checks ran, and what your team installed.** | Application-security or compliance reviewer who needs a decision record. | Source, scanner evidence, policy decision, immutable release, and install metadata. | It can sound like a security guarantee. Keep runtime protection, malware-free claims, and universal approval out of the message. |

The recommended message is a positioning hypothesis. It does not claim that
scanning, governance, provenance, private storage, evaluation, or distribution
is unique. The product must continue to distinguish Eve's review suggestions,
draft authoring, configured policy admission, and any required human gate.

## Sourced alternatives and the buying implication

| Category | Primary-source signal | Relationship to Private Skills | Practical comparison |
| --- | --- | --- | --- |
| [Tessl Registry and documentation](https://tessl.io/registry) | Tessl presents agent skills as evaluated, secured, versioned, and discoverable; its [documentation](https://docs.tessl.io/) describes a registry/package manager, governance, RBAC, policies, audit trails, evaluations, and observability. | **Direct competitor.** | Test whether a smaller source-to-release-to-install record answers a maintainer's questions faster than a broad package and evaluation platform. Do not claim Tessl lacks governance or portability. |
| [JFrog AI Catalog / Agent Skills Registry](https://jfrog.com/ai-catalog/mcp-registry/) | JFrog lists an Agent Skills Registry beside model, plugin, and MCP registries and describes a unified catalog with policy, curation, access control, and coding-agent integrations. | **Direct enterprise alternative.** | Test a focused first workflow that can sit alongside an existing artifact platform. Storage, policy, or scanning alone cannot be the wedge. |
| [skills.sh CLI](https://www.skills.sh/docs/cli) | The public `skills` CLI installs from a source with `npx skills add`, and its docs list packs, agent targets, and anonymous install telemetry with an opt-out. | **Public discovery and install alternative.** | Preserve a short developer path while adding private authorization, release evidence, and repeat verification. Do not imply `pskills` is drop-in compatible. |
| [ClawHub documentation](https://github.com/openclaw/clawhub/blob/main/docs/clawhub.md) | ClawHub is a public OpenClaw registry with versioned bundles, tags, changelogs, download/star signals, scan summaries, and moderation. | **Ecosystem-specific alternative.** | It shows existing capability and competitive investment. Compare only the private, provider-neutral workflow; do not call it demand validation or claim provider-neutral parity. |
| [Cloudsmith artifact management](https://cloudsmith.com/platform-features/artifact-management) | Cloudsmith offers private repositories, raw files, upstream proxy/cache, access controls, audit logs, retention, and checks across many formats. | **Adjacent artifact-repository substitute.** | Run a side-by-side task: which source, review, policy, and install questions are answered by the existing repository, and which require a skill-specific release record? |

The first purchase conversation should ask which of these jobs is urgent:

- tracing a skill to its source and revision;
- keeping failed or stale required checks out of the install path;
- giving a maintainer a repeatable release and update process; or
- making another engineer's install reproduce the same approved bytes.

If a team only needs raw file storage or public discovery, an existing
artifact repository or public directory may be a better fit.

## Buyer, daily user, and adoption path

| Role | First job | Purchase or adoption trigger | Proof needed in the first evaluation |
| --- | --- | --- | --- |
| Platform/DevEx lead | Give developers one team-approved way to find and install skills. | A growing set of internal or upstream skills has no shared release trail. | One source-to-release-to-install transcript and a second verification. |
| Skill maintainer / platform engineer | Intake, update, and explain a skill without copying files between projects. | A release must retain source, revision, digest, and policy context. | Release history, source record, checks, and CLI install path. |
| Application security / compliance | Decide what evidence is required before distribution. | A failed, stale, or unreviewed skill needs a visible disposition. | Required checks, findings, policy result, quarantine, and any configured human decision. |
| Engineering manager | Reduce one-off instructions and drift across projects. | Two engineers need the same approved skill or pack on different machines. | Repeatable install and lock metadata, with no claim of remote retraction of bytes already installed. |
| Procurement / operations | Assess deployment, retention, support, and spend boundaries. | The team needs a managed service or a defined self-managed path. | Actual deployment and data-handling answers; no unsupported SLA, residency, SSO, or compliance promise. |

The likely sequence is: a maintainer feels the operational pain, a platform
lead sponsors a small evaluation, security or compliance reviews the evidence,
and an engineering manager or platform owner approves expansion. This is a
sampling hypothesis, not a description of a validated buying process.

### Switching friction to test

| Starting point | What the team already has | Likely switching friction | Pilot response |
| --- | --- | --- | --- |
| Public skills directory | Fast discovery and a familiar install command. | A private review and release path adds a step before a developer sees a skill. | Keep the first workflow to one source, one decision, and one install; measure added time and the answers it makes available. |
| Tessl or another broad control plane | Registry, governance, evaluation, and agent distribution may already be bundled. | A new system can duplicate policy, identity, or package management. | Show the smallest skill-specific workflow and record whether it answers a source/digest/install question the current system leaves open. |
| JFrog, Cloudsmith, npm, or GitHub Packages | Storage, access control, and existing engineering ownership. | Migration, new permissions, and another artifact vocabulary. | Test side-by-side ingestion or a clear boundary; do not ask a team to replace storage before the release record is useful. |
| Provider-specific agent marketplace | Admin-managed distribution inside an agent surface. | Provider-specific paths make a cross-agent promise hard to prove. | Support only named passing fixtures and document content/path differences. |

## Offer and distribution choice

| Offer shape | Scope to test | Boundary that must remain explicit |
| --- | --- | --- |
| Guided evaluation | One workspace or local operator, one source, one release, one install, and one repeat verification. | Local `--allow-unscanned` is disposable operator evaluation only. It is not production policy evidence. |
| Team pilot | Several maintainers using private sources, required checks, packs, release history, and the normal CLI path. | Support destination, hosted identity, deployment, retention, and commercial terms remain inputs to confirm. |
| Organization discovery | Role separation, deployment/data handling, retention/export, source restrictions, and support requirements. | Do not promise enterprise SSO, SCIM, residency, SLA, or payment readiness until those capabilities and operations are accepted. |

Use documentation as the first distribution channel:

1. Keep the current homepage, [demo route](../../apps/marketing/src/routes/demo.tsx), and [getting-started guide](../../apps/marketing/src/routes/docs.getting-started.tsx) aligned around the recommended message and a hosted-user versus local-operator split.
2. Publish CLI and agent-surface notes only after commands and install paths are
   checked against the actual parser and a named fixture. Measure task
   completion and confusion, not page impressions as demand.
3. Test a source-linked comparison note with internal readers or explicitly
   consented participants. Keep competitor wording attributed to its source.
4. Use a real request page only when `PUBLIC_CONTACT_URL` points to one. Until
   then, route visitors to the demo and guide without inventing support
   contact details.

The existing research defines useful gates: 8 of 10 readers choose the correct
hosted/operator path, 4 of 5 complete a first workflow without unplanned help,
6 of 8 identify source/revision/digest/check/policy evidence, and 4 of 6
complete a two-agent repeat test. These are future study criteria, not current
performance or conversion results.

## Launch-week actions

These actions are feasible without outreach, spend, or a brand decision:

1. Freeze the first message and proof order: source identity, required checks
   and policy result, then release/pack and install verification.
2. Run the sanitized demo and getting-started commands against a known local
   fixture. Record the exact parser/help output and any unsupported agent
   target rather than broadening the copy.
3. Test the hosted-user and self-host operator paths with internal readers or
   explicitly consented participants. Record role, task, duration, confusion,
   and the first failed step.
4. Prepare the source-linked competitor explainer and one public-safe sample
   install transcript. Keep them drafts until support, licensing, source, and
   brand decisions are ready.
5. Keep pricing as a no-purchase preview. Decide the value metric and support
   boundary only after the pilot records release, scanner, storage, egress,
   model, and support cost dimensions.

## Finding-to-action map

| Finding from the source review | Homepage copy | Launch offer | Product priority |
| --- | --- | --- | --- |
| Registries, evaluation, policy, and scanning are already marketed by larger platforms. | Lead with the complete source-to-install decision trail rather than “secure skills.” | One guided workflow with a visible release record. | Make one transcript reproducible and label every evidence boundary. |
| Public directories make installation familiar but do not answer the team's private decision questions. | “Give your team control of private AI-agent skills.” | Team pilot around one internal and one approved upstream source. | Source-aware intake, immutable release/pack, policy state, and CLI verification. |
| Provider surfaces have different install conventions. | Say “supported targets” only when a fixture passes. | Include a compatibility check in the evaluation. | Run two named agent conformance tests before publishing portability copy. |
| Artifact repositories can already store files and enforce general policy. | Explain which source, review, and install questions stay together in this workflow. | Offer side-by-side evaluation where an existing repository is present. | Add import/export and evidence views only when the first comparison shows a gap. |
| Pricing and support depend on variable scanner, storage, model, and deployment cost. | Keep the pricing preview and a clear no-purchase path. | Guided evaluation first; no firm public price. | Measure cost-to-serve and support burden before final allowances or checkout. |

## Brand and domain screen

The current domain-screen source is [brand-domain-shortlist.md](brand-domain-shortlist.md).
The earlier semantic screen in [brand-options.md](brand-options.md) ranked
Packrail, Brintra, and Gusset, but the current registrar/collision screen
advances **ReleaseLoom** and **Vouchpack** instead. Packrail and Brintra have
registered domains or collision signals in the current screen. No name is
selected; keep Private Skills in public copy.

### Ranked candidates

| Rank | Candidate and pronunciation | Why it fits | Collision and domain status |
| --- | --- | --- | --- |
| 1 | **ReleaseLoom** — *ri-LEASE loom* | Directly suggests weaving source, review, and releases into a repeatable path. | Close public-name results include LeaseLoom, Reeloom, and ReleaseOwl. On the 15 September 2026 15:54–15:57 UTC Namecheap recheck, `.com` and `.dev` each showed **Add to cart** at `$11.28/yr` (retail `$14.98`) and `$10.98/yr` (retail `$15.98`), respectively. The `.com` RDAP result remains unverified because the earlier response was an empty-body 404; `.dev` was previously unregistered at check. |
| 2 | **Vouchpack** — *VOUCH-pack* | Connects a visible approval signal with a versioned pack. | `Vouchstack` is a close security-software name. The same recheck showed `.com` and `.dev` **Add to cart** at the same first-year/retail prices as ReleaseLoom. The `.com` RDAP result remains unverified; `.dev` was previously unregistered at check. |
| 3 / hold | **DraftCove** — *DRAFT-cove* | A protected place for a draft before release. | An exact public [DraftCove](https://draftcove.world/) product was found. The recheck showed `draftcove.com` **REGISTERED IN 2025 / Make offer**; it is not a normal registration candidate. |

The registrar cards showed no premium badge for the two leading names and no
renewal price for those target cards. “Add to cart” is a live registrar UI
indication, not confirmed purchasability, reservation, or ownership. No account,
cart, checkout, purchase, or registration was used. `.ai` was not part of this
latest UI recheck. Package, company, GitHub, social-handle, and trademark
clearance remain open for every finalist.

Safe domain directions from the earlier screen include `use<name>.com`,
`<name>.systems`, and `docs.<name>.dev`; these are unverified options, not
availability claims. Repeat registry and registrar checks within 24 hours of
any selection, then run legal, company, package, repository, and handle
clearance. Do not infer a trademark clearance or customer preference from this
scorecard.

## Open decisions

- Whether to keep Private Skills or choose a finalist after spoken-recall and
  collision testing.
- Which deployment and support path a real evaluation requires.
- Which package boundary and value metric buyers prefer; the earlier `$49/$199`
  and later `$99/$249` ideas remain internal hypotheses.
- Which two named agent surfaces pass conformance and can be listed publicly.

The brief is complete as a research recommendation. Buyer preference,
customer demand, conversion, pricing, legal clearance, and production support
remain unvalidated.
