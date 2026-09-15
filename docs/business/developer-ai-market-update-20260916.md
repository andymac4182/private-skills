# Developer tools and AI coding-agent market update

**Checked:** 15 September 2026 at approximately 16:40 UTC (16 September 2026 at approximately 02:40 AEST)

**Purpose:** This is a dated addendum to the [market research](market-research.md)
and [market decision brief](market-decision-brief.md). It fills the open B14
questions about current developer-tool buying, agent adoption, and distribution.
The earlier documents remain the source of record for the broader category map,
Tessl, JFrog AI Catalog, skills.sh, ClawHub, Cloudsmith, the brand screen, and
the existing MR/A experiment backlog. This update concentrates on the layer
those documents only partly cover: provider accounts, admin controls, quotas,
and the paths by which a skill reaches a developer.

The sources below are vendor documentation, product pages, and vendor
announcements. Their feature, pricing, and adoption statements are attributed
to the vendor and are not independent evaluations. No customer interviews,
conversion data, or external outreach were performed for this update. Nothing
here is a claim that a scanner makes a skill safe, secure, or malware-free.

## What changed in the market signal

The strongest new signal is the convergence of agent access and agent
customization inside the provider account. Current provider pages combine
team or enterprise seats with one or more of private skill/plugin distribution,
SSO or SCIM, policy controls, usage analytics, quotas, and billing. A team that
already pays for an agent can often distribute its own instructions from a
repository, an IDE extension, a managed settings directory, or a provider
marketplace.

That changes the buying question for Private Skills. A standalone private
directory is easy to compare with Tessl or JFrog, but it is also competing with
an existing agent provider's control plane. The narrow opportunity to test is a
neutral release and evidence layer: keep source identity, revision, checks,
policy decision, and installed bytes together, then produce the provider
specific files or plugin package that a team already knows how to distribute.
This complements provider distribution until evidence shows that a team needs a
separate catalog or control plane.

The second signal is bounded consumption. Provider plans use seats, included
credits, request quotas, pooled usage, or post-pool charges. A Private Skills
offer should therefore make its billable and hard-stop units legible. It should
not imply unlimited scans, storage, agent runs, or support while those costs and
the value metric are unresolved.

The third signal is a pilot-to-expansion motion. OpenAI's team pricing update
explicitly describes small groups starting pilots, proving value in a few
workflows, and expanding. That is a vendor-stated go-to-market pattern, not
evidence of demand for Private Skills. It supports keeping the first offer to a
small, repeatable source-to-release-to-install workflow.

## Current primary-source signals

| Source checked | Vendor-stated signal | Buying, adoption, or distribution meaning |
| --- | --- | --- |
| [OpenAI: Codex pay-as-you-go for teams](https://openai.com/index/codex-flexible-pricing-for-teams/) (published 2 April 2026; updated 24 June 2026) and [role plugins](https://openai.com/index/codex-for-every-role-tool-workflow/) (2 June 2026) | The April article described Business and Enterprise workspaces adding Codex-only seats with token-based pay-as-you-go usage; its 24 June update says new Business pay-as-you-go seats stopped while existing seats remain. OpenAI also describes plugins that bundle apps, skills, instructions, and workflows, with admin control over app permissions. | The provider account can own both the pilot budget and the workflow package. A Private Skills pilot must show what the release record adds after the team already has Codex access. Treat provider pricing and vendor-reported adoption numbers as volatile marketing inputs, not our pricing or demand evidence. |
| [GitHub Copilot seats and billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/seats-and-billing-cycles) and [about agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) (current pages checked 15 September 2026 UTC) | Copilot Business is listed at $19/user/month with 1,900 AI credits per user; Enterprise at $39/user/month with 3,900. Seats are assigned and billed by organization or enterprise, usage beyond the credit pool is metered, and budgets can control spend. Agent Skills work across Copilot cloud agent, code review, CLI, app, VS Code, and JetBrains; project locations include `.github/skills`, `.claude/skills`, and `.agents/skills`. | GitHub is both a procurement system and a repository-native distribution path. A useful integration can preserve the source/revision/digest record while exporting a supported skill into a repository location. `pskills` should not be positioned as a replacement for Copilot licensing or as automatically portable across every Copilot surface. |
| [VS Code Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) and [Agent Plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins) (current pages checked 15 September 2026 UTC) | VS Code describes Agent Skills as an open standard for instructions, scripts, and resources and describes Agent Plugins as packages distributed through plugin marketplaces. Some plugin capabilities are client-specific even when skills and MCP servers are portable. | Repository and marketplace distribution are already familiar developer motions. The product needs a canonical content representation plus target-specific manifests and conformance evidence. “Open standard” does not establish that policy, hooks, tools, or install behavior match between clients. |
| [Cursor pricing](https://cursor.com/en-US/pricing) and [plugin documentation](https://prod.cursor.com/docs/plugins) (current pages checked 15 September 2026 UTC) | Cursor Teams is listed at $40/user/month with centralized billing, a team marketplace for rules, skills, and plugins, usage analytics, team privacy mode, and SAML/OIDC. Enterprise adds pooled usage, invoice/PO billing, SCIM, access controls, audit logs, and service accounts. Team marketplaces can restrict access by organization group, use Default Off/On/Required modes, import a GitHub repository, and auto-refresh it at most every ten minutes. Cursor says its public marketplace plugins are manually reviewed. | Cursor's team marketplace is a channel substitute with a strong incumbent distribution path. A branch-imported marketplace can change as the repository changes, so a source revision and immutable digest are a potential complementary value; this is an inference to test, not a claim of a gap in Cursor. A Private Skills connector should be able to emit a Cursor-compatible package and explain exactly which review, access, and update decisions remain in the registry. |
| [Claude Code plugins](https://code.claude.com/docs/en/plugins), [skills](https://code.claude.com/docs/en/skills), and [organization setup](https://code.claude.com/docs/en/admin-setup) (current pages checked 15 September 2026 UTC) | Claude describes standalone configuration for quick experiments and plugins for sharing, versioned releases, and reuse across projects. A private repository can host a team marketplace. Managed settings take precedence over local configuration and can restrict tools, MCP servers, marketplace sources, sideloading, and customization. Teams/Enterprise provide seat-based access; Console and cloud providers change billing, authentication, compliance, and feature availability. | Claude exposes both the maintainer's packaging path and the administrator's policy path. Mixed-provider teams may need more than one delivery mechanism, which creates switching friction. A Private Skills adapter should preserve content and release evidence while recording target-specific policy and feature limits; it must not claim that a Claude plugin is equivalent to a Copilot, Cursor, or `pskills` release. |
| [Gemini Code Assist overview](https://docs.cloud.google.com/gemini/docs/codeassist/overview), [setup](https://docs.cloud.google.com/gemini/docs/codeassist/set-up-gemini), and [quotas](https://docs.cloud.google.com/gemini/docs/quotas) (overview last updated 15 September 2026; quota page last updated 3 September 2026) | Standard and Enterprise are purchased and assigned through Google Cloud administration. Setup requires a subscription, license assignment, a project with the Gemini API enabled, and IAM roles. Enterprise adds private-repository code customization. The quota page lists 1,500 agent-mode/CLI requests per Standard user per day and 2,000 per Enterprise user per day; GitHub review is a separate preview quota. The overview says consumer IDE/CLI access changed on 18 June 2026. | Account, project, IAM, and quota prerequisites are part of adoption, not an afterthought. A pilot guide should list the exact provider prerequisites and distinguish a registry's own limits from provider quotas. Cross-provider support should be named and tested per target rather than inferred from the Agent Skills file format. |
| [Amazon Q Developer pricing](https://aws.amazon.com/q/developer/pricing/), [administrator permissions](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/id-based-policy-examples-admins.html), and [IDE setup](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-in-IDE-setup.html) (current pages checked 15 September 2026 UTC) | Q Developer lists a free tier with 50 agentic requests per month and a Pro tier at $19/user/month, with an admin dashboard, policy management, and bounded transformation allocations. AWS documents IAM Identity Center/Organizations administration and IDE distribution and authentication paths. | Free-to-paid activation, account administration, quotas, and provider-specific IDE authentication all affect adoption. This is a reminder to keep provider adapters replaceable and to record the provider/version used for a conformance result. It also argues for clear Private Skills hard stops and an export path that does not assume one provider-specific path will remain unchanged. |

These signals do not prove that any provider's controls are sufficient or
insufficient for a particular organization. They show where a buyer already
has budget, identity, policy, and distribution decisions, and therefore where a
new release layer will encounter the least or most friction.

## Direct competitors and substitutes

| Alternative | Relationship | What a buyer can already get | The focused comparison to test |
| --- | --- | --- | --- |
| Tessl | **Direct competitor** | The existing market research records Tessl's registry, package, governance, evaluation, and observability positioning. | Does a smaller source-to-release-to-install record answer the first operational questions faster for a team with a small skill set? Keep the comparison source-linked and do not imply Tessl lacks governance or portability. |
| JFrog AI Catalog / Agent Skills Registry | **Direct enterprise alternative** | The existing research records a unified catalog for models, plugins, MCP, and Agent Skills with policy, curation, and access controls. | Does a skill-specific workflow fit alongside an existing artifact platform with less setup, or is JFrog already the natural control plane? Test the boundary instead of claiming a universal replacement. |
| Cursor team marketplace; Claude plugin marketplace; GitHub/VS Code repository and plugin paths | **Provider-native channel substitutes** | Team access, group or policy controls, repository import, plugin/skill packaging, and provider-specific installation. | Can Private Skills retain a source, revision, check, policy, and installed-digest trail while emitting the provider artifact? If not, the product should integrate with the channel or narrow its promise. |
| Gemini Code Assist and Amazon Q cloud/IDE flows | **Cloud-platform substitutes** | Provider billing, identity, quotas, IDE or CLI access, and cloud-specific administration. | Can the pilot accommodate project/account/IAM setup without hiding the provider dependency? Record provider/version/quota boundaries and keep adapters replaceable. |
| skills.sh and ClawHub | **Public or ecosystem-specific discovery/install substitutes** | The earlier research records familiar public discovery, versioning, and install mechanics. | Test the added value of private authorization, immutable release evidence, and repeat verification for a team-owned skill. A public page, download, or scan summary is not customer demand or approval evidence. |
| Cloudsmith, GitHub Packages, npm, or an internal object store | **Artifact storage and access substitutes** | Existing engineering ownership, access control, package retention, and sometimes policy or audit capabilities. | Run a side-by-side task and ask which system answers source identity, review/policy result, release decision, and installed digest. Keep storage portable and do not force migration before the release record proves useful. |
| Noma, Check Point AI Guardrails, HiddenLayer, and similar controls | **Adjacent runtime/security products** | Runtime or broader AI security controls. | Treat them as possible integration or approval context. They are not substitutes for a skill release admission record, and Private Skills should not claim runtime enforcement. |

The direct competitors compete for the registry/control-plane budget. The
provider-native and cloud alternatives compete for the distribution and
administration step inside an already purchased agent. Public ecosystems
compete for discovery convenience. Artifact repositories compete for storage
ownership. Keeping these relationships separate prevents a comparison page from
calling every adjacent tool a competitor or claiming a capability that is only
present in one provider's product.

## Buyer and adoption implications

The likely economic buyer remains a platform or DevEx lead, engineering manager,
or application-security lead with authority over the team's agent workflow. The
daily user is a platform engineer or skill maintainer who needs a short install
and update loop. Security, compliance, and procurement become approvers when the
team needs policy evidence, retention answers, deployment choices, or a spend
boundary. This is a sampling hypothesis; no buyer validation has been recorded.

The strongest triggers to test are:

1. A team has bought one or more agent providers but cannot answer which source,
   revision, or bytes a distributed skill came from.
2. The same skill must reach two named agent surfaces, or an existing provider
   marketplace is not the desired system of record for release decisions.
3. A maintainer needs to update a skill without mutating the bytes already
   approved or without losing the prior review and check context.
4. An administrator needs hard limits for storage, scan work, agent/Eve work,
   or provider-linked usage and wants the stop condition to be visible before
   the operation starts.
5. A developer can discover a skill quickly, but the organization needs a
   repeatable, private path that another developer can verify.

The likely adoption path is: discover a skill in an existing repository or
provider surface; run one guided source-to-release workflow; install and verify
the same digest on a second machine or target; then decide whether group
distribution, audit export, retention, deployment, or procurement material is
worth adding. The path should be measured as a hypothesis, not described as a
current funnel.

Switching friction is likely to come from:

- provider account and seat ownership already carrying the budget;
- provider-specific paths, namespaces, manifests, hooks, policy precedence,
  and remote versus local session behavior;
- a team marketplace or repository import already being “good enough” for
  distribution;
- duplicate identity, access, audit, and policy administration;
- differences between seat, pooled, credit, request, and overage models; and
- deployment, data retention, support, and legal review requirements that a
  small pilot may not yet answer.

This favors a complementary first offer. Give the maintainer a canonical
release record and provider export, then let the existing provider account
continue to own the developer-facing install where that is the team's chosen
path.

## Distribution recommendation

Prioritize channels in this order:

1. **Repository and CLI:** provide a source-linked template and the documented
   `pskills` path. Preserve the Agent Skills content and add only release,
   digest, policy, and target metadata that the adapter owns.
2. **Named provider exports:** generate or publish to a supported GitHub/VS
   Code, Cursor, or Claude target only after a sanitized conformance fixture
   passes. Keep a matrix of exact paths, manifests, namespaces, and update
   behavior.
3. **Existing team marketplaces:** treat Cursor and Claude marketplaces as
   downstream distribution channels. Do not require a team to replace its
   marketplace before the evidence record adds value.
4. **Public discovery:** keep skills.sh and ClawHub as comparison and possible
   source inputs. Public listing or install convenience should not be confused
   with private approval or demand validation.
5. **Artifact repositories:** support a clear import/export boundary for
   Cloudsmith, GitHub Packages, npm, or object storage when a team already owns
   that infrastructure. Avoid an early storage migration project.

The website and launch material should say:

> Keep a source, release decision, and repeatable install record for the
> AI-agent skills your team distributes through its chosen tools.

The proof order remains source identity and revision, content digest, required
checks and configured policy result, then the immutable release or pack and
the install verification. Say “supported targets” only for named passing
fixtures. Avoid “one marketplace for every agent,” “drop-in” compatibility,
unconditional safety language, and any claim that a provider's policy or
scanner behavior is inherited automatically.

## Positioning and validation experiments

These are proposed experiments only. They have no participant, conversion, or
customer result. Run them with internal readers or explicitly consented
participants when the relevant work is authorized; do not treat page visits,
signups, vendor customer stories, or a successful local fixture as adoption
evidence.

| ID | Hypothesis | Smallest useful test | Measure and decision rule |
| --- | --- | --- | --- |
| DA01 — provider export | A team will keep a neutral release record if it can still install through its existing agent surface. | Use one sanitized skill and export it to two named targets chosen from GitHub/VS Code, Cursor, and Claude. | Record setup steps, target-specific files, revision/digest preservation, and first-repeat completion. List only targets whose fixtures pass; classify failures as content, path, manifest, or provider behavior. |
| DA02 — evidence gap | Source/revision/check/policy/install evidence is useful beside a provider marketplace listing. | Give readers a provider listing and a Private Skills release card for the same fixture. Ask who can answer where it came from, what changed, what checks ran, who or what admitted it, and what bytes were installed. | Use the existing comprehension thresholds where applicable; record whether the reader chooses a neutral record, provider record, or both. If no gap is understood, position Private Skills as an export/conformance layer rather than a separate catalog. |
| DA03 — control-plane placement | The first buyer will prefer a small add-on to the agent account or artifact repository they already administer. | Ask platform/DevEx readers to map source, policy, release, and install records across their current GitHub, Cursor, Claude, or artifact workflow. | Count duplicate systems, missing evidence, and required owners. If a provider already covers the job end to end, prioritize integration and remove replacement language. |
| DA04 — bounded cost comprehension | Buyers will accept a usage boundary when the unit and hard stop are visible before work starts. | Run a local/test-mode fixture with explicit storage bytes, scan operations, and Eve/agent budget reservations; show seat, pooled, quota, and overage examples as provider context only. | At least 6 of 8 readers should identify the billable unit, reservation, hard stop, and reconciliation path without a prompt. If they cannot, simplify the meter and keep public allowances unpublished. |
| DA05 — immutable update | The release record matters when a provider or repository source changes after an install. | Release revision A, verify it on two targets, update the source to revision B, then prove the old digest and new digest remain distinguishable. | Record time to update, accidental mutation, and whether the maintainer can explain the difference. If not, improve lock/update UX before expanding targets. |
| DA06 — policy delivery | Mixed-provider teams need a documented way to carry release evidence without pretending policies are portable. | Compare the same policy-admitted release on two providers and list which controls are registry-owned, provider-owned, or unavailable. | Every control must have one owner and one observed result. If parity cannot be stated, publish a bounded compatibility table and a clear responsibility split. |
| DA07 — procurement readiness | Deployment, retention, identity, and support questions can block a technically successful pilot. | Use a documentation review with platform/operations readers covering deployment mode, data handling, retention/export, SSO/SCIM, support contact, and invoice path. | Classify each answer as documented, configured, or unresolved. Unresolved answers become roadmap or launch-boundary items; do not promise enterprise packaging from the review alone. |
| DA08 — message and package | “Release evidence and repeatable install” will be clearer than “private registry” when a provider marketplace already exists. | Test two factual message cards and three package shapes: evaluation, team, and organization. Do not show firm prices. | Record role, chosen message, desired package boundary, and value metric. Keep the winner as a hypothesis until repeated observations agree. |

## Pricing and packaging hypothesis

The provider sample uses several commercial units at once:

- GitHub and Cursor publish per-user seats and usage controls;
- Claude combines seat-based access with Console or cloud-provider billing
  choices;
- Google combines license assignment with project, IAM, and request quotas;
- Amazon Q combines per-user pricing with included requests, pooled
  transformation allocations, and possible overage; and
- OpenAI's Codex update illustrates a pilot-oriented seat and token-billing
  path that can change by plan and date.

This is a reason to keep Private Skills pricing as a preview. Test value units
that match the release workflow: active source connections, governed releases,
retained evidence, organizations or teams, and separately metered storage,
required scans, and Eve/agent work. A reservation before expensive work and a
durable reconciliation record are more credible than a post-hoc usage count.
Provider charges remain the provider's responsibility and should not be mixed
with Private Skills allowances.

The first offer can remain a guided evaluation or local/test-mode demonstration
with one source, one release, one named target, and one repeat verification. It
should have a visible no-purchase path while the company entity, support
destination, legal review, cost-to-serve, and payment configuration are open.
No firm public price, live checkout, account creation, or live charge is
implied by this document.

## Roadmap implications

| Horizon | Product priority | Why the current signals support it |
| --- | --- | --- |
| Now | Make the source/revision/content-digest, checks, policy, release, and install record reproducible; keep content compatible with the Agent Skills standard; document hard limits and disabled/unconfigured states. | Every provider can distribute content, but the buyer still needs a trustworthy explanation of what was released and installed. This is the smallest cross-provider story. |
| Now | Build a repository-first export boundary and two named conformance fixtures, with provider/version recorded for every result. | GitHub/VS Code, Cursor, and Claude all have different paths despite shared skill concepts. A measured support list is more useful than a universal claim. |
| Next | Add provider adapters for marketplace/plugin manifests, update and revoke semantics, and policy responsibility mapping. | Provider marketplaces can own distribution, but their access modes, update cadence, and policy controls differ. The adapter should make that boundary visible. |
| Next | Add budget reservation, reconciliation, usage visibility, and per-operation explanations for storage, scans, and Eve/agent work. | Provider plans train buyers to expect quotas, pooled usage, budgets, or overage. Private Skills must provide the same operational clarity for its own work. |
| Next | Add audit export, role separation, retention/export documentation, and deployment choices only where a pilot identifies a real blocker. | These are procurement requirements, but the current repository has no customer evidence to justify a larger enterprise surface. |
| Later | Evaluate SSO/SCIM, private connectivity, additional provider targets, and marketplace partnerships after conformance and operating support are proven. | Provider accounts already own identity and distribution; broader integrations carry ongoing support and compatibility cost. |

The current brand remains **Private Skills**. ReleaseLoom and Vouchpack remain
unselected shortlist candidates in the [brand/domain screen](brand-domain-shortlist.md);
this market update does not choose a name, register a domain, or change the
existing tracker.

## Source notes and limits

All external pages above were opened or searched on 15 September 2026 UTC
(16 September 2026 AEST, around 02:40 local time).
Google's quota page states its last update as 3 September 2026 UTC and its
overview states 15 September 2026 UTC. OpenAI's pricing article carries an
April 2026 publication date and a June 2026 plan update. Provider pricing and
feature pages can change without notice, so recheck them before publishing
comparison or pricing copy.

The current sources establish vendor-stated product mechanics and commercial
signals. They do not establish independent adoption, quality, security,
customer satisfaction, willingness to pay, or a successful Private Skills
workflow in a hosted deployment. The four existing business documents and the
unchanged B14–B16 tracker remain the place to record future research outcomes.
