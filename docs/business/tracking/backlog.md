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

- [ ] B10 — L07: prove billing reservations and webhook deduplication on actual disposable PostgreSQL with competing transactions, not only the SQL test double.

## Later roadmap — preserve, reassess after launch essentials

- [ ] F01 — MCP as both a source for consuming skills and a distribution interface.
- [ ] F02 — CLI/MCP agent feedback: working behavior, failures, broken instructions and improvement suggestions, linked to immutable skill versions.
- [ ] F03 — Audit OpenClaw feed production/consumption against earlier requirements and current implementation before identifying remaining work; do not assume missing or complete.
- [ ] F04 — Audit diffs.com file viewing/editing and editor Eve assistance against earlier requirements; retain unfinished polish without duplicating completed features.
- [ ] F05 — SCIM provisioning, custom domains, residency/SLA commitments and dedicated scanner fleet when evidence warrants them. Company SSO itself is launch scope.

- [ ] B11 — L04: verify copied invitation in browser through invitee login, acceptance, membership persistence, wrong-email denial and expiration. Component tests pass at 574286e; browser proof pending.

- [ ] B12 — L04: actual browser owner invite denied on d529e42 (Alice Acme / Acme Labs Demo, reader invite for synthetic Ben). UI shows owner but Better Auth returns permission denial. Inspect role resource mapping and invitation creation contract; prove authorized owner success and reader denial against real runtime. No invitation was created by this test.

- [ ] B13 — L05: bridge company provider persistence into Better Auth actual SSO provider lookup with matching persisted record IDs; prove a full configured OIDC callback. Configuration tests alone do not prove login. Also complete signed SAML protocol proof before claiming SAML works.
