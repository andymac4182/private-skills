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

See Vercel's [monorepo Root Directory guidance](https://vercel.com/docs/monorepos/monorepo-faq)
and [build configuration reference](https://vercel.com/docs/builds/configure-a-build)
for the corresponding project settings.
