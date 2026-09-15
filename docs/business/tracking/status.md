# Launch status

Last reconciled: 15 September 2026, Brisbane. Target: 18 September; contingency through 20 September. Overall: implementation in progress, not launched.

Latest published increment: origin/main `668f53e6420419eda6aef0d0d73385da3af280cc`, independently confirmed by root with git ls-remote. Release agent reports Git-triggered app `dpl_BvgT5TSCPRUM5zXfzXkthniKzWyA` and marketing `dpl_ArrxaeUqYmABC8uWDWtCGRLKU1SX` READY for this SHA; frozen install, typecheck, 1,031 tests passed / 11 skipped, app/marketing/all Eve builds passed. Root independently observed anonymous marketing homepage and app `/health` HTTP 200. Identity remains opt-in and unconfigured in production; no authenticated hosted tenant acceptance is implied. Native CI remains explicitly waived.

Market research and eight-name RDAP shortlist integrated as `1a7edfe`. Registrar purchase-availability/price checks remain active; no brand selection or domain purchase made.

Company SSO settings UI integrated `cba7f63`; invitation clipboard/manual-selection fallback integrated `c7e4671`. Root verification: 16 SSO/client/command-palette/company tests plus 6 invitation acceptance tests passed, and typecheck passed. Runtime SSO mounting and actual browser verification of these latest screens remain open. These are local integration changes after the published foundation.

Public marketing browser check on published 668f53e: root clicked release-path Install tab and CLI Install tab and observed both corresponding panels; Pilot guide navigation rendered getting-started content. Hosted-user onboarding currently leads with repository/local-demo instructions; marketing_finish is separating hosted customer onboarding from operator setup and checking CLI command examples. This is interaction evidence, not full responsive/accessibility acceptance.

| ID | Work | Owner | State / next proof |
| --- | --- | --- | --- |
| L01 | Separate marketing deployment | foundation_release | Project private-skills-marketing deployed READY at 6c8b958; routes/links pass with bypass; anonymous homepage HTTP 200 and rendered content verified by root; full interactive/mobile review remains open |
| L02 | Marketing usability, support and accurate claims | marketing_finish | Active; review desktop/mobile, support path and calls to action |
| L03 | Company portal navigation | tenant_ui | Navigation integrated d529e42, four focused tests pass; browser proof pending; compact overview integrated 491ddc7 (11 related tests pass); visual proof pending |
| L04 | Invitations and member administration | editor_test_stability | Integrated 574286e; 25 focused checks pass; inviter/invitee browser journey remains open |
| L05 | Company-managed SSO | editor_test_stability / oauth_demo_finish | Bridge committed 01a3650, UI cba7f63. Root signed local OIDC/PostgreSQL rerun: 14 tests passed. editor_test_stability owns runtime/plugin/admin API and login discovery mounting; oauth_demo_finish owns signed SAML fixture and protocol modules. Authenticated full browser flow remains open; no customer IdP claim |
| L06 | Existing registry adoption and tenant workers | runtime_finish | Integrated e13600d; focused checks pass, live PostgreSQL adoption and hosted worker proof remain open |
| L07 | Company billing console and enforced usage | billing_finish | Backend 9089e10 and console/route factory 9c92c68 integrated; actual PostgreSQL concurrency/deduplication/order tests pass. Runtime/navigation/invoice wiring and browser payment fixture journey active; Stripe account deferred |
| L08 | Tenant-aware Eve callbacks | tenant_eve | Eve entrypoints integrated f486ee6, 26 tests pass; registry provider/client wiring and end-to-end tenant flows remain open |
| L09 | Login/logout browser journey | root / editor_test_stability | dc836e7 browser proof passed: Acme sign-in, sign-out to login, Globex sign-in with only Globex membership; real customer SSO remains open |
| L10 | Full isolation and launch acceptance | root | Open; test populated companies across every registry surface, not just empty catalogs |

## Verified evidence

- Remote main was verified at `6c8b958a088c6924c6c204aae530c41ce5d0c05c`. Release agent confirmed Git-triggered Vercel production deployment `dpl_9fXQEjtsWrM6epgXVVMeTFGh9DRM` READY and aliased to private-skills-theta.vercel.app.
- Integration `2211bdd`: typecheck and app build passed; 946 tests passed, 8 skipped. Subsequent main merge was whitespace-only; logout fix dc836e7 passed five API tests. Full browser logout proof remains open.
- Marketing a6d1cda: separate build passed; seven built public routes returned 200 with configured app login links.
- Local Acme provider browser login reached explicit company selection and company registry. Acme/Globex HTTP callbacks and PostgreSQL persistence verified; this is fixture evidence, not real customer SSO.

## External inputs still open

Brand selection; actual legal entity and support contact; real identity-provider application configuration; final commercial offer. Stripe account and live activation explicitly stay until the end. Continue independent implementation while these remain open.

- Billing backend `9089e10`: 20 focused tests and integration typecheck passed. PostgreSQL coverage currently includes a simulated SQL contract; real database concurrency and full console/Stripe proofs remain open.

- Browser proof on committed dc836e7 at local port 5399: Acme callback showed Alice/Acme Labs Demo; Sign out returned to provider login; Globex callback showed Globex Research Demo only. No real identity-provider accounts were used.

- Separate marketing project `prj_UCQvxPTnSjcTjwONPwLroAGvAb7m`, deployment `dpl_4nd7MgcZhUf2TygC2oq4ieuRR5xC`, canonical private-skills-marketing.vercel.app. Agent verified eight routes with Vercel bypass. Deployment protection still enabled at this observation, so public launch is not proven.

- Root independently verified anonymous marketing homepage HTTP 200 and app login link, and read the rendered public page in browser. Interactive tab click was not completed because that browser tab became unavailable; do not count it as a passed interaction.
- Navigation/invitation fixture from d529e42 reported ready at port 5400, launcher 74412. Root browser journey pending.

- Clean release candidate d529e42: release agent reports frozen install, typecheck, 1,001 tests passed (8 skipped), production build. Root browser confirmed corrected single-company prompt and opening grouped mobile navigation as a dialog. Full keyboard/resize and invitation acceptance proof still pending.

- Root browser on d529e42: drawer Escape dismissal/focus restoration and Company admin navigation passed. Invitation creation by displayed owner failed with permission denial; B12 is an open functional blocker and must be fixed before invitee acceptance can be verified.

- Market research and brand/domain shortlist requested explicitly; marketing_finish owns B14–B16. Brand remains unselected. Live availability must be rechecked at purchase time.

- Clean integration e13600d: typecheck passed; full suite 1,031 passed, 9 skipped (139 passing files, 7 skipped). Adoption/worker modules integrated, but live database adoption remains unproven.

- Root ran multi-tenant-postgres-acceptance.test.ts against disposable loopback PostgreSQL after integration b5d48b8: 1 broad scenario passed with populated tenant records. Covers fixed-handler core registry isolation; it does not prove Better Auth live membership or the outer tenant router. Those remain L10 work.

- Root browser on fixed 65c5637 fixture: owner successfully created a reader invitation and UI showed copyable link plus one pending invite. Owner denial B12 fixed in integrated668f53e; invitee browser acceptance remains pending.
