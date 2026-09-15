# Operations runbook

This runbook covers the implemented local and deployment interfaces. Keep the environment contract in `.env.example` and the deployment templates in [`deployment/README.md`](../deployment/README.md) aligned with any operator changes. Never place token values, provider credentials, signed transfer URLs, or raw scanner output in this repository or in routine logs.

## Start and check the service

Use Node 24 and pnpm 11.19.0.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm setup:dev
pnpm dev
```

The development server normally uses `http://localhost:5173`. Verify liveness without credentials:

```sh
curl --fail http://localhost:5173/health
```

For a local check of the built Node profile using your generated development settings:

```sh
pnpm build
PSKILLS_PUBLIC_ORIGIN=http://localhost:3000 node --env-file=.env apps/web/.output/server/index.mjs
curl --fail http://localhost:3000/health
```

The self-hosted baseline starts PostgreSQL and the API with the pinned compose configuration. Configure production variables using [`deployment/README.md`](../deployment/README.md), then run the scanner controller on a dedicated Docker-capable host as described below:

```sh
docker compose up --build
curl --fail http://127.0.0.1:3000/health
```

The API must have a user bootstrap token. Production additionally requires a configured session secret, a durable state provider, and private artifact storage. `PSKILLS_ALLOW_UNSCANNED=false` is the safe default; keep it false unless the organization has deliberately accepted the policy consequence.

## Runtime profiles and environment

Choose the state, storage, and search boundaries together. The runtime factory
uses these production defaults:

| Profile | Required selection | Result |
| --- | --- | --- |
| Node with PostgreSQL | `PSKILLS_STATE_PROVIDER=postgres`, `DATABASE_URL` | PostgreSQL JSONB state and pgvector semantic search by default; Files SDK storage uses the selected provider, S3 by default. |
| Node single process | `PSKILLS_STATE_PROVIDER=file`, `PSKILLS_SINGLE_PROCESS=true` | File state and the exact StateRepository search fallback; suitable for local or explicitly single-process deployments. |
| Vercel Node with gateways | `PSKILLS_STATE_PROVIDER=http`, `PSKILLS_STORAGE_PROVIDER=http`, `PSKILLS_STORAGE_BUILD_PROFILE=http` | Authenticated HTTP state/blob gateways keep local filesystem, PostgreSQL, and provider SDKs out of the Vercel function. |
| Cloudflare edge | `PSKILLS_RUNTIME_PROFILE=edge`, HTTP state/blob endpoints | Uses `apps/web/server/runtime-edge.ts`; the bundle does not include Files SDK, PostgreSQL, or Node scanner execution. |

`PSKILLS_STORAGE_BUILD_PROFILE` is a build-time adapter choice. Keep it aligned
with `PSKILLS_STORAGE_PROVIDER` for a direct Node/Vercel Files SDK build, or
set both to `http` for a gateway-backed function. Provider credentials,
`PSKILLS_SESSION_SECRET`, `PSKILLS_BOOTSTRAP_TOKEN`, state/blob gateway tokens,
and worker/reviewer tokens are runtime secrets; do not put them in `VITE_`
variables or source control.

### skills.sh directory gateway

The portable directory gateway is an operator-controlled configuration for
hosts where request-scoped Vercel OIDC is unavailable. On a Node host with
request-scoped Vercel OIDC available, selecting the canonical `https://skills.sh`
URL uses project OIDC and never the gateway token. Edge hosts require the
explicit gateway configuration below:

```sh
PSKILLS_DIRECTORY_ENABLED=true
PSKILLS_DIRECTORY_GATEWAY_URL=https://directory-gateway.example/skills
PSKILLS_DIRECTORY_GATEWAY_TOKEN=replace-with-server-secret
```

The gateway URL must be an operator-trusted HTTPS base without userinfo, query,
or fragment data. Requests are bound to its exact origin and path. Gateway
catalog authentication is stripped on redirects; existing private-source
authentication is retained only for an allowed same-origin request. The token
is available only to the server/worker request path, is bounded and redacted,
and must never reach browser code, job data, logs, source acquisition, or
redirects. Invalid or incomplete settings fail closed with directory unavailable
behavior. Legacy ambient directory-token settings, including `DIRECTORY_TOKEN`
and `PSKILLS_DIRECTORY_TOKEN`, are ignored; use the explicit URL/token pair.
Deployment enablement and runtime evidence are tracked separately.

The production state factory starts the scanner policy with Cisco
(`cisco-skill-scanner`) `required`, NVIDIA Skillspector `advisory`, SkillsGuard
`advisory`, and `allowUnscanned=false`. Development starts all three scanners
`disabled`; `pnpm setup:dev --allow-unscanned` is the explicit disposable-demo
override. The in-memory/core policy fallback is also fail-closed, so do not
use it as evidence that a production factory has disabled its configured
scanners. Read `/v1/policy` after startup and record the policy revision with
the deployment manifest.

These are the fresh-factory defaults. The verified current production
deployment is an explicit override: SkillsGuard is `required`, Cisco and
NVIDIA are `disabled`, and `allowUnscanned=false`. The committed [production
policy checkpoint](evidence/production-m6-readonly-dpl_39j65TecJNinwh9o1Y5Y1PALvnR3.json)
records the corresponding fail-closed policy and read-only checks; disabled
engines do not constitute scanner verdicts. Keep the override documented with
the deployment's policy revision and do not describe it as evidence that those
disabled scanners ran.

Semantic search is disabled unless `PSKILLS_AI_ENABLED=true`. When it is
enabled, configure `PSKILLS_EMBEDDING_MODEL` and
`PSKILLS_EMBEDDING_DIMENSIONS` only when overriding the defaults, plus either
`AI_GATEWAY_API_KEY` or the deployment's Vercel OIDC credential. The default
profile is `openai/text-embedding-3-small` with 1,536 dimensions. Configured
dimensions must be an integer from 1 through 2,000, matching the search index.
An optional `PSKILLS_AI_GATEWAY_BASE_URL` must use HTTPS; HTTP is accepted only
for loopback development. Any production marker in `PSKILLS_ENVIRONMENT`,
`NODE_ENV`, or `VERCEL_ENV` disables that HTTP exception. PostgreSQL
uses pgvector; deployments without PostgreSQL use the exact StateRepository
fallback. The pinned self-hosted `compose.yaml` Postgres image does not ship
the pgvector extension, so compose explicitly selects `PSKILLS_SEARCH_PROVIDER=state`
for a durable local search index; set `PSKILLS_SEARCH_PROVIDER=pgvector` only
with a database image or managed service that provides the extension. There is
no libSQL/Turso implementation in this release. The
embedding request and reindex bounds are documented in
[`docs/semantic-search.md`](semantic-search.md).

## Authenticate a check

Use the web form for browser work. For a scripted check, keep the token in the process environment and let curl write only the session cookie to a temporary file:

```sh
cookie_file="$(mktemp)"
curl --fail -c "$cookie_file" \
  -H 'content-type: application/json' \
  -H "Origin: ${PSKILLS_PUBLIC_ORIGIN:-http://localhost:5173}" \
  --data "{\"token\":\"${PSKILLS_BOOTSTRAP_TOKEN}\"}" \
  http://localhost:5173/auth/session
curl --fail -b "$cookie_file" http://localhost:5173/v1/me
rm -f "$cookie_file"
```

The exchange turns a configured user token into a short-lived signed `HttpOnly` cookie. Worker tokens cannot be exchanged for browser sessions. Cookie mutations require an `Origin` matching `PSKILLS_PUBLIC_ORIGIN`. Do not use a browser session for worker or CLI automation.

Company operations status is available at `GET /v1/operations/status` to an
owner or admin with the selected company's live membership. Its identity block
shows aggregate sign-in failures, provider callback failures, and membership
denials, including retained totals and last-24-hour counts. Events without a
server-verified company membership remain global diagnostics and are never
included in another company's response. The route returns no event rows or
identity credentials.

The CLI stores a token bound to an exact registry origin:

```sh
printf '%s' "$PSKILLS_BOOTSTRAP_TOKEN" | pnpm cli login --registry http://localhost:5173 --token-stdin
pnpm cli --registry http://localhost:5173 health
pnpm cli --registry http://localhost:5173 whoami
```

`pskills login` intentionally has no interactive browser/device flow in this build. Use the registry-issued token path and keep it out of shell history and logs.

## Run the external worker

The worker claims scan/import jobs from the internal API and completes them with a lease/fencing token. Configure these values in the worker environment:

- `PSKILLS_API_URL`: API origin reachable by the worker;
- `PSKILLS_WORKER_TOKEN`: worker-only bearer credential;
- `PSKILLS_WORKER_ID`: stable operator-visible worker identity;
- `PSKILLS_IMAGE_CISCO`, `PSKILLS_IMAGE_NVIDIA`, and `PSKILLS_IMAGE_SKILLSGUARD`: reviewed scanner image references;
- `PSKILLS_POLL_INTERVAL_MS`: optional poll interval.

The local command loads optional `.env` settings without replacing explicitly exported variables. Run this on the host that has Docker and the reviewed scanner images; the API container does not execute scanners:

```sh
pnpm worker
```

The worker defaults to `DockerExecutor`. Its scanner containers have no network, read-only artifact input, separate report output, dropped capabilities, no-new-privileges, bounded memory/CPU/PIDs, and bounded output. A trusted local executor is available for adapter tests; it is not the production default. The worker's event log is metadata-only and must not be expanded to include artifact bytes, lease tokens, credentials, or scanner stderr.

If a required scanner image or executable is unavailable, the resulting evidence is unsupported/error and the core policy remains closed. Install and test scanner images on the dedicated worker boundary before selecting `required` for production traffic.

Build and exercise the pinned engines with `./scripts/scanner-acceptance.sh all`. Use `PSKILLS_DOCKER_CONTEXT=desktop-linux` for a Docker Desktop controller, or the default daemon on a dedicated Linux worker. SkillsGuard can provide complete static evidence for supported files. Cisco's current JSON coverage and NVIDIA's offline OSV fallback are reported as degraded; they are useful in advisory mode, while required mode correctly blocks incomplete evidence. No scanner proves a skill harmless.

Deployment code may inject local `ingest.validate` and `artifact.evaluate` hooks into `WorkerRunner`. Required hook rejection, timeout, or error denies approval. Automatic outbound webhook delivery is disabled; no remote URL receives skill content or job metadata automatically.

## Hosted Vercel Sandbox worker

The optional hosted worker is a Node-only, one-shot route at
`GET /internal/worker/run`. Set `PSKILLS_HOSTED_WORKER=true` in the web
runtime and provide the following values in the Vercel secret store:

```dotenv
PSKILLS_HOSTED_WORKER=true
PSKILLS_API_URL=https://registry.example.test
PSKILLS_WORKER_TOKEN=worker-service-token
CRON_SECRET=at-least-16-random-characters
PSKILLS_IMAGE_CISCO=registry.example/cisco@sha256:<64-lowercase-hex>
PSKILLS_IMAGE_NVIDIA=registry.example/nvidia@sha256:<64-lowercase-hex>
PSKILLS_IMAGE_SKILLSGUARD=registry.example/skillsguard@sha256:<64-lowercase-hex>
```

The route accepts only `GET` and requires an exact
`Authorization: Bearer $CRON_SECRET` value. The scheduler user-agent is not
authentication. With the explicit Better Auth/PostgreSQL tenant dispatcher
configured, one call walks a bounded keyset page of server-listed
organizations, invokes only a server-constructed tenant worker for each, and
persists a fenced cursor and per-company retry backoff. Without that
dispatcher, the route retains the single default-company worker fallback.
Scanner reports, artifact bytes, worker tokens, and scanner stderr never appear
in the route response. Vercel Sandbox creates a fresh ephemeral sandbox with
deny-all network access and bounded input/output; the edge runtime cannot run
this Node/Sandbox boundary.

The repository-root Vercel fallback cron invokes the route every five minutes
(`*/5 * * * *` UTC), so a bounded page continues on the same day and a failed
company receives durable backoff retries. A successful `POST /v1/publish`,
`/v1/imports`, or skill rescan also starts a bounded drain of at most two jobs
through Nitro's `waitUntil` hook when the platform provides it. Queue leases
and fencing remain authoritative; cron is liveness for the durable queue.
Keep at least one reviewed required scanner configured and do not enable
`PSKILLS_ALLOW_UNSCANNED` to fit a function limit.

The hosted-worker dispatcher owns two separate PostgreSQL tables. Its
`hostedWorkerDispatchSchemaSql()` migration is not run by default; set
`PSKILLS_HOSTED_WORKER_DISPATCH_AUTO_MIGRATE=true` only as an explicit
operator choice, or apply the exported migration during deployment. Bounds
can be reduced with the `PSKILLS_HOSTED_WORKER_DISPATCH_*` settings shown in
`.env.example`; the lease duration must outlive the invocation budget.

When tenant-bound Eve review is enabled, the same deployment invokes
`/internal/reviewer/dispatch` every 15 minutes (`*/15 * * * *` UTC). Each
invocation drains one bounded cursor page and persists the next page in the
registry state row, allowing all explicitly provisioned organizations to be
attempted within the daily UTC window without making one function unbounded.
Set `PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS` when the host needs a lower
budget; the dispatcher keeps a persistence margin before the lease or platform
deadline. A tenant review claim is durably marked `starting` before cost
reservation or the Eve session call. `starting` and `uncertain` records remain
fenced after lease expiry until an operator or reconciliation process resolves
the provider outcome, so a host crash cannot automatically open a duplicate
session. Definite provider rejections release their claim and can retry on the
next scheduled invocation.

Use immutable scanner references. A SkillsGuard source-built snapshot must
include its source revision and prepared artifact digest:

```dotenv
PSKILLS_IMAGE_SKILLSGUARD=snapshot:<snapshot-id>|revision:<source-commit>|artifact:sha256:<64-lowercase-hex>
```

The provisioning script is source-pinned and non-provisioning by default. A
finite snapshot lifetime is optional. The currently promoted verified
source-built snapshot uses the non-expiring mapping (`expiresAt: null`); replace
it when the pinned source/build changes or through an explicit operator
rotation. If a deployment chooses a finite 30-day lifetime, run the dry-run
mapping before requesting a remote snapshot:

```sh
PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS=30 \
  pnpm exec tsx scripts/provision-scanner-sandbox.ts
PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS=30 \
  pnpm exec tsx scripts/provision-scanner-sandbox.ts --provision
```

Persist the returned mapping and update `PSKILLS_IMAGE_SKILLSGUARD`. Rotate
before `expiresAt` when the mapping has a finite expiry; with the current
non-expiring mapping, `expiresAt` is `null` and source/build changes still
require an explicit replacement. `PSKILLS_SCANNER_SNAPSHOT_TTL_DAYS` defaults
to `0` (no expiry), and a bare or mutable snapshot id is never sufficient
provenance. The snapshot source is the exact SkillsGuard revision recorded in
`workers/images/scanner-metadata.json`; do not describe a snapshot as
provisioned until the `--provision` command has returned and its immutable
mapping has been reviewed.

## Eve reviewer

The reviewer is a separate Eve 0.52.3 application under `apps/reviewer`, not a
registry route or a model with registry credentials. The root API can trigger
it only when `PSKILLS_AI_ENABLED=true`, `PSKILLS_REVIEWER_URL`, and
`PSKILLS_EVE_API_TOKEN` are present. The reviewer deployment separately
requires `PSKILLS_REGISTRY_API_URL`, `PSKILLS_REVIEWER_TOKEN`, its Eve bearer
`PSKILLS_EVE_API_TOKEN`, and an AI Gateway credential (`AI_GATEWAY_API_KEY` or
Vercel `VERCEL_OIDC_TOKEN`). Keep these values in each project's runtime secret
store; never expose them to the browser or put them in candidate text.

The authored schedule is `0 22 * * *` UTC (08:00 Australia/Brisbane). The root
Vercel fallback worker cron is separate at `0 21 * * *` UTC. Manual runs use
the authenticated admin review action or the Eve server-side Client SDK; do
not put the Eve token in a browser request. The deployed reviewer health probe
at `https://private-skills-reviewer.vercel.app/eve/v1/health` returned `200`,
while an unauthenticated session request returned `401`. This verifies the
reviewer service boundary only; the main registry project has not been claimed
as deployed, and no registry authenticated flow is implied by the reviewer
probe. See [`docs/eve-reviewer.md`](eve-reviewer.md) for the complete tool,
session, and build contract.

The interactive skill-builder bridge in this web runtime is production-bound
to `https://private-skills-builder.vercel.app`; its server-side credentials and
authorized draft context are never exposed to the browser. The registry and
core hosting contracts remain Nitro-portable, but alternate builder
destinations are not supported or claimed by this runtime.

Eve receives a bounded approved-skill snapshot through the two fixed internal
routes. Its model can propose and submit a review suggestion, but it cannot
merge or publish a release, edit source, authorize an install, or execute
candidate content. Accepting a suggestion in the registry records a human
decision only.

## Pull-through proxy

Configure an allowlisted upstream in the Sources screen. `pskills proxy @team/name@1.0.0 --upstream <id> --path skills/name --ref <commit-or-ref>` asks the registry to acquire and scan the complete source, waits for the operation, and then installs the approved artifact. GitHub acquisition records the resolved commit. The API is `POST /v1/proxy/resolve` with `{ upstreamId, path, ref?, repository?, name, version }`.

A cold request returns `202 { operation }`; matching pending requests join that job. An approved exact-source cache hit returns `200 { resolution }` without contacting the upstream. A changed source cannot replace an existing name/version. Proxy creation requires publisher access. Readers can install an already cached approved version with ordinary `pskills install`.

Pack versions also record the policy revision under which they were published. After changing policy, rescan the member skills and publish a new pack version under the current revision. Historical pack versions remain immutable and do not silently acquire new approval.

## State and artifact storage

Select the profile through the environment-backed runtime factory:

| Profile | Settings | Operational constraint |
| --- | --- | --- |
| File state | `PSKILLS_STATE_PROVIDER=file`, `PSKILLS_STATE_PATH` | One API process only. Production requires `PSKILLS_SINGLE_PROCESS=true`; do not mount the same state directory into multiple API instances. |
| PostgreSQL state | `PSKILLS_STATE_PROVIDER=postgres`, `DATABASE_URL` | Preferred multi-process Node profile. State is JSONB in `private_skills_registry_state`; updates are row-locked transactions. |
| HTTP state | `PSKILLS_STATE_PROVIDER=http`, `PSKILLS_STATE_ENDPOINT`, `PSKILLS_STATE_TOKEN` | Use for edge or isolated metadata service. The server enforces the versioned HTTP CAS protocol. |
| Files SDK storage | `PSKILLS_STORAGE_PROVIDER=filesystem`/`s3`/`r2`/`gcs`/`azure`/`vercel-blob` plus provider settings | Node loads the selected adapter. Credentials stay server-side and public object URLs are not accepted. |
| HTTP blob gateway | `PSKILLS_STORAGE_PROVIDER=http`, `PSKILLS_STORAGE_ENDPOINT`, `PSKILLS_STORAGE_TOKEN` | Edge and provider-isolated profile. The gateway is authenticated, bounded, and digest-checking. |
| Semantic search index | PostgreSQL with `PSKILLS_SEARCH_PROVIDER=pgvector`, or `PSKILLS_SEARCH_PROVIDER=state` | pgvector is the Node multi-process default when PostgreSQL is selected; StateRepository is the portable exact fallback. |

File-state writes are atomic per organization and use restrictive permissions. PostgreSQL increments the revision in the same transaction as the JSONB update. The HTTP repository retries compare-and-set conflicts by replaying the synchronous updater; it does not hide a conflict with local memory.

Install receipt tickets and receipts are stored with the selected state
repository. The client submits a receipt after its local transaction commits;
the CLI retries transient receipt delivery once and then reports a warning
without changing install success. See [`docs/analytics.md`](analytics.md) for
the endpoint contract, 24-hour ticket, 90-day retention, 100,000-record
bound, and admin report.

The Files SDK store writes to fresh random `sealed/` keys, reads the object back, and verifies its size and SHA-256 digest. The HTTP gateway is a transport boundary, not a second source of truth: back up the gateway's underlying state and object provider.

## Backup procedure

Take metadata and artifacts from a consistent recovery point. Stop the API and worker first, or use a provider snapshot that guarantees the same point for both records and objects.

1. Record the deployment version, organization IDs, active policy revision, and the chosen state/storage providers. Keep this manifest beside the backup metadata, without secrets.
2. For file state, back up the whole `PSKILLS_STATE_PATH` directory. For local filesystem artifacts, back up the whole `PSKILLS_STORAGE_ROOT` directory. Preserve file bytes, permissions, and sealed-object names.

   ```sh
   tar -czf private-skills-state.tgz -C "$PSKILLS_STATE_PATH" .
   tar -czf private-skills-artifacts.tgz -C "$PSKILLS_STORAGE_ROOT" .
   ```

   `PSKILLS_STATE_PATH` is a directory for `FileStateRepository`; do not point a second process at a copy while the original is running.
3. For PostgreSQL, use a provider-consistent dump of the configured database:

   ```sh
   pg_dump --format=custom --file=private-skills-db.dump "$DATABASE_URL"
   ```

   Back up the object provider in the same window. The registry metadata contains object keys and digests; the database dump alone cannot restore artifact bytes.
4. For HTTP state/blob profiles, back up the authoritative metadata service and object provider behind the gateway. Do not treat a gateway cache or a browser download as a backup.
5. Record digest manifests from the metadata snapshot. During restore, hash the restored sealed bytes and compare each `sha256:<hex>` digest before serving the object.
6. Encrypt backups at rest, restrict access to the operator role, and test the restore in a separate origin, database, and storage prefix before replacing a live deployment.

Do not copy a live file-state directory while it is being written. Do not overwrite published objects to repair a mismatch; restore a fresh object under a new recovery boundary and investigate the digest failure.

## Recovery procedure

1. Stop API and worker processes. Preserve logs and the original metadata/object snapshots for investigation.
2. Restore metadata and artifacts into an isolated database/storage prefix. Use the same organization ID, policy revision, and object keys where the provider supports safe immutable restore.
3. Start the API with a new temporary public origin and the restored state/storage configuration. Check `/health`, then authenticate and read `/v1/me`, `/v1/capabilities`, `/v1/policy`, and a known catalog entry.
4. Verify known artifact and pack digests through the registry and CLI. A restored pack must resolve its exact members and still reference the expected immutable bytes.

   ```sh
   pnpm cli --registry "$RECOVERY_ORIGIN" health
   pnpm cli --registry "$RECOVERY_ORIGIN" search recovery-check
   pnpm cli --registry "$RECOVERY_ORIGIN" pack list
   ```

5. Start the worker only after metadata and object verification passes. Let queued jobs claim through the normal lease path. Requeue or rescan evidence that is stale under the restored policy; never mark a release approved by editing state directly.
6. Test one authorized transfer and one denied/revoked transfer. Confirm no public object URL, cross-organization record, or expired grant serves bytes.
7. After the isolated checks pass, switch the reviewed origin/route to the recovered service, retain the old deployment for rollback, and update the backup manifest with the new revision.

If metadata is available but an artifact digest is missing, leave the release unavailable and restore the missing sealed object from the provider backup. If a required scan is missing, stale, incomplete, or fenced to an abandoned job, queue a rescan under the current policy. A storage or persistence `503` is a retry/recovery event, not permission to bypass the policy gate.

## Routine checks and limits

- Check `/health` from the deployment health probe and inspect operation age through `/v1/operations` with an authorized principal.
- Alert on repeated persistence/storage `503` responses, expired worker leases, increasing queued jobs, scanner timeouts, unsupported scanner evidence, and digest mismatches.
- Keep logs metadata-only. Redact authorization headers, session cookies, signed transfer URLs, source credentials, report excerpts, and artifact content.
- Treat `required` scanner coverage and evidence age as release gates. Advisory findings remain visible but do not approve missing required evidence.
- Keep external upstream mappings HTTPS-only, allowlisted, and server-side. The acquisition code rejects unsafe redirects, private/metadata destinations, unbounded responses, and mutable identity where an immutable revision is required.

## Deployment verification

See [`docs/verification.md`](verification.md) for actual checks. Nitro builds, native workerd tests, and local container checks are separate from deployment to a cloud account. Before production use, test the selected host and storage credentials, restore a metadata/object backup, and verify authenticated allowed and denied transfers at that origin.
