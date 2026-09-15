# Launch status

Last reconciled: 16 September 2026, Brisbane. Target: 18 September;
contingency through 20 September. Overall: implementation in progress, not
launched.

Production `main` is `c8709858659767850dfc35d39a925e83aace55bb`, merged from PR
#57. All four Git-triggered Vercel deployments are READY for that exact source;
the [production evidence](../../evidence/production-release-c870985-20260916.json)
records the deployment readbacks, frozen checks, and public route checks. The
production identity configuration is deliberately disabled, native CI was
blocked before runner execution and is recorded as waived, and no hosted
identity or customer billing activation is implied.

The local candidate merge is `2348002`, based on candidate source `a65c8a9`.
The [candidate record](../../evidence/local-final-candidate-a65c8a9-20260916.json)
reports 173 files passed / 17 skipped and 1,240 tests passed / 40 skipped,
plus the focused billing/database/storage/tenant checks. These are local
candidate results; they do not replace hosted acceptance or close the active
billing recovery gates.

The published v0.4.0 CLI now has direct native Apple Silicon evidence for
version/help and install → verify → remove in an isolated local fixture, and
emulated Linux amd64 evidence for version/help and the same controlled install
path. The [macOS record](../../evidence/local-macos-arm64-cli-qualification-20260916.json)
and [Linux record](../../evidence/local-linux-amd64-cli-qualification-20260916.json)
state their architecture and limits explicitly; native Linux hardware/CI and
Windows execution remain unverified.

The edge dependency cleanup in `1b043cb`/`9ba903c` removes executable
PostgreSQL, runtime-node, and Files SDK imports from the edge output. Its local
edge builds, focused tests, and workerd smoke are recorded in the
[boundary evidence](../../evidence/edge-portability-boundary-cleanup-9ba903c.json).
This is local portability evidence, not hosted edge acceptance.

The read-only hosted identity baseline in `7140029` confirms production Better
Auth is disabled, no providers are configured, and the target identity,
company-SSO, service-token, and operations-event tables are absent. The SQL
plan and digests were materialized for review in `ccfbdef` under the
[identity evidence](../../evidence/hosted-identity-migration-review-20260916.json)
and [SQL manifest](../../evidence/hosted-identity-migration-review-20260916.sql-manifest.json);
no DDL, DML, or traffic activation occurred.

Billing restore/over-cap handling and known-completed-write recovery remain
active release work. The local PostgreSQL operator/recovery proof passed 16
tests, but the metered reservation crash repro still leaves a reservation in
`releasing`, and provider finality review requires retaining ambiguous writes
until an authoritative terminal result. B21, B22, and B28 therefore remain
open alongside the hosted restore and Stripe/commercial inputs.

Market research, brand selection, legal entity/support details, real customer
IdP configuration, final offer, and Stripe account activation remain external
inputs. The dated [market update](../developer-ai-market-update-20260916.md)
and [brand follow-up](../brand-clearance-next-steps.md) remain owned by
`business_billing` and `oauth_demo_finish`; no brand or domain purchase is
selected.

## Current checkpoint — 16 September 2026

The current documentation checkpoint is `ccfbdef`, with production `main`
`c870985`, candidate merge `2348002`, and candidate source evidence `a65c8a9`.
The production record reports all four deployments READY for the merged main
SHA. The candidate record reports 1,240 passed / 40 skipped and its focused
PostgreSQL, billing, storage, and populated-tenant checks passed. The passed
checks are bounded local evidence and do not establish launch readiness.

The current next actions are:

1. `tenant_auth_backend` and Hosting/Operations review the hosted identity
   readback and SQL plan, capture a fresh fenced baseline, and defer any
   additive migration or activation until separately approved customer IdP
   inputs exist.
2. `billing_finish`, `business_billing`, and `runtime_finish` complete the
   restore/over-cap, durable reservation ownership, delayed-write finality, and
   billing/finalization barrier work, then rerun the targeted candidate checks.
3. `oauth_demo_finish` and `runtime_finish` complete the same-deployment hosted
   archive install and worker/scanner acceptance, including negative stale,
   revoked, and foreign-company cases. Native Linux hardware/CI and Windows
   remain separate platform gaps.
4. `root` keeps B14–B16, legal/support/entity, real IdP, final offer, and Stripe
   account decisions open while preserving the later MCP, editor, OpenClaw,
   SCIM, residency, and custom-domain roadmap items.

| ID | Work | Owner | State / next proof |
| --- | --- | --- | --- |
| L01 | Separate marketing deployment | foundation_release | Production main `c870985` has the marketing deployment READY; public route readback is recorded in [production evidence](../../evidence/production-release-c870985-20260916.json), while full interactive/mobile review remains open |
| L02 | Marketing usability, support and accurate claims | marketing_finish | Active; production pricing projection and compact mobile menu markup are deployed, while full responsive/accessibility review, support path, and claims review remain open |
| L03 | Company portal navigation | tenant_ui | Navigation, overview, and connected token console are integrated (`d529e42`, `491ddc7`, `d30fcc8`); fresh 5407 operations readback passed locally, while final invitee/admin browser proof remains open |
| L04 | Invitations and member administration | editor_test_stability | Integrated 574286e; 25 focused checks pass; inviter/invitee browser journey remains open |
| L05 | Company-managed SSO | editor_test_stability / oauth_demo_finish | Signed local OIDC/SAML and PostgreSQL checks pass; hosted readback `7140029` shows Better Auth disabled and the reviewed SQL plan is unapplied. Customer IdP configuration, callback, and hosted browser flow remain open |
| L06 | Existing registry adoption and tenant workers | runtime_finish | Local Nitro/PostgreSQL/Files SDK/worker transfer and edge dependency-boundary checks pass; hosted worker/scanner acceptance and the full same-deployment install path remain open |
| L07 | Company billing console and enforced usage | billing_finish | Candidate and local PostgreSQL billing checks pass, but costly caller enforcement, restore/over-cap handling, known-completed-write recovery, browser payment fixture, and Stripe activation remain open |
| L08 | Tenant-aware Eve callbacks | tenant_eve | Eve entrypoints integrated f486ee6, 26 tests pass; deterministic worker transfer/denial is separately recorded, while registry provider/client wiring, cost recovery, and end-to-end tenant Eve flows remain open |
| L09 | Login/logout browser journey | root / editor_test_stability | dc836e7 browser proof passed Acme sign-in, sign-out to login, and Globex sign-in with only Globex membership; local 5405 token create/use/revoke also passed, while real customer SSO remains open |
| L10 | Full isolation and launch acceptance | root | Open; candidate `a65c8a9` covers populated two-company local surfaces and post-merge focused checks, but hosted boundaries, provider behavior, billing recovery, and the full L10/B05 acceptance bundle remain open |

## Verified evidence

- [Production PR #57 evidence](../../evidence/production-release-c870985-20260916.json): main `c870985` has all four Vercel deployments READY at the exact merged SHA. The record includes frozen checks, 1,146 passed / 27 skipped in its full suite, public health/pricing readbacks, and the native-CI billing-admission waiver. Production identity remains deliberately disabled.
- [Local candidate evidence](../../evidence/local-final-candidate-a65c8a9-20260916.json): source `a65c8a9` passed 173 files / 17 skipped and 1,240 tests / 40 skipped; five focused files passed 43 tests and the populated two-company matrix passed separately. This is local evidence with explicit provider, runtime, and recovery limits.
- [Native macOS CLI evidence](../../evidence/local-macos-arm64-cli-qualification-20260916.json) records direct arm64 version/help and isolated install → verify → remove. [Linux evidence](../../evidence/local-linux-amd64-cli-qualification-20260916.json) records the equivalent v0.4.0 path in an emulated `linux/amd64` container on an arm64 Docker host. Native Linux hardware/CI and Windows remain unverified.
- [Edge boundary evidence](../../evidence/edge-portability-boundary-cleanup-9ba903c.json) records the `1b043cb` cleanup, local Node/Vercel/Cloudflare builds, two focused files / 11 tests, and both local workerd compatibility modes. It does not prove a hosted edge deployment.
- [Hosted identity readback](../../evidence/hosted-identity-migration-review-20260916.json) at `7140029` is read-only: Better Auth and providers are disabled and target tables are absent. The [SQL manifest](../../evidence/hosted-identity-migration-review-20260916.sql-manifest.json) and SQL artifacts materialized at `ccfbdef` are a review plan; no migration or activation was performed.
- [Local billing/operator recovery evidence](../../evidence/local-billing-operator-restore-root-20260916.json) passes 16 PostgreSQL tests with no skips. The [metered reservation repro](../../evidence/local-metered-reservation-repro-root-20260916.json), [storage finality review](../../evidence/storage-recovery-finality-review.md), and [provider finality research](../../evidence/storage-provider-finality-research.md) keep B21/B22/B28 open for restore/over-cap and known-completed-write recovery.

## External inputs still open

Brand selection; actual legal entity and support contact; real identity-provider application configuration; final commercial offer. Stripe account and live activation explicitly stay until the end. Continue independent implementation while these remain open.

- **Identity/hosting:** select and configure the customer IdP, callback origins, production env bindings, and authenticated hosted browser flow. The local signed OIDC/SAML and 5407 settings evidence does not close this gate; owners: `editor_test_stability` / `oauth_demo_finish` / `Hosting/Operations`.
- **Hosted install and worker boundary:** the production registry now proves authenticated metadata and exact-byte/digest archive delivery for all three v0.4.0 targets, while the same-deployment positive publish → required scan → approval → CLI archive install and negative stale/revoked/foreign-company checks remain open. The local deterministic Nitro/worker proof is bounded evidence; owners: `runtime_finish` / `oauth_demo_finish`.
- **Billing and commercial:** connect costly scan/storage/seat/Eve callers to durable reservations, complete test-mode lifecycle/reconciliation and plan projection, then record legal entity, support contact, offer, and Stripe account/readback. Owners: `billing_finish` / `business_billing` / Finance.
- **Recovery and operations:** prove explicit default adoption, rollback/forward-fix, hosted migration/restore, monitoring, auth/callback/membership signals, queue age, scan freshness, billing webhooks, and Eve crash/restart reconciliation. Owners: Hosting/Operations / `runtime_finish` / `tenant_auth_backend`.
- **Marketing:** finish separate deployment/cross-site and responsive/claim review, then record the brand/domain decision. Owners: `foundation_release` / `marketing_finish`.

## Historical evidence — dated snapshots

- 15 September recovery (`da2606b`/`3950816`) and hosting (`b15ed1b`) records are local/provider planning evidence. Hosted migration, restore, capacity, and monitoring remain open.
- 15 September browser and invitation snapshots (`dc836e7`, `d529e42`, `205a28e`) remain fixture history. They do not prove customer identity, hosted onboarding, or the current B05/L10 matrix.
- The earlier 5403 token-session rejection is superseded by the dated 5405 create/use/revoke/readback proof above; it remains historical context, not a release blocker.
- The 15–16 September `1b849db` run recorded 1,079 passed, 20 skipped, and one DraftEditor fallback failure. Root's later `d93a1e6` candidate rerun passed 1,087 with 20 skipped and no failures.
- SSO bridge/picker and Files SDK filesystem restore records (`784f39a`, `4e4ce2d`, `d2fe825`, `7b6935f`, `3950816`) are local evidence. Customer-provider callback and hosted restore remain open; the e32161a production record later reports the four Git-triggered deployments READY.
