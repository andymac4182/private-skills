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

## Pull-through proxy

Configure an allowlisted upstream in the Sources screen. `pskills proxy @team/name@1.0.0 --upstream <id> --path skills/name --ref <commit-or-ref>` asks the registry to acquire and scan the complete source, waits for the operation, and then installs the approved artifact. GitHub acquisition records the resolved commit. The API is `POST /v1/proxy/resolve` with `{ upstreamId, path, ref?, repository?, name, version }`.

A cold request returns `202 { operation }`; matching pending requests join that job. An approved exact-source cache hit returns `200 { resolution }` without contacting the upstream. A changed source cannot replace an existing name/version. Proxy creation requires publisher access. Readers can install an already cached approved version with ordinary `pskills install`.

## State and artifact storage

Select the profile through the environment-backed runtime factory:

| Profile | Settings | Operational constraint |
| --- | --- | --- |
| File state | `PSKILLS_STATE_PROVIDER=file`, `PSKILLS_STATE_PATH` | One API process only. Production requires `PSKILLS_SINGLE_PROCESS=true`; do not mount the same state directory into multiple API instances. |
| PostgreSQL state | `PSKILLS_STATE_PROVIDER=postgres`, `DATABASE_URL` | Preferred multi-process Node profile. State is JSONB in `private_skills_registry_state`; updates are row-locked transactions. |
| HTTP state | `PSKILLS_STATE_PROVIDER=http`, `PSKILLS_STATE_ENDPOINT`, `PSKILLS_STATE_TOKEN` | Use for edge or isolated metadata service. The server enforces the versioned HTTP CAS protocol. |
| Files SDK storage | `PSKILLS_STORAGE_PROVIDER=filesystem`/`s3`/`r2`/`gcs`/`azure`/`vercel-blob` plus provider settings | Node loads the selected adapter. Credentials stay server-side and public object URLs are not accepted. |
| HTTP blob gateway | `PSKILLS_STORAGE_PROVIDER=http`, `PSKILLS_STORAGE_ENDPOINT`, `PSKILLS_STORAGE_TOKEN` | Edge and provider-isolated profile. The gateway is authenticated, bounded, and digest-checking. |

File-state writes are atomic per organization and use restrictive permissions. PostgreSQL increments the revision in the same transaction as the JSONB update. The HTTP repository retries compare-and-set conflicts by replaying the synchronous updater; it does not hide a conflict with local memory.

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
