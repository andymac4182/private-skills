# Private Skills marketing site

This is the public marketing deployment for Private Skills. It is a separate
TanStack Start/Nitro app with product, pricing preview, documentation, FAQ,
and legal pages. The authenticated registry remains in `apps/web`.

The marketing app has no authentication, registry data, database, or billing
credentials. Set `APP_ORIGIN` to the public origin of the authenticated
app at build time. Production builds fail when it is missing or malformed, so
public calls to action cannot accidentally point back to the marketing site.
Development uses the explicit app default `http://localhost:5173` when the
variable is unset. Links use `/login?returnTo=%2Fapp` on that origin.

`MARKETING_ORIGIN` is optional until the site is ready for public indexing. If
it is omitted, every build is noindex and emits no canonical or
origin-derived social URLs; `robots.txt` disallows crawling and the sitemap
is empty. If it is supplied, it must be an origin without credentials, a path,
query, or fragment. Set `MARKETING_INDEXING=noindex` explicitly for local and
preview deployments when you want that intent to be visible in the build
configuration. To publish discovery metadata, set
`MARKETING_INDEXING=public` and provide an HTTPS `MARKETING_ORIGIN`; a public
build fails when either requirement is missing or malformed. Public mode lists
only the nine public marketing routes.

The optional `PUBLIC_CONTACT_URL` may point to a real public intake form or
scheduling page. It must be an HTTPS URL in Preview and Production. When it
is unset, `/contact` shows the setup guide and app sign-in paths and clearly
marks the public contact link as pending; it never invents an email address or
renders a nonfunctional email link. The marketing app does not accept or
store contact submissions. If first-party intake is needed later, add a
durable, rate-limited route in the authenticated app (for example,
`POST /v1/support/requests` with an operator-facing queue), then point
`PUBLIC_CONTACT_URL` at its real public entry point.

For local work from the repository root:

```sh
pnpm --filter @private-skills/marketing dev
APP_ORIGIN=https://app.example.com MARKETING_ORIGIN=https://marketing.example.com MARKETING_INDEXING=noindex pnpm --filter @private-skills/marketing build
```

For Vercel, create a dedicated project for this app with these settings:

- **Root Directory:** `apps/marketing`
- **Include source files outside of the Root Directory in the Build Step:**
  enabled. The workspace lockfile and `pnpm-workspace.yaml` are at the
  repository root and are needed by the package manager.
- **Framework Preset:** TanStack Start
- **Node.js:** 24.x
- **Environment variables:** set `APP_ORIGIN` to the public origin of the
  authenticated app in both Preview and Production, for example
  `https://app.example.com`. For a noindex Preview, the new marketing
  variables may be omitted or set explicitly to `MARKETING_INDEXING=noindex`.
  For a public Production deployment, set `MARKETING_ORIGIN` to the exact
  HTTPS marketing origin and set `MARKETING_INDEXING=public`. Do not place
  secrets in this deployment.

The checked-in [`vercel.json`](vercel.json) is the project configuration. With
`apps/marketing` as the Root Directory, Vercel runs these commands from that
directory:

```text
Install Command: pnpm install --frozen-lockfile
Build Command:   pnpm --filter @private-skills/marketing build
```

You can verify the same commands locally from the app directory:

```sh
cd apps/marketing
pnpm install --frozen-lockfile
APP_ORIGIN=https://app.example.com MARKETING_ORIGIN=https://marketing.example.com MARKETING_INDEXING=public pnpm --filter @private-skills/marketing build
```

The public discovery endpoints are `/robots.txt` and `/sitemap.xml`. Their
contents follow `MARKETING_INDEXING`; a preview or local build is intentionally
not discoverable.

When the hosted identity configuration changes, re-read the app's public
`/auth/identity/config` response and update the time-bound preview wording in
these visitor pages before publishing the marketing build:

- `src/routes/faq.tsx` — the first-time sign-in answer;
- `src/routes/docs.getting-started.tsx` — the hosted access note, application
  workspace card, and setup step;
- `src/routes/demo.tsx` — the hosted token instruction; and
- `src/routes/legal.tsx` — the application access note.

Those sentences currently explain that company sign-in is not configured and
that hosted access uses an existing owner/admin-supplied registry token. On a
real identity activation, replace that current-preview wording with the
verified company sign-in path and keep the demo/example boundary. Do not
describe copy-link invitations as email delivery until an email transport is
configured and tested, and do not add SCIM or other enterprise integrations
from the roadmap without separate acceptance.

## Plan preview boundary

The pricing preview is a projection of the billing package's browser-safe
`PlanCatalog.publicMetadata()` result. The default build imports only the pure
plan metadata module and renders the shared `free`, `team`, and `business`
IDs, labels, descriptions, and finite limits. It does not import the app
server, a Stripe adapter, billing credentials, or customer state.

The marketing site is a separate static build, so it cannot read a live app
catalog at request time. If an application deployment supplies custom plan
definitions or recurring Price IDs, export only its public metadata (the
`protocolVersion`, plan IDs, labels, descriptions, limits, and the two boolean
readiness flags) and set `PUBLIC_PLAN_METADATA_JSON` during the marketing
build. The value may be a metadata array or a
`{ "protocolVersion": 1, "plans": [...] }` envelope. The build rejects
malformed, duplicate, oversized, or server-only fields such as `priceId`; it
does not silently merge custom values with the defaults. Keep this input free
of Price IDs and secrets.

When `PUBLIC_PLAN_METADATA_JSON` is omitted, the projection uses the shared
default catalog. Rebuild the marketing site with the public projection before
publishing custom application packaging. The authenticated app's billing console and
`GET /v1/billing` response remain authoritative for live entitlements,
provider readiness, and checkout. The public page always keeps its preview
label and has no purchase or checkout action, even when a build-time metadata
projection reports an application price as configured.

See Vercel's [monorepo Root Directory guidance](https://vercel.com/docs/monorepos/monorepo-faq)
and [build configuration reference](https://vercel.com/docs/builds/configure-a-build)
for the corresponding project settings.
