# Pull-through proxy

## Identity and source routing

Resolve a skill by organization, namespace, skill name, and requested version/ref. Internal identifiers also include upstream ID, repository identity, normalized subdirectory, resolved commit/artifact revision, and SHA-256 digest. Never use just a URL, branch name, or skill name as a cache key.

The registry owns namespace routing. Locally published namespaces are authoritative and cannot silently fall back to public upstreams. Proxy namespaces have explicit ordered upstream mappings; in v1 each mapping has one source. Authentication/authorization failure must not trigger fallback. Unqualified names require a configured default namespace and still obey the mapping. These choices prevent private names resolving to unrelated public packages.

Upstream adapters initially support:

1. GitHub repositories, including a selected subdirectory at a pinned commit. Repository archives come through an authenticated server-side fetch; no clone hooks, recursive submodules, credential-bearing URLs, or working-tree code execution.
2. Another Private Skills registry using the versioned API and artifact digest contract. Authenticate server-to-server, retain the upstream digest/provenance, and apply this registry's own scan policy. Limit proxy hops and reject cycles.

GitHub URLs may be accepted as user input only when they match an administrator-approved upstream. URLs from skills.sh are discovery references, not evidence of a supported proxy protocol. GitLab, Bitbucket, generic HTTP archives, and other registries require explicit later adapters.

## Cache-miss transaction

1. Authenticate the caller, authorize the namespace/source, enforce quotas, and resolve the source to immutable revision metadata.
2. Create or reuse a durable job using a database uniqueness constraint and idempotency key. Concurrent requests join the same job within the authorized organization/source context.
3. Fetch into isolated acquisition storage, enforce network and archive limits, and validate the complete skill directory. Record the source archive digest and the extracted file manifest.
4. Produce a deterministic archive of the permitted skill contents and compute its distribution digest. Use Files SDK to store it under a fresh, server-only sealed object key, still quarantined by registry state. Client upload grants never target this key. If normalization changes bytes, record both source and distributed digests; all scanners analyze the distributed payload. The sealed object is never overwritten, including when the backend lacks conditional writes.
5. Seal the artifact against modification, run scanner adapters and configured gates, store reports, and evaluate the captured policy revision.
6. Recheck the current policy and source permissions before committing approval. A concurrent policy change cannot approve under obsolete rules. Persist the approved digest and evidence transactionally.
7. On each subsequent download request, authorize the immutable release/source and any pack context again, then issue a short-lived transfer descriptor for that cached digest only when its effective policy permits it. Use a qualified private signed URL or an authenticated transfer gateway depending on backend/runtime capability. Identical content under another namespace/source does not inherit this permission. The client verifies the digest independently before extraction and revalidates the complete install plan before activation.

No client redirects to the upstream, no upstream credential forwarding, and no partial download before the complete artifact is fetched and policy-approved. `202 Accepted` with an operation ID represents pending work; a cache miss is not a successful install. Implement this through explicit Nitro handlers and durable jobs: Nitro route-rule proxy rewrites are a pass-through transport and must not implement the registry's fetch/store/scan gate. See [Nitro provider behavior](https://nitro.build/deploy/providers/vercel).

## Cache rules

| Case | Behavior |
| --- | --- |
| Approved immutable digest | Reuse Files SDK object reference; reevaluate required scan freshness and resource-context authorization before issuing access |
| Mutable branch/tag alias | Refresh metadata on a short configurable TTL; any changed revision creates a new artifact and scan |
| Same published version, changed bytes | Reject immutable-version conflict; never overwrite |
| Upstream unavailable | Explicitly requested cached versions may work if access, policy freshness, and retention permit; report provenance and cached status |
| Uncached upstream failure | Return retryable failure; never claim install success |
| Upstream 404 | Short, scoped negative cache; do not cache authentication failures as missing artifacts |
| Revoked artifact | Deny new transfers and resolutions even if a pack/lock references it |
| Expired scan or new mandatory engine | Re-evaluate/rescan; required pending evidence blocks new distribution |
| Cache garbage collection | Preserve artifacts referenced by published versions, packs, retention holds, and active jobs; do not evict them as ordinary disposable proxy data |

Published proxy versions receive registry versions explicitly selected by the importing publisher. Unversioned sources can be installed by their source revision/digest without pretending to have upstream semantic versions. Mutable aliases are convenience pointers; lockfiles always resolve them.

## Private upstream behavior

Default private GitHub access uses an organization-admin-configured GitHub App installation with repository allowlists, plus registry namespace ACLs. This is a deliberate organization mirror: registry access is the distribution authority. Do not assume every reader must also possess upstream GitHub access. A stricter per-user upstream entitlement mode would require live revalidation and is a later feature.

Disabling a private upstream defaults to denying new distribution from its mirror until an administrator explicitly chooses a retention policy. Upstream repository removal or revoked credentials must generate an actionable state, never trigger anonymous/public fallback. Public-source caching retains license notices, source URL, author/provenance metadata, and deletion/takedown controls.

## Fetch and extraction defenses

Use source-specific allowlists; validate DNS/IP destinations and each redirect, rejecting loopback, private/link-local networks, metadata services, non-HTTPS schemes, and credential leakage across origins. Bound redirects, total time, compressed bytes, expanded bytes, file count, individual file size, and compression ratio. Never let a skill choose a fetch command.

Initial application limits to validate in the spike: 25 MiB compressed bundle, 100 MiB expanded, 2,000 files, 10 MiB per file, and 100:1 maximum expansion ratio. These are product limits, not hosting-provider limits. Use direct private transfers or an external gateway when a host cannot handle these sizes. A large repository archive has a separate 100 MiB acquisition cap even when its selected skill is small.

Reject traversal, absolute paths, symlinks/hardlinks, device nodes, Windows drive/UNC paths, alternate data streams, reserved Windows names, case-fold collisions, Unicode-normalization collisions, trailing dots/spaces, and nested archives that policy cannot inspect. Limit path length conservatively and validate again in the CLI. Suspicious archives fail before scanner execution.

Reject agent plugin-enabling manifests such as `.claude-plugin/plugin.json` and payloads that would implicitly activate agent hooks, MCP servers, or settings. Target adapters also reject agent-reserved directory names. Supporting files are preserved only within the ordinary skill-content contract; an install must not silently become a plugin installation. See [target compatibility](cli-and-packs.md#skill-identity-and-compatibility).

Sources that fetch additional code at runtime are not transitively scanned by downloading their initial bundle. Record outbound/dependency references; require review or deny according to policy. Uploading a clean manifest cannot approve a different archive: completion rehashes server-side and ignores client-asserted digests as authority.
