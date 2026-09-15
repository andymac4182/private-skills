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

- [ ] B18 — Company CLI token console: create scoped expiring tokens, reveal secret once with copy/manual fallback, list metadata and revoke, clear secret on company switch, enforce server role/company checks. Root found no token management entry in CompanyView/command navigation; tenant_ui owns current API contract audit and complete connected UI, not just a visual mockup.

- [ ] B19 — Restore rehearsal must include Better Auth organizations/memberships, token revocations, both company SSO configuration and mirrored provider rows, billing mappings/reservations/webhook state, and registry/blob consistency. Existing registry-only restore is insufficient. tenant_eve owns isolated local PostgreSQL rehearsal and post-restore tenant boundary checks; hosted proof remains separate.
- [ ] B20 — Signed SAML callback currently rejects issuer because the provider SP entityID is compared with the IdP entityID. oauth_demo_finish owns protocol trust-anchor correction and wrong-issuer/audience negative tests; editor_test_stability owns runtime mounting. Do not claim SAML works before the signed round trip passes.
