# Private Skills launch acceptance

**Planning snapshot:** 15 September 2026, Brisbane (Australia/Brisbane)

**Reconciled against production:** 16 September 2026, Brisbane. Current
production source is `origin/main` `ef8922c` (PR #58); the runtime candidate
line `3713f14` / `59c8f69` and its follow-up ownership/receipt commits are
tracked separately. The status rows below distinguish production, candidate,
local, historical, and external-input evidence. Local and disposable evidence
remains separate from hosted and commercial acceptance.

**Target:** Friday 18 September 2026, Brisbane. Sunday 20 September is a
contingency review date only; it does not move an unverified external approval
into the ready column.

**Document owner:** launch integration owner, with Product/Engineering,
Identity, Billing, Marketing, Hosting/Operations, and Legal/Finance owners
recorded against each gate below.

This is the authoritative launch matrix for the current business goal. It
joins product behavior, the public homepage and docs, commercial readiness,
and hosting acceptance. A row is ready only when the stated observable result
has a dated artifact or deployment record. Source existence, a green unit test,
an unconfigured account, and a healthy unauthenticated `/health` response do
not close a row that requires an authenticated hosted result.

## Verification update after the planning snapshot

Current production is `origin/main` `ef8922c` (PR #58). The durable [PR #58
release record](../evidence/production-release-ef8922c-20260916.json) records
all four Git-triggered Vercel deployments READY at the exact merged SHA,
public health/pricing readbacks, identity disabled with `providers: []`, and
the native-CI billing-admission waiver.

The hosted CLI storage record for the private Vercel Blob store records
provisioning and exact authenticated readback for all three v0.4.0 assets
(`docs/evidence/hosted-cli-v0.4.0-private-provision-20260916.json`). Hosted
browser chooser/install, same-deployment positive publish → required scan →
approval → install, and negative stale/revoked/foreign-company checks remain
open. Native Linux and Windows execution remain unverified; native CI is
explicitly waived by the user and is recorded as blocked/waived, not passed.

The runtime candidate line is `3713f14` with atomic billing ledger `59c8f69`,
authoring/core ownership fixes `17f0414`, `5e4268d`, `1ab98c2`, and `a223961`,
and receipt/provider-binding work `f24813f` / `f3de225`. It is not released.
The [local recovery record](../evidence/local-storage-billing-restoration-20260916.json)
reports 86 focused local tests, 49 mixed checks, and one separate PostgreSQL
recovery test; the 86/49 results are not an all-PostgreSQL combined proof.
The committed G1 measurement-fence fix, owned-PUT receipt interaction, actual
runtime bindings/hosted proof, and final combined suite remain required.

The [local billing demo](../evidence/local-billing-console-demo-acceptance-20260916.json)
passes tenant-bound checkout/portal completion, signed test billing, PostgreSQL
readback, and Reader denial through `LocalBillingAdapter`; it uses no Stripe
account or live charge. Local token create/sign-in/use/revoke, signed local
OIDC/SAML protocol checks, the fresh 5407 settings readback, the composed
Nitro/PostgreSQL/Files SDK/worker proof, and the three-file tenant acceptance
rerun remain fixture evidence. Current backup records `1da9863`/`7d3836c`
preserve bounded JSONB and object-digest state; they do not prove hosted tenant
migration or a whole-database restore. Hosted identity/provider callbacks, the
populated two-company matrix, quota enforcement, Eve scheduling, and commercial
gates remain open.

## Remaining work count — 16 September 2026

These are grouped launch workstreams; the detailed requirements and evidence
boundaries remain below.

| Group | Open workstreams | Current scope |
| --- | ---: | --- |
| Product/public surface | 6 | Populated B05/L10 isolation matrix; hosted identity/onboarding/SSO; required-scan and worker/Eve audience journey; source/search/analytics isolation; hosted publish/review/install; final marketing, claim, and public pricing review. The local `9f46983` contrast follow-up is not deployed. |
| Hosting/operations | 5 | Hosted browser archive journey; hosted tenant migration/restore/rollback; worker capacity and monitoring; native Linux/Windows qualification; production provider, callback, and secret readback. The PR #58 deployment record and private archive provisioning/readback slices are already recorded. |
| Business/commercial | 5 | B21/B22/B28 billing caller and recovery fixes, including G1 measurement fencing, owned-PUT receipts, delayed remote-write and pre-finalization accounting barriers; plan/catalog alignment; B14–B16 customer/name/domain decisions; legal/support/offer inputs; Stripe activation. |

The native-CI waiver removes an account admission blocker for this review; it
does not turn native Linux or Windows qualification into a passing result.

## Launch modes and decision boundary

There are three deliberately different launch modes:

1. **Local evaluation:** a disposable registry, synthetic accounts, and the
   deterministic two-issuer OIDC fixture. This mode is useful for onboarding
   and regression tests, but it is not provider availability or hosted tenant
   evidence.
2. **Hosted private beta/demo:** a real Node deployment, durable state and
   storage, configured identity, required scanning, worker/Eve boundaries, and
   a manual invitation path. The public site may describe this mode while the
   flow remains invitation-only or requests a team pilot.
3. **Paid self-serve activation:** a verified billing integration, selected
   legal entity and support contact, published terms/privacy, and live payment
   account. Test-mode billing is required launch readiness; live paid
   activation is the final external Stripe-account gate.

The 18 September decision can ship the homepage and a clearly labeled private
beta/demo when the corresponding product and hosted gates pass. It must remain
beta/demo when identity, tenant isolation, required scan, migration/restore,
or hosted positive install evidence is missing. A test-mode checkout does not
authorize charging a customer. No dates are promised for OAuth-provider review,
Stripe onboarding, legal-entity selection, or other external account approval.

## Critical path to 18 September

### Separate marketing site and application

User requirement confirmed on 15 September: the public marketing site and the
registry application must be independently deployable projects in the same
monorepo. `apps/marketing` owns the homepage, product explanation, pricing,
public documentation, FAQs, and legal pages. `apps/web` owns login, company
onboarding, the registry/editor, analytics, and account billing.

Acceptance requires separate build outputs and deployment configuration,
independent environment variables, and browser verification of both sites.
The marketing deployment must not require database, registry, identity-provider,
Stripe-secret, or Eve credentials. Public sign-in and signup links use a
configured application origin and enter the application's normal login and
onboarding flow. Identity callbacks and session cookies remain on the app
origin. Shared brand/design assets must not import app server code.

The final brand and custom domains are not selected. Separate deployable
projects are required now; inventing or purchasing domains is not part of this
acceptance gate. Root's current production check confirms the separate
deployment status contexts, a public marketing HTTP 200 with mobile-menu
markup, and the marketing-to-application cross-link. The gate remains open
for complete cross-site navigation, responsive and claim review, and the
remaining hosted application journey.

| Date (Brisbane) | Owner | Concrete increment | Exit evidence |
| --- | --- | --- | --- |
| 15 Sep | Launch integration + Identity | Land the first working homepage/onboarding increment and compose the Better Auth identity seam with the tenant router. | Reviewable source diff, focused identity/tenant test output, and a public-page route readback. |
| 16 Sep | Tenant acceptance + Auth backend | Run two-company journeys through the actual `Request` runtime: provider/session identity, active membership, company switch, scoped CLI token, role change, and revocation. | `apps/web/src/tenant-identity-route.postgres.integration.test.ts` and `tests/e2e/multi-tenant-postgres-acceptance.test.ts` against the integrated runtime, with no fixture-only selector presented as hosted proof. |
| 17 Sep | Tenant acceptance + Worker/Eve + Billing | Complete the deterministic two-issuer flow, required-scan approval/rejection, worker/Eve audience checks, and billing test-mode create/change/cancel/refund/reconcile path. | Dated focused test artifacts and a sanitized evidence bundle. |
| 18 Sep | Hosting/Operations + Product + Marketing + Finance/Legal | Verify the selected hosted origin, migration/backup/rollback runbook, public claims, pricing configuration, draft policies, and launch decision. | Authenticated hosted readback, immutable deployment/evidence identifiers, and an owner decision for every open external input. |
| 20 Sep contingency | Launch owner | Recheck only gates whose external state changed; do not relabel pending provider or payment approval as complete. | Updated row dates and an explicit beta-only or paid-ready decision. |

## Product acceptance

| Owner | Requirement and observable acceptance | Authoritative evidence | Status at production main ef8922c / candidate 3713f14 + 59c8f69 / target |
| --- | --- | --- | --- |
| Product + Engineering | **Positioning:** the product is a private registry and governed pull-through for versioned agent skills and packs. The user journey is source or upload → validation → required scan → policy decision → immutable release → authorized CLI install. Homepage copy must say that scan evidence is a policy input, not a harmlessness or agent-behavior guarantee. | `README.md:1-3,53-68`, `docs/product.md`, `docs/business/launch-plan.md`, and `apps/marketing/src/routes/index.tsx`. | Production main `ef8922c` serves the separate marketing route with HTTP 200; the PR #58 record covers the public readback and deployment status. Complete cross-site navigation, final claim review, and the hosted application journey remain open; 16 Sep. |
| Product + Engineering | **Publish/review/install:** a benign artifact can be published, required evidence can complete, approval can be read, a pinned release or exact-member pack can be authorized, and the Rust CLI receives the same approved digest on repeat install. A blocked, stale, or revoked release cannot transfer. | `tests/e2e/registry.test.ts`, `tests/e2e/directory-security.test.ts`, `docs/evidence/local-compose-required-scan-34e4f56.json`, `docs/evidence/production-release-checkpoint-34e4f56.json`, `docs/evidence/hosted-cli-v0.4.0-private-provision-20260916.json`, `docs/cli-and-packs.md`. | Private-store provisioning and authenticated exact-byte/digest readback pass for all three v0.4.0 assets. The current PR #58 deployment record is durable; a same-deployment positive publish → required scan → approval → install, plus negative stale/revoked/foreign-company checks and hosted browser chooser/install, remains required; 17–18 Sep. |
| Product + Engineering | **No execution:** uploaded/imported skill content is data during ingestion, scanning, and installation. Candidate scripts, hooks, MCP servers, and package lifecycle code are never executed by the registry. | `AGENTS.md`, `README.md:174-180`, scanner and storage contracts, and the required-scan negative fixture. | Implemented boundary; retain as a homepage FAQ claim and include it in the release readback. |
| Product + Source owner | **Source catalog:** a configured source can list/search/resolve an exact external identity; source revision, policy, and canonical digest remain attached through import. A source credential never enters a browser response, job body, log, cache value, or CLI token. | `docs/source-catalog.md`, `packages/source-catalog/src`, `tests/e2e/source-tenant-isolation.test.ts`, and `docs/evidence/openclaw-clawhub-feed-evidence-20260910.json`. | Existing local/source-specific evidence is real but broad hosted positive pull-through and tenant-aware warm-cache proof remain open; 17 Sep. |
| Product + Engineering | **Search and analytics:** search only returns approved, authorized rows and rechecks content/artifact digests. Install analytics come from client-confirmed receipts and never infer installs from downloads. | `docs/semantic-search.md`, `docs/analytics.md`, `packages/search/src`, `packages/core/src/index.ts` search/analytics routes. | Implemented as opt-in/best-effort. Hosted identity/company filters and cost controls require the tenant acceptance run; 17 Sep. |
| Product + Eve owner | **Human review:** Eve receives a bounded, company-bound snapshot and records a proposal. Eve cannot publish, merge, edit source, authorize installs, or execute candidates. | `docs/eve-reviewer.md`, `packages/intelligence/src/handler.ts`, `apps/web/server/eve-tenant-runtime.ts`, `packages/eve-tenant/src/index.ts`, and `docs/evidence/production-m6-eve-session-34e4f56.json`. | Tenant-bound Eve entrypoints and registry callbacks are integrated in `f486ee6`/`5be8f00`; the tracking ledger records 26 focused entrypoint tests. Company-bound end-to-end prepare/complete, worker/Eve audience, cost-reservation, and hosted proof remain required; 17 Sep. |
| CLI owner | **Cross-platform install:** the published `pskills` assets pass checksum/member-shape verification and the supported native limits are stated. Mac arm64 is the current native smoke; Linux QEMU and Windows Wine are nonnative evidence unless current native CI says otherwise. | `README.md:7-12,65-66`, `docs/verification-current.md`, `docs/evidence/production-cli-v0.3-release-20260913.json`. | Release evidence exists with explicit limits. Do not expand the homepage into a native-platform promise without new evidence; 18 Sep. |
| Product + Support | **Onboarding:** a new user can see provider choices, sign in, choose or create a company, and use a copy-link invitation. An authenticated user with no membership receives an onboarding response and no registry data. Invitation delivery is not described as email until an email transport is configured and tested. | Integrated identity BFF (`/auth/identity/config`, `/auth/identity/session`), `apps/web/server/company-sso-runtime.ts`, `docs/identity.md`, `docs/identity-company-sso.md`, and the local browser journey. | Better Auth identity BFF, onboarding source, company selector UI, invitation copy-link source, company SSO runtime/discovery/picker source, and local PostgreSQL composition are integrated. The latest [hosted schema-preparation record](../evidence/hosted-identity-schema-preparation-20260916-attempt-2.json) verifies 12 empty identity/SSO/token/operations tables, while production identity remains deliberately disabled (`providers: []`). Invitee acceptance, clipboard/wrong-email/expiry cases, hosted browser flow, and a real customer provider callback remain open. Manual link/code is the launch path; 16–18 Sep. |
| Tenant acceptance | **Two-company boundary:** the actual outer tenant router derives company from a verified Better Auth membership or scoped credential before creating a fixed-company handler. Same names and digests remain separate rows; a foreign id/key/grant/operation returns a generic denial without opening the blob. Company headers, query selectors, body fields, and display names cannot switch context. | `docs/identity-company-sso.md`, `tests/e2e/directory-security.test.ts`, `tests/e2e/source-tenant-isolation.test.ts`, `apps/web/src/tenant-identity-route.postgres.integration.test.ts`, and `tests/e2e/multi-tenant-postgres-acceptance.test.ts`. | Local PostgreSQL proofs cover composed Better Auth/API-token routing and a separate populated fixed-handler registry isolation scenario. B05/L10 still requires the populated two-company matrix across files, drafts, packs, imports/scans, downloads, search, analytics, tokens, and Eve callbacks through the integrated runtime; no hosted acceptance is claimed. |
| Tenant acceptance + Worker/Eve | **Credential audiences:** browser sessions, scoped CLI/service tokens, worker tokens, source credentials, storage grants, and Eve reviewer tokens are separate. User/session cookies cannot claim jobs; worker tokens cannot call `/v1/*`; Eve tokens cannot call registry routes; company A credentials cannot reach company B. Role removal, session revoke, and token revoke take effect on the next privileged request. | `packages/contracts/src/index.ts`, `packages/auth/src/index.ts`, `workers/runner/src`, `packages/eve-tenant/src/index.ts`, `docs/eve-reviewer.md`, integrated identity/tenant router, and the focused acceptance tests. | Baseline negative matrix and tenant-bound Eve entrypoint/runtime source are integrated. Local session/token create/use/revoke readback and deterministic worker transfer/denial evidence are recorded; the full worker/Eve audience journey, hosted boundary, and connected provider proof remain open; 16–17 Sep. |
| Tenant acceptance + Operations | **Migration/recovery:** Better Auth and company tables migrate additively under a lock; the current `default` organization is adopted only through an explicit bootstrap-owner action; backup/restore preserves ids, digests, grants, scans, audit, and object references; rollback behavior is rehearsed and secrets are absent from manifests/logs. | `docs/identity-company-sso.md`, `docs/restore-rehearsal.md`, `docs/evidence/hosted-restore-20260910.json`, `scripts/restore-backup-postgres.ts`, `tests/operations-postgres-rehearsal.test.ts`, and the integrated identity migration plan. | The `da2606b`/`3950816` PostgreSQL recovery rehearsal passed once against disposable loopback PostgreSQL and covers identity/session/membership, SSO records, revoked tokens, billing mappings/reservations, registry state, sealed-object bytes, and cross-company denial. Better Auth migration is exercised locally. Current `1da9863`/`7d3836c` evidence preserves physical and semantic JSONB state plus referenced existing-registry object digests for one bounded row; explicit default adoption, rollback, hosted tenant migration, and whole-database restore/readback remain open; 17–18 Sep. |
| Tenant acceptance + Operations | **Caps:** request/body, upload, publish, source fetch, search/reindex, callback/device poll, transfer, worker, reviewer, and provider calls have per-company bounded limits. At a cap, responses are stable and bounded with no silent required-scan bypass or unbounded queue/cache growth. | `docs/identity-company-sso.md`, `docs/operations.md`, `packages/auth/src`, scanner/job contracts, and a low-cap focused probe. | Some route and scanner bounds are implemented. Identity callback/device, company-aware rate accounting, and deployed cap evidence remain open; 17–18 Sep. |

## Marketing and public surface acceptance

| Owner | Requirement and observable acceptance | Authoritative evidence | Status at production main ef8922c / candidate 3713f14 + 59c8f69 / target |
| --- | --- | --- | --- |
| Marketing + Product | **Homepage:** the hero, feature sections, FAQ, and calls to action explain “private registry for engineering teams,” source → scan → pack → install, provenance, required-scan failure behavior, and human Eve review. Claims distinguish implemented product behavior from configured provider/deployment inputs. | Integrated `apps/marketing/src/routes/index.tsx`, `apps/marketing/src/components/PublicLayout.tsx`, `apps/marketing/src/lib/brand.ts`, `docs/business/launch-plan.md`, `README.md`, and `docs/evidence/production-release-ef8922c-20260916.json`. PR #58 production readback serves the public marketing route; the local `9f46983` follow-up records nine-route axe/manual contrast evidence but is not deployed. Final responsive/claim review and the hosted application journey remain open; 16 Sep. |
| Marketing + Product | **Docs-led activation:** `/docs`, `/docs/getting-started`, and the CLI path show the shortest benign local proof, policy-first setup, exact release/pack install, boundaries, and the next owner-group workflow. They do not imply hosted source, OAuth, or paid support where none is configured. | Integrated `apps/marketing/src/routes/docs.tsx`, `apps/marketing/src/routes/docs.getting-started.tsx`, `apps/marketing/src/routeTree.gen.ts`, `docs/cli-and-packs.md`, `docs/verification-current.md`, `docs/identity-company-sso.md`, and `docs/evidence/production-release-ef8922c-20260916.json`. Production public route probes pass under PR #58; the complete docs-led route browser/readback and authenticated application next step remain required; 16 Sep. |
| Marketing + Product | **Proof labeling:** local fixtures, deterministic issuers, nonnative CLI checks, quarantined imports, test-mode billing, and prior deployment evidence carry visible labels. The site never uses a quarantined artifact as a positive testimonial and does not claim “secure,” “compliant,” SLA, residency, SOC 2, or native-platform support without evidence. | `docs/business/launch-plan.md`, `docs/verification-current.md`, `docs/evidence/*`, this matrix, and the final copy review. | Copy policy is documented. Final homepage and pricing claim review remains open; 16–18 Sep. |
| Marketing + Product | **Brand/domain:** “Private Skills” remains the working name until a naming and domain decision is recorded. Candidate names are not clearance results. A custom production domain is only advertised after DNS ownership, TLS, callback origins, and hosted health are verified. | `apps/marketing/src/lib/brand.ts`, `docs/business/brand-options.md`, `docs/business/brand-domain-shortlist.md`, `docs/business/market-research.md`, DNS/deployment evidence, and final owner decision. | Dated market and naming research is integrated in `d02b1ae` with MR01–MR07 and A1–A7 tracking. No name/domain selection or purchase is recorded; recheck availability and obtain the business/legal decision before changing the working name, 18 Sep. |
| Marketing + Product | **Pricing page:** public cards must match the actual server `PlanCatalog` and show whether a recurring price is configured. “Proposed,” “test mode,” and “checkout unavailable” states are visible; the page has no self-serve paid CTA before the live account and legal/contact gate. | Integrated `apps/marketing/src/routes/pricing.tsx`, `apps/marketing/src/lib/marketingPlans.ts`, `apps/marketing/src/lib/marketingPlanMetadata.ts`, `docs/business/launch-plan.md`, and `packages/billing/src/plans.ts`. | The locally verified marketing change now projects the shared browser-safe metadata with server `free`/`team`/`business` IDs, labels, descriptions, finite limits, and explicit price/checkout readiness. It accepts a bounded public-only custom projection at build time, fails closed for malformed or server-only fields, and keeps preview/no-purchase copy. The app billing console remains authoritative at runtime; Stripe account, final packaging, and public prices remain open. |

## Business and billing acceptance

| Owner | Requirement and observable acceptance | Authoritative evidence | Status at production main ef8922c / candidate 3713f14 + 59c8f69 / target |
| --- | --- | --- | --- |
| Billing + Engineering | **Billing test mode is launch readiness:** a disposable/local provider and signed webhook fixture create a customer, start checkout, map a known price to a plan, apply an entitlement, change/cancel/refund it, reject stale/invalid/replayed events, and reconcile idempotently. Usage reservations enforce seats, retained bytes, scanner executions, and Eve budget without an “unlimited” fallback. | Integrated `packages/billing/src/{types,plans,repository,stripe,webhooks}.ts`, `apps/web/server/routes/billing.ts`, focused billing/runtime tests, the [local billing demo](../evidence/local-billing-console-demo-acceptance-20260916.json), and `docs/business/launch-plan.md`. | The local demo passes tenant-bound checkout/portal completion, signed test billing, PostgreSQL readback, and Reader denial through `LocalBillingAdapter`; no Stripe account or live charge is involved. The candidate recovery line has bounded 86-focused/49-mixed/one-PostgreSQL evidence, but G1 fencing, owned-PUT receipts, actual runtime bindings, final combined recovery, costly caller enforcement, and usage reconciliation remain open. |
| Billing + Product | **Plan/entitlement consistency:** one server catalog is the source of plan ids, limits, price ids, checkout availability, portal availability, and cap behavior. The public page and onboarding use projections of that catalog rather than a second hard-coded offer. | `packages/billing/src/plans.ts`, `packages/billing/src/types.ts`, `apps/marketing/src/lib/marketingPlans.ts`, `apps/marketing/src/lib/marketingPlanMetadata.ts`, integrated pricing route, and a plan readback. | The separate marketing build now projects the catalog's browser-safe metadata, accepts a bounded public-only custom projection, and fails closed for malformed or server-only fields. The app billing console remains authoritative at runtime. Final packaging, Stripe account, and public prices remain open. |
| Billing + Finance/Operations | **Paid activation:** Stripe account, products/prices, webhook endpoint/signing secret, merchant/legal identity, currency, tax treatment, invoice/refund policy, customer portal, and reconciliation are configured and read back without exposing secrets. | `packages/billing/src/stripe.ts`, `packages/billing/src/webhooks.ts`, deployment env/config evidence, and a sanitized Stripe test/live readback. | Stripe account setup is the final external step and is currently absent. Keep checkout unavailable or test-only until this row is explicitly approved; no provider-approval date promised. |
| Founder + Legal/Finance | **Legal contracting inputs:** legal entity, registered address/jurisdiction, contracting name, privacy/security contact, support email, escalation owner, response target, retention/deletion periods, DPA/subprocessors, and incident notice terms are selected and recorded before charging. | `docs/business/launch-plan.md` commercial-input table, draft Privacy/Terms documents, and owner decision record. | No legal entity or support email has been selected. This does not block independent implementation, but it blocks paid activation and any production support/SLA claim; 18 Sep decision gate. |
| Product + Operations | **Commercial limits:** publish the selected Team/Pilot allowances, scanner/egress/storage/Eve budget policy, cap behavior, cancellation/refund path, and abuse/takedown route only after cost traces and billing enforcement agree. | `docs/business/launch-plan.md`, `docs/business/hosting-review.md`, billing usage service, and a test-mode cap probe. | Planning hypotheses exist; final offer and cost calibration remain open. Do not publish “unlimited” usage; 17–18 Sep. |

## Hosting and production acceptance

| Owner | Requirement and observable acceptance | Authoritative evidence | Status at production main ef8922c / candidate 3713f14 + 59c8f69 / target |
| --- | --- | --- | --- |
| Hosting/Operations | **Hosting decision:** use the existing Vercel Pro + Nitro Node path for launch where configured: Neon PostgreSQL, Files SDK object storage, durable PostgreSQL jobs, bounded Vercel Sandbox scanning, and AI/Eve provider settings. Keep S3/R2 and other Nitro profiles as portability seams, not Friday migrations. | `docs/business/hosting-review.md`, `docs/implementation.md`, `docs/operations.md`, `vercel.json`, and the final deployment record. | Hosting review and executable cost model are integrated in `b15ed1b`; JavaScript syntax and regenerated CSV equality were checked. Production main has all four Vercel status contexts SUCCESS, but scenario values remain estimates and exact release/origin, capacity, and hosted acceptance remain open, 18 Sep. |
| Hosting/Operations | **Configuration and secrets:** production has explicit Better Auth secret/base URL/callback origins, database and storage bindings, worker/cron credentials, immutable scanner references, deny-all scanner networking, model/provider config, and bounded request/storage settings. No secret appears in source, health, browser config, logs, or evidence. | `.env.example`, `docs/identity.md`, `docs/operations.md`, hosting env readback with values redacted, and secret-scan output. | Identity/provider env contract exists in the integrated root `.env.example`, `docs/identity.md`, and Node infrastructure. Production identity readback is explicitly disabled with `providers: []`; provider wiring, secret bindings, and redacted deployment readback remain open, 18 Sep. |
| Hosting/Operations + Identity | **Migration/rollback:** run the reviewed Better Auth migration before accepting traffic, record schema/revision/backup manifest, quiesce or fence concurrent mutations, verify row counts/digests/object references, and demonstrate rollback or a documented forward-fix when down-migration is unsafe. | `docs/identity-company-sso.md`, `docs/identity.md`, `docs/restore-rehearsal.md`, `docs/evidence/hosted-restore-20260910.json`, and `tests/operations-postgres-rehearsal.test.ts`. | The `da2606b`/`3950816` PostgreSQL recovery rehearsal is integrated and passed once against disposable loopback PostgreSQL. `docs/evidence/hosted-postgres-restore-proof-20260916.json` and `docs/evidence/hosted-postgres-restore-physical-type-correction-20260916.json` add bounded registry-row/JSONB physical-semantic and referenced-object-digest evidence. These records do not prove tenant-wide migration, a provider snapshot/fence, or whole-database restore; explicit default adoption, rollback, hosted migration, and hosted provider restore/readback remain open, 17–18 Sep. |
| Hosting/Operations | **Runtime proof:** the target origin serves the current release and an authenticated browser/CLI flow. `/health` is nonsecret; hosted positive publish → required scan → approval → transfer → CLI install and negative revoked/stale/foreign-company checks are recorded against the same deployment. | `docs/verification-current.md`, `docs/evidence/production-release-ef8922c-20260916.json`, `docs/evidence/hosted-cli-v0.4.0-private-provision-20260916.json`, deployment URL/source/deployment IDs, and the tenant acceptance evidence bundle. | Production PR #58 has all four deployments READY and public health/identity readbacks; identity remains disabled with `providers: []`. Private archive provisioning/readback is separately verified for all three v0.4.0 assets. Actual runtime provider bindings, authenticated hosted multi-company positive flow, and negative stale/revoked/foreign-company checks remain open, 18 Sep. |
| Hosting/Operations | **Worker/Eve operations:** the cron route is a liveness trigger, durable leases/fencing remain authoritative, scanner images/rules are pinned, required evidence expires predictably, and Eve/model calls have per-company budgets and bounded time/token limits. | `docs/operations.md`, `docs/scanners.md`, `docs/eve-reviewer.md`, `workers/runner`, `apps/web/server/eve-tenant-runtime.ts`, `docs/business/hosting-review.md`, and operational logs with redaction. | Core worker/Eve boundaries and tenant delegation wiring are integrated, but capacity/cost traces, actual provider credentials, and hosted worker/Eve audience proof remain open, 17 Sep. |
| Hosting/Operations | **Monitoring and recovery:** dashboards/alerts cover auth failure, membership denial, callback errors, migration state, queue age, required-scan freshness, blob reads, storage/egress, model spend, billing webhooks, and tenant mismatch denials. Operators can rotate/revoke credentials and restore a company without widening access. | `docs/operations.md`, provider dashboards, restore runbook, and a credential-rotation/readback record. | Current docs cover many operational controls, but the Better Auth and billing dashboards/owners are not assigned; 18 Sep. |

## Authoritative evidence register

The following files are the source of truth for their stated slices against
production main `ef8922c`, the separately tracked runtime candidate line
`3713f14` / `59c8f69`, or the named local/historical fixture. Each row names
the evidence boundary that still has to be closed; source integration alone
does not turn a local fixture into hosted acceptance:

| Source | What it proves | What it cannot prove by itself |
| --- | --- | --- |
| `README.md`, `docs/product.md`, `docs/implementation.md` | Product shape, portable Request/Response runtime, current boundaries, and supported commands. | A live provider, hosted company isolation, or billing account. |
| `docs/roadmap.md`, `docs/verification-current.md` | Milestone status and dated deployment/scanner/CLI/restore evidence with explicit limits. | That an older deployment or fixture still represents the integrated release. |
| `docs/identity-company-sso.md`, `apps/web/server/company-sso-runtime.ts`, `packages/identity/test/company-sso.better-auth.integration.test.ts` | Tenant identity/SSO contract, critical isolation surfaces, provider strategy, migration requirements, runtime mounting, local signed OIDC/SAML protocol checks, and focused acceptance plan. | A hosted Better Auth implementation, customer provider, or authenticated deployment readback until those checks pass. |
| `tests/e2e/directory-security.test.ts`, `tests/e2e/source-tenant-isolation.test.ts` | Existing operation/skill/pack/scan/audit/grant/blob and source-cache isolation slices. | Interactive membership, OAuth callback, or worker/Eve runtime composition. |
| `apps/web/src/tenant-identity-route.postgres.integration.test.ts` and `tests/e2e/multi-tenant-postgres-acceptance.test.ts` | Two complementary local PostgreSQL tests: actual Better Auth/API-token tenant routing, and populated core registry isolation across resource types. | The composed identity test uses real memberships and persisted tokens; the populated core test uses fixed handlers. Neither alone proves full Nitro startup, hosted providers, or deployed worker/Eve boundaries. |
| `packages/identity/src/index.ts`, `docs/identity.md` | Integrated Better Auth runtime contract: provider config, live membership/session lookup, onboarding, copy-link invitations, explicit migration, and sanitized identity BFF. | Provider account approval, hosted PostgreSQL migration/readback, or a deployed authenticated callback. |
| `apps/web/server/tenant-runtime.ts` and `apps/web/server/runtime.ts` | Integrated outer tenant router and Request composition: verified selection, no untrusted header selection, handler cache keyed only by company, onboarding, inner recheck, default credential non-reuse, and the current optional company SSO runtime mount. | A hosted end-to-end route, real provider, or full populated two-company matrix until those checks pass. |
| `scripts/local-identity-demo.mjs`, `tests/local-identity-demo.test.ts`, `tests/fixtures/local-identity-demo-providers.json` | Disposable two-issuer protocol proof: discovery, state, S256 PKCE, token/userinfo/JWKS, fixed users/companies, and provider-env envelope. Tracking also records local signed OIDC/SAML protocol checks. | A real GitHub/Google callback, customer IdP, durable membership in a deployed service, or hosted availability. |
| `packages/billing/src`, `apps/web/server/routes/billing.ts`, `apps/marketing/src/routes/pricing.tsx`, `apps/marketing/src/lib/marketingPlans.ts` | Integrated test-mode billing contracts, tenant console/route factory, and pricing preview projection. | A live Stripe account, legal entity, final offer, or consistent public/server catalog until wired and read back. |
| `docs/business/launch-plan.md`, `docs/business/brand-options.md`, `docs/business/brand-domain-shortlist.md`, `docs/business/market-research.md`, `docs/business/hosting-review.md` | Business positioning/pricing hypotheses, provisional name/domain options, dated market research, hosting recommendation, cost model, and named commercial inputs. | Legal clearance, customer traction, provider approval, or a committed offer. |
| `docs/evidence/production-release-ef8922c-20260916.json` | Durable PR #58 record for all four READY production deployments at main `ef8922c`, public health/pricing readbacks, identity disabled with `providers: []`, and the native-CI waiver. | These deployment and archive records do not prove hosted identity/provider callbacks, the full customer publish-to-install path, native Linux/Windows execution, or paid activation. |
| `docs/evidence/local-storage-billing-restoration-20260916.json` | Candidate storage/billing recovery record: 86 focused local tests, 49 mixed checks, and one separate PostgreSQL recovery test covering ledger compensation and generation fencing. | It is not an all-PostgreSQL combined proof and does not close provider finality, hosted recovery, G1 crash closure, owned-PUT receipt interaction, or final runtime bindings. |
| `docs/evidence/local-billing-console-demo-acceptance-20260916.json` | Local `LocalBillingAdapter` browser demo with tenant-bound checkout/portal completion, signed test billing, PostgreSQL readback, Reader denial, and diagnostics. | No Stripe account, live charge, or commercial payment availability is proved; the local adapter is a bounded development fixture. |
| `docs/evidence/marketing-usability-audit-20260916.md` | Local `9f46983` marketing follow-up with nine public routes, axe cleanliness, and manual gradient-contrast review. | The follow-up is not deployed by PR #58; production responsive, contrast, claims, and hosted app navigation still require review. |
| `docs/evidence/hosted-cli-v0.4.0-private-provision-20260916.json`, `docs/evidence/hosted-cli-v0.4.0-private-manifest-20260916.json` | Private Vercel Blob provisioning and exact-byte/digest provider readback for the three v0.4.0 CLI assets, plus the redacted manifest envelope. | The scoped provision did not mutate production environment or deploy the manifest; it does not prove a hosted browser chooser/install, same-deployment publish-to-install, or native Linux/Windows execution. |
| `docs/evidence/production-release-11b5e1d.json` | Historical PR #54 production record for source `11b5e1d`; it is retained for its dated archive and deployment observations. | It is not the current main release and cannot close current production rows by itself. |
| `docs/evidence/hosted-postgres-restore-proof-20260916.json`, `docs/evidence/hosted-postgres-restore-physical-type-correction-20260916.json` | Bounded existing-registry row restore, referenced-object digest checks, and PostgreSQL JSONB physical/semantic preservation. | These records do not prove tenant-wide migration, whole-database restore, or the coordinated PostgreSQL/object-storage fence required for launch. |
| `docs/evidence/*.json` | Sanitized, dated evidence for the exact slice named by each record. | General release readiness when the deployment, source, or mutation window differs. |

## Launch must-haves and later work

The 18 September launch must close the following before it can be described as
a hosted private beta with a credible path to paid activation:

* the homepage, getting-started docs, pricing state, and support/claim labels
  are integrated and browser-checked;
* Better Auth identity, actual tenant router composition, durable membership,
  explicit company switch/onboarding, scoped CLI token handling, and the
  two-company role/revocation matrix pass focused tests;
* GitHub and Google are configured and each has a real deployed callback proof
  when their external credentials are available; the local two-issuer proof is
  separately labeled and green;
* required scan approval/rejection, worker/Eve audience separation, source and
  cache isolation, storage grant checks, migration/default adoption,
  backup/restore/rollback, and caps have dated evidence;
* billing test mode is integrated, tenant-bound, signed/idempotent, and
  reconciled; the public plan cards match the server catalog;
* hosting, secrets/configuration, monitoring, support escalation, draft terms
  and privacy, and the final beta-only versus paid-ready decision are recorded;
* Stripe setup, legal entity, support contact, tax/invoice/refund decisions,
  and any required external provider approvals remain explicit blockers rather
  than implied completion.

The following are post-launch or enterprise follow-ons unless separately
selected and evidenced by 18 September: custom production domains and DNS
automation, destructive organization deletion and customer data erasure
workflows, Microsoft as a third live provider, SCIM provisioning, residency
or SLA commitments, broad public marketplace/source coverage, and a dedicated
scanner fleet triggered by measured scale. They must not leak into first-launch
pricing or marketing claims.

## Decision record template

The launch owner should update each row with a link to the immutable test,
deployment, or provider record. A final decision must use one of these labels:

* **Ready for hosted beta/demo:** product, identity, isolation, required scan,
  recovery, and hosted positive/negative evidence are complete; public CTAs are
  beta/demo or pilot requests; billing remains test-only if the external gate is
  open.
* **Ready for paid activation:** hosted beta gates pass, the selected offer is
  enforced, legal/support inputs are approved, and the Stripe account and live
  webhook/readback are complete.
* **Hold:** any required row is missing, stale, unassigned, or supported only by
  a fixture that is labeled local/baseline.

Record the label, date/time in Brisbane, release/source/deployment identifiers,
owner approvals, and the next external action. Never turn “test mode,” “pending
account,” “unconfigured,” or “local fixture” into a paid or hosted claim.

## Company portal, billing console and SSO — required scope

User-confirmed on 15 September 2026: every company has a complete isolated portal and company administration, separate from platform administration. This is required launch work, not a post-launch enterprise-only roadmap item.

- Company portal: dedicated company URL/context, branding, registry, packs, sources, scan policies, analytics and Eve; server-enforced tenant boundaries on every operation.
- Company administration: members, invitations, roles, service/API credentials and settings; permissions verified server-side.
- Billing console: plan and subscription status, measured usage and enforced limits, invoices, checkout and subscription management. Restrict billing operations to authorized company roles and derive customer identifiers server-side. Before Stripe setup, explicitly show unavailable/test states; never imply live billing works.
- Company SSO: company-admin-managed identity-provider configuration and company-specific sign-in/discovery, supporting OIDC and SAML integration paths. Prove separate companies using separate configured providers, correct callback/session/membership binding, unauthorized configuration rejection and recovery access. Platform social login alone does not satisfy this requirement. Never grant company membership based solely on an unverified email domain.
- Acceptance evidence: browser journeys for company administrator and member; denied cross-company portal, billing and SSO access; provider callback and persistence evidence. Label local SSO fixtures separately from actual customer IdP setup.

## Integration reconciliation — 16 September 2026

This checkpoint supersedes the older PR #55/candidate `8c3a69` wording. It
reconciles production main `ef8922c` (PR #58), the unreleased runtime candidate
line `3713f14` / `59c8f69`, and the evidence ledger in
`docs/business/tracking/status.md`. Production, candidate, local, historical,
hosted, and commercial evidence remain labeled at their own boundaries.

- The [PR #58 release record](../evidence/production-release-ef8922c-20260916.json)
  records all four Git-triggered Vercel deployments READY at the exact merged
  SHA, public health/pricing readbacks, identity disabled with `providers: []`,
  and native CI blocked before runner execution under the user-authorized
  waiver. It does not prove hosted identity, customer callbacks, or paid
  activation.
- The [hosted schema-preparation record](../evidence/hosted-identity-schema-preparation-20260916-attempt-2.json)
  independently verifies 12 empty target tables, verified columns/indexes,
  unchanged registry revision `232` and state-set digest, and a public config
  readback with Better Auth disabled and `providers: []`. It records additive
  schema preparation only; customer IdP configuration, traffic activation,
  migration/restore acceptance, and provider callbacks remain open.
- The local `9f46983` marketing follow-up records nine public routes, axe
  cleanliness, and manual gradient-contrast review. It is not deployed by PR
  #58; production responsive, contrast, and claim review remain open.
- The [local billing demo](../evidence/local-billing-console-demo-acceptance-20260916.json)
  at source `3548be2` passes tenant-bound checkout/portal completion, signed
  test billing, PostgreSQL readback, Reader denial, and browser diagnostics
  through `LocalBillingAdapter`. It has no Stripe account or live charge and
  proves only the local test-mode surface.
- The [storage/billing recovery record](../evidence/local-storage-billing-restoration-20260916.json)
  reports 86 focused local tests, 49 mixed checks, and one separate PostgreSQL
  recovery test. The 86/49 checks are not an all-PostgreSQL combined proof;
  provider finality, durable compensation, and hosted recovery remain open.
- Candidate follow-ups include the committed G1 measurement-fence fix, the
  receipt-mint/only-owned-PUT interaction, actual runtime provider bindings and
  hosted proof, and the final combined suite. The candidate remains unreleased
  until those checks pass together. The local evidence does not close B05/B21/
  B28 or the hosted worker/scanner/provider boundaries.
- The existing bounded backup and local tenant/worker records remain useful
  component evidence only. They do not prove hosted tenant migration, a
  coordinated PostgreSQL/object-storage fence, real external scanner/provider
  behavior, or customer two-company isolation.

The decision remains **Hold** until required hosted/product evidence and the
candidate recovery gates are complete. Native Linux and Windows remain
unverified. Real customer IdP configuration, legal entity/support details,
brand/domain selection, final offer, and Stripe activation remain external
inputs; Stripe stays the final activation step. Preserve the later MCP, editor,
OpenClaw, SCIM, residency, custom-domain, and dedicated-scanner roadmap items.
