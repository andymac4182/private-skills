# Scratchpad and handoff

Observations are not completion evidence. Turn concrete next actions into backlog IDs.

## Current observations

- At approximately 712px width the current app menu becomes a clipped horizontal row. The overview also spends most of the first screen on a hero, three large action panels and four metric cards. See B02/B03.
- Browser sign-out exposed Better Auth rejecting a POST without JSON content type. Fixed in dc836e7; tests cover serialized body/header, and B01 now has browser verification on port 5399.
- Local OIDC form submission was blocked by CSP redirect handling. Fixture now permits exact issuer/app origins; Acme browser callback succeeds.
- Parallel browser sessions on the same origin share cookies. Root owns the identity-demo browser while other agents use separate fixtures/origins.

## Next coordinator actions

1. Keep the `c870985` production record, `2348002` candidate merge, and local
   platform evidence separated by source and environment.
2. Have `tenant_auth_backend` and Hosting/Operations review the hosted identity
   readback and unapplied SQL plan before any separately approved migration or
   customer IdP activation.
3. Have `billing_finish`, `business_billing`, and `runtime_finish` close the
   restore/over-cap, known-completed-write, and billing/finalization recovery
   cases before treating the candidate as a billing release.
4. Complete the hosted browser archive install and worker/scanner acceptance;
   keep native Linux hardware/CI and Windows separate from the passing macOS
   and emulated Linux CLI checks.

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

Reviewed billing `635d112`. Seat subject/revision reconciliation is implemented, but root identified two remaining acceptance questions: active holds with no committed identity row require safe failed-write recovery, and newest-N usage-operation loading cannot be the authority for old-key idempotency. B28 records the exact durable-lookup/replay proof needed. Billing and Eve owners are coordinating; no billing candidate is integrated on this evidence alone.

The token-display browser owner reports CUA host locked with automatic unlock paused. User unlock requested asynchronously. This pauses the browser-dependent proof only; no fixture session or production configuration was changed.

Root independently passed the composed Nitro/PostgreSQL/Files SDK worker acceptance at verification d11f6cb (1 test, 11.41 seconds). Integrated c17d113/0cf5440; sanitized evidence is `docs/evidence/local-composed-nitro-root-20260916.json`. Native CLI follow-through remains assigned to tenant_ui against the separately retained approved fixture.

### Integrated token migration compatibility and local boundary checks

Integrated e978ae3/aeb85a8: the explicit migration entrypoint covers Better Auth, company SSO and API tokens; token schema remains unchanged by default and a separate API-token schema is opt-in. Root verification cddf73a passed 17 focused tests across three files, including four actual PostgreSQL SSO/infrastructure cases, and TypeScript passed. A follow-up regression will strengthen existing-token survival evidence across rerunning the composed migration; B27 remains open until that case is recorded. No production DDL or identity activation occurred.

At d11f6cb, root also reran populated PostgreSQL tenant acceptance, source tenant isolation, and live identity-route PostgreSQL integration: three files / three tests passed in 2.25 seconds. The populated matrix uses bootstrap identities/core composition, source catalog responses are fixtures, and hosted acceptance remains separate.

Release owner is authorized to publish prepared `37ddf6f` while explicitly retaining the Reader friendly-label browser check as pending due the locked host. That local display check does not block the independently verified operations/copy increment while production identity remains disabled. Billing and newer migration candidates are excluded from that release.

### Full regression and native CLI checkpoint

Root full suite at verification cddf73a after the explicit token migration fixes: 154 files passed / 15 skipped; 1,113 tests passed / 24 skipped; 26.45 seconds. TypeScript passed separately. Opt-in PostgreSQL scenarios were run separately as recorded above; skipped suites are not counted as accepted.

Native Mac CLI proof is integrated from 5d7a645 plus correction e6465ab. Against the retained local Nitro Company B fixture: approved install into an isolated directory, frozen-lockfile repeat with changed=false, tree verification and reconstructed canonical artifact digest all passed. Retained metadata covered B only; no cross-company native CLI assertion is claimed. Market research/domain recheck d252f03 is also integrated; no brand or domain purchase decision has been made.

### Existing token survival and worker recovery

Integrated `dff442f` (`0669c9e`) and independently passed four PostgreSQL tests at root `cc50c62`. The regression issues a public-table token before composed migration, reruns migration, creates fresh infrastructure, and authenticates the same unchanged token without a custom-schema token table. B27 is closed for local implementation/regression; production migration remains unperformed.

PR53 is merged at `92d2f0b` (GitHub merged at 2026-09-15T15:21:07Z), verified by root. Integration merged `origin/main` successfully. Production deployment verification remains with foundation_release. Root found B29 by tracing `hosted-worker.ts` / `runtime.ts`: new companies get only best-effort two-job POST drains, while `/internal/worker/run` cron selects the default tenant. Durable cross-company retry scheduling is assigned to tenant_ui with Eve owner coordination.

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

B25 identity telemetry candidate `03c73bb` needs request-lifetime persistence rather than fire-and-forget writes, operational retention cleanup rather than migration-only cleanup, and actual loopback PostgreSQL proof. CLI acquisition needs an in-app sign-in/download flow instead of public links landing on JSON 401 responses. Neither candidate is accepted yet.

Extended Nitro fixture `21701b7` adds packs, draft revisions/files, search through a local embedding fixture and synthetic confirmed-install receipts. Follow-up strengthens exact edited content and foreign edit denial before root runs combined scenarios. B30 tracks missing marketing metadata/sitemap discovered in root source review.

### Composed authoring and pack acceptance

Integrated `47f10a8` / `82ccaea` and independently ran both Nitro, PostgreSQL, and Files SDK scenarios at root `a50f0c9`: two tests passed in 20.99 seconds. New proof verifies exact edited SKILL.md bytes, changed revision digest, persisted revision 2, stale-revision denial, rejected foreign PUT with unchanged owner content, isolated same-name packs/search and synthetic client-confirmed pack receipts. Evidence: `docs/evidence/local-composed-tenant-authoring-root-20260916.json`. External scanner/Gateway, native pack install and hosted identity remain separate gates.

### Recovery/adoption regression checkpoint

Root verification `a50f0c9` passed the loopback PostgreSQL operations restore rehearsal and Better Auth bootstrap-adoption integration together: two files / two tests, 3.01 seconds. The current implementation preserves restored identity/SSO/token/billing/registry/filesystem object state and exercises protected owner adoption with replay/concurrency denials. This is local evidence, not a hosted restore.

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

Editor delivered `85b3d68` and `9e56c40` after 11 PostgreSQL/Eve tests and TypeScript passed on its composition. Root applied the prerequisite ledger/Eve commit chain through verification `54c2f6c`, preserving CLI provider and identity operational-events fields in additive runtime conflicts. The final identity seat-hook cherry-pick `9e56c40` has two conflicts against newer identity telemetry; editor now owns the verification checkout to resolve them and compose the already-tested scheduler/runtime and caller lifecycle fixes. Shared integration has not received this incomplete billing batch, and customer-facing unverified seat recovery remains excluded.

### SEO root type gate resolved — 16 September, 02:04 AEST

Reviewed and integrated type-only fix `0fcc803` as `36385d0`. Root independently ran TypeScript and all seven SEO tests successfully on the integration checkout. The fix includes the marketing ambient declarations in the root compiler input and narrows test metadata fields before rendering; it does not exclude source or suppress type errors. Release owner was instructed to prepare the corrected immutable candidate PR and preview checks. Billing/recovery composition remains independent and unmerged.

### Commercial decision checkpoint — 16 September

Source review confirms contact page still uses the honest launch-preview fallback when PUBLIC_CONTACT_URL is absent. It is not a working support channel and remains a launch input alongside legal/entity details. Root presented concrete brand options (keep Private Skills, ReleaseLoom, Vouchpack) and a positioning approval question via asynchronous input; no selection is inferred while waiting. Proposed positioning: a private registry taking AI-agent skills from source to a checked, repeatable install, initially for platform/DevEx leads. Domain observations are snapshots, not secured assets. GitHub readback at this checkpoint showed no open PR; release owner is preparing the corrected candidate.

### Main merge and anonymous production readback — 16 September

Root independently confirmed PR54 merged to `main` at `11b5e1d7888d28e65e37143fc7d3da940c37a318` and merged `origin/main` into the integration branch. Subsequent anonymous requests returned marketing homepage 200, marketing robots.txt 200, and registry `/v1/cli/releases` 401. This proves public-route availability and anonymous inventory denial at observation time; exact deployment-SHA correlation and authenticated archive byte checks remain with the release owner. Do not treat these anonymous checks as full CLI or identity acceptance.

### Combined ledger/Eve/scheduler database verification — 16 September, 02:14 AEST

Root independently ran three PostgreSQL-enabled suites at coherent verification snapshot `8cff18f`: billing repository/lifecycle, Eve durable reservation recovery, and hosted worker dispatch. All 22 tests passed in 2.72 seconds. Editor separately reported 161 focused tests and TypeScript passing on this snapshot. It remains unreleased: caller StorageAttempt/atomic reservation ownership work is pending, operator seat recovery is being strengthened, and generated Vercel configuration lacks an explicit duration while the reviewer default is 600 seconds. A dedicated owner is aligning deployment and runtime budgets before release; component passes do not close those gaps.

### Expanded local restore root proof — 16 September, 02:15 AEST

Root applied recovery test `f3ab981` as `d4f8640` atop coherent `8cff18f` and ran the real disposable PostgreSQL rehearsal: one test passed in 3.08 seconds. The test exercises identity operations persistence, billing reserve/reconcile replay, Eve starting/uncertain ledger claims, job lease/retry denials, restored identity/token boundaries and Files SDK filesystem object bytes. It does not yet copy separate `private_skills_hosted_worker_dispatch` and `private_skills_hosted_worker_dispatch_retry` tables present in the current schema; the owner is extending that coverage. StorageAttempt fields in this interim test are compatibility-shaped JSON, not acceptance of the pending caller lifecycle implementation. Hosted object restore remains open.

### Combined runtime full regression — 16 September, 02:18 AEST

Root full Vitest run on verification `d4f8640` passed 168 files / 1,197 tests, with 17 files / 36 tests skipped, in 23.54 seconds. Opt-in PostgreSQL tests were separately activated in the 22-test ledger/Eve/worker checkpoint and expanded restore proof. The snapshot still excludes pending atomic caller ownership, operator recovery and deployment budget fixes; full regression passing does not remove those release holds. The release owner reported that production `11b5e1d` authenticated CLI catalog and all three exact archive downloads passed, with an anonymous download returning 401; the durable production record was being prepared.

### Function duration source refresh — 16 September

Root opened [Vercel’s 15 June 2026 duration announcement](https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes): Node/Python on Pro/Enterprise can opt into up to 1,800 seconds, while durations above 800 seconds are beta and require Fluid compute. Older search snippets still show 800 as the maximum. The budget owner was notified to use live primary docs and distinguish a conservative launch setting from the platform maximum. The product still needs explicit emitted duration plus bounded runtime work and response headroom; increased platform capability does not resolve missing deployment configuration by itself.

### 100-company dispatch root rehearsal — 16 September

Root independently executed `e0613617` against disposable loopback PostgreSQL: 100 companies, 200 jobs, 5 dispatch invocations, 201 worker calls, 200 claims/completions, 0 duplicate claims, and 1 forced failure recovered. The first traversal stayed at 32/32/32/4 and at most 2 worker calls per company. Dispatch took 5.153 seconds; total time was 6.129 seconds. These are local deterministic-worker measurements, not scanner or hosted-capacity measurements. Evidence: `docs/evidence/local-worker-dispatch-capacity-root-20260916.json`; script integration awaits the scheduler/runtime batch.

### PostgreSQL operator and recovery verification — 16 September

Root independently ran `packages/billing/test/postgres.integration.test.ts`, `packages/billing/test/routes.test.ts`, and `tests/operations-postgres-rehearsal.test.ts` at clean verification source `7f45b81` against disposable loopback Docker PostgreSQL. Three files and 16 tests passed in 4.01 seconds with no skips. The checks cover the composed operator route, fenced recovery, ordinary-credential denial, and restored dispatcher state. This is local evidence; it does not prove hosted database/blob restore, production identity or billing configuration, or the remaining launch gates. Evidence: `docs/evidence/local-billing-operator-restore-root-20260916.json`.

### Hosted Blob restore proof — 16 September

The bounded hosted Blob check recorded in `ac86076` copied 11 non-CLI registry-candidate objects (37,741 bytes) into a new private restore prefix. The source inventory remained 14 objects, with three CLI assets excluded; source hashes and before/after inventories showed no drift, and a fresh-client destination readback matched exact bytes. This is object-storage evidence only and does not prove a PostgreSQL snapshot/fence or whole-database restore, so B19 remains open. Evidence: `docs/evidence/hosted-blob-restore-proof-20260916.json`.

### Combined candidate verification — 16 September

Root's combined verification snapshot `4917215`, with caller changes from `40783cd`, passed 170 files with 17 skipped and 1,211 tests with 38 skipped in 27.64 seconds. Root and reviewer TypeScript checks passed. PostgreSQL opt-in suites were not enabled in this full run; the separate `7f45b81` verification above remains the PostgreSQL evidence. This does not make a release claim while independent caller review, runtime budget, and test-fixture fixes remain open.

### Brand domain recheck — 16 September

Root independently repeated the authoritative Google RDAP checks at 2026-09-15 16:42:35 UTC for `releaseloom.dev` and `vouchpack.dev`. Both returned HTTP 404 JSON with `errorCode: 404` and no domain object. This supports “unregistered at check” only; it does not establish purchasability, pricing, legal clearance, or a secured domain. The dated [brand-clearance and domain follow-up](../brand-clearance-next-steps.md) remains the source document, and B15 stays open.

### Metered reservation crash-window repro — 16 September

Root reproduced the B21/B28 release block at source `4917215` by exercising `releaseMeteredUsageIfUnowned` and `claimMeteredReservationOwner` with a simulated second repository transaction failure after billing correction. The reservation stayed `releasing` after both the crash and retry, recorded two corrections, and the queue returned `METERED_RESERVATION_BUSY`. A non-idempotent retry remains stuck. `runtime_finish` owns the durable fencing/recovery fix and crash-barrier test, with `billing_finish` reviewing independently; the combined billing/runtime release remains blocked, while independent mobile marketing can release separately. Do not use a blind TTL release as the recovery. See [sanitized repro evidence](../../evidence/local-metered-reservation-repro-root-20260916.json).

The `40783cd` billing review found three additional B21/B28 gaps beyond that executed root wedge. These are review-derived and remain unverified until targeted tests reproduce them: generic `resolveOrQueueImport` branches lack an owner fence (`runtime_finish`); worker pre-scan release plus a delayed duplicate can reopen a reservation while retaining its charge (`business_billing` is implementing); and pending/orphaned `StorageAttempt` state retains charge without a reconciler or stable object identity for an ambiguous put (`billing_finish` is implementing). These findings also block the combined runtime candidate; independent mobile marketing and documentation release can proceed.

### Current durable checkpoint — 16 September 2026

The current shared documentation snapshot is `ccfbdef`. Production `main`
`c870985` is PR #57's merged source, and all four Git-triggered Vercel
deployments are READY at that exact SHA. Its [sanitized production
record](../../evidence/production-release-c870985-20260916.json) is the source
for deployment, public readback, and native-CI-waiver claims. The waiver records
jobs blocked before runner execution; it is not a native test pass.

Candidate merge `2348002` incorporates candidate source `a65c8a9`. The [local
candidate record](../../evidence/local-final-candidate-a65c8a9-20260916.json)
reports 173 files passed / 17 skipped and 1,240 tests passed / 40 skipped,
with the focused billing, database, storage, and populated-tenant checks
passing separately. These results are local and bounded; they do not establish
hosted or commercial readiness.

The [native macOS CLI record](../../evidence/local-macos-arm64-cli-qualification-20260916.json)
passes direct Apple Silicon version/help and isolated install → verify →
remove. The [Linux record](../../evidence/local-linux-amd64-cli-qualification-20260916.json)
passes the equivalent path under `linux/amd64` emulation on an arm64 Docker
host. Native Linux hardware/CI and Windows remain open; no cross-platform claim
is inferred from these local checks.

The edge dependency cleanup `1b043cb` / `9ba903c` passes local Node, Vercel,
and Cloudflare builds, 11 focused tests, and both local workerd compatibility
modes. The [boundary record](../../evidence/edge-portability-boundary-cleanup-9ba903c.json)
shows removal of executable PostgreSQL, runtime-node, and Files SDK imports;
hosted edge acceptance remains separate.

Hosted identity remains deliberately inactive. Read-only production/database
evidence `7140029` finds Better Auth disabled, no configured providers, and
missing identity, company-SSO, service-token, and operations-event tables. The
SQL plan and digests materialized at `ccfbdef` are review artifacts only; no
DDL, DML, or traffic activation occurred. See the [identity readback](../../evidence/hosted-identity-migration-review-20260916.json)
and [SQL manifest](../../evidence/hosted-identity-migration-review-20260916.sql-manifest.json).

Billing restore/over-cap handling and known-completed-write recovery remain
active. The local PostgreSQL operator/recovery proof passed 16 tests, while the
metered crash repro leaves a reservation in `releasing`. The storage provider
review says an aborted or lost write response is not terminal proof for Vercel
Blob or generic S3-compatible paths, so a charge must remain until provider
finality or a durable reconciliation result exists. See the [metered repro](../../evidence/local-metered-reservation-repro-root-20260916.json),
[storage review](../../evidence/storage-recovery-finality-review.md), and
[provider research](../../evidence/storage-provider-finality-research.md).

Brand selection, legal/entity and support details, real customer IdP setup,
final commercial offer, and Stripe activation remain external inputs. B14–B16,
the later MCP/editor/OpenClaw/SCIM/residency/custom-domain roadmap, and the
hosted migration/restore gates remain open.
