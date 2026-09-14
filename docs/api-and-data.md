# API and data model

This is a proposed v1 contract inventory. Implementation milestone M1 produces and validates the complete OpenAPI specification and generated TypeScript/Rust types. Nitro serves the HTTP contract across deployment targets; Files SDK and infrastructure providers remain behind service interfaces. The included JSON Schemas are reviewable drafts, not a complete server API.

## Conventions

API base `/v1`; JSON metadata only. Authorization binds every request to an organization and allowed namespaces. IDs are opaque; display names like `@team/review` are resolved through explicit namespace mappings. A feed is a tenant-scoped discovery list plus adapter/policy configuration, not a source namespace. A configured feed selects the catalog adapter and retains the complete skills.sh external ID (`source/slug`) as source identity. After verification, a canonical reference may be derived from the source provider/origin, repository and exact skill path, or a well-known scoped identity; snapshot-only metadata cannot invent those components. Any configured feed prefix is readable metadata and never renames a skill or becomes a mandatory alias; source identity remains source-derived. Object IDs and hashes are never credentials. Resource lookups return a uniform unavailable response when revealing existence would violate permissions.

Use `Idempotency-Key` for publish completion, imports, pack releases, rescans, and other retryable mutations; bind it to actor, organization, operation, and a request-body hash. Reuse with a different payload returns `409`. Use ETags/`If-Match` for mutable pack drafts, policies, and upstreams. Pagination uses bounded cursor-based pages. All serialized hashes use `sha256:<64 lowercase hex characters>`.

Errors have stable `code`, readable `message`, `requestId`, optional `details`, and `retryable`. Credentials and report excerpts are excluded. Typical codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_AVAILABLE`, `VERSION_CONFLICT`, `POLICY_BLOCKED`, `SCAN_PENDING`, `SCAN_FAILED`, `DIGEST_MISMATCH`, `UPSTREAM_UNAVAILABLE`, `RATE_LIMITED`, and `CLIENT_UPGRADE_REQUIRED`.

## Endpoints

| Endpoint | Purpose / response |
| --- | --- |
| `GET /v1/capabilities` | Authenticated protocol, effective host/storage transfer limits, transfer modes/range support, schema versions, supported targets/scanners |
| `GET /v1/feeds` | Readable organization feed metadata: id, unique name, kind, enabled state, configured prefix metadata, trusted-origin summary, and configuration revision |
| `POST /auth/device` and `POST /auth/token` | Standards-based browser/device login; expiring codes and prescribed polling |
| `POST /auth/revoke` | Revoke the caller's CLI session/token |
| `GET /v1/skills?q=...` | Search accessible skills, cursor pagination; each authorized row includes response-only `currentAdmission` metadata (`allowed`, status/reason, current policy revision, and optional scanner/expiry details) computed from the same current policy/evidence gate used for resolution and file access |
| `GET /v1/skills/{id}/versions` | Authorized version/provenance metadata |
| `GET /v1/skills/{resourceId}/files` | Authorized immutable release digest and canonical file manifest with per-file content digests and explicit binary/unsupported/oversize preview states; metadata-only and scanner/policy gated |
| `GET /v1/skills/{resourceId}/file?path=...` | Authorized exact file read for one canonical relative path; repeats the release/digest binding and returns full bounded UTF-8 text only for that selected file |
| `POST /v1/drafts` | Publisher-only upload-origin draft from a namespace-scoped canonical bundle; requires an idempotency key and has no fake base release |
| `POST /v1/skills/{resourceId}/drafts` | Publisher-only draft fork from an authorized approved release; requires the exact base digest and an idempotency key |
| `GET/PUT /v1/drafts/{draftId}` | Publisher-only namespace draft read or CAS update; every revision is a freshly sealed canonical bundle with an exact digest |
| `POST /v1/drafts/{draftId}/publish` | Publisher-only explicit publication request; queues a scan-bound pending release for the selected draft revision and returns an idempotent operation |
| `POST /v1/resolve` | Resolve `{kind, ref, version?, sourceRevision?}` to pinned resource/member records; `200` resolved or `202` ingestion operation |
| `POST /v1/imports` | Import approved upstream/source/subdirectory/revision; `202` operation |
| `POST /v1/proxy/resolve` | Transparent feed resolution for `{feed?, externalId, refresh?}`; response `{feed, externalId, reference, operation \| resolution}`; a `202` operation may omit `reference`, while a `200` resolution includes the verified source reference; both echo the original external ID; server owns internal ID/revision |
| `POST /v1/uploads` | Reserve a fresh private quarantine attempt object and intended release; `201` scoped signed-upload or authenticated-gateway descriptor |
| `POST /v1/uploads/{id}/complete` | Revalidate actual stored bytes; `202` ingestion operation; server computes digests |
| `GET /v1/operations/{id}` | Authorized status, stage, retry timing, redacted failure detail |
| `POST /v1/install-authorizations` | Authorize a complete resolved install plan, including resource/pack identities and exact digests; recheck every member and pack decision; return actor-bound authorization ID valid for 60 seconds |
| `POST /v1/install-authorizations/{id}/validate` | Recheck the full plan immediately before activation; renew only if ACLs, sources, releases, packs, and current policies still permit it |
| `POST /v1/artifacts/{digest}/download` | Require release/source-revision ID and install authorization ID, including pack context when applicable; reauthorize; `200` transfer descriptor (signed URL or authenticated gateway), digest, size, expiry; `202` if rescan required, otherwise deny |
| `GET /v1/packs` / `GET /v1/packs/{id}/versions` | Pack catalog and immutable member sets |
| `POST /v1/packs` / `PATCH /v1/packs/{id}/draft` | Create/edit unpublished pack intent |
| `POST /v1/packs/{id}/publish` | Resolve all members, scan/evaluate aggregate manifest, commit exact graph; `202` operation |
| `GET /v1/scan-runs?artifact=...` | Redacted status/coverage; raw report access requires extra permission |
| `POST /v1/artifacts/{digest}/rescan` | Explicit authorized rescan, idempotent job |
| `POST /v1/versions/{id}/revoke` | Audited revocation, immediate denial of future grants |
| `GET/PUT /v1/policies/{id}` | Read/change revisioned scanner and hook policy; administrator only |
| `GET/POST/PATCH /v1/upstreams` | Manage generic explicit proxy mappings and credential references; administrator only; feed restrictions are configured on `/v1/feeds` and are not required for the built-in `skills-sh` path |
| `GET /v1/audit-events` | Administrative paginated audit access |
| `POST /internal/scan-results` | Service-authenticated, job-scoped result ingestion; unavailable to ordinary clients |

API paths above containing `{digest}` URL-encode the digest as a single component. Every digest-based client endpoint also requires an authorized resource context: immutable release ID or source-revision ID, and pack version/manifest identity when a pack is involved. Identical bytes do not imply identical namespace ACLs, source permissions, or distribution policies. Native publish, imported source, and pack references resolve through the same current-policy evaluator. A pack resolution returns no installable result until every member is accessible and approved; a failed member is reported without leaking another namespace's metadata.

Feed resolution validates the selected feed name, enabled state, tenant ACL,
and feed source policy before reading the catalog or opening an outbound
connection. Unknown or disabled feeds therefore fail before fetch. The current
feed kind is `skills-sh`; future kinds must register their own bounded adapter
and provenance contract rather than widening this path implicitly. A source
provider/origin or repository/path is recorded only after the resolver verifies
the exact scoped identity; snapshot-only metadata never invents a
physical source path. Sharing a canonical source identity does not share a
tenant/feed ACL grant.

The feed base URL must be the canonical skills.sh origin or an operator-trusted
gateway listed in `trustedSkillsShBaseUrls`. A caller-supplied `credentialEnv`
value is rejected; server-managed credentials are never returned to browsers or
forwarded to source, artifact, or redirect requests. When `feed` is omitted,
the server auto-selects only when exactly one enabled feed exists; with multiple
enabled feeds the caller must select one explicitly.

Installation authorization binds the caller, organization, selected feed and
primary references, full desired member set and owners, release/source
identities, pack versions/manifests, target scope, effective policy revisions,
and digests. It is required even when every archive is already cached locally.
A fresh authorization may be obtained after a long download, but the server
must repeat every check. The CLI validates it immediately before the first
activation write. Revocation after that last check cannot atomically stop local
filesystem operations; document the bounded authorization window and report
revocation on the next check. Do not promise remote recall of installed files.

For the transparent skills.sh path, a reader with install permission and
explicit `proxy:resolve` may start a bounded cold pullthrough or consume an
approved warm cache entry. The default reader/publisher grant for
`proxy:resolve` remains pending explicit product approval and production
verification; owner/admin grants may exercise the route. The cold job
does not grant permission to alter source restrictions, scanner policy,
publication state, or aliases. Browsing and listing are metadata-only; file
bytes become transferable only after source provenance, required scanner
evidence, current policy, and actor-bound install authorization pass. A warm
request must not perform an upstream lookup by default, while explicit refresh
or update must recheck the source and surface failure instead of treating an
older cache as fresh.

The authenticated `GET /v1/directory/detail` route returns the metadata-only
`SkillDetailMetadataResponse` DTO: it preserves the external `id`, `source`,
`slug`, install count, snapshot hash, and whether a snapshot is `null`, while
each non-null file entry contains only its path. Snapshot text remains in the
internal directory/acquisition boundary until required scanners and policy
admission complete; the public reader route never serializes `contents`.

For a project spanning registries, the CLI partitions the desired plan by registry origin and organization. Each service sees and authorizes only its own resources; the CLI completes final validation with every participating registry before activation and aborts on any failure. Never share another registry's credentials or private member metadata. A published v1 pack belongs to one registry/organization; its proxied members are locally mirrored resources in that same registry.

Transfer descriptors specify `mode: signed-url | gateway`, approved URL, method, explicit per-transfer headers, expiry, digest, byte size, and range support. The CLI forwards only those scoped transfer headers to that exact approved origin; registry session credentials never flow to storage or a cross-origin gateway. A gateway grant is separate from registry credentials and binds actor/resource/pack context, operation, object, limits, and expiry. The gateway rechecks current authorization before opening the stream. See [storage and transfers](storage.md) for provider capability fallback, upload sealing, and host limits. Metadata replies, reports, and authorization routes set private/no-store caching as appropriate; shared CDN caching never bypasses authorization.

## Tables and invariants

| Table | Key data and constraints |
| --- | --- |
| `organizations`, `memberships`, `namespace_grants` | Stable GitHub user identity, roles, scoped permissions; every owned record carries organization ID |
| `cli_sessions`, `service_tokens` | Hashed token material, scopes, organization, expiry, revocation; no raw tokens stored |
| `feeds`, `upstreams`, `namespace_routes` | Feed id/name/kind/enabled/configured-prefix metadata/configuration revision and trusted-origin/restriction policy; the canonical source reference remains source-derived; generic mappings remain separate optional proxy routes |
| `skills`, `skill_versions` | Namespaced identity; unique `(organization, skill, version)`; immutable artifact binding |
| `source_revisions` | Tenant/feed identity, original external ID/source type, verified upstream/repository/subdirectory/immutable revision when available, external hash/digest (including null), local canonical digest, resolver provenance, ACL/policy revision, and license data; never an invented path from snapshot-only metadata |
| `artifacts`, `artifact_files` | Organization-scoped digest, logical store ID and sealed object key/version, byte limits, file manifest, creation/retention state; no provider URL as permanent identity |
| `packs`, `pack_drafts`, `pack_versions`, `pack_members` | Immutable published manifest/member graph; exact skills/releases/digests; no nested packs in v1 |
| `skill_drafts`, `skill_draft_revisions` | Tenant/namespace-scoped mutable editor state, explicit release/upload origin, optional base release/digest, exact sealed bundle digest, monotonic revision, and publication idempotency records |
| `policy_revisions`, `policy_exceptions` | Immutable normalized config/hash; scoped reasoned exceptions with expiry |
| `scan_runs`, `scan_findings`, `approvals` | Reusable artifact/engine/config/rules evidence; approvals additionally bind release/source/pack context, effective policy revisions, and expiry |
| `jobs`, `job_attempts`, `outbox_events` | Unique idempotency binding, lease/fencing token, state, heartbeat, bounded retries, durable event handoff |
| `revocations`, `audit_events` | Append-only actor/action/subject/time/reason; no full secret-bearing skill bodies |
| `install_authorizations`, `download_grants` | Actor, full resource/pack context, exact desired-plan hash, digests, effective policies, scope, expiration, audit ID; never log full signed URL |

Composite foreign keys must include organization IDs where they prevent cross-organization joins. Enforce authorization in the service layer and database row-level policies where supported; test both. Hash deduplication is organization-scoped initially to avoid cross-tenant existence/timing leaks and deletion ambiguity.

Artifact bytes and published version/member bindings are immutable. Approval is a separate revisioned record, so a rescan or policy change cannot mutate package identity. User-facing `approved`, `quarantined`, `rejected`, `scan-error`, and `revoked` distribution states are derived from current policy/evidence and revocations; historical decisions remain available for audit.

## Transactions and races

Job creation and outbox insertion occur in one database transaction. Unique constraints collapse concurrent requests; workers use renewable leases and monotonic fencing tokens to reject stale attempts. Job/event delivery is at least once; a managed workflow provider is optional. Create a fresh server-only sealed object, validate/hash/scan its exact bytes, then publish its database pointer. Do not require cross-provider atomic rename, conditional upload, or cheap server-side copy. Reconcile orphaned objects and missing events periodically.

Publish/approve transactions check the active policy revision, resource context, and exact artifact digest at commit. A policy race returns pending reevaluation, not an approval from old evidence. Pack publication checks member version identities and permissions again at commit. Download authorization checks release/source/pack revocation and current context-bound approval immediately before minting its short-lived grant. Final installation authorization rechecks the pack-level decision and every desired member, including retained shared members.

Do not keep database transactions open during network fetches or scanner execution. Retry unique/transient conflicts with bounded backoff. Destructive source/cache deletion is asynchronous, audited, retention-aware, and cannot delete artifacts required by active published releases without an explicit revoke/delete workflow.
