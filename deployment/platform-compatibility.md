# Platform compatibility

The web application is built with TanStack Start and Nitro. Each production
target is selected at build time so the generated server has one deliberate
runtime boundary:

| Target | Nitro preset | Infrastructure module | Storage boundary in the web bundle |
| --- | --- | --- | --- |
| Node | `node-server` (default) | `apps/web/server/runtime-node.ts` | Files SDK adapter selected by `PSKILLS_STORAGE_PROVIDER` |
| Vercel | `vercel` | `apps/web/server/runtime-node.ts` | Same Node adapter; Nitro traces it into the Vercel function |
| Cloudflare Workers | `cloudflare_module` | `apps/web/server/runtime-edge.ts` | HTTP state and blob gateways; no Files SDK or Node storage adapter |

Build one target with the checked-in helper from the repository root:

```sh
pnpm exec tsx scripts/platform-build.ts node
pnpm exec tsx scripts/platform-build.ts vercel
pnpm exec tsx scripts/platform-build.ts cloudflare
```

The Node and Vercel helper profiles set a production environment and select
S3 by default. Set `PSKILLS_STORAGE_PROVIDER` in the shell to build another
supported Node Files SDK adapter deliberately. `filesystem` maps to the Files
SDK `fs` adapter, while `http` does not need Files SDK tracing. Providers with
optional peer dependencies must be installed in the build environment that
selects them; they are not installed as a side effect of the portable build.
Use `PSKILLS_STORAGE_BUILD_PROFILE` when the build-time adapter should differ
from the runtime's `PSKILLS_STORAGE_PROVIDER`; the helper defaults this profile
to the runtime provider and the production default is S3.
The default S3 profile pins the four runtime peers used by Files SDK
(`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-presigned-post`,
and `@aws-sdk/s3-request-presigner`) at `3.1079.0`. GCS, Azure Blob, and
Vercel Blob peers remain opt-in.

The Cloudflare profile selects the edge infrastructure alias and HTTP storage
and state providers. It must not import `runtime-node.ts`, `postgres`, or the
Files SDK. The gateway endpoints and tokens are runtime configuration supplied
through Wrangler bindings or secrets; they are not embedded in the bundle.

## Build and runtime evidence

The following checks are separate by design:

| Check | What it proves | What it does not prove |
| --- | --- | --- |
| `scripts/platform-build.ts node` exits successfully | Nitro emitted a production Node server and traced the selected Files SDK package | A database, storage backend, authentication, or authenticated API flow is reachable |
| `scripts/platform-build.ts vercel` exits successfully | Nitro emitted a Vercel Build Output API function with the selected Node dependencies under the function directory | A Vercel deployment, Git-triggered build, or production integration exists |
| `scripts/platform-build.ts cloudflare` exits successfully and the edge artifact contains no `files-sdk`/Node storage imports | Nitro emitted a Workers module with the HTTP gateway runtime boundary | A Worker has been deployed or its gateway bindings work |
| Isolated prebuilt Node and Vercel `/v1/me` smoke | The copied artifact initializes the selected S3 Files SDK adapter and authenticated runtime without an ancestor workspace `node_modules` directory | A real S3 object transfer, cloud deployment, or gateway service is reachable |
| Parent task's production HTTP smoke flow | The running production artifact can serve the configured health/authenticated registry flow | Untested storage backends or cloud control-plane deployment behavior |

For the checked-in dependency boundary, Node and Vercel builds use Nitro's
`traceDeps` for `files-sdk` and the selected adapter. This leaves optional
provider peers external to the application code and traces only dependencies
reachable from the chosen Node profile. Cloudflare supplies `!files-sdk` to
the trace configuration and resolves the infrastructure alias to the edge
module, so Node-only storage code cannot enter that target accidentally.

Do not treat a successful local compile as deployment evidence. Before calling
the portable baseline complete, run the authenticated production flow against
the built Node artifact, deploy and exercise the Vercel function, and deploy
and exercise the Cloudflare Worker with real gateway bindings. The deployment
templates in this directory still require owner-managed credentials and
provider setup.

The current local runtime smoke copies each Node and Vercel function output to
a temporary directory and runs it without the repository's ancestor
`node_modules`. With fake S3 credentials and loopback HTTP gateway endpoints,
`/v1/me` returned `200`; this proves dependency tracing and runtime
initialization, while the actual storage transfer and cloud deployment checks
remain deployment-level work.
