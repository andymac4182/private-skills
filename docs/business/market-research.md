# Developer tools and AI-agent skills market research

**Snapshot:** 15 September 2026 (UTC)

**Purpose:** internal working research for the launch decision. This note separates what a competitor says about its own product, what this repository currently demonstrates, and what remains a positioning hypothesis. It contains no customer, revenue, market-size, or traction claim.

## Reading guide

| Label | Meaning |
| --- | --- |
| **Competitor-stated** | A capability or scope described in the linked vendor or project documentation. |
| **Repository evidence** | A capability described by the checked-in implementation or verification record. |
| **Positioning hypothesis** | A proposed audience, message, or commercial assumption that still needs customer research. |

The product name in the repository remains **Private Skills** for this work. A brand change and a pricing decision are open business decisions.

## Market map

| Product | Relationship | What its primary materials say | Implication for Private Skills |
| --- | --- | --- | --- |
| [Tessl](https://docs.tessl.io/) | Direct competitor | Tessl describes an agentic-development platform with a registry and package manager for public and private context, governance, evaluations, observability, and agent-agnostic use. Its [registry](https://tessl.io/registry) and [evaluation workflow](https://docs.tessl.io/evaluate) put agent skills, package quality, and review in one managed product. | Competes for the full “discover, assess, and manage agent skills” job. A smaller team can be served with a narrower release and distribution workflow, provided that portability and evidence are real. |
| [JFrog Artifactory / AI Catalog](https://jfrog.com/artifactory/) | Potentially direct enterprise competitor | JFrog positions Artifactory as a system of record for software artifacts and explicitly lists AI/ML models plus agent assets such as skills, plugins, and MCP items. Its [AI Catalog](https://jfrog.com/ai-catalog/mcp-registry/) extends that enterprise artifact and governance model to agent assets. | Treat this as a direct governance comparison when a buyer wants one enterprise control plane. Do not frame artifact storage or governance alone as unique; the possible wedge is a focused skill-release workflow that is easier to adopt alongside an existing engineering stack. |
| [skills.sh](https://www.skills.sh/docs) | Direct-adjacent public discovery and install path | The [CLI documentation](https://www.skills.sh/docs/cli) documents `npx skills add` for installing skills and packs, while the project describes public and private packs and warns that routine audits cannot guarantee quality or security. | It is the familiar public discovery and developer-install path. Private Skills can sit in front of selected upstream content and add organization review, release records, and policy-controlled distribution. It must not claim drop-in compatibility with the `skills` CLI unless that is separately verified. |
| [ClawHub](https://github.com/openclaw/clawhub/blob/main/docs/clawhub.md) | Direct-adjacent ecosystem registry | ClawHub describes a public OpenClaw skill/plugin registry with versioned bundles, tags, changelogs, download and star signals, scan summaries, and scan-held or blocked releases. Its [vision](https://github.com/openclaw/clawhub/blob/main/VISION.md) emphasizes provenance and trust evidence for that ecosystem. | It validates demand for provenance and screening in agent-skill distribution, while its OpenClaw-specific public marketplace scope leaves room for a private, provider-neutral team workflow. |
| [Cloudsmith artifact management](https://cloudsmith.com/platform-features/artifact-management) | Adjacent substitute | Cloudsmith describes managed multi-format artifact repositories, upstream proxying, access control, team roles, audit logs, and software supply-chain security. Its [policy management](https://docs.cloudsmith.com/policy-management) materials cover policy-as-code, quarantine, vulnerability, license, deny, and malware controls. | An engineering team may already have this category. The message must explain why skills need source-aware intake, human review, and agent-specific install records in addition to a general artifact repository. |
| [Noma agent control plane](https://noma.security/solutions/agent-control-plane) | Adjacent governance and runtime control | Noma describes discovery of agents, models, skills, MCP servers, and tools, with ownership, access policy, runtime enforcement, and enterprise deployment options. | It addresses runtime identity and permissions. Private Skills should describe a release and distribution layer; it should not imply runtime policy enforcement. |
| [Check Point AI Guardrails](https://docs.lakera.ai/docs/agent-behavior-defense) | Adjacent runtime defense | The documentation describes behavior defense for agents, tool allow/deny lists, detection of dangerous deviation, and treating tool responses as untrusted content. | It protects execution behavior. It is a possible integration or later buyer concern, not the initial product category. |
| [HiddenLayer AI security platform](https://www.hiddenlayer.com/platform) | Adjacent AI security platform | HiddenLayer lists AI supply-chain security, runtime protection, attack simulation, and agentic/MCP security in a broader AI security platform. | It competes for security budget and trust language. Private Skills needs concrete release records and install outcomes rather than a broad AI-security promise. |

This map is a category comparison, not a feature-parity claim. Vendor descriptions change; re-check them before publishing a comparison page.

## ICP hypothesis

The first buyer hypothesis is a platform, developer-experience, or application-security lead in an engineering organization with roughly 20–200 developers and a small infrastructure team. The team has several coding-agent users, an increasing number of internal or upstream skills, and a requirement to keep source, review, and install decisions inside its own controls. The size range and role split are hypotheses for interview sampling, not a claim about the current customer base.

The strongest trigger is a team asking one of these questions:

- Which source and revision did this skill come from?
- Who reviewed it, which checks ran, and what was approved?
- Can another developer install the same bytes on a different machine?
- How do we stop a revoked or failed release from being installed again?

The first user is likely a platform engineer or skill maintainer. The economic buyer may be the platform lead or engineering manager; application security and compliance become approvers or influencers when the team expands. Solo developers, consumer users, and public marketplace publishers are lower-priority segments for the initial launch.

## Wedge hypothesis

Position the product as a **governed release path for AI-agent skills**:

1. An administrator connects one approved source or submits one internal skill.
2. The registry records the source identity and content digest, then validates the complete bundle.
3. Required scanner and policy results determine whether the candidate can proceed.
4. A human reviews the evidence and makes the release decision.
5. The registry publishes an immutable private release or pack.
6. Developers install that release with the `pskills` CLI and can verify the same content on another machine.

The success question is simple: can the team answer “where did this come from, who approved it, what checks ran, and what did we install?” in one place? This is a positioning hypothesis. Hosted provider coverage, source pull-through, and cross-platform installation still need the acceptance work described in the repository verification documents.

The product should describe Eve as a review assistant that prepares evidence or suggestions for a human decision. Eve can apply draft changes in the application, so the public message should distinguish authoring from review and avoid saying that it independently edits source, publishes, merges, or authorizes installs.

## Buyer jobs and proof

| Role | Job to be done | Proof the product should show | Working success measure |
| --- | --- | --- | --- |
| Platform / DevEx lead | Give developers one approved way to find and install team skills. | A source-to-release trail, CLI install, and repeat install verification. | Time from first source to first approved install; repeat install succeeds on a second machine. |
| Application security | Keep risky or incomplete skill content out of the install path. | Required checks, findings, policy decision, quarantine state, and an auditable exception record. | Every failed required check blocks release; reviewers can explain an exception. |
| Engineering manager | Reduce copy/paste drift and make agent adoption repeatable. | A private catalog, immutable versions, packs, and a clear update path. | Fewer one-off install instructions; a new team member can follow the same path. |
| Skill maintainer | Ship a useful skill without losing provenance or review context. | Source revision, digest, release history, review notes, and a new version for changed content. | Time from draft to accepted release; updates retain a traceable history. |
| Procurement / compliance | Understand where content is stored and who can distribute it. | Deployment options, access roles, audit records, scanner configuration, and data-handling documentation. | Review questions can be answered without promising unsupported certifications or controls. |

These measures are research prompts, not current performance claims.

## Positioning recommendation

> For engineering teams rolling out coding-agent skills, Private Skills is a private release and distribution layer that turns source content into reviewable, immutable, installable releases with provenance and scanner and policy evidence.

The differentiation to test is the combination of:

- **Skill-specific release unit:** retains Agent Skills content while adding registry ownership, versions, packs, and release records.
- **Source-aware intake:** can keep source identity, revision, and digest attached to an internal release instead of asking developers to copy content from a public site.
- **Evidence before install:** review and required checks sit before distribution, with failed required checks denying the release.
- **Repeatable installation:** the Rust CLI and lock metadata give developers a consistent project or user install path across supported platforms.
- **Deployment choice:** the registry/API boundary is portable across Nitro server targets and storage adapters; a hosted Vercel deployment is optional rather than the product contract.
- **Human decision boundary:** review assistance can prepare a recommendation, while a human controls release, source edits, and install authorization.

The comparison should be honest:

- Tessl is the closest broad product comparison because it combines a registry, package management, governance, and evaluations.
- JFrog is a serious enterprise substitute because its AI Catalog includes agent assets. Private Skills should win only where a smaller skill-specific workflow has lower setup cost or better source-to-install clarity.
- skills.sh and ClawHub are public or ecosystem-specific distribution paths. They are useful reference points for discovery and installation, but they do not establish that every upstream skill is organization-approved.
- Cloudsmith can cover artifact storage and policy controls. The product needs to prove the value of source-aware skill intake and agent-focused release records on top of, or instead of, that existing infrastructure.
- Noma, Check Point AI Guardrails, and HiddenLayer address runtime or broader AI security. They are adjacent concerns and possible integration targets, not substitutes for a release decision.

Avoid claiming that privacy, scanning, governance, or provenance alone is unique. The focused argument is that a team can move one skill from source to a human-approved, reproducible install with less operational work and clearer evidence.

## Evidence ladder and launch boundaries

### Repository evidence

- The [product brief](../product.md) describes a private team entry point, administrator controls, CLI installation, packs, scanner policy, and revocation.
- The [implementation record](../implementation.md) describes the current TanStack/Nitro web and API surfaces, Rust CLI, storage boundary, acquisition and scanner workers, and the current hosted acceptance limits.
- The [verification record](../verification-current.md) records local and deployed evidence and marks pending hosted source, transfer, and installation acceptance.
- [Scanner policy](../scanners.md) documents the planned scanner adapters, their privacy defaults, and their limitations. It is not a claim that every adapter is enabled in every deployment.
- [CLI and packs](../cli-and-packs.md) documents command and lockfile intent, including the explicit distinction from unmodified `npx skills` behavior.
- [Eve reviewer](../eve-reviewer.md) documents the fixed tool boundary and human decision point.

### Competitor-stated evidence

The market-map links above are the primary materials used for competitor scope. They describe what each vendor or open-source project says it supports; they are not independent evaluations of quality, security, adoption, or pricing.

### Unknown or pending

- Broad hosted source-provider coverage and warm-cache/install acceptance.
- A support intake that is usable before a support email or company entity is chosen.
- Deployment, data-processing, retention, and compliance materials for an external buyer.
- Willingness to pay and which value metric buyers prefer.
- Compatibility with any third-party CLI beyond the documented `pskills` path.
- Whether an organization wants a managed service, self-hosting, or both.

### Claims to avoid

- “Safe,” “secure,” or “malware-free” as an unconditional guarantee.
- Customer logos, adoption, revenue, or measured time savings before evidence exists.
- A broad hosted provider launch while acceptance is still pending.
- “Drop-in” `npx skills` compatibility.
- Eve independently editing source, publishing releases, merging changes, or authorizing installs.
- A runtime guardrail or agent-permission product claim.

## Pricing hypotheses

The commercial decision is pending. Do not publish firm prices or checkout. In particular, keep both the earlier `$49/$199` idea and the later `$99/$249` idea out of public copy until customer research resolves the packaging and value metric. The public site should use a pricing preview or an explicit no-purchase path.

Test three packages without assigning public dollar amounts:

| Package hypothesis | Audience | Candidate value boundary |
| --- | --- | --- |
| Evaluation | One team proving the release path with a small source set. | One workspace, limited history, guided setup, and a clear path to repeatable install. |
| Team | Engineering teams with several maintainers and coding-agent users. | Private sources, review and scanner policy, packs, audit history, and normal support. |
| Organization | Multiple teams or stricter deployment and data requirements. | Deployment choice, role separation, retention/export, support commitments, and procurement materials. |

Research value metrics rather than assuming seats or agent count:

- active governed releases and source connections;
- scan volume and retained evidence;
- workspaces or teams under one organization;
- install and update volume;
- support and deployment requirements.

Do not price on model tokens until a real cost and buyer-value relationship is demonstrated. Keep a human-led pilot available while the commercial decision remains open.

## Next research tasks

1. Recruit 5–8 interviews across platform/DevEx, application security, skill maintainers, and engineering management. These are planned interviews, not current customers.
2. Use one real internal skill and one approved upstream skill to test source-to-install time, reviewer questions, and repeat installation.
3. Ask each participant to rank the proof they need: source provenance, scanner evidence, human approval, revocation, install reproducibility, deployment choice, or support.
4. Test evaluation-to-team packaging and willingness to pay without displaying prices publicly.
5. Recheck competitor scope, pricing, and domain status immediately before any public comparison or naming decision.

## Primary references

- [Tessl documentation](https://docs.tessl.io/) and [Tessl Registry](https://tessl.io/registry)
- [Vercel skills CLI documentation](https://www.skills.sh/docs/cli) and [skills.sh documentation](https://www.skills.sh/docs)
- [ClawHub documentation](https://github.com/openclaw/clawhub/blob/main/docs/clawhub.md) and [vision](https://github.com/openclaw/clawhub/blob/main/VISION.md)
- [JFrog Artifactory](https://jfrog.com/artifactory/) and [JFrog AI Catalog / MCP Registry](https://jfrog.com/ai-catalog/mcp-registry/)
- [Cloudsmith artifact management](https://cloudsmith.com/platform-features/artifact-management) and [policy management](https://docs.cloudsmith.com/policy-management)
- [Noma agent control plane](https://noma.security/solutions/agent-control-plane)
- [Check Point AI Guardrails behavior defense](https://docs.lakera.ai/docs/agent-behavior-defense)
- [HiddenLayer platform](https://www.hiddenlayer.com/platform)
