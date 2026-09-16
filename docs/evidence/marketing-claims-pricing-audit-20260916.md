# Marketing claims and pricing audit

Observed 2026-09-16 against the deployed public aliases and the source
checkouts below. This is a claims and handoff audit; it does not select a
brand, provider, legal entity, support channel, or payment account.

## Source and public boundaries

- Current production main: `884992fdbba30a12dae29ddba7957746e8c1725d`.
- Candidate comparison: `95eaf2a2feeda2d7855d991eb8a452673da8a131`.
- Public marketing origin: `https://private-skills-marketing.vercel.app`.
- Public application origin: `https://private-skills-theta.vercel.app`.
- The candidate's release record for `884992f` is available from the candidate
  snapshot with `git show 95eaf2a:docs/evidence/production-release-reader-ui-884992f-20260916.json`.

The deployed marketing aliases returned HTTP 200 for all nine public routes:
`/`, `/product`, `/pricing`, `/docs`, `/docs/getting-started`, `/demo`,
`/faq`, `/contact`, and `/legal`. The public readback was performed with
headless `agent-browser`; no credentials, mutations, checkout, or contact
submission were used. The deployed URL remains the current main release and
does not include this source-only copy follow-up until it is independently
released.

## Claim decisions

| Boundary | Evidence | Decision |
| --- | --- | --- |
| Demo | `/demo` says “Example records only” and explains that source, release, digest, and pack identifiers must be replaced before CLI use. `/faq` says the demo uses clearly labelled example records and placeholder identifiers. | Keep the demo explicitly illustrative; it does not represent a connected live registry. |
| Hosted access | `GET https://private-skills-theta.vercel.app/auth/identity/config` returned `enabled:false`, `providers:[]`, and `organization.enabled:false` at `2026-09-16T00:02:36Z`. The public app sign-in says company sign-in is not configured and asks for a registry token from an owner or administrator. | The source follow-up makes the access-controlled preview and token path explicit in `apps/marketing/src/routes/faq.tsx`, `apps/marketing/src/routes/docs.getting-started.tsx`, `apps/marketing/src/routes/demo.tsx`, and `apps/marketing/src/routes/legal.tsx`. It does not claim an active invitation or email flow. |
| Source providers | Marketing copy says “with a connected source catalog” or “available source connections and options depend on your application workspace.” The hosted identity response exposes no provider choices; source credentials remain server-owned. | Keep provider availability conditional. No provider name or configured connection is advertised. |
| Billing and prices | `GET https://private-skills-theta.vercel.app/v1/billing` returned `401 UNAUTHENTICATED`. `DEFAULT_PUBLIC_PLAN_METADATA` and `createPlanCatalog().publicMetadata()` match with `priceConfigured:false` and `checkoutAvailable:false` for every public plan. | Keep `Pricing preview`, `Preview`, `No purchase yet`, and billing-console source-of-truth wording. The public page has no purchase or checkout CTA and publishes no firm amount. No Stripe account, live charge, or commercial offer is claimed. |
| Scans and safety | The public pages describe required checks as a policy gate: “Required scan failures deny release” and “A required failure keeps the release unavailable.” The repository contract requires incomplete or blocked required evidence to deny distribution. | These are release-policy statements, not a harmlessness, security, compliance, or agent-behaviour guarantee. No guarantee language is present. |
| Social proof and service levels | A source search of `apps/marketing/src` found no customer logos, customer counts, usage statistics, SLA/uptime, compliance, residency, or unlimited-capacity claims. | No fabricated proof or service-level promise is present. |

## Public plan projection

The pure marketing projection imports only
`packages/billing/src/public-plans.ts` and `packages/billing/src/types.ts`; it
does not import the app server, secrets, Stripe adapter, or customer state.
The source assertion and `tsx` readback matched the server catalog exactly:

| ID | Label | Members | Storage | Scans/month | Eve cents/month | Price | Checkout |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `free` | Free | 3 | 1 GiB | 50 | 50 | not configured | unavailable |
| `team` | Team | 10 | 10 GiB | 750 | 500 | not configured | unavailable |
| `business` | Business | 25 | 50 GiB | 4,000 | 2,500 | not configured | unavailable |

The projection test also accepts pretty-printed JSON with ordinary whitespace,
rejects server-only `priceId` fields, and rejects contradictory checkout flags.
Custom public metadata is a build-time input; the billing console and
`GET /v1/billing` remain authoritative for live entitlements and readiness.

## CTA and responsive readback

Marketing application CTAs resolve to
`https://private-skills-theta.vercel.app/login?returnTo=%2Fapp`. The CLI chooser
CTA resolves to the app's sign-in with the encoded `/app/cli` return path; a
direct read of `/app/cli?target=aarch64-apple-darwin` redirected to that login
surface. No binary or JSON 401 response is used as a public download link.

The local source follow-up was rendered with `agent-browser` at 1280px and
390px. The pricing comparison remained inside its own horizontal region:
viewport/document/body widths were `390/390/390`, the region was `356px` wide
with `570px` scroll content, and scrolling to `scrollLeft:214` reached the
Business column. The mobile navigation opened from the menu button, exposed
Product through Contact, and closed on Escape with document/body widths still
`390/390`.

Sanitized local source screenshots are outside Git at:

- `/private/tmp/private-skills-pricing-claims-final-desktop.png`
- `/private/tmp/private-skills-pricing-claims-final-mobile.png`

## Identity activation recheck

The current-preview wording is intentionally time-bound. Before a real hosted
identity activation is published, re-read `/auth/identity/config` and update
the following exact pages/copy locations together:

- `apps/marketing/src/routes/faq.tsx` — `What does first-time sign-in do?`;
- `apps/marketing/src/routes/docs.getting-started.tsx` — the `Before you begin`
  note, `APPLICATION WORKSPACE` card, and setup step `01`;
- `apps/marketing/src/routes/demo.tsx` — `CONNECT` token guidance; and
- `apps/marketing/src/routes/legal.tsx` — `APP ACCESS` card.

Replace “company sign-in is not configured” and the current hosted-preview
token wording only after the new provider path is publicly read back. Keep the
example-only demo boundary, avoid email-invitation language until delivery is
tested, and keep company SSO distinct from later SCIM/additional enterprise
integrations.

## Validation

- `pnpm --filter @private-skills/marketing test` — 1 file, 5 tests passed.
- `pnpm --filter @private-skills/marketing typecheck` — passed.
- `pnpm exec tsx -e "...createPlanCatalog().publicMetadata()..."` — exact match
  with `DEFAULT_PUBLIC_PLAN_METADATA`.
- `git diff --check` — passed on the final source and evidence change.
- Local Vite rendering and headless route/CTA checks passed as described above.

The source follow-up is not deployed by this audit. Hosting, provider
configuration, legal/support publication, brand/domain selection, and Stripe
activation remain open owner inputs.
