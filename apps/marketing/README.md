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

For local work from the repository root:

```sh
pnpm --filter @private-skills/marketing dev
APP_ORIGIN=https://app.example.com pnpm --filter @private-skills/marketing build
```

For Vercel, create a dedicated project for this app with these settings:

- **Root Directory:** `apps/marketing`
- **Include source files outside of the Root Directory in the Build Step:**
  enabled. The workspace lockfile and `pnpm-workspace.yaml` are at the
  repository root and are needed by the package manager.
- **Framework Preset:** TanStack Start
- **Node.js:** 24.x
- **Environment variable:** set `APP_ORIGIN` to the public origin of the
  authenticated app in both Preview and Production, for example
  `https://app.example.com`. Do not place secrets in this deployment.

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
APP_ORIGIN=https://app.example.com pnpm --filter @private-skills/marketing build
```

See Vercel's [monorepo Root Directory guidance](https://vercel.com/docs/monorepos/monorepo-faq)
and [build configuration reference](https://vercel.com/docs/builds/configure-a-build)
for the corresponding project settings.
