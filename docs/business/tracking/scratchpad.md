# Scratchpad and handoff

Observations are not completion evidence. Turn concrete next actions into backlog IDs.

## Current observations

- At approximately 712px width the current app menu becomes a clipped horizontal row. The overview also spends most of the first screen on a hero, three large action panels and four metric cards. See B02/B03.
- Browser sign-out exposed Better Auth rejecting a POST without JSON content type. Fixed in dc836e7; tests cover serialized body/header, and B01 now has browser verification on port 5399.
- Local OIDC form submission was blocked by CSP redirect handling. Fixture now permits exact issuer/app origins; Acme browser callback succeeds.
- Parallel browser sessions on the same origin share cookies. Root owns the identity-demo browser while other agents use separate fixtures/origins.

## Next coordinator actions

1. Obtain completed invitation/logout handoff and refresh the fixture once, preserving live-process evidence.
2. Review navigation and company SSO patches with explicit ownership to avoid overlapping edits.
3. Verify separate marketing project deployment and keep its configuration independent.
4. Merge proven increments and update status with exact evidence.

## Capture template

Date / observation / affected requirement / proposed next check / owner / backlog ID. Never record secrets or treat an untested hypothesis as a finding.

## Integration dependency coordination

15 September: after SSO dependency edits, a targeted pnpm test command attempted automatic install and failed with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. No adoption/worker test result was produced by that command. SSO agent owns completion of one noninteractive frozen install; coordinator pauses concurrent package commands until it reports completion. Then rerun the two targeted suites.

Resolved dependency check: coordinator ran CI=true pnpm install --frozen-lockfile successfully, then the adoption and worker identity suites passed (7 tests). Runtime integration is still awaiting owner handoff; these focused tests alone do not prove real database adoption or end-to-end worker isolation.

Navigation handoff integrated d529e42. Whole integration typecheck passes at this observation, including in-flight SSO/runtime files, but this is not immutable release evidence. Invitation/navigation browser fixture must use a free port (5400 already occupied by marketing) and a committed snapshot. Overview density is assigned to tenant_ui as a separate bounded change.

Overview implementation integrated 491ddc7: compact company header, useful primary actions and real metrics replace decorative hero/CTA panels. Eleven related tests pass. Browser desktop/mobile visual verification remains required.

## Market positioning research — 15 September 2026

Browser verification follow-up: clean source 6f878b5 fixture at port 5402 started, but root browser and `/auth/identity/config` both show enabled=false and providers=[] despite the supplied two-provider fixture URL. foundation_release owns investigating the existing live launcher 91360 and correcting the setup. Do not count fixture startup or build success as identity-enabled browser proof. Production remains 668f53e.

User reiterated market research and domain checks as launch work (B14–B16). Current primary-source observations: [Tessl registry](https://tessl.io/registry) positions around agent skills and evaluation; [JFrog MCP Registry](https://jfrog.com/ai-catalog/mcp-registry/) explicitly includes agent skills in its broader AI Catalog; [Cloudsmith artifact management](https://cloudsmith.com/platform-features/artifact-management) includes AI artifacts. Governance or scanning alone is not an evidenced unique differentiator.

Working hypothesis to test: an approachable company skills platform for engineering teams, combining transparent upstream ingestion, private authoring and distribution, and portable hosting. This is a positioning hypothesis, not a validated buyer preference or a claim that competitors lack these features. Marketing agent owns the source-backed comparison and naming/domain shortlist. Include buyer versus daily user, switching friction, purchase triggers, pricing hypotheses, and low-cost validation tasks. No outreach or purchases are authorized by this research task.

## 16 September — integration review follow-ups

- SSO admin runtime f2aa0e2 is tested only in isolated root verification checkout c4b147e: real PostgreSQL test 1 passed, typecheck passed, related SSO/Eve tests 20 passed. Two runtime mount tests fail because their infrastructure mock omits the required billing service. Keep out of release until corrected and rerun.
- Review company-login wrapper against trusted canonical origin: do not propagate untrusted forwarded host/protocol into Better Auth. Confirm UI consumes the company-specific provider selection endpoint and disabled/foreign providers are rejected. Assigned to editor_test_stability.
- Billing admission patch is in private-skills-business-billing-enforcement. Review queue/worker shared reservation key, retries after failure reconciliation, no provider/blob calls on quota rejection, and concurrent seat admission before accepting.
- Token browser sessions must retain live token expiry/revocation and membership/scope checks, including non-default companies; a signed static copy of grants is insufficient. Assigned to tenant_ui.

## 16 September local browser acceptance follow-up

- Candidate 5404 (`acca451`): actual Acme fixture login and explicit company selection pass. Company administration correctly separates accepted Ben invitation into history and pending invitation into pending list. SSO settings fails with "Company SSO operation failed"; editor_test_stability is investigating actual runtime/PG failure. This is an open acceptance failure, not a completed SSO setup journey.
- Candidate 5405 (`89ef195`): actual UI-issued Reader token with seven-day expiry, hide-secret, identity sign-out, token sign-in and company overview read pass. Existing-session revocation remains pending; native CLI proof assigned separately. Token session currently shows internal user/company identifiers instead of display names; queued for correction. No secret recorded.
- Foundation reports isolated frozen install, 1,098 passing tests with 20 skipped, typecheck and production build for 5405. These do not replace the pending browser/CLI or hosted provider gates.

### 5405 browser revocation completed

On candidate `89ef195`, the owner API revoked the exact UI-issued local Reader proof token (HTTP 200, revoked true). Reloading its existing browser session redirected to login; submitting that revoked token again returned "Session token is invalid" and cleared the input, as expected. The temporary browser variable was discarded. This closed the local browser create/hide/sign-out/token-sign-in/read/revoke/existing-session/new-session check; native CLI and hosted acceptance remained separate at that observation. No production state changed.

Review follow-ups: billing count reconciliation needs a stale-read/after-hook barrier test in addition to concurrent reservation tests; Eve dispatcher needs current lease timestamps and bounded invocation continuation under slow providers. Owners are implementing and verifying these before integration.

### Second-provider browser onboarding

Root verified Globex fixture login on 5405 (`89ef195`) as Carol, then created `Globex Browser Demo` / `globex-browser-demo` through the actual onboarding UI. The company selector contained only that company; Carol appeared as owner. Reload persisted the company and loaded its empty registry with three configured checks and unreviewed releases blocked. This supplements Acme login; it is local fixture evidence, not real GitHub/Google proof or populated cross-company artifact isolation.

Foundation traced the 5404 SSO error to missing `private_skills_company_sso_providers` (42P01), explicitly applied the repository schema only to disposable local DB, and obtained authenticated HTTP 200 with an empty provider list. The old browser tab had closed, so no post-migration browser success is claimed yet. Launcher regression fix and fresh-instance proof remain assigned.

### SSO browser recheck after explicit local schema application

Root opened a new 5404 browser tab, completed Acme login and explicit company selection, then opened SSO settings. Provider list loaded empty, provider ID input was enabled, and alert count was zero. This verifies the repaired disposable DB at `acca451`; fresh-launch migration regression coverage is still pending.

Release increment `3809277` is in PR #52. Marketing preview ready; app/builder previews pending at this checkpoint. Native CI failures must be checked for billing/runner unavailability before applying the user waiver; no source-regression waiver is implied.

### Fresh candidate browser and migration review — 16 September

Root inspected actual browser tab 18 at local 5407 on candidate e18ad47: Acme Candidate Demo / Alice Acme owner remained selected. Company operations rendered an empty queue, no releases, three enabled scanners, and explicit unavailable Eve/history and disabled billing states without a page error. Fresh-company SSO settings also loaded without the manual schema repair needed by the previous fixture. These are local fixture checks, not production Better Auth activation.

Explicit token migration candidate 5ca2365 is held because inheriting the Better Auth custom schema changes existing token lookup from its prior public location. B27 tracks preserving existing access. B26 tracks a separate launch gap: authenticated customers need CLI acquisition without private source-repository access. Marketing research owner was reactivated for primary-source positioning and registrar-level domain availability/price checks; B14–B16 remain open.

### Billing retention review and browser host pause

Reviewed billing635d112. Seat subject/revision reconciliation is implemented, but root identified two remaining acceptance questions: active holds with no committed identity row require safe failed-write recovery, and newest-N usage-operation loading cannot be the authority for old-key idempotency. B28 records the exact durable-lookup/replay proof needed. Billing and Eve owners are coordinating; no billing candidate is integrated on this evidence alone.

The token-display browser owner reports CUA host locked with automatic unlock paused. User unlock requested asynchronously. This pauses the browser-dependent proof only; no fixture session or production configuration was changed.

Root independently passed the composed Nitro/PostgreSQL/Files SDK worker acceptance at verification d11f6cb (1 test, 11.41 seconds). Integrated c17d113/0cf5440; sanitized evidence is `docs/evidence/local-composed-nitro-root-20260916.json`. Native CLI follow-through remains assigned to tenant_ui against the separately retained approved fixture.

### Integrated token migration compatibility and local boundary checks

Integrated e978ae3/aeb85a8: the explicit migration entrypoint covers Better Auth, company SSO and API tokens; token schema remains unchanged by default and a separate API-token schema is opt-in. Root verification cddf73a passed 17 focused tests across three files, including four actual PostgreSQL SSO/infrastructure cases, and TypeScript passed. A follow-up regression will strengthen existing-token survival evidence across rerunning the composed migration; B27 remains open until that case is recorded. No production DDL or identity activation occurred.

At d11f6cb, root also reran populated PostgreSQL tenant acceptance, source tenant isolation, and live identity-route PostgreSQL integration: three files / three tests passed in 2.25 seconds. The populated matrix uses bootstrap identities/core composition, source catalog responses are fixtures, and hosted acceptance remains separate.

Release owner is authorized to publish prepared37ddf6f while explicitly retaining the Reader friendly-label browser check as pending due the locked host. That local display check does not block the independently verified operations/copy increment while production identity remains disabled. Billing and newer migration candidates are excluded from that release.

### Full regression and native CLI checkpoint

Root full suite at verification cddf73a after the explicit token migration fixes: 154 files passed / 15 skipped; 1,113 tests passed / 24 skipped; 26.45 seconds. TypeScript passed separately. Opt-in PostgreSQL scenarios were run separately as recorded above; skipped suites are not counted as accepted.

Native Mac CLI proof is integrated from 5d7a645 plus correction e6465ab. Against the retained local Nitro Company B fixture: approved install into an isolated directory, frozen-lockfile repeat with changed=false, tree verification and reconstructed canonical artifact digest all passed. Retained metadata covered B only; no cross-company native CLI assertion is claimed. Market research/domain recheck d252f03 is also integrated; no brand or domain purchase decision has been made.

### Existing token survival and worker recovery

Integrated dff442f (0669c9e) and independently passed four PostgreSQL tests at root cc50c62. The regression issues a public-table token before composed migration, reruns migration, creates fresh infrastructure, and authenticates the same unchanged token without a custom-schema token table. B27 is closed for local implementation/regression; production migration remains unperformed.

PR53 is merged at92d2f0b (GitHub mergedAt2026-09-15T15:21:07Z), verified by root. Integration merged origin/main successfully. Production deployment verification remains with foundation_release. Root found B29 by tracing hosted-worker.ts/runtime.ts: new companies get only best-effort two-job POST drains, while /internal/worker/run cron selects default tenant. Durable cross-company retry scheduling assigned to tenant_ui with Eve owner coordination.

### Reconciliation note — 16 September 2026

The later 5405 follow-up completed the local browser token create, sign-in/use,
owner revoke, existing-session denial, fresh-sign-in denial, and native CLI
metadata/revocation readback. This supersedes the earlier “pending browser/CLI”
wording above for the disposable fixture; hosted provider configuration and
customer archive acquisition remain open under L05/B26. Root's fresh 5407
browser check loaded company operations and SSO settings without a page error;
it remains local fixture evidence. A later post-migration candidate run
(`cddf73a` / `432bf5d`) passed 1,113 tests with 24 skipped and typecheck; native
Mac CLI installation and canonical artifact digest/repeat checks passed
against the separately retained a8ab65a fixture. Neither follow-up proves hosted identity or production PR #53 behavior.

### Review follow-through before next integration

B21 concurrent import review found a shared-reservation race: the first reserving request can release the shared scan charge after another request queues the job and a worker begins scanning. Caller owner is adding a durable ownership fence and barrier tests. Definite failure before blob put also needs explicit zero reconciliation.

B25 identity telemetry candidate03c73bb needs request-lifetime persistence rather than fire-and-forget writes, operational retention cleanup rather than migration-only cleanup, and actual loopback PostgreSQL proof. CLI acquisition needs an in-app sign-in/download flow instead of public links landing on JSON401 responses. Neither candidate is accepted yet.

Extended Nitro fixture21701b7 adds packs, draft revisions/files, search through local embedding fixture and synthetic confirmed-install receipts. Follow-up strengthens exact edited content and foreign edit denial before root runs combined scenarios. B30 tracks missing marketing metadata/sitemap discovered in root source review.

### Composed authoring and pack acceptance

Integrated47f10a8/82ccaea and independently ran both Nitro+PostgreSQL+Files SDK scenarios at root a50f0c9: two tests passed in20.99seconds. New proof verifies exact edited SKILL.md bytes, changed revision digest, persisted revision2, stale-revision denial, rejected foreign PUT with unchanged owner content, isolated same-name packs/search and synthetic client-confirmed pack receipts. Evidence: docs/evidence/local-composed-tenant-authoring-root-20260916.json. External scanner/Gateway, native pack install and hosted identity remain separate gates.

### Recovery/adoption regression checkpoint

Root verificationa50f0c9 passed the loopback PostgreSQL operations restore rehearsal and Better Auth bootstrap-adoption integration together: two files / two tests,3.01seconds. The current implementation preserves restored identity/SSO/token/billing/registry/filesystem object state and exercises protected owner adoption with replay/concurrency denials. This is local evidence, not a hosted restore.

B19 follow-through is assigned to tenant_eve: extend recovery inventory for the upcoming billing lifecycle fields, seat revision/holds, Eve dispatch fences, worker retry/lease state and identity operational events once their owners finalize contracts. Current recovery evidence does not cover those unintegrated additions.

### Market research continuation — 16 September

User reiterated research across marketing, developer tools and AI tools, plus detailed future naming/domain work. Existing B14–B16 and MR/N research tasks remain authoritative; no duplicate tracker was created. Root refreshed primary discovery: [JFrog Skills Registry documentation](https://docs.jfrog.com/ai-ml/docs/skills-registry) explicitly describes versioned organization bundles and a scan gate; [JFrog skills repositories](https://docs.jfrog.com/artifactory/docs/skills-repositories) describes ClawHub-compatible packages. This strengthens the need to test adoption simplicity and source-to-install clarity rather than claim scanning or private distribution is unique. Marketing owner has the research continuation alongside SEO. Existing domain observations are dated snapshots, not a fresh registration check or a purchase.

### CLI distribution integration — 16 September, 01:48 AEST

Integrated CLI candidate 572352a as 1b2671a. Root independently ran six focused files / 17 tests and TypeScript successfully in verification checkout 31bdf18. The older verification checkout needed the current integration getting-started document during cherry-pick; executable CLI changes applied unchanged. Routes require a bound company principal, permitted member role and token scopes, return no-store responses, and verify size/digest before sending bytes. This is local component evidence; real release assets remain unprovisioned in the default manifest. Foundation owns private Files SDK provisioning and authenticated exact-byte proof. No production deployment or customer download readiness is claimed.

### Identity operational events — 16 September, 01:50 AEST

Integrated 4d62970 and 5bb67bd as 915d378 / 70f8a7f, preserving the CLI provider in the runtime return type. Root verification snapshot 91eb8d4 passed TypeScript and 9 tests across three files, including two disposable PostgreSQL cases. The PG evidence covers live-member role attribution, global-versus-tenant isolation, awaited handler failure capture, and expired-row cleanup during normal recording. This establishes local operational capture/retention behavior; production migration and full hosted observability remain open. Marketing SEO 180b30f is held for compatibility: omitted new indexing settings must safely build noindex rather than break existing production/preview build commands.

### Combined CLI and identity regression checkpoint — 16 September, 01:52 AEST

Root verification checkout 91eb8d4 passed the full Vitest run: 161 files passed / 16 skipped, 1,138 tests passed / 27 skipped (28.65 seconds). This default run does not activate opt-in PostgreSQL cases; identity operational events were run separately against disposable PostgreSQL in the preceding checkpoint. TypeScript and the production web Vite/Nitro build also passed. Build emitted an ineffective dynamic-import warning for scanner utilities; no build failure occurred. Source snapshot is a local verification composition, not production acceptance or a claim that skipped native/provider checks passed.

### Marketing SEO integration and seat recovery review — 16 September, 01:54 AEST

Integrated SEO 180b30f + 2998519 as 7a9f648 + 5e76eda. Root verification caca65c passed seven metadata/config tests, marketing TypeScript and the marketing production build with only existing APP_ORIGIN set. Missing new SEO settings now safely produce noindex and omit canonical URLs; explicit public indexing requires HTTPS marketing origin. Old verification-branch homepage/docs conflicts were resolved with current integration content. Production public indexing configuration and rendered hosted proof remain open.

Root review held candidate c1fb2df seat recovery POST: company-admin supplied proof strings do not establish that an identity writer failed or terminated. Recovery must not free an in-flight hold or a committed identity row whose after-hook failed. Billing owner is implementing an authoritative operational boundary and concurrency proof; editor was told not to accept the current user-facing route.

### Rendered marketing default-indexing proof — 16 September

Root served the built caca65c marketing app on loopback port 5488 and fetched all nine public routes. Every route returned HTTP 200, rendered noindex metadata and omitted canonical URLs when new SEO configuration was absent. robots.txt returned disallow-all and sitemap.xml contained no locations. This verifies safe defaults in rendered Nitro responses, not just helper output. The temporary server was gracefully stopped. Explicit public-mode checks were reported by the marketing owner; production indexing configuration remains to be applied and verified during release.

### Worker scheduler component acceptance — 16 September, 01:56 AEST

Root independently tested c759d6e as verification commit f64c7ea: all 11 dispatcher tests passed with disposable PostgreSQL enabled (2.72 seconds). Runtime 57a26e6 depends on the pending Eve tenant-review module; the attempted verification cherry-pick was skipped rather than inventing missing interfaces. Scheduler/runtime integration remains held for that dependency and the combined billing review. Release preparation was delegated from integration 7ab3cfc for the independently finished CLI, identity telemetry and SEO increment; no merge/deployment is yet claimed.

### Exact release-candidate gate — 16 September

Release owner verified clean candidate 7ab3cfc522ced9f591381967d264ee74a0f0aaf4 with frozen install and 1,145 tests passed / 27 skipped. Reviewer and marketing TypeScript checks passed, but root TypeScript fails on newly integrated SEO global declarations and test descriptor types. This supersedes any implication that the combined SEO candidate had passed the root type gate: earlier root type checks preceded SEO, and the later check was marketing-only. Marketing owner is correcting the exact types; release remains held until the revised immutable candidate passes. Hosted CLI provisioning owner is checking targeted production storage access; filesystem proof alone does not close that gate.

### Explicit public marketing rendering proof — 16 September

Root rebuilt the verification app with the actual marketing HTTPS origin and explicit public indexing. Through loopback Nitro, all nine routes rendered exactly one correct marketing canonical URL and no noindex metadata. Sitemap contained exactly the nine public marketing URLs; robots referenced that sitemap. This complements the earlier safe-default noindex proof. It is local rendered evidence, not production configuration, and does not waive the separate root TypeScript error being fixed by the marketing owner. Temporary server was stopped gracefully.

### Billing/Eve integration handoff — 16 September, 02:02 AEST

Editor delivered 85b3d68 and 9e56c40 after 11 PostgreSQL/Eve tests and TypeScript passed on its composition. Root applied the prerequisite ledger/Eve commit chain through verification 54c2f6c, preserving CLI provider and identity operational-events fields in additive runtime conflicts. Final identity seat-hook cherry-pick9e56c40 has two conflicts against newer identity telemetry; editor now owns the verification checkout to resolve them and compose the already-tested scheduler/runtime and caller lifecycle fixes. Shared integration has not received this incomplete billing batch, and customer-facing unverified seat recovery remains excluded.

### SEO root type gate resolved — 16 September, 02:04 AEST

Reviewed and integrated type-only fix0fcc803 as36385d0. Root independently ran TypeScript and all seven SEO tests successfully on the integration checkout. The fix includes the marketing ambient declarations in the root compiler input and narrows test metadata fields before rendering; it does not exclude source or suppress type errors. Release owner was instructed to prepare the corrected immutable candidate PR and preview checks. Billing/recovery composition remains independent and unmerged.

### Commercial decision checkpoint — 16 September

Source review confirms contact page still uses the honest launch-preview fallback when PUBLIC_CONTACT_URL is absent. It is not a working support channel and remains a launch input alongside legal/entity details. Root presented concrete brand options (keep Private Skills, ReleaseLoom, Vouchpack) and a positioning approval question via asynchronous input; no selection is inferred while waiting. Proposed positioning: a private registry taking AI-agent skills from source to a checked, repeatable install, initially for platform/DevEx leads. Domain observations are snapshots, not secured assets. GitHub readback at this checkpoint showed no open PR; release owner is preparing the corrected candidate.
