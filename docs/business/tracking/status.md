# Launch status

Billing runtime integrated `7860d16`: company-bound routes, raw webhook dispatch, durable PostgreSQL service and customer-validated invoice adapter. Root isolated rerun: 33 focused runtime/billing/UI tests passed. Navigation mount assigned tenant_ui; billing_finish now owns actual scan/storage/seat quota callers, coordinating Eve cost reservations with runtime_finish. This is not live Stripe activation or completed usage enforcement.

CLI token console integrated `d30fcc8`: create scoped expiring tokens, reveal once with copy fallback, list lifecycle metadata, revoke and clear secret on company switch. Root isolated focused rerun: 20 tests passed. The disposable 5405 PostgreSQL journey passed scoped create, sign-in/use, owner revoke, existing-session denial, fresh-sign-in denial, and native CLI metadata/revocation readback. Hosted provider configuration and authenticated CLI archive acquisition/install remain open; no raw token is recorded.

Root's newer dated candidate rerun after `acca451` passed 1,087 tests with 20 skipped and no failures at verification commit `d93a1e6`. The older `91023f6` result (1,052 passed, 17 skipped) is historical; isolate dependency installs per worktree and do not reuse the older run as current release evidence.

Latest SSO protocol snapshot `fea919d`: signed local OIDC and SAML callbacks plus SAML wrong-issuer/wrong-audience rejection checks pass against disposable PostgreSQL. Root independently ran 16 tests across protocol integration and module suites. The fresh 5407 browser check loaded company SSO settings without a page error; real customer provider callbacks and hosted identity remain open.

Corrected 5402 fixture uses PostgreSQL (initial test adapter intentionally disabled identity). The older browser result covers Acme login/company selection, compact overview rendering, and a copy-link invitation. On fresh 5407, root again reached the selected company operations and SSO settings surfaces with no page error. These are local fixture checks; invitee acceptance, clipboard/wrong-email/expiry cases, and hosted onboarding remain open.

Last reconciled: 16 September 2026, Brisbane. Target: 18 September; contingency through 20 September. Overall: implementation in progress, not launched.

Latest published increment: origin/main `92d2f0bfd06a1d5b4e58d5fd02b015ba597f2c83`, merged from PR #53 (`37ddf6f`). The Git-triggered app, builder, marketing, and upload-reviewer production deployments are all READY for this SHA; exact IDs and URLs are recorded in [production-release-92d2f0b.json](../../evidence/production-release-92d2f0b.json). Frozen install, typecheck, 1,110 tests passed / 21 skipped, web build, and marketing build passed against the candidate snapshots. App `/health` returned 200 and `/auth/identity/config` returned 200 with identity disabled, no providers, and organization/bootstrap disabled. Nine anonymous marketing routes returned 200; builder and upload-reviewer `/health` returned 302 and carry no 200 health claim. Native CI jobs were blocked before runner execution by the account billing admission message and are explicitly waived; the persisted Reader friendly-label browser check remains pending because the CUA host was locked. This is an incremental release record, not a full launch or hosted identity proof.

Market research and eight-name RDAP shortlist integrated as `1a7edfe`. Registrar purchase-availability/price checks remain active; no brand selection or domain purchase made.

Company SSO settings UI integrated `cba7f63`; invitation clipboard/manual-selection fallback integrated `c7e4671`. Root verification: 16 SSO/client/command-palette/company tests plus 6 invitation acceptance tests passed, and typecheck passed. The 5407 browser readback confirms the settings surface locally; configured provider callback and hosted browser verification remain open. These are local integration changes after the published foundation.

Public marketing browser check on published 668f53e: root clicked release-path Install tab and CLI Install tab and observed both corresponding panels; Pilot guide navigation rendered getting-started content. Hosted-user onboarding currently leads with repository/local-demo instructions; marketing_finish is separating hosted customer onboarding from operator setup and checking CLI command examples. This is interaction evidence, not full responsive/accessibility acceptance.

## Current checkpoint — 16 September 2026

The authoritative source snapshot for this reconciliation is `857b149`. Root's
local candidate rerun after `acca451` passed 1,087 tests, skipped 20, with no
failures at `d93a1e6`. The separate PR #52 / `e32161a` production record reports
1,098 passed, 20 skipped, typecheck/build success, four READY deployments, and
`/health` 200 with identity deliberately disabled. Neither result is a full
hosted launch acceptance.

A later post-migration candidate run at `cddf73a` from source integration
`432bf5d` passed 1,113 tests in 154 files with 24 skipped and typecheck passing.
Native Mac CLI installation and canonical artifact digest/repeat checks passed
in that later candidate as well. These are follow-on local release checks; B26
still requires hosted archive acquisition, and the PR #53 previews are not a
production verification.

Root's three-file local tenant rerun at `d11f6cb` passed
`multi-tenant-postgres-acceptance`, `source-tenant-isolation`, and
`tenant-identity-route.postgres.integration` (3 tests, 2.25 seconds). The
composed local Nitro/PostgreSQL/Files SDK/worker proof recorded by `335826c`
passed one deterministic worker transfer test in 11.41 seconds. These records
cover separate local boundaries and leave the populated B05/L10 matrix,
external scanner/provider behavior, and hosted worker proof open.

The local 5405 token create/login/use/revoke journey and native CLI
metadata/revocation readback passed. The fresh 5407 browser check loaded the
selected company operations and SSO settings surfaces without a page error.
These local checks supersede the earlier token-session observation for that
fixture; hosted identity/provider callbacks and authenticated archive
acquisition remain open.

| ID | Work | Owner | State / next proof |
| --- | --- | --- | --- |
| L01 | Separate marketing deployment | foundation_release | Project private-skills-marketing production deployment `dpl_8t49VrmeEaJxxgAYhT7op2SszWk9` is READY from `92d2f0b`; nine public routes returned 200 and root verified anonymous homepage content; full interactive/mobile review remains open |
| L02 | Marketing usability, support and accurate claims | marketing_finish | Active; review desktop/mobile, support path and calls to action |
| L03 | Company portal navigation | tenant_ui | Navigation, overview, and connected token console are integrated (`d529e42`, `491ddc7`, `d30fcc8`); fresh 5407 operations readback passed locally, while final invitee/admin browser proof remains open |
| L04 | Invitations and member administration | editor_test_stability | Integrated 574286e; 25 focused checks pass; inviter/invitee browser journey remains open |
| L05 | Company-managed SSO | editor_test_stability / oauth_demo_finish | Bridge committed 01a3650, UI cba7f63. Root's signed local OIDC/SAML and PostgreSQL checks pass (16 focused tests); fresh 5407 settings readback is clean. Authenticated customer-provider callback and hosted browser flow remain open; no customer IdP claim |
| L06 | Existing registry adoption and tenant workers | runtime_finish | Integrated e13600d; composed local Nitro/PostgreSQL/Files SDK/worker transfer proof passed in `335826c`, while live hosted worker/scanner proof remains open |
| L07 | Company billing console and enforced usage | billing_finish | Backend 9089e10 and console/route factory 9c92c68 integrated; actual PostgreSQL concurrency/deduplication/order tests pass. Runtime/navigation/invoice wiring and browser payment fixture journey active; Stripe account deferred |
| L08 | Tenant-aware Eve callbacks | tenant_eve | Eve entrypoints integrated f486ee6, 26 tests pass; deterministic worker transfer/denial is separately recorded, while registry provider/client wiring, cost recovery, and end-to-end tenant Eve flows remain open |
| L09 | Login/logout browser journey | root / editor_test_stability | dc836e7 browser proof passed Acme sign-in, sign-out to login, and Globex sign-in with only Globex membership; local 5405 token create/use/revoke also passed, while real customer SSO remains open |
| L10 | Full isolation and launch acceptance | root | Open; three local tenant tests and one composed Nitro transfer test pass, but B05 still requires populated files, drafts, packs, imports/scans, downloads, search, analytics, tokens and Eve callbacks through the integrated runtime |

## Verified evidence

- Release `92d2f0b`: PR #53 merged from `37ddf6f`; all four Git-triggered Vercel production deployments are READY at the exact source SHA. Frozen install, typecheck, 1,110 tests passed / 21 skipped, web build, and marketing build passed. The 5407 disposable PostgreSQL browser fixture passed fresh Acme company creation, SSO settings load, and operations rendering; persisted Reader friendly-label browser proof is pending because the tenant UI CUA host was locked. App `/health` returned 200 and identity config is explicitly disabled in production. Marketing's nine anonymous routes returned 200. Builder and upload-reviewer `/health` returned 302, so no 200 health claim is made for those services. Native GitHub CI was blocked before runner execution by the documented billing admission message and is recorded as waived, not passed. See [sanitized evidence](../../evidence/production-release-92d2f0b.json).
- Release `e32161a`: PR #52 merged from `3809277`; all four Git-triggered Vercel production deployments are READY at the exact source SHA. Frozen install, typecheck, 1,098 tests passed / 20 skipped, and build passed against the same executable snapshot. Disposable Acme/Globex PostgreSQL browser token create/use/revoke and native CLI metadata/revocation proof passed. App `/health` returned 200; identity config is explicitly disabled with no providers; nine anonymous marketing routes returned 200. Native GitHub CI was blocked before runner execution by the documented billing admission message and is recorded as waived, not passed. See [sanitized evidence](../../evidence/production-release-e32161a.json).
- Local 5405 evidence ([local-native-cli-api-token-20260915.json](../../evidence/local-native-cli-api-token-20260915.json), observed 15 September) records scoped token creation, sign-in/use, owner revoke, existing-session denial, fresh-sign-in denial, and native CLI metadata/revocation readback. It is disposable local evidence; hosted provider and archive acquisition remain open.
- Root's 16 September local verification passed the three-file tenant set at `d11f6cb` (3 tests, 2.25 seconds) and the composed Nitro transfer test recorded in `335826c` (1 test, 11.41 seconds). Synthetic identities, deterministic scanner/file adapters, and local storage are explicit limits.

## External inputs still open

Brand selection; actual legal entity and support contact; real identity-provider application configuration; final commercial offer. Stripe account and live activation explicitly stay until the end. Continue independent implementation while these remain open.

- **Identity/hosting:** select and configure the customer IdP, callback origins, production env bindings, and authenticated hosted browser flow. The local signed OIDC/SAML and 5407 settings evidence does not close this gate; owners: `editor_test_stability` / `oauth_demo_finish` / `Hosting/Operations`.
- **Hosted install and worker boundary:** record the same-deployment positive publish → required scan → approval → CLI archive install and negative stale/revoked/foreign-company checks. The local deterministic Nitro/worker proof is bounded evidence; owners: `runtime_finish` / `oauth_demo_finish`.
- **Billing and commercial:** connect costly scan/storage/seat/Eve callers to durable reservations, complete test-mode lifecycle/reconciliation and plan projection, then record legal entity, support contact, offer, and Stripe account/readback. Owners: `billing_finish` / `business_billing` / Finance.
- **Recovery and operations:** prove explicit default adoption, rollback/forward-fix, hosted migration/restore, monitoring, auth/callback/membership signals, queue age, scan freshness, billing webhooks, and Eve crash/restart reconciliation. Owners: Hosting/Operations / `runtime_finish` / `tenant_auth_backend`.
- **Marketing:** finish separate deployment/cross-site and responsive/claim review, then record the brand/domain decision. Owners: `foundation_release` / `marketing_finish`.

## Historical evidence — dated snapshots

- 15 September recovery (`da2606b`/`3950816`) and hosting (`b15ed1b`) records are local/provider planning evidence. Hosted migration, restore, capacity, and monitoring remain open.
- 15 September browser and invitation snapshots (`dc836e7`, `d529e42`, `205a28e`) remain fixture history. They do not prove customer identity, hosted onboarding, or the current B05/L10 matrix.
- The earlier 5403 token-session rejection is superseded by the dated 5405 create/use/revoke/readback proof above; it remains historical context, not a release blocker.
- The 15–16 September `1b849db` run recorded 1,079 passed, 20 skipped, and one DraftEditor fallback failure. Root's later `d93a1e6` candidate rerun passed 1,087 with 20 skipped and no failures.
- SSO bridge/picker and Files SDK filesystem restore records (`784f39a`, `4e4ce2d`, `d2fe825`, `7b6935f`, `3950816`) are local evidence. Customer-provider callback and hosted restore remain open; the e32161a production record later reports the four Git-triggered deployments READY.
