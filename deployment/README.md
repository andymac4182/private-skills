# Deployment templates and runbook

These files describe deployment profiles; they do not contain provider
credentials and no cloud deployment has been performed. The portable baseline
is a Node Nitro server, PostgreSQL, a host worker/controller, and Files SDK
storage. Vercel and Cloudflare Workers are optional Nitro targets with the same
HTTP contracts. An edge deployment still needs a separate host worker for
durable acquisition and scanning.

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

The [Vercel template](vercel.json) is for a repository-root Vercel project. It
uses the TanStack Start framework preset and the Nitro build emitted by the
web package. If the Vercel project is configured to read a checked-in config,
copy this template to the repository root as `vercel.json`, or apply the same
settings in the project configuration. Keep provider-specific storage and
metadata adapters behind the existing environment-backed interfaces.

The [official TanStack Start Vercel guide](https://vercel.com/kb/guide/deploy-a-tanstack-start-app-to-vercel)
and [Nitro's Vercel provider documentation](https://nitro.build/deploy/providers/vercel)
document the required `nitro/vite` plugin, Vercel preset, Git deployments, and
runtime environment handling. Use a Git-connected deployment for the production
integration and verify the resulting deployment's commit, branch, health
route, authenticated API flow, private artifact transfer, and worker callback.
A local build or a CLI-only deployment is not evidence that Git deployment
automation works.

Set secrets in Vercel's environment configuration, never in `VITE_` variables
or this repository. A Vercel function cannot use the local filesystem or run
native scanners; use `PSKILLS_STORAGE_PROVIDER=http` and
`PSKILLS_STATE_PROVIDER=http` with an authenticated gateway/transaction
service, and keep the durable host worker/controller outside Vercel. Vercel is
optional and no Vercel account, paid integration, or deployment is required by
this repository.

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
# Run this with a reviewed Wrangler installation in the deployment environment.
wrangler deploy --config deployment/cloudflare/wrangler.jsonc
```

The repository does not add Wrangler as an application dependency. Pin and
provision the CLI in the deployment environment before using the command; the
command above is a runbook example and has not been run by this change.
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
