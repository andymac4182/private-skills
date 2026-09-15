# Marketing usability and claims audit

Observed 2026-09-16 against `https://private-skills-marketing.vercel.app` with
headless `agent-browser`. The audit used the isolated marketing worktree based
on `eb23f54`; no credentials, secrets, or purchase flows were used.

## Route coverage

These public routes rendered successfully and exposed their expected page
titles and navigation:

`/`, `/product`, `/pricing`, `/docs`, `/docs/getting-started`, `/demo`, `/faq`,
`/contact`, and `/legal`.

The content review found the current boundaries visible to visitors: example
records are labelled, connected source catalogs are conditional, Eve proposes
and a person decides, the public site does not create accounts or collect
credentials, pricing is a preview with no purchase action, and Linux and
Windows native CLI validation is still marked pending. No public claim for
security certification, compliance, SLA, residency, unlimited capacity, or
firm pricing was found. The public routes make no SSO or SCIM claim.

The contact route accurately says that a walkthrough request page is coming
soon, and the legal route records that service terms, privacy notice, and an
application support contact are not published yet. Those launch inputs remain
open for their owners.

## Navigation and handoffs

The public app CTAs target
`https://private-skills-theta.vercel.app/login?returnTo=%2Fapp`. The CLI chooser
CTA resolves to the same app sign-in with its encoded CLI return path. Both
destinations rendered the expected sign-in surface without entering a
credential.

At `390x844`, the first keyboard stop is the skip link. Tabbing to the menu
button and pressing Enter opens the navigation; the Product link is then
reachable by Tab. The expanded menu keeps the document width at the viewport.

At `1440x1000` and `390x844`, the audited public pages keep
`document.documentElement.scrollWidth` and `document.body.scrollWidth` equal to
the viewport width. The pricing comparison intentionally scrolls inside its
table region on mobile. The cue “Swipe to compare all plans” is visible, the
Business column is reachable at the scroll end, and the source follow-up keeps
the comparison heading fixed while the table moves.

The pricing route returned zero axe violations. Axe reported one incomplete
gradient-background contrast check, which requires manual colour review and
was not treated as a confirmed violation.

## Source follow-up

The bounded source changes in this commit:

- replace residual visitor-facing “shape” wording with plan limits or packaged
  files;
- keep the comparison heading and mobile swipe cue outside the horizontal
  table scroller so the heading remains readable at the Business column;
- preserve the existing plan IDs, finite limits, preview wording, and no-
  purchase behaviour.

The follow-up is local source validation only. The deployed URL above was not
changed by this audit.

## Validation

- `pnpm --filter @private-skills/marketing test` — 1 file, 5 tests passed
- `pnpm --filter @private-skills/marketing typecheck` — passed
- `APP_ORIGIN=https://private-skills-theta.vercel.app MARKETING_ORIGIN=https://private-skills-marketing.vercel.app MARKETING_INDEXING=noindex pnpm --filter @private-skills/marketing build` — passed
- `git diff --check` — passed

The local source follow-up was also rendered at `390x844` and `1440x1000`;
the table region remains keyboard-focusable and ArrowRight advances its
horizontal scroll without moving the comparison heading.

Sanitized screenshots captured from the deployed URL are stored outside the
repository at:

- `/private/tmp/private-skills-marketing-audit-home-desktop.png`
- `/private/tmp/private-skills-marketing-audit-home-mobile.png`
- `/private/tmp/private-skills-marketing-audit-pricing-mobile.png`
- `/private/tmp/private-skills-marketing-audit-pricing-mobile-business.png`
- `/private/tmp/private-skills-marketing-audit-local-pricing-mobile.png`
- `/private/tmp/private-skills-marketing-audit-local-pricing-mobile-business.png`
- `/private/tmp/private-skills-marketing-audit-local-pricing-desktop.png`
