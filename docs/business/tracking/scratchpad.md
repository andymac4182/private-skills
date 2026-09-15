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
