# Deployment templates and runbook

These files describe deployment profiles; they do not contain provider
credentials. The portable baseline is a Node Nitro server, PostgreSQL, a host
worker/controller, and Files SDK storage. Vercel and Cloudflare Workers are
optional Nitro targets with the same HTTP contracts. An edge deployment still
needs a separate host worker for durable acquisition and scanning.

The separate Eve reviewer has a verified Vercel deployment at
`private-skills-reviewer.vercel.app`: its public health probe returned `200`
and its unauthenticated session probe returned `401`. This proves the reviewer
boundary only. The main registry project `private-skills-theta.vercel.app` is
provisioned but has not been claimed as deployed; database terms/user setup is
still required before an authenticated registry deployment can be reported.

## Self-hosted Node and PostgreSQL

The root `compose.yaml` requires these values in a local `.env` file or in the
shell environment. Keep the file outside source control:

```dotenv
POSTGRES_PASSWORD=use-a-long-random-value
DATABASE_URL=postgresql://private_skills:use-a-long-random-value@db:5432/private_skills
PSKILLS_BOOTSTRAP_TOKEN=use-a-separate-bootstrap-token
PSKILLS_SESSION_SECRET=use-a-long-random-session-secret
PSKILLS_WORKER_TOKEN=use-a-separate-worker-token
```

The password in `DATABASE_URL` must be URL-encoded if it contains characters
reserved by a URI. `PSKILLS_ALLOW_UNSCANNED` defaults to `false`; keep it false
for a production registry. The API binds to loopback by default, so put a
reviewed TLS reverse proxy in front of it before exposing it to a network.

Start the API and database after the application build is available:

```sh
docker compose up --build
curl --fail http://127.0.0.1:3000/health
```

The API uses the `artifacts` volume, while PostgreSQL uses its own named
volume. The API also has a `state-data` volume for an explicitly selected
single-process file-state profile; the default PostgreSQL profile does not use
it. To select that local fallback, set `PSKILLS_STATE_PROVIDER=file` and
`PSKILLS_SINGLE_PROCESS=true`. The API container is read-only, drops all Linux
capabilities, and has a no-new-privileges policy.

The Compose file intentionally does not start a worker container. The checked-in
worker image has no Docker CLI or daemon socket, while `WorkerRunner` defaults
to the isolated `DockerExecutor`; starting that container would claim jobs and
then fail to launch scanner containers. Set `PSKILLS_WORKER_TOKEN` in the shell
or ignored `.env` file, then run exactly one host controller against the API and
the reviewed scanner images:

```sh
PSKILLS_API_URL=http://127.0.0.1:3000 \
PSKILLS_WORKER_ID=host-controller-1 \
PSKILLS_IMAGE_CISCO=private-skills/cisco-skill-scanner:2.1.0 \
PSKILLS_IMAGE_NVIDIA=private-skills/nvidia-skillspector:2.11.1 \
PSKILLS_IMAGE_SKILLSGUARD=private-skills/skillsguard:1.1.1 \
PSKILLS_DOCKER_CONTEXT="${PSKILLS_DOCKER_CONTEXT:-default}" \
pnpm worker
```

Run this command from a checkout with `pnpm install --frozen-lockfile` and a
Docker CLI authenticated to the dedicated worker daemon. On Docker Desktop,
set `PSKILLS_DOCKER_CONTEXT=desktop-linux`; on a local Linux daemon, leave it
as `default`. Verify each image with `docker image inspect` before starting the
controller. Do not run the Compose API more than once with the same state
volume and do not run a second worker with the same queue unless that worker
has its own reviewed token and stable ID. Leases and fencing prevent stale
completion, but a worker without the scanner images will still consume and
fail jobs.

Scanner execution remains on the host-controller boundary. `DockerExecutor`
passes only the sealed artifact workspace and bounded scanner arguments to
each isolated container. The API never receives a Docker socket, privileged
mode, host PID namespace, or scanner credentials.

### Optional S3-compatible storage

The default profile uses the filesystem adapter. To exercise the S3-compatible
adapter with the pinned optional MinIO image, set the storage variables and
start the profile:

```dotenv
PSKILLS_STORAGE_PROVIDER=s3
PSKILLS_STORAGE_ENDPOINT=http://minio:9000
PSKILLS_STORAGE_BUCKET=private-skills
PSKILLS_STORAGE_REGION=us-east-1
PSKILLS_STORAGE_PATH_STYLE=true
PSKILLS_STORAGE_ACCESS_KEY_ID=replace-me
PSKILLS_STORAGE_SECRET_ACCESS_KEY=replace-me-with-a-long-random-value
```

```sh
docker compose --profile s3 up --build
```

The API and MinIO ports bind to loopback. The compose image is pinned to a
multi-architecture digest instead of `latest`; review the current MinIO
distribution terms and image availability before adopting it for a shared
deployment. An S3-compatible service that meets the Files SDK privacy,
durability, and exact-byte requirements can replace it without changing the
application contract. Do not switch a private registry to a public bucket or
public object URL.

## Vercel

The repository-root [`vercel.json`](../vercel.json) owns the main web project.
It keeps the Vercel project root at the checkout root, installs with the pinned
pnpm lockfile, and runs [`scripts/build-vercel.mjs`](../scripts/build-vercel.mjs).
That script builds the TanStack Start web package with Nitro's `vercel` preset
and copies `apps/web/.vercel/output` to the repository-root `.vercel/output`,
which is the Build Output API directory Vercel collects. The matching
[`deployment/vercel.json`](vercel.json) is a copyable template for a new
repository-root project.

The script requires Node 24 and does not invoke a second package-manager
install. Vercel's install phase is the only install phase:

```sh
pnpm install --frozen-lockfile
node scripts/build-vercel.mjs
test -f .vercel/output/config.json
```

Keep the Vercel project on Node 24.x. The repository's `.node-version` and
`packageManager` fields pin Node `24.20.0` and pnpm `11.19.0`; preserve those
pins when overriding Build & Development settings.

The web project is separate from the Eve reviewer project. Configure that
project with Root Directory `apps/reviewer` and its own `pnpm build` command;
`eve build` emits that project's `.vercel/output`. Do not point the reviewer
project at the root web build script or combine its services with the registry
project. The scanner worker/controller remains a separately operated host
process and is not included in either Vercel build.

Keep provider-specific storage and metadata adapters behind the existing
environment-backed interfaces. For a Vercel deployment backed by the
authenticated HTTP gateways, set both `PSKILLS_STORAGE_PROVIDER=http` and
`PSKILLS_STORAGE_BUILD_PROFILE=http` in the Vercel build environment. For a
direct Node Files SDK provider, set the build profile to that provider and
install its pinned optional peer dependencies before building. Runtime state,
storage, model, session, and reviewer tokens belong in Vercel environment
configuration and never in `VITE_` variables or this repository.

The [official TanStack Start Vercel guide](https://vercel.com/kb/guide/deploy-a-tanstack-start-app-to-vercel)
and [Nitro's Vercel provider documentation](https://nitro.build/deploy/providers/vercel)
document the required `nitro/vite` plugin, Vercel preset, Git deployments, and
runtime environment handling. Use a Git-connected deployment for the production
integration and verify the resulting deployment's commit, branch, health
route, authenticated API flow, private artifact transfer, and worker callback.
A local build or a CLI-only deployment is not evidence that Git deployment
automation works.

Set `PSKILLS_STATE_PROVIDER=http` with its endpoint and token for the same
gateway-backed deployment. A Vercel function cannot use the local filesystem
or run native scanners, so keep the durable host worker/controller outside
Vercel. Vercel is optional and no Vercel account, paid integration, or
deployment is required by this repository.

### Hosted Sandbox worker (optional)

The one-shot hosted worker factory in
[`workers/runner/src/hosted.ts`](../workers/runner/src/hosted.ts) is a Node
runtime route for Vercel Cron or an explicitly authenticated operator pump. It
accepts `GET` only and requires `Authorization: Bearer $CRON_SECRET`; the
Vercel cron user-agent is not authentication. Each invocation claims at most
one job through the existing worker API, runs the configured scanners in
Vercel Sandbox, and returns queue metadata only. Reports, artifact bytes,
worker tokens, and scanner errors are not returned to the caller.

The route configuration uses these Vercel environment variables:

```dotenv
PSKILLS_HOSTED_WORKER=true
PSKILLS_API_URL=https://registry.example.test
PSKILLS_WORKER_TOKEN=an-independent-worker-token
CRON_SECRET=at-least-16-random-characters
PSKILLS_IMAGE_CISCO=registry.example/cisco@sha256:<64-lowercase-hex>
PSKILLS_IMAGE_NVIDIA=registry.example/nvidia@sha256:<64-lowercase-hex>
PSKILLS_IMAGE_SKILLSGUARD=registry.example/skillsguard@sha256:<64-lowercase-hex>
```

Scanner image variables may instead contain a trusted source-built snapshot:

```dotenv
PSKILLS_IMAGE_SKILLSGUARD=snapshot:<snapshot-id>|revision:<source-commit>|artifact:sha256:<64-lowercase-hex>
```

The snapshot form records the source revision and SHA-256 digest of the
prepared scanner tree; a bare snapshot ID is rejected. The Vercel Sandbox SDK
is loaded lazily by the route, uses `networkPolicy: "deny-all"`, stages only
the sealed bundle under bounded input/output limits, and stops the ephemeral
sandbox after each scanner. The route must run on Vercel's Node runtime; the
Cloudflare edge target cannot launch the Node Sandbox SDK or native scanners.

The repository-root Vercel fallback cron invokes the route at `0 21 * * *`
UTC. Successful publish, import, and skill-rescan requests also schedule a
bounded drain of at most two jobs with Nitro's platform `waitUntil` hook when
available. The route's scheduler is a liveness fallback rather than the queue
itself.
Cron invocations do not provide durable retries, so the existing worker lease
expiry and fencing behavior remains authoritative. Configure the function
duration and lease longer than the worst-case sequential scanner policy, and
keep at least one configured required scanner. Do not set
`PSKILLS_ALLOW_UNSCANNED=true` to fit a function limit.

For the source-built SkillsGuard snapshot, run the source-pinned provisioning
script when creating or replacing a mapping. Its default invocation only
prints the immutable mapping; `--provision` is the remote operation and must
be recorded before the returned reference is placed in the secret store. A
finite 30-day rotation policy is optional:

```sh
PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS=30 \
  pnpm exec tsx scripts/provision-scanner-sandbox.ts
PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS=30 \
  pnpm exec tsx scripts/provision-scanner-sandbox.ts --provision
```

The currently promoted verified source-built snapshot is nonexpiring, with
`expiresAt: null`; replace it when the pinned source/build changes or by an
explicit operator action. For finite mappings, rotate before `expiresAt` and
keep the source revision and artifact digest in the mapping. The script
defaults to `PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS=0` (no expiry), and a bare or
mutable snapshot id is never sufficient provenance.

## Cloudflare Workers

[`cloudflare/wrangler.jsonc`](cloudflare/wrangler.jsonc) is a checked-in
template for a Nitro output under `apps/web/.output`. It follows Nitro's
[Cloudflare provider](https://nitro.build/deploy/providers/cloudflare) and
Cloudflare's [TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
plus [Wrangler configuration requirements](https://developers.cloudflare.com/workers/wrangler/configuration/): an explicit entrypoint,
compatibility date, `nodejs_compat`, and static asset directory. The
compatibility date is intentionally explicit; update it only after the edge
conformance suite passes.

The template sets `workers_dev` to `false` so a deployment cannot silently
create a public `workers.dev` endpoint. Before any deployment, add the reviewed
zone route or custom domain in the target environment and configure an account
ID through Cloudflare's environment/CI configuration. Set private values with
`wrangler secret put`, for example `PSKILLS_STATE_TOKEN`,
`PSKILLS_SESSION_SECRET`, and the gateway credentials. Do not add them to
`wrangler.jsonc` or source control.

Build and inspect the generated output before deploying:

```sh
PSKILLS_RUNTIME_PROFILE=edge NITRO_PRESET=cloudflare_module pnpm --filter @private-skills/web build
# Use the repository-pinned Wrangler CLI.
pnpm exec wrangler deploy --config deployment/cloudflare/wrangler.jsonc
```

Wrangler is pinned as a development dependency. Native local workerd validation
is recorded in `platform-compatibility.md`; the cloud deployment command above
requires your own account and route configuration and has not been run.
Cloudflare Workers cannot provide the Node filesystem, PostgreSQL native
connection, or child-process scanner execution directly. Use the authenticated
HTTP state/storage transport and the host worker/controller described above,
then run the same publish,
proxy, scan-denial, revocation, and install checks used for the Node profile.

## Versioned CLI releases

`.github/workflows/release.yml` runs only for a semantic version tag matching
the package version. It builds native binaries on Linux, macOS, and Windows,
attaches checksums and archives to a GitHub Release, and does not publish to
npm, crates.io, GHCR, or another public registry. The current assets are
`x86_64-unknown-linux-gnu`, `aarch64-apple-darwin` (the standard arm64 macOS
runner), and `x86_64-pc-windows-msvc`; an Intel macOS artifact is not claimed
until an available private-repository runner is selected. Keep version tags
protected and review the repository visibility and `contents: write` permission
before enabling releases. CI and release action references are immutable commit
SHAs; Dependabot watches the GitHub Actions ecosystem for reviewed pin updates.
