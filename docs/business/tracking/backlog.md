# Work queue

Launch items L01–L10 and owners are in `status.md`. Add new concrete work here instead of relying on chat history.

## Required follow-ups

- [x] B01 — L09: restart the local fixture gracefully from dc836e7 or later, preserve the disposable database, verify sign-out returns to login and then complete Globex browser login. Completed on dc836e7 with local PostgreSQL fixture; simultaneous legacy-plus-identity session revocation remains separately covered by component tests, not this browser sequence.
- [ ] B02 — L03: make Overview distinct from Discover; group directory/topics/official/audits contextually and separate company administration from daily work. Keep existing deep links and command search working.
- [ ] B03 — L03: reduce overview hero/CTA height so useful releases and activity appear sooner; verify 712px and phone widths, keyboard focus, drawer dismissal and reduced motion.
- [x] B04 — L04: one-company chooser must not say the account belongs to multiple companies.
- [ ] B05 — L10: create two populated disposable company registries and verify denied cross-company files, drafts, packs, imports, scans, downloads, search, analytics, tokens and Eve callbacks.
- [ ] B06 — L07/L08: connect atomic usage reservations to costly scan/AI actions; test retries, concurrent quota exhaustion and reconciliation.
- [ ] B07 — L05: company SSO must not auto-enroll users solely from email domain. Prove admin-only configuration, company callback binding, safe recovery and real signed protocol flows.
- [ ] B08 — L01/L02: check separate marketing project has public configuration only, working app links, responsive pages and truthful unavailable billing/legal states.
- [ ] B09 — L10: reconcile all acceptance rows against actual evidence before claiming beta or paid readiness; keep skipped native CI and local fixtures explicitly limited.

- [x] B10 — L07: actual disposable PostgreSQL proof reported by billing_finish at 93d089b (integrated 9c92c68): three tests cover concurrent reservations, durable webhook deduplication and out-of-order events. Route mounting, invoice adapter and browser billing journey remain L07 work; this does not prove Stripe configuration.

## Later roadmap — preserve, reassess after launch essentials

- [ ] F01 — MCP as both a source for consuming skills and a distribution interface.
- [ ] F02 — CLI/MCP agent feedback: working behavior, failures, broken instructions and improvement suggestions, linked to immutable skill versions.
- [ ] F03 — Audit OpenClaw feed production/consumption against earlier requirements and current implementation before identifying remaining work; do not assume missing or complete.
- [ ] F04 — Audit diffs.com file viewing/editing and editor Eve assistance against earlier requirements; retain unfinished polish without duplicating completed features.
- [ ] F05 — SCIM provisioning, custom domains, residency/SLA commitments and dedicated scanner fleet when evidence warrants them. Company SSO itself is launch scope.

- [ ] B11 — L04: root browser proof on owner-role-fixed local 5401 fixture passed invitee Acme OIDC login, invitation display and acceptance, with correct company selected and reader role. Clipboard copy returned empty, so root used the previously observed invitation URL; copy UX needs review. Real PostgreSQL persistence covered by author flow; browser wrong-email denial and expiration remain open. No production IdP proof claimed.

- [x] B12 — L04: actual browser owner invite denied on d529e42 (Alice Acme / Acme Labs Demo, reader invite for synthetic Ben). UI shows owner but Better Auth returns permission denial. Inspect role resource mapping and invitation creation contract; prove authorized owner success and reader denial against real runtime. No invitation was created by this test.

- [ ] B13 — L05: bridge company provider persistence into Better Auth actual SSO provider lookup with matching persisted record IDs; prove a full configured OIDC callback. Configuration tests alone do not prove login. Also complete signed SAML protocol proof before claiming SAML works.

## Market and brand research — user requested

- [ ] B14 — Research current developer tools, AI agent tools and private package registries using primary sources; distinguish competitors from adjacent categories. Identify the engineering-team buyer, adoption triggers, alternatives, defensible differentiation and claims supported by actual product behavior. Owner: marketing_finish.
- [ ] B15 — Develop a detailed brand shortlist with name rationale, pronunciation, category fit, collision risks and domain options. Check live domain registration/registrar availability with timestamps and source links; explicitly separate unregistered, purchasable, premium, reserved, taken and unverified. DNS absence is not availability. Domain checks are not trademark clearance. No purchases or registrations without a separate user decision. Owner: marketing_finish.
- [ ] B16 — Use market findings to revise positioning, homepage messaging, launch offer and prioritized roadmap; obtain user brand selection before replacing the working name.

- [x] B17 — L03: account display fix integrated 2de3e2f; identity name/email preferred with legacy fallback. Reader overview role-order correction ff2d0ab also integrated. Root seven focused tests passed. New build browser proof remains part of B03.

- [x] B18 — Company CLI token console: create scoped expiring tokens, reveal secret once with copy/manual fallback, list metadata and revoke, clear secret on company switch, enforce server role/company checks. The connected console and server contract are integrated in `d30fcc8`; local product acceptance is complete. Hosted identity/provider and authenticated archive acquisition remain separate L05/B26 gates.

  Dated local follow-up on 5405 / candidate `89ef195`: scoped Reader token creation, sign-in/use, owner revoke, existing-session denial, fresh-sign-in denial, and native CLI metadata/revocation readback all passed. This supersedes the earlier 5403 / `205a28e` “Session token is invalid” observation for that fixture. No raw token is recorded here.

- [ ] B19 — Restore rehearsal must include Better Auth organizations/memberships, token revocations, both company SSO configuration and mirrored provider rows, billing mappings/reservations/webhook state, and registry/blob consistency. Existing registry-only restore is insufficient. tenant_eve owns isolated local PostgreSQL rehearsal and post-restore tenant boundary checks; hosted proof remains separate.
- [ ] B20 — Signed SAML callback currently rejects issuer because the provider SP entityID is compared with the IdP entityID. oauth_demo_finish owns protocol trust-anchor correction and wrong-issuer/audience negative tests; editor_test_stability owns runtime mounting. Do not claim SAML works before the signed round trip passes.

## Research follow-through

- Initial market desk research and dated naming/domain screens are integrated in `d02b1ae`; B14–B16 remain open for positioning application, brand selection and further validation.
- MR01–MR07 in [market research](../market-research.md) track buyer, onboarding, evidence comprehension, repeat use, ownership, packaging and deployment hypotheses. These are unvalidated research plans, not customer evidence.
- A1–A7 in that document track content/onboarding experiments with measurable acceptance criteria. No external outreach or publication is authorized by those experiment descriptions.
- Keep research identifiers separate from implementation B17–B20. Recheck shortlisted domains immediately before selection; retain Private Skills until a brand is chosen.

## Billing acceptance findings — 16 September

- [ ] B21 — Billing lifecycle correctness before release: preserve explicit-zero reconciliation; re-admit released operation keys on retry; keep successful or uncertain blob writes charged until durable reconciliation; deduplicate concurrent imports without extra quota or false limit errors; release scan reservations for failures before scanner invocation. Owners: billing_finish (ledger), business_billing (core/authoring/worker callers). Add failure/retry/concurrency tests, not just quota-rejection tests.
- [ ] B22 — Seat reconciliation must handle stale low and high snapshots, natural invitation expiry, removal of pre-existing members, and recovery from failed lifecycle hooks without lost capacity or quota bypass. Owner: billing_finish. Actual PostgreSQL barrier and lifecycle evidence required.
- [ ] B23 — Eve dispatch crash recovery must prevent duplicate external sessions under one reservation after a host crash between provider acceptance and durable completion. Owner: runtime_finish. Verify durable start/reconciliation behavior beyond caught timeout tests.

- [ ] B24 — Eve cost reconciliation must survive process restart and cache eviction. Current candidate stores reservation lookup metadata only in a process-local map; replace with durable lookup and prove restart/eviction reconciliation against PostgreSQL. Confirm budgeted Eve works in the intended no-Stripe evaluation configuration without bypassing limits. Owner: runtime_finish.
- [ ] B25 — Persist sanitized authentication/callback failure and membership-denial signals. Attribute company metrics only from server-trusted identity; unknown-tenant failures stay operator-only. Verify persistence and tenant/admin boundaries. Owner: tenant_auth_backend.

- [ ] B26 — Hosted customers must obtain verified platform CLI archives without private GitHub repository access. Add authenticated company release metadata/downloads backed by Files SDK storage, pinned sizes/digests, platform chooser and install documentation. Preserve native-test qualifications. Owner: oauth_demo_finish.
- [x] B27 — Explicit identity migration must preserve the location and validity of existing API tokens when a custom Better Auth schema is already configured. Require separate explicit token-schema configuration or a reviewed data-preserving migration; prove the existing custom-identity/public-token combination. Owner: editor_test_stability. Corrected by ad19364; existing-token survival across explicit migration and fresh infrastructure proven by 0669c9e, independently passed by root at cc50c62 (four PostgreSQL cases). Production migration remains separate.

- [ ] B28 — Billing operation retention must not invalidate idempotency or strand reconciliation: exact-key lookup must find durable reservations after the recent-history window evicts them, including unresolved Eve runs and reopened old operation keys. Verify small-window PostgreSQL replay/reconciliation tests. Also provide a safe recovery path for active seat holds whose identity write definitively failed. Owners: billing_finish and runtime_finish.

- [ ] B29 — Recover queued worker jobs for every company after initial request-drain failure or timeout. Current operator cron selects only the default company; implement fair bounded durable company dispatch with leases/cursors, server-selected scoped credentials and actual PostgreSQL retry/isolation tests. Owners: tenant_ui (worker scheduler), runtime_finish (coordinate Eve scheduler/runtime/cron seams).
