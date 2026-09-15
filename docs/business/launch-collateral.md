# Private Skills launch collateral

**Working status:** launch preview collateral, 15 September 2026 (UTC)<br>
**Working brand:** Private Skills<br>
**Audience:** engineering, platform, developer-experience, and application-security teams evaluating a first AI-agent skill workflow

This document is an operator copy deck and demo runbook. It is deliberately
grounded in the checked-in product and verification notes. It contains no
customer quotes, adoption numbers, guarantees, firm prices, or claim that
hosted SSO, billing, or every source adapter is ready for production use.

## The message to use

**One sentence:** Private Skills gives engineering teams a private place to
review, release, and install AI-agent skills with source provenance, scanner and
policy evidence, packs, and a Rust CLI.

**Thirty seconds:** Teams find AI-agent skills in different places, then lose
the source, review decision, and exact bytes behind an install. Private Skills
puts those handoffs in one private registry: identify the source, inspect the
release evidence, apply the configured policy and any configured review gate,
then install an immutable release or pack with `pskills`. The marketing site
shows the workflow with examples; a real pilot uses the team's configured app,
source, scanner, and token paths.

**Primary headline:** Give your team control of private AI-agent skills.

**Primary lede:** Bring source discovery, release review, packs, and CLI
installation into one workflow your engineering team can inspect and repeat.

**Primary calls to action:**

- **See the demo** → `/demo` for the example source-to-install story.
- **Read the pilot guide** → `/docs/getting-started` for the hosted-user and
  self-host operator paths.
- **Sign in to registry** → the configured application origin's
  `/login?returnTo=%2Fapp` path for an enabled environment.

Use the configured application sign-in only for a real pilot. The marketing
deployment has no account creation, registry records, database, token, or
billing credentials.

## Claims ledger

Keep the wording below tied to the evidence. A claim that says **configured**
must stay configured in the sentence; it must not become a general hosted
availability claim.

| Claim allowed in launch copy | Boundary | Evidence |
| --- | --- | --- |
| Private Skills is a private registry with release, pack, and CLI workflows. | Describe the product category and checked-in implementation. | [`README.md`](../../README.md), [`product.md`](../product.md), [`cli-and-packs.md`](../cli-and-packs.md) |
| A configured source adapter can preserve source identity and provenance through a candidate workflow. | Source availability, credentials, and hosted pull-through acceptance depend on deployment configuration. | [`source-catalog.md`](../source-catalog.md), [`verification-current.md`](../verification-current.md) |
| Required scanner failures keep a release unavailable or quarantined. | Say required; advisory and disabled modes have different behavior. Do not promise a universal scanner set. | [`scanning-and-hooks.md`](../scanning-and-hooks.md), [`scanners.md`](../scanners.md) |
| Packs and lock metadata support a repeatable install plan. | Use an approved exact reference and a configured registry. Do not claim every external CLI is drop-in compatible. | [`product.md`](../product.md), [`install-directories.md`](../install-directories.md) |
| Eve can prepare review proposals and draft authoring changes. | Eve cannot publish, merge, edit source, authorize installs, or execute candidate content. A configured review gate may require a person; a review proposal is advisory by default. | [`eve-reviewer.md`](../eve-reviewer.md), [`scanning-and-hooks.md`](../scanning-and-hooks.md), [`completion-criteria.md`](../completion-criteria.md) |
| The current CLI login path accepts a scoped token through stdin. | OIDC, device authorization, and a broad SSO promise are out of scope for this launch copy. | [`README.md`](../../README.md), [`implementation.md`](../implementation.md) |
| Pricing is a preview of plan shapes. | No purchase, checkout, payment account, or firm price is active. | [`pricing.tsx`](../../apps/marketing/src/routes/pricing.tsx), [`marketingPlans.ts`](../../apps/marketing/src/lib/marketingPlans.ts) |

Do not turn repository evidence into customer evidence. The repository shows
implementation and selected verification runs; it does not show customer
logos, production adoption, conversion, time savings, or a security guarantee.

## Eight-minute demo script

The public [`/demo`](../../apps/marketing/src/routes/demo.tsx) route implements
this talk track with example records. Keep the **Example flow** and **Example
records only** labels visible while presenting it.

### 0:00–0:45 — Frame the problem

Say: “We are following one skill from a configured source to one install. The
example identifiers are placeholders; this page is not connected to a live
registry.”

Ask the teammate to name one skill they already copy into an agent workspace,
one person who should review it, and one agent scope they need to support.

### 0:45–2:15 — Source

Open the **Source** tab and point out that discovery starts with a configured
catalog and a source identity. Use the example command:

```sh
pskills sources list
pskills sources search --source skills-sh "frontend"
```

Explain that discovery returns metadata and does not itself approve a release.
For a real run, use the source adapter and exact external identity returned by
that registry. Source access and hosted pull-through still need the deployment
inputs and acceptance evidence recorded in the verification notes.

### 2:15–3:45 — Scan and policy

Open **Scan** and show the digest-bound status example:

```sh
pskills scan status sha256:<release-digest>
```

Say: “Required scanner evidence is part of the release decision. A required
failure, error, stale result, incomplete result, or blocked finding keeps the
release unavailable. If the team has no required scanners, `allowUnscanned`
still controls whether an unscanned release can proceed.”

Then make the review distinction explicit: configured policy may admit a
release after required evidence passes. A separate, versioned review gate can
require a human decision. Eve's proposal is advisory unless that policy makes
the human decision a gate.

### 3:45–5:00 — Pack

Open **Pack** and show how a team can make a selected set repeatable:

```sh
pskills pack show @team/frontend
```

Replace `@team/frontend` with the exact pack reference returned by the real
registry. Explain that a pack is a selected release plan; it is not a claim
that every upstream source or agent understands the same format.

### 5:00–6:30 — Install and verify

Open **Install** and show the authorized install example:

```sh
pskills install @team/web-guidelines@1.2.0 --agent codex
pskills verify
```

For a real CLI session, authenticate separately with a scoped token supplied
by the configured workspace:

```sh
pskills login --registry <registry-url> --token-stdin
```

Do not type a real token into a screen recording or place it in shell history.
Use an exact approved release or pack reference from the registry. A second
machine can use the committed lock entry with the global flag before the
subcommand:

```sh
pskills --frozen-lockfile install @team/web-guidelines@1.2.0 --agent codex
```

### 6:30–7:30 — Boundaries

Say: “Skill content is handled as data during ingestion and scanning. The
registry does not execute uploaded scripts or install hooks. Eve can suggest a
review action, and the builder can apply a chosen draft change after an
explicit author action. Publishing, merging, and install authorization remain
separate decisions.”

Do not say that Eve automatically edits source, publishes, merges, or approves
every release. Do not imply a person must manually approve every release unless
the pilot's configured policy adds that gate.

### 7:30–8:00 — Close with a pilot

Say: “Bring one source, one release, and one teammate through this path. The
pilot guide separates a hosted user from a self-host operator, so we can start
with the environment we can actually verify.”

Point to **Read the pilot guide**. For an enabled app, use its configured
**Sign in to registry** link. For a public deployment without a configured
contact URL, use the setup guide; do not display a guessed email address.

### Never demo

- A real token, cookie, private source URL, or customer data.
- A fake customer quote, logo, adoption number, savings claim, or guarantee.
- A claim that SSO, payment, checkout, or a public account-creation flow is live.
- An upstream source as available when the current deployment has not configured
  and verified it.
- A failed or stale scanner result presented as approved.
- “Safe,” “secure,” or “approved by AI” as an unqualified product promise.

## CLI onboarding copy

Use this block in operator conversations and pilot notes. It deliberately
separates the browser user path from the local operator path.

### Hosted user path

1. Open the configured app origin's **Sign in to registry** link.
2. Complete the company or workspace onboarding shown by that application.
3. Obtain a scoped registry token through the deployment's supported operator
   path.
4. Pipe that token to the CLI login command; keep it out of shell history:

   ```sh
   pskills login --registry <registry-url> --token-stdin
   ```

5. Confirm the configured source and release identifiers before installing:

   ```sh
   pskills sources list
   pskills sources search --source skills-sh "frontend"
   pskills show @team/web-guidelines
   pskills scan status sha256:<release-digest>
   ```

6. Install an approved exact version into the selected agent scope and verify
   the local result:

   ```sh
   pskills install @team/web-guidelines@1.2.0 --agent codex
   pskills verify
   ```

The current CLI does not provide an interactive browser or device login. Do not
turn the browser application sign-in into an SSO claim.

### Self-host operator path

An operator who is running the repository locally can use the disposable setup
for a local evaluation:

```sh
pnpm setup:dev --allow-unscanned
pnpm dev
curl --fail http://localhost:5173/health
```

The `--allow-unscanned` flag is explicit, local, and disposable. It is not a
production release policy and must not be used as evidence that required
scanner coverage is configured. A fail-closed environment runs the scanner
worker and uses the normal setup path before publishing. Storage, source
credentials, scanner modes, and deployment origin remain operator inputs.

### Supported command reference

| Job | Example | Notes |
| --- | --- | --- |
| Check registry reachability | `pskills --registry <registry-url> health` | Uses the registry origin configured for this CLI invocation. |
| List configured sources | `pskills sources list` | Returns server-configured source adapters. |
| Search one source | `pskills sources search --source skills-sh "frontend"` | `skills-sh` is an example adapter id; use the exact id returned by `sources list`. |
| Inspect a release | `pskills show @team/web-guidelines` | Replace with an exact registry reference. |
| Read scanner status | `pskills scan status sha256:<release-digest>` | Use the release digest, not a display name. |
| Inspect a pack | `pskills pack show @team/frontend` | Replace with an exact pack reference. |
| Install an approved release | `pskills install @team/web-guidelines@1.2.0 --agent codex` | Select the configured agent adapter. |
| Verify local state | `pskills verify` | Reads the selected local install state. |
| Reproduce a locked install | `pskills --frozen-lockfile install @team/web-guidelines@1.2.0 --agent codex` | The flag is a global option and precedes the subcommand. |

The examples above match the Rust CLI command and argument definitions in
[`crates/pskills-cli/src/main.rs`](../../crates/pskills-cli/src/main.rs). The
CLI accepts `--agent` as a global option; the common `pskills install ...
--agent codex` spelling remains accepted by the parser, while the frozen
example places its global flag before `install` for clarity.

## FAQ and support copy

Use these answers on the public FAQ, launch calls, and the first support
conversation.

**What is Private Skills?** It is a private registry for engineering teams. It
brings source discovery, release checks, packs, and installation into one place
so a team can see what it is choosing.

**Does it execute a skill while it is imported?** No. Uploaded and imported
skill content is handled as data during ingestion, scanning, and installation.
The registry does not run skill scripts or package lifecycle hooks.

**What happens when a required scanner fails?** The candidate stays unavailable
or quarantined. A client-side setting cannot turn a failed required check into
an approved release.

**Does every release require a human approval?** Only when the configured
policy adds a review gate. Required scanner evidence can drive a policy decision
without a manual step; Eve review proposals are advisory unless that separate
gate is enabled.

**Can Eve publish or merge a change?** No. Eve records a proposal for a person
to decide. In the builder, a person can ask Eve to apply a chosen change to a
draft; that authoring action is separate from publishing, merging, and install
authorization.

**How do I sign in?** Use the configured app's sign-in for browser onboarding.
The current CLI login path accepts a scoped token through
`pskills login --registry <registry-url> --token-stdin`. The public marketing
site does not create accounts or collect tokens.

**Is there a purchase path?** No. The public pricing page is a planning preview
while packaging is decided. Do not quote a firm price or imply that checkout or
payment is active.

**How do I request a walkthrough?** Use the public contact or scheduling link
only when `PUBLIC_CONTACT_URL` has been configured to a real HTTPS destination.
When it is unset, use the demo and pilot guide. The marketing deployment does
not accept or store support submissions and does not publish a guessed email.

## Operator-ready launch copy

### Route snippets

| Route | Title / message | Required boundary |
| --- | --- | --- |
| `/` | **Give your team control of private AI-agent skills.** Bring source discovery, release review, packs, and CLI installation into one workflow your engineering team can inspect and repeat. | Keep example release UI visibly labelled as an example. |
| `/product` | **Keep every skill decision close to the code.** Connect source checks, review, and install plans around the agent stack you already have. | Source and scanner behavior depends on configured deployment inputs. |
| `/demo` | **See one skill move from source to install.** Follow the four handoffs with example records, then swap in your own registry identifiers. | No live registry state is implied. |
| `/docs/getting-started` | **Bring one real skill through a deliberate release path.** Choose hosted-user or self-host operator setup, then inspect one release and install the approved plan. | `--allow-unscanned` is local disposable evaluation only. |
| `/pricing` | **Choose the shape of your first workflow.** Compare preview plan shapes while commercial packaging is being decided. | No purchase, payment, or firm price. |
| `/faq` | **Clear answers for a careful rollout.** | Keep policy-dependent review and current CLI auth wording. |
| `/contact` | **Start with a useful next step.** | Show a contact destination only when configured; never render a broken `mailto:`. |

### Deployment acceptance

Before calling the marketing deployment launch-ready, the operator should:

- Set a valid production `APP_ORIGIN` pointing to the authenticated app. A
  missing or malformed value must fail the production build rather than route
  sign-up back to the marketing site.
- Set `PUBLIC_CONTACT_URL` only when there is a real HTTPS intake or scheduling
  destination. Leave it unset while support ownership is undecided.
- Confirm the marketing project has no auth, registry, database, scanner, or
  billing secrets.
- Build from the monorepo with the Vercel project rooted at `apps/marketing`
  and outside-root source enabled:

  ```sh
  pnpm install --frozen-lockfile
  APP_ORIGIN=https://app.example.com pnpm --filter @private-skills/marketing build
  ```

- Check HTTP 200 for `/`, `/product`, `/demo`, `/pricing`, `/docs`,
  `/docs/getting-started`, `/faq`, `/contact`, and `/legal` on the actual
  deployment.
- Open the homepage, demo, docs, and pricing routes at desktop and narrow
  widths. Check keyboard skip link, focus states, tab controls, headings,
  external app links, and the absence of horizontal overflow.
- Verify that an app CTA resolves to the configured app origin and includes
  `returnTo=%2Fapp`. Verify that unset contact configuration shows the pending
  state rather than a guessed support channel.
- Keep this document and the public routes aligned when the product, brand,
  pricing, auth, or source acceptance status changes.

### Future research tasks

These are follow-ups, not launch claims:

1. Interview platform and DevEx leads about one real source-to-install workflow;
   measure time-to-first approved install and repeat-install friction only after
   a real pilot.
2. Test whether the focused release-and-distribution wedge is clearer than a
   broad governance or AI-security message against Tessl, JFrog AI Catalog,
   skills.sh, ClawHub, Cloudsmith, and runtime governance products.
3. Decide the commercial model and publish pricing only after buyer and cost
   evidence exists.
4. Re-check the working name and domains with proper trademark, package,
   company, social-handle, and registrar clearance before any rename or public
   announcement.
5. Add a durable, authenticated support intake in the app if a first-party
   support channel is required; keep public marketing contact configuration
   pointed at its real HTTPS entry point.

