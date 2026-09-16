# Private Skills launch acceptance

**Planning snapshot:** 15 September 2026, Brisbane (Australia/Brisbane)

**Reconciled against production:** 16 September 2026, Brisbane. Current
production source is `origin/main` `ee7d3c` (PR #60); the [durable production
marketing/claims record](../evidence/production-release-marketing-claims-ee7d3c35-20260916.json)
records all four Vercel deployments READY, nine marketing routes, and the app
health/config/robots/sitemap readbacks. The last committed prior production
record is PR #59 at `884992f`.
The current combined candidate snapshot is `87a2f0c`, with full validation
source `036fb74`, billing schema/apply evidence through `ac87e31` / `95eaf2a`,
forward-recovery evidence `b886ccd`, and PostgreSQL/Blob comparison evidence
`87a2f0c`. The status rows below distinguish production, candidate, local,
historical, hosted, and external-input evidence. Local and disposable evidence
remains separate from hosted and commercial acceptance. Root subsequently
carried this checkpoint into tree-identical merge candidate `ab3c1dd`; the
named evidence remains keyed to `87a2f0c`.

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

Current production is `origin/main` `ee7d3c` (PR #60). The [PR #60 release
record](../evidence/production-release-marketing-claims-ee7d3c35-20260916.json)
verifies all four Vercel deployments READY at that exact merged SHA, nine
public marketing routes plus app health/config/robots/sitemap readbacks, and
the corrected public copy. The last committed [PR #59 release record](../evidence/production-release-reader-ui-884992f-20260916.json)
records the earlier public slice, identity disabled with `providers: []`, and
the user-authorized native-CI waiver. Neither production record proves an
authenticated hosted tenant journey, provider callbacks, or paid activation.

The current candidate [full validation record](../evidence/local-storage-billing-restoration-20260916.json)
uses source `036fb74` and reports 178 test files passed, 18 skipped, 1,281
tests passed, and 44 skipped. Typecheck, the Node Nitro build, the Vercel Blob
build profile, and the Cloudflare edge build passed. Separate disposable
loopback PostgreSQL coverage passed 12 files/34 tests, and the composed Nitro /
PostgreSQL / Files SDK proof passed one file/2 tests. These are local tests with
no production database, storage provider, or external IdP contact. Root later
carried the same checkpoint into merge candidate `ab3c1dd`.

The migration guard source `9ca72ce` passed its bounded 14 focused checks and
TypeScript validation. The [hosted billing migration record](../evidence/billing-hosted-migration-plan-20260916.json)
now records the guarded apply and independent readback: five billing tables,
51 columns, 13 checks, 9 indexes, and zero billing rows; the 12 identity
relations remain empty and the registry remains at revision `232`. This creates
schema only; billing, metering, webhook, Stripe, and customer payment state are
not activated.

The [populated B05/L10 matrix](../evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json)
is **local complete for its stated scope**: a disposable two-company matrix
covers wrong-company resource reads/mutations, packs, drafts, source lists /
search / resolve, analytics, and Eve audience denial, alongside the actual
PostgreSQL identity route. The [two-company browser record](../evidence/local-two-company-switch-acceptance-20260916.json)
adds an Alpha-owner/Beta-reader switch, catalog/pack/draft isolation, and
reader billing denial on desktop and mobile. These records use fixed handlers
or local fixtures for part of the registry surface and do not prove worker
dispatch, scanner execution, storage recovery, provider lifecycle, or hosted
browser isolation.

The [hosted receipt rehearsal](../evidence/hosted-storage-receipt-rehearsal-20260916.json)
records one bounded private Vercel Blob plan object, 177 bytes, with exact
receipt/readback and cleanup. Its unknown-provider and binding-mismatch
retention negatives are local disposable checks; it is not whole-provider
finality or hosted database recovery evidence. The [local billing demo](../evidence/local-billing-console-demo-acceptance-20260916.json)
remains test-mode only and uses no Stripe account or live charge. Local token
create/sign-in/use/revoke and signed OIDC/SAML checks remain fixture evidence.

The [full PostgreSQL backup/restore record](../evidence/full-postgres-backup-recovery-20260916.json)
(`38915216`) read the production database through a repeatable-read snapshot,
encrypted the dump, restored it into an isolated PostgreSQL target, and matched
the 14-table source state. The [forward recovery record](../evidence/full-postgres-forward-billing-recovery-20260916.json)
(`b886ccd`) then restored that image locally after the reviewed billing schema,
matching a 19-table target with five empty billing tables and unchanged
identity/semantic/registry state. The [composed PostgreSQL/Blob record](../evidence/composed-pg-blob-backup-coverage-20260916.json)
(`87a2f0c`) verifies 11 referenced objects totaling 37,741 bytes by key, digest,
and size. The operations are bounded: no coordinated freeze, application-level
key remap, serving-path restore, provider-state restore, or full application
restore is claimed.

The [Vercel entitlement readback](../evidence/vercel-entitlement-readonly-20260915T225659Z.json)
records the current Hobby/Fluid account. The candidate's 615-second function
budget exceeds Hobby's 300-second maximum. Independently, its 5- and 15-minute
cron schedules exceed Hobby's daily cron minimum. The user's Pro-versus-
adaptation decision remains open. Real provider callbacks, hosted secrets,
hosted application restore/serving-path verification, worker/scanner bindings,
and commercial gates remain open. The [marketing claims/pricing audit](../evidence/marketing-claims-pricing-audit-20260916.md)
from `a74dc3e` remains source-only; PR #60 includes the deployed contrast and
public route readbacks, while the a74 copy follow-up is not yet deployed.

## Remaining work count — 16 September 2026

These are grouped launch workstreams; the detailed requirements and evidence
boundaries remain below.

| Group | Open workstreams | Current scope |
| --- | ---: | --- |
| Product/public surface | 4 | Hosted identity/onboarding/SSO; the integrated two-company browser journey with required-scan and worker/Eve audiences; hosted publish/review/install with source/search/analytics isolation; final marketing, claim, and public pricing review. The populated local B05/L10 matrix is recorded as complete for its bounded scope. |
| Hosting/operations | 5 | Hosted tenant migration/restore/rollback and provider finality; worker capacity and monitoring; native Linux/Windows qualification; production provider, callback, and secret readback; Vercel Hobby/Pro versus adaptation decision. PR #60 deployment and bounded Blob receipt/readback slices are already recorded. |
| Business/commercial | 5 | Billing recovery and usage reconciliation; plan/catalog alignment; B14–B16 customer/name/domain decisions; legal/support/offer inputs; Stripe activation. Test-mode billing remains local evidence only. |

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
| 16 Sep | Tenant acceptance + Auth backend | Record the bounded two-company browser and PostgreSQL journeys, then separate their local limits from the hosted runtime proof: provider/session identity, active membership, company switch, scoped CLI token, role change, and revocation. | `docs/evidence/local-two-company-switch-acceptance-20260916.json`, `apps/web/src/tenant-identity-route.postgres.integration.test.ts`, and `tests/e2e/multi-tenant-postgres-acceptance.test.ts`; local source and browser evidence is complete for its stated scope, with no fixture-only selector presented as hosted proof. |
| 17 Sep | Tenant acceptance + Worker/Eve + Billing | Complete the deterministic two-issuer flow, required-scan approval/rejection, worker/Eve audience checks, and billing test-mode create/change/cancel/refund/reconcile path. | Dated focused test artifacts and a sanitized evidence bundle. |
| 18 Sep | Hosting/Operations + Product + Marketing + Finance/Legal | Verify the selected hosted origin, migration/backup/rollback runbook, public claims, pricing configuration, draft policies, and launch decision. | Authenticated hosted readback, immutable deployment/evidence identifiers, and an owner decision for every open external input. |
| 20 Sep contingency | Launch owner | Recheck only gates whose external state changed; do not relabel pending provider or payment approval as complete. | Updated row dates and an explicit beta-only or paid-ready decision. |

## Product acceptance

| Owner | Requirement and observable acceptance | Authoritative evidence | Status at production main ee7d3c / candidate 87a2f0c / target |
| --- | --- | --- | --- |
| Product + Engineering | **Positioning:** the product is a private registry and governed pull-through for versioned agent skills and packs. The user journey is source or upload → validation → required scan → policy decision → immutable release → authorized CLI install. Homepage copy must say that scan evidence is a policy input, not a harmlessness or agent-behavior guarantee. | `README.md:1-3,53-68`, `docs/product.md`, `docs/business/launch-plan.md`, `apps/marketing/src/routes/index.tsx`, and `docs/evidence/production-release-marketing-claims-ee7d3c35-20260916.json`. | **Public slice verified:** PR #60's durable record verifies the separate marketing route, nine public routes, and app readbacks at `ee7d3c`. Final hosted application journey and claim/cross-site review remain open. |
| Product + Engineering | **Publish/review/install:** a benign artifact can be published, required evidence can complete, approval can be read, a pinned release or exact-member pack can be authorized, and the Rust CLI receives the same approved digest on repeat install. A blocked, stale, or revoked release cannot transfer. | `tests/e2e/registry.test.ts`, `tests/e2e/directory-security.test.ts`, `docs/evidence/local-compose-required-scan-34e4f56.json`, `docs/evidence/hosted-storage-receipt-rehearsal-20260916.json`, `docs/evidence/composed-pg-blob-backup-coverage-20260916.json`, `docs/evidence/hosted-cli-v0.4.0-private-provision-20260916.json`, `docs/cli-and-packs.md`. | **Local/hosted storage slices complete:** private-store exact-byte readback for all three v0.4.0 assets, the bounded 177-byte hosted receipt cleanup pass, and separate 11-object PostgreSQL/Blob digest readback. A same-deployment positive publish → required scan → approval → install, hosted browser chooser/install, and negative stale/revoked/foreign-company checks remain open. |
| Product + Engineering | **No execution:** uploaded/imported skill content is data during ingestion, scanning, and installation. Candidate scripts, hooks, MCP servers, and package lifecycle code are never executed by the registry. | `AGENTS.md`, `README.md:174-180`, scanner and storage contracts, and the required-scan negative fixture. | Implemented boundary; retain as a homepage FAQ claim and include it in the release readback. |
| Product + Source owner | **Source catalog:** a configured source can list/search/resolve an exact external identity; source revision, policy, and canonical digest remain attached through import. A source credential never enters a browser response, job body, log, cache value, or CLI token. | `docs/source-catalog.md`, `packages/source-catalog/src`, `tests/e2e/source-tenant-isolation.test.ts`, `docs/evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json`, and `docs/evidence/openclaw-clawhub-feed-evidence-20260910.json`. | **Local bounded slice complete:** the populated matrix covers company-scoped source list/search/resolve and provenance. Hosted positive pull-through, external source availability, and tenant-aware warm-cache proof remain open; 17 Sep. |
| Product + Engineering | **Search and analytics:** search only returns approved, authorized rows and rechecks content/artifact digests. Install analytics come from client-confirmed receipts and never infer installs from downloads. | `docs/semantic-search.md`, `docs/analytics.md`, `packages/search/src`, `packages/core/src/index.ts` search/analytics routes, and `docs/evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json`. | **Local bounded slice complete:** company-scoped search and analytics isolation are covered by the populated matrix. Hosted identity/company filters, cost controls, and same-deployment readback remain open; 17 Sep. |
| Product + Eve owner | **Human review:** Eve receives a bounded, company-bound snapshot and records a proposal. Eve cannot publish, merge, edit source, authorize installs, or execute candidates. | `docs/eve-reviewer.md`, `packages/intelligence/src/handler.ts`, `apps/web/server/eve-tenant-runtime.ts`, `packages/eve-tenant/src/index.ts`, `docs/evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json`, and `docs/evidence/production-m6-eve-session-34e4f56.json`. | **Local bounded slice complete:** the populated matrix covers foreign-company Eve resources and registry-route audience denial. Company-bound prepare/complete through the worker, cost reservation, external model/provider, and hosted proof remain open; 17 Sep. |
| CLI owner | **Cross-platform install:** the published `pskills` assets pass checksum/member-shape verification and the supported native limits are stated. Mac arm64 is the current native smoke; Linux QEMU and Windows Wine are nonnative evidence unless current native CI says otherwise. | `README.md:7-12,65-66`, `docs/verification-current.md`, `docs/evidence/local-macos-arm64-cli-qualification-20260916.json`, `docs/evidence/local-linux-amd64-cli-qualification-20260916.json`, and `docs/evidence/local-nitro-native-cli-install-20260916.json`. | **Mac arm64 local qualification complete; Linux amd64 is emulated:** v0.4.0 archive digests, version/help, and controlled install/verify/remove (Mac) or install (Linux) passed. Native Linux CI and Windows remain unverified; do not expand the homepage into those platform promises, 18 Sep. |
| Product + Support | **Onboarding:** a new user can see provider choices, sign in, choose or create a company, and use a copy-link invitation. An authenticated user with no membership receives an onboarding response and no registry data. Invitation delivery is not described as email until an email transport is configured and tested. | Integrated identity BFF (`/auth/identity/config`, `/auth/identity/session`), `apps/web/server/company-sso-runtime.ts`, `docs/identity.md`, `docs/identity-company-sso.md`, and the local browser journey. | Better Auth identity BFF, onboarding source, company selector UI, invitation copy-link source, company SSO runtime/discovery/picker source, and local PostgreSQL composition are integrated. The latest [hosted schema-preparation record](../evidence/hosted-identity-schema-preparation-20260916-attempt-2.json) verifies 12 empty identity/SSO/token/operations tables, while production identity remains deliberately disabled (`providers: []`). Invitee acceptance, clipboard/wrong-email/expiry cases, hosted browser flow, and a real customer provider callback remain open. Manual link/code is the launch path; 16–18 Sep. |
| Tenant acceptance | **Two-company boundary:** the actual outer tenant router derives company from a verified Better Auth membership or scoped credential before creating a fixed-company handler. Same names and digests remain separate rows; a foreign id/key/grant/operation returns a generic denial without opening the blob. Company headers, query selectors, body fields, and display names cannot switch context. | `docs/identity-company-sso.md`, `tests/e2e/directory-security.test.ts`, `tests/e2e/source-tenant-isolation.test.ts`, `apps/web/src/tenant-identity-route.postgres.integration.test.ts`, `tests/e2e/multi-tenant-postgres-acceptance.test.ts`, `docs/evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json`, and `docs/evidence/local-two-company-switch-acceptance-20260916.json`. | **Local B05/L10 matrix and browser slice complete for their stated scopes:** the populated record covers files, drafts, packs, source/import-facing lists, search, analytics, and Eve callbacks; the browser record proves Alpha owner/Beta reader switch and cross-company draft/billing denial. The fixed-handler and local-fixture portions do not prove full worker/scanner/storage/provider composition; hosted two-company evidence remains open. |
| Tenant acceptance + Worker/Eve | **Credential audiences:** browser sessions, scoped CLI/service tokens, worker tokens, source credentials, storage grants, and Eve reviewer tokens are separate. User/session cookies cannot claim jobs; worker tokens cannot call `/v1/*`; Eve tokens cannot call registry routes; company A credentials cannot reach company B. Role removal, session revoke, and token revoke take effect on the next privileged request. | `packages/contracts/src/index.ts`, `packages/auth/src/index.ts`, `workers/runner/src`, `packages/eve-tenant/src/index.ts`, `docs/eve-reviewer.md`, integrated identity/tenant router, and the focused acceptance tests. | **Local negative slices complete:** session/token create/use/revoke, company mismatch, and deterministic worker/Eve denial are recorded, including the populated matrix's foreign-company checks. The full worker/Eve audience journey, hosted boundary, and connected provider proof remain open; 16–17 Sep. |
| Tenant acceptance + Operations | **Migration/recovery:** Better Auth and company tables migrate additively under a lock; the current `default` organization is adopted only through an explicit bootstrap-owner action; backup/restore preserves ids, digests, grants, scans, audit, and object references; rollback behavior is rehearsed and secrets are absent from manifests/logs. | `docs/identity-company-sso.md`, `docs/restore-rehearsal.md`, `docs/full-postgres-backup-recovery.md`, `docs/evidence/full-postgres-backup-recovery-20260916.json`, `docs/evidence/full-postgres-forward-billing-recovery-20260916.json`, `docs/evidence/composed-pg-blob-backup-coverage-20260916.json`, `docs/evidence/hosted-postgres-restore-proof-20260916.json`, `scripts/restore-backup-postgres.ts`, `tests/operations-postgres-rehearsal.test.ts`, and the integrated identity migration plan. | **Bounded recovery slices complete:** a read-only production snapshot restored locally with 14-table matching, forward recovery restored 19 local tables including five empty billing tables, and a separate Blob comparison read 11 referenced objects with matching key/digest/size. Coordinated PostgreSQL/Blob fencing, application serving-path restore, provider state, explicit default adoption, rollback, hosted tenant migration, and hosted recovery remain open. |
| Tenant acceptance + Operations | **Caps:** request/body, upload, publish, source fetch, search/reindex, callback/device poll, transfer, worker, reviewer, and provider calls have per-company bounded limits. At a cap, responses are stable and bounded with no silent required-scan bypass or unbounded queue/cache growth. | `docs/identity-company-sso.md`, `docs/operations.md`, `packages/auth/src`, scanner/job contracts, and a low-cap focused probe. | **Local implementation partial:** route and scanner bounds are present, but identity callback/device limits, company-aware rate accounting, worker/provider caps, and deployed cap evidence remain open; 17–18 Sep. |

## Marketing and public surface acceptance

| Owner | Requirement and observable acceptance | Authoritative evidence | Status at production main ee7d3c / candidate 87a2f0c / target |
| --- | --- | --- | --- |
| Marketing + Product | **Homepage:** the hero, feature sections, FAQ, and calls to action explain “private registry for engineering teams,” source → scan → pack → install, provenance, required-scan failure behavior, and human Eve review. Claims distinguish implemented product behavior from configured provider/deployment inputs. | Integrated `apps/marketing/src/routes/index.tsx`, `apps/marketing/src/components/PublicLayout.tsx`, `apps/marketing/src/lib/brand.ts`, `docs/business/launch-plan.md`, `README.md`, and `docs/evidence/production-release-marketing-claims-ee7d3c35-20260916.json`. | **Public production slice verified:** PR #60's durable record verifies nine public marketing routes, corrected access copy, and the app readbacks at `ee7d3c`. The source-only `a74dc3e` follow-up remains separate; the hosted application journey and final claim/cross-site review remain open. |
| Marketing + Product | **Docs-led activation:** `/docs`, `/docs/getting-started`, and the CLI path show the shortest benign local proof, policy-first setup, exact release/pack install, boundaries, and the next owner-group workflow. They do not imply hosted source, OAuth, or paid support where none is configured. | Integrated `apps/marketing/src/routes/docs.tsx`, `apps/marketing/src/routes/docs.getting-started.tsx`, `apps/marketing/src/routeTree.gen.ts`, `docs/cli-and-packs.md`, `docs/verification-current.md`, `docs/identity-company-sso.md`, and `docs/evidence/production-release-marketing-claims-ee7d3c35-20260916.json`. | **Public route readback verified:** PR #60 records the nine marketing routes and noindex robots/sitemap responses. Complete docs-led browser/readback and the authenticated application next step remain required. |
| Marketing + Product | **Proof labeling:** local fixtures, deterministic issuers, nonnative CLI checks, quarantined imports, test-mode billing, and prior deployment evidence carry visible labels. The site never uses a quarantined artifact as a positive testimonial and does not claim “secure,” “compliant,” SLA, residency, SOC 2, or native-platform support without evidence. | `docs/business/launch-plan.md`, `docs/verification-current.md`, `docs/evidence/production-release-marketing-claims-ee7d3c35-20260916.json`, this matrix, and the final copy review. | **Public labeling verified; copy follow-up open:** PR #60 deploys the corrected access/preview wording and contrast change. Source `a74dc3e` still contains a follow-up audit that is not deployed; final pricing, responsive, and claim review remains open. |
| Marketing + Product | **Brand/domain:** “Private Skills” remains the working name until a naming and domain decision is recorded. Candidate names are not clearance results. A custom production domain is only advertised after DNS ownership, TLS, callback origins, and hosted health are verified. | `apps/marketing/src/lib/brand.ts`, `docs/business/brand-options.md`, `docs/business/brand-domain-shortlist.md`, `docs/business/developer-ai-market-update-20260916.md`, `docs/business/market-research.md`, DNS/deployment evidence, and final owner decision. | Dated market research is complete in `41e864b`/`5966e0f`, and naming/clearance research is recorded in `dd903de` with MR01–MR07 and A1–A7 tracking. No name/domain selection or purchase is recorded; recheck availability and obtain the business/legal decision before changing the working name, 18 Sep. |
| Marketing + Product | **Pricing page:** public cards must match the actual server `PlanCatalog` and show whether a recurring price is configured. “Proposed,” “test mode,” and “checkout unavailable” states are visible; the page has no self-serve paid CTA before the live account and legal/contact gate. | Integrated `apps/marketing/src/routes/pricing.tsx`, `apps/marketing/src/lib/marketingPlans.ts`, `apps/marketing/src/lib/marketingPlanMetadata.ts`, `docs/business/launch-plan.md`, and `packages/billing/src/plans.ts`. | The locally verified marketing change now projects the shared browser-safe metadata with server `free`/`team`/`business` IDs, labels, descriptions, finite limits, and explicit price/checkout readiness. It accepts a bounded public-only custom projection at build time, fails closed for malformed or server-only fields, and keeps preview/no-purchase copy. The app billing console remains authoritative at runtime; Stripe account, final packaging, and public prices remain open. |

## Business and billing acceptance

| Owner | Requirement and observable acceptance | Authoritative evidence | Status at production main ee7d3c / candidate 87a2f0c / target |
| --- | --- | --- | --- |
| Billing + Engineering | **Billing test mode is launch readiness:** a disposable/local provider and signed webhook fixture create a customer, start checkout, map a known price to a plan, apply an entitlement, change/cancel/refund it, reject stale/invalid/replayed events, and reconcile idempotently. Usage reservations enforce seats, retained bytes, scanner executions, and Eve budget without an “unlimited” fallback. | Integrated `packages/billing/src/{types,plans,repository,stripe,webhooks}.ts`, `apps/web/server/routes/billing.ts`, focused billing/runtime tests, the [local billing demo](../evidence/local-billing-console-demo-acceptance-20260916.json), [candidate validation](../evidence/local-storage-billing-restoration-20260916.json), and `docs/business/launch-plan.md`. | **Local test-mode slice complete; recovery gate open:** the demo passes tenant-bound checkout/portal completion, signed test billing, PostgreSQL readback, and Reader denial through `LocalBillingAdapter`; no Stripe account or live charge is involved. The current candidate record has 1,281 passed/44 skipped full-suite tests and 34 direct PostgreSQL tests, but billing recovery/usage reconciliation and hosted binding/readback remain open. |
| Billing + Product | **Plan/entitlement consistency:** one server catalog is the source of plan ids, limits, price ids, checkout availability, portal availability, and cap behavior. The public page and onboarding use projections of that catalog rather than a second hard-coded offer. | `packages/billing/src/plans.ts`, `packages/billing/src/types.ts`, `apps/marketing/src/lib/marketingPlans.ts`, `apps/marketing/src/lib/marketingPlanMetadata.ts`, integrated pricing route, and a plan readback. | The separate marketing build now projects the catalog's browser-safe metadata, accepts a bounded public-only custom projection, and fails closed for malformed or server-only fields. The app billing console remains authoritative at runtime. Final packaging, Stripe account, and public prices remain open. |
| Billing + Finance/Operations | **Paid activation:** Stripe account, products/prices, webhook endpoint/signing secret, merchant/legal identity, currency, tax treatment, invoice/refund policy, customer portal, and reconciliation are configured and read back without exposing secrets. | `packages/billing/src/stripe.ts`, `packages/billing/src/webhooks.ts`, deployment env/config evidence, and a sanitized Stripe test/live readback. | Stripe account setup is the final external step and is currently absent. Keep checkout unavailable or test-only until this row is explicitly approved; no provider-approval date promised. |
| Founder + Legal/Finance | **Legal contracting inputs:** legal entity, registered address/jurisdiction, contracting name, privacy/security contact, support email, escalation owner, response target, retention/deletion periods, DPA/subprocessors, and incident notice terms are selected and recorded before charging. | `docs/business/launch-plan.md` commercial-input table, draft Privacy/Terms documents, and owner decision record. | No legal entity or support email has been selected. This does not block independent implementation, but it blocks paid activation and any production support/SLA claim; 18 Sep decision gate. |
| Product + Operations | **Commercial limits:** publish the selected Team/Pilot allowances, scanner/egress/storage/Eve budget policy, cap behavior, cancellation/refund path, and abuse/takedown route only after cost traces and billing enforcement agree. | `docs/business/launch-plan.md`, `docs/business/hosting-review.md`, billing usage service, and a test-mode cap probe. | Planning hypotheses exist; final offer and cost calibration remain open. Do not publish “unlimited” usage; 17–18 Sep. |

## Hosting and production acceptance

| Owner | Requirement and observable acceptance | Authoritative evidence | Status at production main ee7d3c / candidate 87a2f0c / target |
| --- | --- | --- | --- |
| Hosting/Operations | **Hosting decision:** use the existing Vercel Pro + Nitro Node path for launch where configured: Neon PostgreSQL, Files SDK object storage, durable PostgreSQL jobs, bounded Vercel Sandbox scanning, and AI/Eve provider settings. Keep S3/R2 and other Nitro profiles as portability seams, not Friday migrations. | `docs/business/hosting-review.md`, `docs/implementation.md`, `docs/operations.md`, `vercel.json`, `docs/evidence/vercel-entitlement-readonly-20260915T225659Z.json`, and the final deployment record. | **External decision open:** the readback shows the current team is Hobby with Fluid enabled. Independently, the candidate's 615-second function budget exceeds Hobby's 300-second maximum, and its 5- and 15-minute cron schedules exceed Hobby's daily cron minimum. PR #60 is production-verified at `ee7d3c`, but Pro versus adaptation, capacity, exact hosted origin, and hosted acceptance remain open, 18 Sep. |
| Hosting/Operations | **Configuration and secrets:** production has explicit Better Auth secret/base URL/callback origins, database and storage bindings, worker/cron credentials, immutable scanner references, deny-all scanner networking, model/provider config, and bounded request/storage settings. No secret appears in source, health, browser config, logs, or evidence. | `.env.example`, `docs/identity.md`, `docs/operations.md`, hosting env readback with values redacted, and secret-scan output. | Identity/provider env contract exists in the integrated root `.env.example`, `docs/identity.md`, and Node infrastructure. Production identity readback is explicitly disabled with `providers: []`; provider wiring, secret bindings, and redacted deployment readback remain open, 18 Sep. |
| Hosting/Operations + Identity | **Migration/rollback:** run the reviewed Better Auth migration before accepting traffic, record schema/revision/backup manifest, quiesce or fence concurrent mutations, verify row counts/digests/object references, and demonstrate rollback or a documented forward-fix when down-migration is unsafe. | `docs/identity-company-sso.md`, `docs/identity.md`, `docs/restore-rehearsal.md`, `docs/full-postgres-backup-recovery.md`, `docs/evidence/full-postgres-backup-recovery-20260916.json`, `docs/evidence/full-postgres-forward-billing-recovery-20260916.json`, `docs/evidence/composed-pg-blob-backup-coverage-20260916.json`, `docs/evidence/billing-hosted-migration-plan-20260916.json`, `tests/operations-postgres-rehearsal.test.ts`. | **Bounded migration/recovery slices complete:** the hosted billing schema was applied and independently read back as five empty billing tables (51 columns, 13 checks, 9 indexes, zero rows), while local backup/forward recovery matched 14 source tables to a 19-table target and separate Blob comparison read 11 referenced objects with matching key/digest/size. Blob/provider state, coordinated fencing, application serving-path restore, explicit default adoption, rollback, hosted tenant migration, and full hosted recovery remain open. |
| Hosting/Operations | **Runtime proof:** the target origin serves the current release and an authenticated browser/CLI flow. `/health` is nonsecret; hosted positive publish → required scan → approval → transfer → CLI install and negative revoked/stale/foreign-company checks are recorded against the same deployment. | `docs/verification-current.md`, `docs/evidence/production-release-marketing-claims-ee7d3c35-20260916.json`, `docs/evidence/production-release-reader-ui-884992f-20260916.json`, `docs/evidence/hosted-cli-v0.4.0-private-provision-20260916.json`, deployment URL/source/deployment IDs, and the tenant acceptance evidence bundle. | **Public production slice verified; hosted application flow open:** PR #60 records all four deployments READY at `ee7d3c`, public health/config/readbacks, and nine marketing routes. Identity remains disabled (`providers: []`), and the authenticated hosted multi-company positive flow plus stale/revoked/foreign-company checks remain open. |
| Hosting/Operations | **Worker/Eve operations:** the cron route is a liveness trigger, durable leases/fencing remain authoritative, scanner images/rules are pinned, required evidence expires predictably, and Eve/model calls have per-company budgets and bounded time/token limits. | `docs/operations.md`, `docs/scanners.md`, `docs/eve-reviewer.md`, `workers/runner`, `apps/web/server/eve-tenant-runtime.ts`, `docs/business/hosting-review.md`, and operational logs with redaction. | Core worker/Eve boundaries and tenant delegation wiring are integrated, but capacity/cost traces, actual provider credentials, and hosted worker/Eve audience proof remain open, 17 Sep. |
| Hosting/Operations | **Monitoring and recovery:** dashboards/alerts cover auth failure, membership denial, callback errors, migration state, queue age, required-scan freshness, blob reads, storage/egress, model spend, billing webhooks, and tenant mismatch denials. Operators can rotate/revoke credentials and restore a company without widening access. | `docs/operations.md`, provider dashboards, restore runbook, and a credential-rotation/readback record. | Current docs cover many operational controls, but the Better Auth and billing dashboards/owners are not assigned; 18 Sep. |

## Authoritative evidence register

The following files are the source of truth for their stated slices against
production main `ee7d3c`, the current combined candidate snapshot `87a2f0c`
and its named validation commits, or the named local/historical fixture. Each
row names the evidence boundary that still has to be closed; source
integration alone does not turn a local fixture into hosted acceptance:

| Source | What it proves | What it cannot prove by itself |
| --- | --- | --- |
| `README.md`, `docs/product.md`, `docs/implementation.md` | Product shape, portable Request/Response runtime, current boundaries, and supported commands. | A live provider, hosted company isolation, or billing account. |
| `docs/roadmap.md`, `docs/verification-current.md` | Milestone status and dated deployment/scanner/CLI/restore evidence with explicit limits. | That an older deployment or fixture still represents the integrated release. |
| `docs/identity-company-sso.md`, `apps/web/server/company-sso-runtime.ts`, `packages/identity/test/company-sso.better-auth.integration.test.ts` | Tenant identity/SSO contract, critical isolation surfaces, provider strategy, migration requirements, runtime mounting, local signed OIDC/SAML protocol checks, and focused acceptance plan. | A hosted Better Auth implementation, customer provider, or authenticated deployment readback until those checks pass. |
| `tests/e2e/directory-security.test.ts`, `tests/e2e/source-tenant-isolation.test.ts` | Existing operation/skill/pack/scan/audit/grant/blob and source-cache isolation slices. | Interactive membership, OAuth callback, or worker/Eve runtime composition. |
| `apps/web/src/tenant-identity-route.postgres.integration.test.ts` and `tests/e2e/multi-tenant-postgres-acceptance.test.ts` | Two complementary local PostgreSQL tests: actual Better Auth/API-token tenant routing, and populated core registry isolation across resource types. The companion [populated B05/L10 matrix](../evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json) covers files, drafts, packs, source lists/search/resolve, analytics, and Eve audience denial for two companies. | The composed identity test uses real memberships and persisted tokens; the populated core test uses fixed handlers. The matrix is local-complete for its stated scope, but neither proves full hosted Nitro/provider lifecycle, external scanner execution, or deployed worker/Eve boundaries. |
| `packages/identity/src/index.ts`, `docs/identity.md` | Integrated Better Auth runtime contract: provider config, live membership/session lookup, onboarding, copy-link invitations, explicit migration, and sanitized identity BFF. | Provider account approval, hosted PostgreSQL migration/readback, or a deployed authenticated callback. |
| `apps/web/server/tenant-runtime.ts` and `apps/web/server/runtime.ts` | Integrated outer tenant router and Request composition: verified selection, no untrusted header selection, handler cache keyed only by company, onboarding, inner recheck, default credential non-reuse, and the current optional company SSO runtime mount. | A hosted end-to-end route, real provider, or full worker/scanner/storage/provider composition; the bounded populated two-company matrix is recorded separately and is not a hosted claim. |
| `scripts/local-identity-demo.mjs`, `tests/local-identity-demo.test.ts`, `tests/fixtures/local-identity-demo-providers.json` | Disposable two-issuer protocol proof: discovery, state, S256 PKCE, token/userinfo/JWKS, fixed users/companies, and provider-env envelope. Tracking also records local signed OIDC/SAML protocol checks. | A real GitHub/Google callback, customer IdP, durable membership in a deployed service, or hosted availability. |
| `packages/billing/src`, `apps/web/server/routes/billing.ts`, `apps/marketing/src/routes/pricing.tsx`, `apps/marketing/src/lib/marketingPlans.ts` | Integrated test-mode billing contracts, tenant console/route factory, and pricing preview projection. | A live Stripe account, legal entity, final offer, or consistent public/server catalog until wired and read back. |
| `docs/business/launch-plan.md`, `docs/business/brand-options.md`, `docs/business/brand-domain-shortlist.md`, `docs/business/market-research.md`, `docs/business/hosting-review.md` | Business positioning/pricing hypotheses, provisional name/domain options, dated market research, hosting recommendation, cost model, and named commercial inputs. | Legal clearance, customer traction, provider approval, or a committed offer. |
| `docs/evidence/production-release-marketing-claims-ee7d3c35-20260916.json` | Durable PR #60 record for all four READY production deployments at main `ee7d3c`, nine public marketing routes, app health/config/robots/sitemap readbacks, corrected access copy, identity disabled with `providers: []`, and the native-CI waiver. | It does not prove hosted identity/provider callbacks, the full customer publish-to-install path, native Windows execution, or paid activation. |
| `docs/evidence/production-release-reader-ui-884992f-20260916.json` | Historical PR #59 record for all four READY production deployments at main `884992f`, public health and marketing route readbacks, identity disabled with `providers: []`, protected configuration, and the native-CI waiver. | It is the prior production slice; it does not supersede the current PR #60 record or prove hosted identity/provider callbacks, the full customer publish-to-install path, native Windows execution, or paid activation. |
| `docs/evidence/production-release-ef8922c-20260916.json` | Historical PR #58 record for all four READY production deployments at main `ef8922c`; retained for its dated archive and deployment observations. | It is not the current main release and cannot close current production rows by itself. |
| `docs/evidence/local-storage-billing-restoration-20260916.json` | Candidate validation from source `036fb74`: 178 test files passed/18 skipped, 1,281 tests passed/44 skipped, typecheck and Node/Vercel Blob/Cloudflare builds, 34 direct PostgreSQL tests, and 2 composed Nitro tests. | The checks are local/disposable and do not close provider finality, hosted recovery, billing recovery, hosted bindings, or a final hosted customer flow. |
| `docs/evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json` | Populated local two-company B05/L10 matrix: files, drafts, packs, source lists/search/resolve, analytics, Eve foreign-resource denial, and organization-header spoof denial; related PostgreSQL identity routing and Nitro/Files checks are listed. | Part of the registry matrix uses fixed handlers and deterministic adapters; worker dispatch, scanner execution, storage recovery, provider lifecycle, and hosted browser isolation remain outside this record. |
| `docs/evidence/local-two-company-switch-acceptance-20260916.json` | Local headless browser proof with one Alpha owner and Beta reader: company switch/switchback, catalog/pack/draft isolation, reader billing `403`, and mobile selector checks all passed without browser errors. | Disposable PostgreSQL/filesystem state, `LocalBillingAdapter`, and scanner-disabled fixtures were used; no hosted identity, external scanner/LLM, Stripe, or production write is proved. |
| `docs/evidence/hosted-storage-receipt-rehearsal-20260916.json` | Bounded private Vercel Blob receipt plan execution: 177-byte canonical receipt, exact readback, release, inspection deletion, and prefix cleanup. | The unknown-provider and binding-mismatch retention negatives are local disposable checks; this is not whole-provider finality, hosted tenant isolation, or hosted database recovery. |
| `docs/evidence/full-postgres-backup-recovery-20260916.json` | Read-only production PostgreSQL snapshot, encrypted dump, isolated restore, and 14-table/row/digest/registry matching from `38915216`; credentials and payloads are redacted. | The target restore is isolated/local. Blob objects, provider-side state, cluster roles, billing-provider state, and coordinated tenant-wide restore/fence remain separate gates. |
| `docs/evidence/full-postgres-forward-billing-recovery-20260916.json` | Local forward recovery from the retained image after the reviewed schema, matching a 19-table target with five empty billing tables and preserved identity/semantic/registry state. | It is local and does not prove production SQL application, billing rows, provider/webhook state, role/global-object parity, or hosted rollback. |
| `docs/evidence/composed-pg-blob-backup-coverage-20260916.json` | Separate PostgreSQL/Blob comparison: registry revision `232` references 11 objects totaling 37,741 bytes, and a fresh private Blob read matched key, digest, and size. | The operations were not fenced or transactional; no application-level key remap, serving-path restore, provider-state restore, or full application restore is proved. |
| `docs/evidence/billing-hosted-migration-plan-20260916.json` | Guarded production billing schema apply with independent readback: five billing tables, 51 columns, 13 checks, 9 indexes, and zero billing rows; identity relations remain empty and registry revision remains `232`. | This is schema preparation only. It does not activate billing/metering/Stripe/webhooks, prove provider state or usage reconciliation, or prove rollback and hosted application acceptance. |
| `docs/evidence/local-macos-arm64-cli-qualification-20260916.json`, `docs/evidence/local-linux-amd64-cli-qualification-20260916.json`, `docs/evidence/local-nitro-native-cli-install-20260916.json` | v0.4.0 archive digest, version/help, and controlled install evidence: native Apple Silicon Mac, emulated Linux amd64, and a local Nitro/CLI approved install. | Linux is emulated and Windows remains unverified; fixtures do not prove hosted identity, provider callbacks, or production authorization. |
| `docs/evidence/vercel-entitlement-readonly-20260915T225659Z.json` | Sanitized Vercel account/project metadata: Hobby billing plan, Fluid projects, and current linked deployment shape. | It does not select Pro, prove capacity or cron compatibility, or authorize a production plan change. |
| `docs/evidence/local-billing-console-demo-acceptance-20260916.json` | Local `LocalBillingAdapter` browser demo with tenant-bound checkout/portal completion, signed test billing, PostgreSQL readback, Reader denial, and diagnostics. | No Stripe account, live charge, or commercial payment availability is proved; the local adapter is a bounded development fixture. |
| `docs/evidence/marketing-claims-pricing-audit-20260916.md` | Source `a74dc3e` claims/pricing and preview-copy audit, including nine-route local rendering and explicit access/billing labels. | The a74 copy follow-up is source-only and not deployed; PR #60 is the production readback for the released access copy and contrast change. |
| `docs/evidence/marketing-usability-audit-20260916.md` | Historical local `9f46983` marketing follow-up with nine public routes, axe cleanliness, and manual gradient-contrast review. | It is local historical evidence; PR #60 is the production readback for the deployed contrast and access-copy changes. |
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

This checkpoint reconciles the current production main `ee7d3c` (PR #60), the
combined candidate snapshot `87a2f0c`, and the evidence ledger in
`docs/business/tracking/status.md`. PR #59 remains linked as the prior
production record. Production, candidate, local, hosted, historical, and
commercial evidence remain labeled at their own boundaries.

**Complete bounded evidence (local or public):**

- The [PR #60 production record](../evidence/production-release-marketing-claims-ee7d3c35-20260916.json)
  records all four Git-triggered Vercel deployments READY at `ee7d3c`, nine
  public marketing routes, app health/config/robots/sitemap readbacks, and the
  corrected access copy. Identity remains disabled with `providers: []`; this
  is a public release record, not hosted authenticated acceptance.
- The [candidate validation record](../evidence/local-storage-billing-restoration-20260916.json)
  records source `036fb74`, 1,281 passed/44 skipped tests, 34 direct disposable
  PostgreSQL tests, 2 composed Nitro tests, and passing typecheck, Node, Blob,
  and edge builds. The [populated B05/L10 matrix](../evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json)
  and [two-company browser proof](../evidence/local-two-company-switch-acceptance-20260916.json)
  cover their stated local resource, role, switch, and denial surfaces.
- The [billing migration record](../evidence/billing-hosted-migration-plan-20260916.json)
  records guarded schema application and independent readback of five billing
  tables, 51 columns, 13 checks, 9 indexes, and zero billing rows. The identity
  relations remain empty and registry revision `232` is unchanged. This is
  schema preparation only; it is not billing activation or Stripe proof.
- The [full PostgreSQL backup/restore record](../evidence/full-postgres-backup-recovery-20260916.json)
  proves a repeatable-read source snapshot, encrypted dump, isolated restore,
  and 14-table/row/digest/registry matching. The [forward recovery record](../evidence/full-postgres-forward-billing-recovery-20260916.json)
  proves a local 19-table target after the reviewed schema, including five empty
  billing tables. The [composed PostgreSQL/Blob record](../evidence/composed-pg-blob-backup-coverage-20260916.json)
  separately verifies 11 referenced objects totaling 37,741 bytes by key,
  digest, and size. These are bounded local/provider comparisons, not a full
  coordinated application restore.
- Native Mac arm64, emulated Linux amd64, and local Nitro CLI records prove the
  stated v0.4.0 archive/lifecycle slices. The [hosted receipt rehearsal](../evidence/hosted-storage-receipt-rehearsal-20260916.json)
  proves one bounded 177-byte private Blob receipt/readback/cleanup; its
  retention negatives are local-only. The local billing demo, token
  create/use/revoke, and signed local OIDC/SAML checks remain test-mode or
  fixture evidence.

**Hosted-pending engineering work:**

- Bind Better Auth callbacks, the outer tenant router, required scan,
  worker/Eve audiences, source/cache controls, and billing routes in one
  selected deployment. Run the existing authenticated two-company browser/CLI
  flow, including role/switch/revocation, stale/revoked/foreign-company
  negatives, and the same-deployment publish → scan → approval → install path.
  The local matrix and browser proof are starting fixtures, not hosted closure.
- Prove the applied billing schema through the hosted billing routes: catalog,
  usage, entitlement, webhook/reconciliation and authorized-role readbacks.
  Empty tables do not establish billing activation; Stripe, customer payment
  state, and live webhook proof remain external gates.
- Turn the completed local recovery implementation into a coordinated hosted
  PostgreSQL/Blob proof: fence the mutation window, verify application key
  mapping, tenant scope, provider finality, negative retention, rollback or
  forward-fix, and redacted provider/secret readback. Do not reimplement the
  completed local fixes or treat separate 14/19-table and 11-object records as
  a full application restore.
- Resolve the Hobby/Fluid plan or adaptation choice, then record worker
  capacity, monitoring, callback/device caps, and provider bindings. The
  candidate's 615-second function budget exceeds Hobby's 300-second maximum,
  while its 5- and 15-minute cron schedules separately exceed Hobby's daily
  minimum.
- Complete and release the source-only `a74dc3e` marketing copy follow-up,
  then recheck its nine routes, claims, and pricing projection. PR #60 already
  records the deployed contrast and corrected access copy; keep preview and
  no-purchase language until the offer and Stripe gates are approved. Native
  Linux is emulated and Windows remains unverified.

**External decisions:** the [Vercel entitlement readback](../evidence/vercel-entitlement-readonly-20260915T225659Z.json)
does not choose Pro or authorize a plan change. The user still owns the brand
and domain choice, real OAuth/customer provider credentials, legal entity and
support inputs, final offer, and hosted account approvals. Stripe remains the
last activation step; the local billing adapter is not a live payment account.
Dated market research is complete and informs these choices; it is not a
pending external approval.

**Future scope:** preserve the later MCP, editor, OpenClaw, SCIM, residency,
custom-domain, broad marketplace/source, organization-erasure, and
dedicated-scanner roadmap items. They are not first-launch closure evidence.

The decision remains **Hold** until the hosted engineering gates and required
external inputs are complete. The native-CI waiver records an admission
exception; it does not pass native Linux or Windows. No local, schema-only, or
unconfigured-provider record should be promoted to a hosted or paid claim.
