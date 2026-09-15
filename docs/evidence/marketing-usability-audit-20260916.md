# Marketing usability and claims audit

Observed 2026-09-16 against `https://private-skills-marketing.vercel.app` with
headless `agent-browser`. The deployed route, CTA, and claims observations are
the state of that URL before the local source follow-up in commit `3da1cf0`;
the URL was not changed by this audit. Local checks below include the source
follow-up based on `eb23f54`; no credentials, secrets, or purchase flows were
used.

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
was closed manually against the local source follow-up. The shell background's
linear-gradient stops are `#f8faff`, `#f1f5fb`, and `#fafcff`, with a blue
radial overlay only at the upper-right. Across the nine public routes, the
lowest sampled root-gradient text pair was `.marketing-section-heading p`
using `#5d6d86` over approximately `rgb(241,245,251)` at 4.80:1; the
`#5d6d86` value over the actual sampled point was 4.806:1. The previous
`.marketing-footer-bottom` foreground `#8d9ab0` measured 2.76:1 over its
lower-gradient background; it now uses `--marketing-muted` and measures
5.10:1 at the same point. The strongest radial overlay region contains no
root-gradient body text bounds. At the radial centre, the overlay composes to
approximately `#dfe9fc`, where `#5d6d86` would measure 4.30:1; sampled text
bounds reached at most 0.026 overlay alpha and retained the 4.80:1 minimum
above. The other local gradient text surfaces were also above 4.5:1 at their
darkest stops. No contrast violation remains in the manual review; axe cannot
resolve CSS gradient backgrounds and therefore keeps this one item as
incomplete.

## Source follow-up

The bounded source changes in this commit:

- replace residual visitor-facing “shape” wording with plan limits or packaged
  files;
- keep the comparison heading and mobile swipe cue outside the horizontal
  table scroller so the heading remains readable at the Business column;
- raise the footer metadata text to the existing muted text token so it remains
  readable over the lower page gradient;
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
- `/private/tmp/private-skills-marketing-audit-local-home-desktop-contrast.png`
- `/private/tmp/private-skills-marketing-audit-local-home-mobile-contrast.png`
