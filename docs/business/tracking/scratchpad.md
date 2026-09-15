# Scratchpad and handoff

Observations are not completion evidence. Turn concrete next actions into backlog IDs.

## Current observations

- At approximately 712px width the current app menu becomes a clipped horizontal row. The overview also spends most of the first screen on a hero, three large action panels and four metric cards. See B02/B03.
- Browser sign-out exposed Better Auth rejecting a POST without JSON content type. Fixed in dc836e7; tests cover serialized body/header, but B01 still needs browser verification.
- Local OIDC form submission was blocked by CSP redirect handling. Fixture now permits exact issuer/app origins; Acme browser callback succeeds.
- Parallel browser sessions on the same origin share cookies. Root owns the identity-demo browser while other agents use separate fixtures/origins.

## Next coordinator actions

1. Obtain completed invitation/logout handoff and refresh the fixture once, preserving live-process evidence.
2. Review navigation and company SSO patches with explicit ownership to avoid overlapping edits.
3. Verify separate marketing project deployment and keep its configuration independent.
4. Merge proven increments and update status with exact evidence.

## Capture template

Date / observation / affected requirement / proposed next check / owner / backlog ID. Never record secrets or treat an untested hypothesis as a finding.
