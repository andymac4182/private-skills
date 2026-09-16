# Launch status

Last reconciled: 16 September 2026, Brisbane. Target: 18 September;
contingency through 20 September. Overall: **Hold** — implementation is in
progress and no paid or hosted launch is claimed.

## Current production and candidate

Production `main` is `ee7d3c` (PR #60). The [production marketing/claims release record](../../evidence/production-release-marketing-claims-ee7d3c35-20260916.json)
records all four Git-triggered Vercel deployments READY at that exact merge,
nine marketing routes, app health/config/robots/sitemap readbacks, corrected
access copy, identity disabled with `providers: []`, and the user-authorized
native-CI waiver. It does not prove an authenticated hosted tenant journey,
provider callbacks, or paid activation. Native CI remains waived/blocked, not
passed. The prior [PR #59 reader release record](../../evidence/production-release-reader-ui-884992f-20260916.json)
is retained as historical production evidence.

The latest frozen candidate qualification is the [final local qualification
record](../../evidence/final-candidate-local-qualification-20260916.json)
from runtime source `8cdbb30`, recorded in evidence commit `1f8a814`. It reports
180 test files passed / 19 skipped, 1,292 tests passed / 45 skipped, passing
typecheck and Node, Vercel Build Output, and Cloudflare builds, 12 direct
disposable loopback PostgreSQL files / 33 tests, and 1 composed Nitro file / 2
tests. These checks are local or disposable and do not replace hosted
acceptance. The earlier `87a2f0c` record remains a dated 178-file / 1,281-test
snapshot rather than the current qualification.

The [local serving-path restore record](../../evidence/local-serving-path-restore-skillsguard-20260916.json)
from `d4fa33d` adds script and evidence only after the frozen qualification; it
does not change runtime behavior. It proves the bounded default-organization
restore through a local Node/PostgreSQL/Files SDK filesystem process and the
pinned SkillsGuard rescan, while hosted coordinated recovery remains open.

The hosted billing schema is now applied with independent readback in the
[billing migration evidence](../../evidence/billing-hosted-migration-plan-20260916.json),
from the `ac87e314` / `95eaf2a` documentation chain. PostgreSQL reports five
billing tables, 51 columns, 13 checks, 9 indexes, and zero billing rows; the 12
identity relations remain present with zero rows and the registry remains at
revision `232`. The migration created schema only: billing, metering, Stripe,
webhook activation, and customer payment state are not enabled.

The [forward recovery record](../../evidence/full-postgres-forward-billing-recovery-20260916.json)
proves a local isolated forward recovery with 19 tables, including the five
empty billing tables, while preserving the 14-table source state, identity
rows, semantic rows, and registry revision. The [composed PostgreSQL/Blob
record](../../evidence/composed-pg-blob-backup-coverage-20260916.json) verifies
11 referenced objects totaling 37,741 bytes by key, digest, and size against a
fresh private Blob read. The two source records were separate: no coordinated
freeze, application-level key remap, upload/delete, or hosted application
restore was performed in those records. The later local serving-path rehearsal
proves only the bounded local default-organization serving path.

The [populated B05/L10 matrix](../../evidence/local-b05-l10-populated-tenant-matrix-b7efd48-20260916.json)
and [two-company browser proof](../../evidence/local-two-company-switch-acceptance-20260916.json)
are **local complete for their stated scopes**. They cover populated company
resource isolation, role/switch readback, catalog/pack/draft separation, source
lists/search/resolve, analytics, Eve audience denial, and Reader billing
`403`. Fixed handlers, deterministic adapters, local PostgreSQL/filesystem
state, and scanner-disabled fixtures remain explicit limits; hosted runtime,
provider, worker, scanner, and customer IdP behavior are still open.

The [marketing claims/pricing audit](../../evidence/marketing-claims-pricing-audit-20260916.md)
was produced from `a74dc3e`, the exact cherry-pick of `968363c7` included in
PR #60; its corrected access/preview copy is deployed. PR #59 delivered the
contrast change and PR #60 provides the corrected-copy/public-route readback.
The [Vercel entitlement record](../../evidence/vercel-entitlement-readonly-20260915T225659Z.json)
shows a Hobby/Fluid team: Hobby's 300-second function maximum and daily cron
minimum are separate constraints, both exceeded by the candidate's 615-second
function budget and 5-/15-minute schedules. Pro versus adaptation remains a
hosting decision.

Market research is complete in the dated [developer/AI market update](../developer-ai-market-update-20260916.md)
and related research records. It is not an unresolved external input. Brand and
domain selection remains a business decision, alongside real customer IdP
credentials, hosting plan, legal/support inputs, final offer, and Stripe-last
activation.

## Current status matrix

| ID | Work | Current owner | State and next proof |
| --- | --- | --- | --- |
| L01 | Production/public deployments | root / launch integration | **Complete public slice:** PR #60 at `ee7d3c`, all four Vercel deployments READY, nine marketing routes and app health/config/robots/sitemap read back. Identity remains disabled; authenticated hosted acceptance is open. |
| L02 | Marketing usability and claims | marketing_finish | **Production copy and contrast verified:** PR #60 deployed the `a74dc3e`/`968363c7` corrected access/preview wording, while PR #59 delivered contrast; the nine-route production readback passes. Remaining pricing/offer review belongs to the billing and commercial gates. |
| L03 | Company portal and switch | tenant_ui / tenant acceptance | **Local complete for bounded scope:** B05/L10 matrix and two-company browser evidence cover Alpha-owner/Beta-reader switch, catalog/packs/drafts, and Reader billing denial. Hosted two-company runtime remains open. |
| L04 | Identity and company SSO | tenant_auth_backend / oauth_demo_finish | **Local evidence complete; hosted pending:** Better Auth routes, local signed OIDC/SAML, invitation/member acceptance, and schema/readback exist, while production is disabled (`providers: []`). The [local invitation record](../../evidence/local-invitation-membership-acceptance-20260916.json) covers owner create, member acceptance, Reader role denial, revocation, and expiry in disposable fixtures. Configure a real customer provider and callback only after hosted recovery and owner approval. |
| L05 | Registry/source/search/analytics isolation | runtime_finish / tenant acceptance | **Local bounded evidence complete:** populated matrix covers resource, source, search, analytics, and Eve denials. Same-deployment publish → required scan → approval → CLI install and hosted negatives remain open. |
| L06 | Worker, scanner, and Eve boundary | runtime_finish / tenant_eve | **Local runtime implementation/regression complete for B23/B24/B29:** durable tenant-review start/reconciliation, Eve reservation restart/eviction recovery, and multi-company worker dispatch/lease/retry paths are covered by local tests and PostgreSQL restore rehearsal. Hosted worker/scanner/model bindings, capacity, provider finality, and cost traces remain open. |
| L07 | Billing schema and console | billing_finish | **Schema applied, activation open:** five hosted billing tables now exist empty with independent readback; local test-mode console passes. Metering/caller enforcement, hosted route readback, webhook/provider state, and Stripe activation remain open. |
| L08 | Backup, restore, and recovery | Hosting/Operations / runtime_finish | **Bounded local recovery and serving complete:** 19-table local forward restore plus 11-object Blob read verification pass, and the [local serving-path record](../../evidence/local-serving-path-restore-skillsguard-20260916.json) proves Files SDK materialization, pinned SkillsGuard rescan, and exact Node route/transfer readback for the default organization. Coordinated hosted PostgreSQL/Blob freeze, IAM/provider finality, identity/billing state, and rollback remain open. |
| L09 | CLI and edge portability | release / Hosting/Operations | **Mac complete; Linux emulated:** v0.4.0 native arm64 Mac lifecycle and emulated Linux amd64 lifecycle pass. Native Linux hardware/CI and Windows remain unverified. |
| L10 | Full launch acceptance | root | **Hold:** local implementation and evidence are substantial, but hosted identity/runtime, coordinated recovery, provider/worker proof, hosting choice, and commercial inputs are not all closed. |

## Concrete next actions

1. `runtime_finish`, `tenant_auth_backend`, and Hosting/Operations bind the
   Better Auth callback, outer tenant router, required scan, worker/Eve
   audiences, source/cache controls, and billing routes in one selected
   deployment. Record the existing two-company browser/CLI flow against that
   deployment, including role/switch/revocation, stale/revoked/foreign-company
   negatives, and publish → scan → approval → install.
2. `billing_finish` proves hosted catalog, entitlement, usage, webhook/
   reconciliation, and authorized-role route behavior from the now-applied
   five-table schema without treating empty tables as billing activation. Keep
   Stripe test/live setup behind the external account gate.
3. Hosting/Operations and `runtime_finish` turn the local recovery records into
   a coordinated proof: fence PostgreSQL and Blob state, verify application key
   mapping and tenant scope, exercise provider-finality/negative retention,
   and record rollback or forward-fix readback. The completed local recovery
   implementation is not reopened.
4. Hosting/Operations resolves the Hobby/Fluid plan choice or adapts the
   candidate's independent 615-second function and 5-/15-minute cron settings,
   then records capacity, monitoring, callback/device caps, and redacted
   provider/secret readback.

## External decisions still open

- Hosting plan: Hobby/Fluid adaptation versus Pro, including the independent
  function and cron limits above.
- Real customer identity-provider applications, callback origins, and approval;
  production remains `providers: []`.
- Brand/domain choice, legal entity, support contact, final commercial offer,
  and policy/contact decisions.
- Stripe account, products/prices, webhook, and live activation remain the last
  commercial step.

The dated market research is complete and informs these choices; it is not a
pending external approval. Preserve later MCP, editor, OpenClaw, SCIM,
residency, custom-domain, broad marketplace/source, organization-erasure, and
dedicated-scanner roadmap items.

## Historical evidence — dated snapshots

- The prior [PR #59 reader release record](../../evidence/production-release-reader-ui-884992f-20260916.json), [Hobby/Fluid entitlement readback](../../evidence/vercel-entitlement-readonly-20260915T225659Z.json), [edge boundary record](../../evidence/edge-portability-boundary-cleanup-9ba903c.json), and [local billing console demo](../../evidence/local-billing-console-demo-acceptance-20260916.json) remain available as dated predecessor evidence. They do not override the current PR #60, candidate, or hosted boundaries above.
- The [hosted identity migration review](../../evidence/hosted-identity-migration-review-20260916.json) and [schema-preparation record](../../evidence/hosted-identity-schema-preparation-20260916-attempt-2.json) preserve the pre- and post-preparation comparisons: identity remains disabled and the target tables are empty. They do not prove a customer IdP callback or hosted traffic acceptance.
- The [native Mac](../../evidence/local-macos-arm64-cli-qualification-20260916.json), [emulated Linux](../../evidence/local-linux-amd64-cli-qualification-20260916.json), [hosted CLI provision](../../evidence/hosted-cli-v0.4.0-private-provision-20260916.json), and [bounded Blob receipt](../../evidence/hosted-storage-receipt-rehearsal-20260916.json) records retain their exact v0.4.0 and storage-slice boundaries; native Linux hardware and Windows remain unverified.
- 15 September recovery (`da2606b`/`3950816`) and hosting (`b15ed1b`) records are local/provider planning evidence. Hosted migration, restore, capacity, and monitoring remain open.
- 15 September browser and invitation snapshots (`dc836e7`, `d529e42`, `205a28e`) remain fixture history. They do not prove customer identity, hosted onboarding, or the current B05/L10 matrix.
- The earlier 5403 token-session rejection is superseded by the dated 5405 create/use/revoke/readback proof above; it remains historical context, not a release blocker.
- The 15–16 September `1b849db` run recorded 1,079 passed, 20 skipped, and one DraftEditor fallback failure. Root's later `d93a1e6` candidate rerun passed 1,087 with 20 skipped and no failures.
- SSO bridge/picker and Files SDK filesystem restore records (`784f39a`, `4e4ce2d`, `d2fe825`, `7b6935f`, `3950816`) are local evidence. Customer-provider callback and hosted restore remain open; the e32161a production record later reports the four Git-triggered deployments READY.
