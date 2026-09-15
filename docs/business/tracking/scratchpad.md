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

On candidate `89ef195`, the owner API revoked the exact UI-issued local Reader proof token (HTTP 200, revoked true). Reloading its existing browser session redirected to login; submitting the same token again returned "Session token is invalid" and cleared the input. The temporary browser variable was discarded. This closes the local browser create/hide/sign-out/token-sign-in/read/revoke/existing-session/new-session check; native CLI, display-name correction, SSO settings failure and hosted acceptance remain separate. No production state changed.

Review follow-ups: billing count reconciliation needs a stale-read/after-hook barrier test in addition to concurrent reservation tests; Eve dispatcher needs current lease timestamps and bounded invocation continuation under slow providers. Owners are implementing and verifying these before integration.

### Second-provider browser onboarding

Root verified Globex fixture login on 5405 (`89ef195`) as Carol, then created `Globex Browser Demo` / `globex-browser-demo` through the actual onboarding UI. The company selector contained only that company; Carol appeared as owner. Reload persisted the company and loaded its empty registry with three configured checks and unreviewed releases blocked. This supplements Acme login; it is local fixture evidence, not real GitHub/Google proof or populated cross-company artifact isolation.

Foundation traced the 5404 SSO error to missing `private_skills_company_sso_providers` (42P01), explicitly applied the repository schema only to disposable local DB, and obtained authenticated HTTP 200 with an empty provider list. The old browser tab had closed, so no post-migration browser success is claimed yet. Launcher regression fix and fresh-instance proof remain assigned.

### SSO browser recheck after explicit local schema application

Root opened a new 5404 browser tab, completed Acme login and explicit company selection, then opened SSO settings. Provider list loaded empty, provider ID input was enabled, and alert count was zero. This verifies the repaired disposable DB at `acca451`; fresh-launch migration regression coverage is still pending.

Release increment `3809277` is in PR #52. Marketing preview ready; app/builder previews pending at this checkpoint. Native CI failures must be checked for billing/runner unavailability before applying the user waiver; no source-regression waiver is implied.
