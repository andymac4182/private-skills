# Launch status

Last reconciled: 15 September 2026, Brisbane. Target: 18 September; contingency through 20 September. Overall: implementation in progress, not launched.

| ID | Work | Owner | State / next proof |
| --- | --- | --- | --- |
| L01 | Separate marketing deployment | foundation_release | Source merged; provision separate project and verify Git deployment, public routes and app links |
| L02 | Marketing usability, support and accurate claims | marketing_finish | Active; review desktop/mobile, support path and calls to action |
| L03 | Company portal navigation | tenant_ui | Active; replace 16 equal menu items with task groups and accessible mobile drawer |
| L04 | Invitations and member administration | editor_test_stability | Integrated 574286e; 25 focused checks pass; inviter/invitee browser journey remains open |
| L05 | Company-managed SSO | oauth_demo_finish | Active; pinned Better Auth SSO integration, company-bound configuration, OIDC/SAML proofs |
| L06 | Existing registry adoption and tenant workers | runtime_finish | Active; explicit owner proof, atomic adoption and signed worker routing |
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
