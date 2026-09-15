# Launch status

Last reconciled: 15 September 2026, Brisbane. Target: 18 September; contingency through 20 September. Overall: implementation in progress, not launched.

| ID | Work | Owner | State / next proof |
| --- | --- | --- | --- |
| L01 | Separate marketing deployment | foundation_release | Project private-skills-marketing deployed READY at 6c8b958; routes/links pass with bypass; anonymous homepage HTTP 200 and rendered content verified by root; full interactive/mobile review remains open |
| L02 | Marketing usability, support and accurate claims | marketing_finish | Active; review desktop/mobile, support path and calls to action |
| L03 | Company portal navigation | tenant_ui | Navigation integrated d529e42, four focused tests pass; browser proof pending; compact overview integrated 491ddc7 (11 related tests pass); visual proof pending |
| L04 | Invitations and member administration | editor_test_stability | Integrated 574286e; 25 focused checks pass; inviter/invitee browser journey remains open |
| L05 | Company-managed SSO | oauth_demo_finish | Configuration module integrated 825c6a3; 15 focused tests pass and agent PG proof passes; real plugin provider lookup/callback bridge and UI remain open |
| L06 | Existing registry adoption and tenant workers | runtime_finish | Integrated e13600d; focused checks pass, live PostgreSQL adoption and hosted worker proof remain open |
| L07 | Company billing console and enforced usage | billing_finish | Backend integrated 9089e10; console/API wiring and real PostgreSQL concurrency proof active; Stripe account deferred |
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
