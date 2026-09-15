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
| [ClawHub](https://github.com/openclaw/clawhub/blob/main/docs/clawhub.md) | Direct-adjacent ecosystem registry | ClawHub describes a public OpenClaw skill/plugin registry with versioned bundles, tags, changelogs, download and star signals, scan summaries, and scan-held or blocked releases. Its [vision](https://github.com/openclaw/clawhub/blob/main/VISION.md) emphasizes provenance and trust evidence for that ecosystem. | It shows an existing ecosystem capability and competitive investment in provenance and screening. Its OpenClaw-specific public marketplace scope leaves room for a private, provider-neutral team workflow. |
| [Cloudsmith artifact management](https://cloudsmith.com/platform-features/artifact-management) | Adjacent substitute | Cloudsmith describes managed multi-format artifact repositories, upstream proxying, access control, team roles, audit logs, and software supply-chain security. Its [policy management](https://docs.cloudsmith.com/policy-management) materials cover policy-as-code, quarantine, vulnerability, license, deny, and malware controls. | An engineering team may already have this category. The message must explain why skills need source-aware intake, human review, and agent-specific install records in addition to a general artifact repository. |
| [Noma agent control plane](https://noma.security/solutions/agent-control-plane) | Adjacent governance and runtime control | Noma describes discovery of agents, models, skills, MCP servers, and tools, with ownership, access policy, runtime enforcement, and enterprise deployment options. | It addresses runtime identity and permissions. Private Skills should describe a release and distribution layer; it should not imply runtime policy enforcement. |
| [Check Point AI Guardrails](https://docs.lakera.ai/docs/agent-behavior-defense) | Adjacent runtime defense | The documentation describes behavior defense for agents, tool allow/deny lists, detection of dangerous deviation, and treating tool responses as untrusted content. | It protects execution behavior. It is a possible integration or later buyer concern, not the initial product category. |
| [HiddenLayer AI security platform](https://www.hiddenlayer.com/platform) | Adjacent AI security platform | HiddenLayer lists AI supply-chain security, runtime protection, attack simulation, and agentic/MCP security in a broader AI security platform. | It competes for security budget and trust language. Private Skills needs concrete release records and install outcomes rather than a broad AI-security promise. |

This map is a category comparison, not a feature-parity claim. Vendor descriptions change; re-check them before publishing a comparison page.

## Competitor refresh — 15 September 2026

The initial market map remains useful, but the surrounding agent ecosystem is moving quickly. The following refresh records primary documentation signals that should shape the next tests. These are statements from the linked projects or vendors; they do not prove quality, adoption, security, or willingness to pay.

| Source | Current primary-source signal | Research consequence |
| --- | --- | --- |
| [Tessl evaluation documentation](https://docs.tessl.io/evaluate) and [how Tessl works](https://docs.tessl.io/introduction-to-tessl/how-tessl-works) | Tessl describes a registry and package manager for agent skills, with evaluation signals covering validation, implementation, activation, and scenario-based review. | “We review skills” is too broad to differentiate. Test whether a release record that connects source, decision, digest, and install is easier to use than a general package score. |
| [Cursor plugins](https://prod.cursor.com/docs/plugins) and [Agent Skills](https://prod.cursor.com/docs/skills) | Cursor documents bundles that can include rules, skills, agents, commands, MCP servers, and hooks, with team marketplaces and default, disabled, or required plugin settings. | Team distribution already exists inside an important coding-agent surface. Test the value of keeping source intake and release evidence across agent surfaces rather than claiming distribution itself is new. |
| [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) and [adding skills to cloud agent](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) | GitHub documents skills for Copilot cloud agent, code review, CLI, app, and IDE agent mode, with repository and user skill locations. | Repository-native, provider-specific workflows are becoming normal. Verify which parts of the `pskills` release and install path work alongside these workflows before using “portable” as a public claim. |
| [Claude Code Skills](https://code.claude.com/docs/en/skills) | Anthropic documents the Agent Skills open standard and project, user, enterprise, and plugin skill locations, with skills loaded when relevant. | Portability must be tested at the content and installation boundaries across agent tools. An open standard does not by itself make registry, policy, or lock behavior interchangeable. |
| [JFrog AI Catalog / MCP Registry](https://jfrog.com/ai-catalog/mcp-registry/) | JFrog presents a centralized AI Catalog for models, skills, plugins, and MCP servers, with access controls, policies, and blocking integrated with tools such as Cursor and Claude Code. | This is a direct enterprise governance comparison, not only an artifact-store comparison. A smaller team workflow must win on setup effort, source-to-release clarity, or deployment fit; governance alone is not a unique claim. |
| [skills.sh CLI](https://www.skills.sh/docs/cli) | The public CLI documents `npx skills add` for installing skills and packs and lists filters for several agent tools. The project also documents anonymous telemetry and an opt-out. | Discovery and installation are already familiar developer actions. Test whether teams will adopt a private approval and repeat-install path without requiring compatibility with the public CLI. |
| [ClawHub documentation](https://github.com/openclaw/clawhub/blob/main/docs/clawhub.md) | ClawHub documents versioned OpenClaw bundles with semver, tags, changelogs, scan summaries, source metadata, and lock-file support. | Provenance, scans, and versioning are visible ecosystem investments. Use ClawHub as an ecosystem-specific comparison and avoid implying provider-neutral parity. |
| [Cloudsmith artifact management](https://cloudsmith.com/platform-features/artifact-management) | Cloudsmith documents private and public repositories, upstream proxying, access control, audit logs, multiple package formats, and policy checks. | General artifact infrastructure is a realistic substitute. The test must show the operational value of skill-specific source intake and agent-focused release records. |

This refresh changes the competitive test, not the product evidence. It strengthens the case for a narrow engineering-team workflow while weakening any claim that evaluation, scanning, policy, provenance, private storage, or distribution is unique in isolation.

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
4. If the organization has enabled a review gate, a human reviews the evidence and makes that decision; otherwise the configured policy can admit the candidate automatically after the required checks pass.
5. The registry publishes an immutable private release or pack.
6. Developers install that release with the `pskills` CLI and can verify the same content on another machine.

The success question is simple: can the team answer “where did this come from, what policy or reviewer decision admitted it, what checks ran, and what did we install?” in one place? This is a positioning hypothesis. Hosted provider coverage, source pull-through, and cross-platform installation still need the acceptance work described in the repository verification documents.

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
- **Human decision boundary:** review assistance can prepare a recommendation, while explicit human/API actions control authoring and any configured review gate; Eve cannot publish, merge, or authorize installs.

The comparison should be honest:

- Tessl is the closest broad product comparison because it combines a registry, package management, governance, and evaluations.
- JFrog is a serious enterprise substitute because its AI Catalog includes agent assets. Private Skills should win only where a smaller skill-specific workflow has lower setup cost or better source-to-install clarity.
- skills.sh and ClawHub are public or ecosystem-specific distribution paths. They are useful reference points for discovery and installation, but they do not establish that every upstream skill is organization-approved.
- Cloudsmith can cover artifact storage and policy controls. The product needs to prove the value of source-aware skill intake and agent-focused release records on top of, or instead of, that existing infrastructure.
- Noma, Check Point AI Guardrails, and HiddenLayer address runtime or broader AI security. They are adjacent concerns and possible integration targets, not substitutes for a release decision.

Avoid claiming that privacy, scanning, governance, or provenance alone is unique. The focused argument is that a team can move one skill from source to a policy-admitted, optionally human-reviewed, reproducible install with less operational work and clearer evidence.

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

## Evidence state and tracker reconciliation

The initial desk-research pass recorded in B14–B16 is complete for the evidence it was designed to collect: primary competitor pages were read, the repository evidence was linked, and the candidate names received RDAP and public registrar checks. The pass did not validate a buyer problem, customer demand, conversion, pricing, legal clearance, or production acceptance. The business tracker should keep those items open.

| Area | Initial evidence now recorded | Still unvalidated |
| --- | --- | --- |
| Market category | Primary descriptions for Tessl, JFrog, skills.sh, ClawHub, Cloudsmith, Cursor, GitHub Copilot, and Claude Code, with direct versus adjacent interpretation. | Which category a real team would budget for, and which alternative it would replace. |
| Product wedge | A source-to-policy-to-release-to-install workflow is a positioning hypothesis tied to repository documents. | Whether it is a more urgent job than discovery, evaluation, runtime control, or general artifact storage. |
| Brand and domains | `ReleaseLoom` and `Vouchpack` remain leading candidates; public RDAP and registrar observations are dated in [the shortlist](brand-domain-shortlist.md). | Trademark, company, package, GitHub, social, and checkout clearance; user choice. |
| Buyer and adoption | ICP and role split are explicit sampling hypotheses. | Interviews, guided tasks, repeat use, support burden, and a budget owner. |
| Commercial model | Evaluation, Team, and Organization package shapes are hypotheses; no firm prices are in copy. | Value metric, cost-to-serve, willingness to pay, and payment readiness. |

No customer validation, customer traction, revenue, or market-size claim is made in this document. A future result may confirm, narrow, or reject the hypotheses below.

## Buyer and adoption hypotheses

Run these tests with internal operators or explicitly consented research sessions. Do not send outreach or publish results as customer evidence until the participants, task, date, and raw observation are recorded. The pass signals are decision rules for a future study, not present performance claims.

| ID | Hypothesis | Smallest useful test | Pass signal | If the signal fails |
| --- | --- | --- | --- | --- |
| B17 | A platform, DevEx, or application-security lead feels the provenance and repeat-install problem strongly enough to sponsor a trial. | Six scripted sessions; show the same source-to-install scenario and ask each person to rank the top two operational problems. | At least 4 of 6 independently put source history, release decision, or repeatable installation in their top two. | Revisit the ICP and lead with the problem participants actually rank. |
| B18 | A maintainer and an operator can reach a first approved install without hand-written coordination. | Five consenting teams use one internal skill and one approved upstream fixture from source intake through install. | At least 4 of 5 finish in 30 minutes or less with no unplanned help, and the path records the source and decision. | Remove setup steps or narrow the first workflow; do not increase marketing claims. |
| B19 | Evidence shown before install is understandable to a non-author reviewer. | Eight participants receive a ten-minute walkthrough, then answer where the source, revision, digest, required checks, and decision are shown. | At least 80% identify all five items without prompts. | Improve labels, ordering, and documentation before testing demand. |
| B20 | Repeat installation is a real adoption event rather than a one-time demo. | Five participants use the same release or lock data for a second install or update seven days after the first task. | At least 3 of 5 complete without manually copying skill files or changing the recorded digest. | Treat repeatability as unresolved and inspect the CLI, lock, and update path. |
| B21 | The buying process can name an owner, operator, and approver without inventing a new organizational role. | Six buyer-side sessions map the workflow to a real team and identify who owns policy, review, support, and spend. | At least 4 of 6 can name those roles and a trigger for a trial. | Simplify the operating model and remove role-heavy copy. |
| B22 | Package boundaries are clearer than a seat-based price. | Six buyers compare Evaluation, Team, and Organization shapes without dollar amounts and select the boundary they need. | At least 4 of 6 state a concrete value metric or deployment requirement behind their choice. | Keep pricing as a preview and research the job or cost driver again. |
| B23 | Deployment and data handling are early adoption constraints. | Five platform leads rank hosted, self-hosted, and hybrid options against source credentials, retention, and support needs. | Produce a ranked list with a recorded reason for every choice; no consensus is assumed. | Keep deployment choice open and add the observed blocker to the product evidence. |

The activation definition for these tests is: a team identifies an allowed source, creates or receives one release decision, installs the resulting release, and completes one repeat or verification action. A page visit, signup, or demo click alone is not activation.

## Positioning tests

Test message comprehension before testing conversion. Use the same factual product card and randomize only the lead message in a private prototype or consented session. Do not run a public experiment until analytics, privacy, support, and brand decisions are ready.

| Variant | Copy hypothesis | What it should make clear |
| --- | --- | --- |
| A — release path | “Give your engineering team a clear path from an AI-agent skill source to a reviewed, repeatable install.” | The product connects source, decision, and installation for a team. |
| B — private registry | “A private registry for teams to review and distribute AI-agent skills.” | The category is a team registry; it should not imply runtime protection. |
| C — evidence before install | “Know where a skill came from, what checks ran, and what your team installed.” | The proof a maintainer or reviewer receives before distribution. |

For a first ten-person concept test, keep these gates:

- 8 of 10 can say the intended user and the source-to-install outcome in their own words;
- 6 of 10 choose a platform/DevEx, application-security, or engineering owner when asked who would start the evaluation;
- no more than 2 of 10 describe the product as a runtime guardrail, source-code authoring tool, or autonomous publishing agent;
- 6 of 10 complete the requested demo or guide task in eight minutes or less; record this as a directional usability measure, not a conversion rate.

Use the disqualifying observations as seriously as positive responses. A message that earns clicks but causes people to expect runtime enforcement, automatic source edits, or universal human approval should be rewritten. Manual review remains policy-dependent: the product should say that a human gate applies when an organization enables it, while configured policy may admit a candidate automatically after required checks pass.

If a later landing-page experiment is instrumented, use aggregate events such as `message_viewed`, `guide_started`, `guide_completed`, `demo_completed`, and `cta_to_app`. Do not collect skill content, source credentials, or personal identifiers for this research. Report sample size, date, variant, and completion definition with every result.

## Acquisition and content experiments

These are asset and measurement experiments only. No outreach, paid spend, newsletter send, community post, or partner contact has happened as part of this research. Draft assets can be tested with internal readers or people who explicitly consent to a usability session.

| Experiment | Asset and test | Measurable success criterion | Guardrail |
| --- | --- | --- | --- |
| A1 — hosted-first guide | A two-path getting-started page: hosted user signs in, creates or joins a company, gets a CLI token, and installs; self-host operator setup is a separate path. Test with 10 readers. | 8 of 10 choose the right path and can point to the first safe action; zero command examples fail the actual CLI parser. | Keep disposable `--allow-unscanned` setup clearly local and separate from hosted use. |
| A2 — source-to-install demo | A five-to-eight-minute sanitized walkthrough using example records, not live customer data. Test with five consenting readers. | 4 of 5 can name source, digest, check result, and install outcome after the walkthrough. | Label examples as examples; do not imply live provider coverage or a customer release. |
| A3 — evidence explainer | One page that shows source identity, revision, digest, scanner result, policy decision, and optional human review. Test with eight readers. | 6 of 8 can map each item to the question it answers without calling it a security guarantee. | Link every product statement to repository evidence or a dated acceptance record. |
| A4 — comparison explainer | A short, source-linked comparison of Tessl, JFrog AI Catalog, skills.sh, ClawHub, and Cloudsmith. Test with eight readers. | 6 of 8 correctly classify each as direct, platform/substitute, ecosystem-specific, or adjacent according to the documented scope. | Use vendor-stated language and a last-checked date; never imply market share or customer preference. |
| A5 — technical documentation baseline | Publish no new claim; first validate headings, links, metadata, canonical URLs, and `robots` behavior on the deployed marketing app. Review after 28 days if search measurement is configured. | Zero broken internal links and a recorded indexability check; impressions are reported as an observation, not a demand signal. | Do not promise an organic traffic target or treat impressions as customer validation. |
| A6 — reproducible sample pack | Prepare a public-safe sample and installation transcript for later review; keep it unpublished until source, license, and package checks pass. Five internal readers run the transcript. | 5 of 5 can follow it without credentials, hidden files, or commands absent from the CLI help. | Do not upload source credentials or execute untrusted skill scripts in the sample. |
| A7 — launch post or community note | Keep a draft only while the brand, support destination, and evidence links are pending. | Gate is completion of the prerequisites, not an audience or click target. | No send, post, paid placement, or third-party contact in this phase. |

The useful acquisition funnel for a later consented pilot is: relevant page view → guide start → first source or example inspection → first release decision → first install → repeat verification → request for a team or organization workflow. Store only aggregate counts needed for the decision and keep the event definitions stable between variants.

## Sequenced backlog and decision gates

1. **B17–B19:** run the scripted buyer, first-install, and evidence-comprehension tasks with a known fixture. Attach participant count, task script, duration, and observed failure to the tracker.
2. **B20–B23:** test repeat use, role ownership, package boundaries, and deployment constraints. Keep the commercial and deployment decisions open until the observations exist.
3. **A1–A4:** test the hosted/self-host split and three positioning messages with the same evidence card. Update copy only after recording confusion and completion, not after a single opinion.
4. **A5–A7:** prepare discoverable content and a launch draft after support, brand, and evidence links are ready. No outreach or paid acquisition is part of the current task.
5. Reconcile the business tracker after every study. Mark a hypothesis confirmed only when its pass signal is met and the underlying observations are attached; otherwise mark it mixed, rejected, or still open.

## Primary references

- [Tessl documentation](https://docs.tessl.io/) and [Tessl Registry](https://tessl.io/registry)
- [Tessl evaluation](https://docs.tessl.io/evaluate) and [how Tessl works](https://docs.tessl.io/introduction-to-tessl/how-tessl-works)
- [Cursor plugins](https://prod.cursor.com/docs/plugins) and [Cursor Agent Skills](https://prod.cursor.com/docs/skills)
- [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [Vercel skills CLI documentation](https://www.skills.sh/docs/cli) and [skills.sh documentation](https://www.skills.sh/docs)
- [ClawHub documentation](https://github.com/openclaw/clawhub/blob/main/docs/clawhub.md) and [vision](https://github.com/openclaw/clawhub/blob/main/VISION.md)
- [JFrog Artifactory](https://jfrog.com/artifactory/) and [JFrog AI Catalog / MCP Registry](https://jfrog.com/ai-catalog/mcp-registry/)
- [Cloudsmith artifact management](https://cloudsmith.com/platform-features/artifact-management) and [policy management](https://docs.cloudsmith.com/policy-management)
- [Noma agent control plane](https://noma.security/solutions/agent-control-plane)
- [Check Point AI Guardrails behavior defense](https://docs.lakera.ai/docs/agent-behavior-defense)
- [HiddenLayer platform](https://www.hiddenlayer.com/platform)
