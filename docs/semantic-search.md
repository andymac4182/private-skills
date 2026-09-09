# Semantic search

Semantic search is an authorization-aware, rebuildable index over approved skill
content. The search package deliberately receives `SearchDocument` values from
the application; it does not decide whether a skill is approved, read the
registry's policy, or turn a search hit into an install authorization. The
application checks publication state and namespace access before indexing, passes
the caller's allowed resource ids to every query, and rechecks the returned
resource and immutable digests before rehydrating a result.

The frozen TypeScript boundary is in
`packages/search/src/types.ts`:

```ts
interface EmbeddingProfile {
  id: string;
  model: string;
  dimensions: number;
}

interface SearchDocument {
  organizationId: string;
  resourceId: string;
  artifactDigest: Digest;
  contentDigest: Digest;
  text: string;
  vector: number[];
  profileId: string;
  indexedAt: string;
}

interface SemanticIndex {
  upsert(documents: readonly SearchDocument[]): Promise<void>;
  search(query: {
    organizationId: string;
    allowedResourceIds: string[];
    profileId: string;
    vector: number[];
    limit: number;
  }): Promise<readonly SearchHit[]>;
  remove(organizationId: string, resourceIds: readonly string[]): Promise<void>;
  health(): Promise<SearchHealth>;
}
```

Every configured profile has a stable model id and dimension count. Vectors must
contain exactly that number of finite, non-zero values, and dimensions are
bounded at 2,000 (the default profile is 1,536). A profile mismatch is rejected
before it reaches a provider. Digest and text metadata are returned with a hit
so callers can reject a stale row when an artifact was replaced or revoked.

## Production adapter: PostgreSQL and pgvector

`PostgresSemanticIndex` uses the existing `PgPoolLike` interface from
`packages/database/src/postgres.ts`, or an injected parameterized query
function. PostgreSQL is the production default because the registry already
uses it for multi-process state, authorization metadata, scan evidence, and
artifact identity. The index table uses an unbounded `vector` column: the
application enforces each profile's dimension while the database can hold
multiple model profiles in one table. A row is replaced by the current
`(organization_id, resource_id, profile_id)` document, making a rebuild or
re-embedding operation idempotent. `remove` removes every profile for the
requested tenant/resource pair.

Set `autoMigrate: true` only in a deployment that permits schema changes. It
creates the `vector` extension and the scoped metadata table; the adapter does
not create an approximate-neighbor index. Queries use pgvector's cosine
distance operator with the tenant, profile, and explicit resource allowlist in
the `WHERE` clause before ordering and limiting. This keeps the initial search
exact and prevents a global approximate scan from being filtered after the
limit. A future ANN index should be introduced only with tenant-aware filtering
and recall tests. pgvector documents exact search as the default and describes
the filtering and multitenancy tradeoffs for HNSW and IVFFlat in its
[official README](https://github.com/pgvector/pgvector).

The database is still an index, not the authorization source. RLS may be added
as defense in depth, but the application must continue to pass an organization
and resource allowlist and recheck state before returning content. PostgreSQL
provisioning is external to this package: Vercel's original Postgres offering
was retired and existing projects moved to Neon, so deployments should use the
organization's selected Postgres/Neon Marketplace integration rather than
assuming a Vercel-provided database. See [Vercel's Postgres
documentation](https://vercel.com/docs/postgres).

## Portable fallback: exact vectors in StateRepository

`StateSemanticIndex` stores an optional `search` extension on the existing
organization-scoped `RegistryState` object. The extension is a JSON-compatible
`{ version: 1, documents: SearchDocument[] }` value; old state without it reads
as an empty index and remains valid. Every write calls
`StateRepository.transaction(organizationId, ...)`, and every read calls
`read(organizationId)`, so an organization boundary is established before
resource filtering. Cosine ranking is exact and deterministic, with resource id
as the tie breaker. The fallback is useful for local development, small
single-process installations, and rebuildable tests. It is not intended as the
multi-process production index because it scans and rewrites tenant state.

The adapter has no knowledge of scanner approval or caller roles. Indexing code
must pass only approved, authorized text, and a query handler must obtain the
same caller-specific resource allowlist used by the ordinary registry routes.
Revocation removes the resource from the index and rehydration checks the
returned `artifactDigest` and `contentDigest` against current registry state.

## Other backends

No libSQL/Turso or PGlite adapter is included in this milestone. The portable
`SemanticIndex` boundary makes either an additive backend: validate the same
profiles and documents, scope every query by organization/profile/allowlist,
replace the current resource/profile row, and return the same digest-bearing
hit. Keep provider clients in an adapter package and add conformance tests for
tenant isolation, replacement, revocation, and exact digest propagation.

Turso/libSQL has native vector functions and a DiskANN-based vector index. Its
official [AI and embeddings documentation](https://docs.turso.tech/features/ai-and-embeddings)
describes BLOB vector storage, `vector_distance_cos`, and `vector_top_k`; the
index is approximate and needs a matching dimension/type. It is a good hosted
serverless option where the project accepts a new operational database and
provider-specific indexing behavior. The [HTTP client](https://docs.turso.tech/sdk/http/quickstart)
fits edge fetch runtimes, but tenant filtering and authorization still belong in
the adapter/query contract.

PGlite embeds PostgreSQL and pgvector in WebAssembly. Its [official overview](https://pglite.dev/docs/about)
supports Node, Bun, and browser use cases, while its [filesystem documentation](https://pglite.dev/docs/filesystems)
describes memory, Node FS, IndexedDB, and OPFS persistence choices. It is useful
for offline or browser local indexes and can share SQL semantics with
PostgreSQL, but it adds a WASM asset, memory, startup, and persistence lifecycle
to an edge deployment. Its [sync plugin](https://pglite.dev/docs/sync) is alpha
and currently provides one-way shape synchronization, so it is not a replacement
for the registry's authoritative multi-tenant Postgres state or conflict
resolution.

The production default therefore remains pgvector over the existing application
database, with the StateRepository exact fallback available wherever a durable
database is unavailable. Embedding providers and model API clients remain
outside this package; callers persist the profile/model identity alongside each
immutable digest so changing a model creates a deliberate re-index operation.

This also matches the current Vercel split: the Node runtime can use the
existing Postgres connection and provider clients, while Edge functions have
strict bundle and memory limits and should delegate database work through the
application's authenticated gateway. The exact StateRepository adapter remains
portable for local or small deployments, but it should not be promoted to a
shared multi-tenant edge database by itself.
