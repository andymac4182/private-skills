# Multi-source catalog proxy

The source catalog is a registry-owned discovery and resolution boundary for
skill sources. Its v1 TypeScript contract lives in
[`packages/source-catalog/src/types.ts`](../packages/source-catalog/src/types.ts)
and its bounded orchestration client lives in
[`packages/source-catalog/src/client.ts`](../packages/source-catalog/src/client.ts).
The current checkout also contains the core handler route and web/Rust client
seams for the contract. `packages/source-catalog/src/runtime.ts` composes the
13 built-in adapters, and `apps/web/server/runtime.ts` injects that client into
the Node/edge registry handler. The runtime configuration contract and local
provider smoke evidence are verified; provider credentials, deployment
configuration, and authenticated hosted acceptance remain separate work. This
document therefore describes the local contract and its limits; it does not
claim that any new provider is live in the hosted registry.

The built-in registry and GitHub adapter implementations are under
[`packages/source-catalog/src/adapters`](../packages/source-catalog/src/adapters).
The runtime factory constructs the adapters in the frozen source-id order and
applies server-only enablement, trust, bounds, and custom-repository settings.
When no client is injected by an alternate host or test, the core handler
returns a retryable source-catalog-unavailable response.

## Request flow

The registry owns source configuration, principal authorization, provider
credentials, timeouts, trust checks, and the transition from a provider identity
to an existing private registry resolution:

1. An authenticated client lists the server-owned source descriptors and their
   availability state.
2. The client searches source metadata through the registry. With no source
   selector, the registry fans out to all configured adapters and isolates a
   failed adapter from the other results.
3. The client selects an exact `sourceId` and `externalId`. A resolve request
   returns a server-owned `reference` and either an in-flight operation or the
   existing registry `resolution`.
4. The existing import, validation, scanner, policy, immutable artifact, and
   transfer boundaries decide whether the resolved source can be installed.

Adapters receive the organization identity derived from the authenticated
principal and a bounded abort signal. They do not receive a browser-selected
credential, an arbitrary URL to fetch, or executable source content. Provider
transport and acquisition stay on the server/worker side.

## HTTP contract

The route contract uses `sourceId` for source identity in rows, requests, and
resolutions. A descriptor uses `id` because it describes the adapter itself.
The core handler requires an authenticated user with reader access and
`registry:read` for list/search; resolve additionally requires `proxy:resolve`.
The route registration and local runtime injection are present; hosted proof is
tracked separately from this contract.

| Request | Response and behavior |
| --- | --- |
| `GET /v1/sources` | `{ "protocolVersion": 1, "sources": [...] }`. Each descriptor contains `id`, `label`, `capabilities`, `availability`, and `configRevision`. Availability is `available`, `unavailable` with a safe code/reason, or `disabled` with a safe reason. |
| `GET /v1/sources/search?q=<query>&source=<optional-id>&limit=20` | `{ "protocolVersion": 1, "query": "...", "data": [...], "sources": [...] }`. `source` selects one adapter; when omitted the registry fans out to all configured adapters. Each `data` row contains `sourceId`, `externalId`, `title`, `installable`, and optional bounded metadata such as `description`, `version`, `sourceUrl`, `repository`, `path`, `ref`, `sourceType`, `snapshotDigest`, `metadata`, and `unavailableReason`. Each entry in `sources` repeats its descriptor with `resultCount` and, when needed, an adapter error. |
| `POST /v1/sources/:sourceId/resolve` with `{ "externalId": "...", "refresh": true }` (where `refresh` is optional) | `{ "sourceId": "...", "externalId": "...", "reference": "...", "operation": { ... }, "resolution": { ... } }` as applicable. A queued response has an operation with `queued` or `running` state; a completed response has the existing registry `resolution`. The server owns `reference` and must echo the requested source identity. |

The search query is trimmed, requires at least two characters, and defaults to
20 results per source. The client defaults are a 200-character query limit, a
50-result per-source limit, a 200-result total limit, and a 15-second adapter
timeout. Server configuration may lower or raise these within the hard bounds
of a 2,000-character query, 100 results per source, 500 total results, and
60 seconds. An explicit `limit` is clamped to the configured per-source
limit. Search rows are metadata only and are not an artifact authorization.

A source resolve request requires a non-empty, control-free `externalId` of at
most 1,024 characters. `refresh: true` asks the selected adapter to recheck
provider identity and content before the registry chooses or creates an
approved resolution. A provider URL in a search row is descriptive metadata;
it is never a client-selected download target.

## Source adapter contract

An adapter has a stable path-safe ID, display label, `search` and `resolve`
capabilities, a configuration revision, and an availability function. The
registry validates every adapter result before it leaves the request boundary:

- Search results must echo the adapter's `sourceId`, contain a bounded
  `externalId` and title, and use scalar metadata only. A malformed row makes
  that source unavailable for the request and does not remove healthy sources'
  rows.
- Resolutions must echo `sourceId` and `externalId`, contain a server-owned
  `reference`, complete title/version metadata, a fresh configuration revision,
  and one of the typed acquisition identities below.
- Each adapter call is bounded by the configured timeout and the caller's
  abort signal. Adapter exceptions become safe per-source errors for search or
  a typed catalog error for resolve; raw provider errors are not returned.
- The organization ID is derived from the authenticated principal. It is not
  accepted as caller-controlled source data and is not a cross-tenant cache
  key supplied by the browser.

The typed acquisition union intentionally excludes a generic URL or bundle
target:

| Kind | Required identity | Boundary |
| --- | --- | --- |
| `github` | `repository`, safe relative `path`, and immutable `ref`; optional provider origin/content digest | The worker resolves the repository/path/ref and verifies any declared content digest. |
| `registry` | Trusted HTTPS `baseUrl`, package, and version; optional provider origin/artifact digest | The worker uses the existing registry acquisition and artifact validation path. |
| `openclaw` | Normalized public ClawHub or public GitHub source; optional provider/artifact-origin evidence | The existing OpenClaw feed/parser and provenance checks remain authoritative. This compatibility acquisition remains separate from native `clawhub`; private or arbitrary source kinds do not pass this boundary. |
| `tessl` | `workspace`, `tile`, `version`, `fingerprint`, `skillPath`, and the fixed provider origin `https://api.tessl.io`; optional artifact digest | The worker must preserve the Tessl identity and verify bytes before admission. |
| `polyskill` | Native `name`, `version`, and `contentDigest`; the provider origin is fixed by the worker | The worker fetches the exact version from the fixed PolySkill API, verifies the deterministic digest over the native semantic fields, and emits the original supported files (`skill.json`, `instructions.md`, and `tools.json` when present) plus a generated Agent Skills `SKILL.md` wrapper. Tool definitions remain JSON data in `tools.json`; adapter declarations are intentionally omitted from the bundle, and nothing is activated. |
| `clawhub` | Native `owner`, `slug`, `version`, and the complete version-file manifest `{ path, size, sha256 }`; optional manifest-derived artifact digest and fixed provider origin | The worker fetches and verifies the documented version files against their per-file SHA-256 values. If the documented download adds one root `_meta.json` provider wrapper, the worker validates it as bounded identity metadata and strips only that reserved member before manifest comparison. A feed/archive hash from the existing OpenClaw compatibility path is not a substitute for the native version manifest. |

The resulting resolution carries the original search row, typed acquisition,
server-owned `reference`, `configRevision`, and `resolvedAt`. The external ID
remains unchanged as provenance; it is not silently replaced with a private
name or inferred SemVer.

## Source inventory

These IDs are frozen in `BUILT_IN_SOURCE_IDS`. They describe the intended
adapter identity and current research/configuration scope. They are not a
claim that the provider is deployed, credentialed, or accepted by the hosted
registry.

| Source IDs | Scope | Current boundary |
| --- | --- | --- |
| `skillsmp`, `skillhub-public`, `tessl`, `polyskill`, `skills-directory`, `skillhub-pro` | Six additional registry/catalog providers | Built-in adapter implementations, bounded provider parsers, and the runtime composition are present locally. Local public search/resolve smoke evidence covers `skillsmp`, `skillhub-public`, `tessl`, and `polyskill`; `skills-directory` and `skillhub-pro` are key-only and remain conditional on `SKILLS_DIRECTORY_API_KEY` and `SKILLHUB_API_KEY`. Missing key-only credentials produce a safe unavailable state; no key values belong in logs or this repository. PolySkill's native worker deterministically verifies the complete native semantic JSON, emits the supported native files plus the generated `SKILL.md` wrapper, preserves tool definitions as data, and omits adapter declarations from the bundle. |
| `clawhub` | Native ClawHub version manifests alongside the existing OpenClaw compatibility path | Local public search/resolve smoke evidence and a native three-file acquisition are recorded. Native resolution requires `owner`, `slug`, `version`, and the version's complete `{ path, size, sha256 }` file manifest. The existing `openclaw` acquisition remains a separate feed/archive compatibility path; its archive hash cannot authorize native ClawHub files. No ClawHub catalog/import is claimed live in the hosted registry. |
| `github-code-search` | GitHub-wide search for metadata describing public `SKILL.md` sources | The bounded GitHub adapter is present locally and preserves exact repository/path/ref identity. Search requires a server-owned `GITHUB_TOKEN` or `GH_TOKEN`; rate limits, provider availability, and hosted acceptance remain deployment configuration. |
| `github-openai-skills`, `github-anthropics-skills`, `github-google-skills`, `github-vercel-agent-skills` | Four curated official/custom GitHub repository sources | Local public search/resolve smoke evidence covers all four curated adapters. Repository/path/ref is part of the typed acquisition; curated membership and revision evidence still must be verified before an import is admitted. |
| `github-custom` | Administrator-selected GitHub repository source | A custom source is allowlisted configuration, not a caller-supplied arbitrary URL. It remains conditional on a configured repository/ref allowlist. The local Universal Skill Finder research fixture is `bibryam/universal-skill-finder` pinned at `18161beadeeda90d99abd75dd573b47a99ac49e8`; this pin is research/configuration evidence, not a live source claim. |

The skills.sh directory and pull-through work remains the separate C1 delivery
described in [`skills-sh.md`](skills-sh.md). It is not silently counted as one
of these source IDs. C1, M6, and M7 remain incomplete.

## Configuration and availability

The host-neutral configuration shape is:

```ts
interface SourceCatalogConfiguration {
  enabled?: boolean;
  sources?: Record<string, {
    enabled?: boolean;
    trustedOrigins?: readonly string[];
  }>;
  maxQueryLength?: number;
  maxResultsPerSource?: number;
  maxTotalResults?: number;
  requestTimeoutMs?: number;
}
```

Public adapters are enabled by default when registered. An adapter with
missing provider credentials reports unavailable rather than fabricating empty
success. An administrator can disable the catalog globally or one source
specifically. The effective `configRevision` includes adapter revision,
enablement, and sorted trusted origins; changing it invalidates warm-cache
assumptions and requires a fresh resolve.

The Node/edge runtime factory accepts these server-only environment settings:

```sh
# Optional; absent means true. PSKILLS_SOURCES_ENABLED overrides JSON enabled.
PSKILLS_SOURCES_ENABLED=true

# Either an envelope with `sources` or a direct source map is accepted.
PSKILLS_SOURCES_JSON='{"enabled":true,"sources":{"skillsmp":{"enabled":false},"tessl":{"trustedOrigins":["https://api.tessl.io"]}}}'

# Optional administrator-owned GitHub repository allowlist, max 32 entries.
PSKILLS_GITHUB_CUSTOM_REPOSITORIES='[{"repository":"owner/repository","ref":"main"}]'
```

`PSKILLS_SOURCES_JSON` may also be a direct map such as
`{"skillsmp":{"enabled":false}}`; source settings support `enabled` and
`trustedOrigins` (a boolean shorthand is accepted for `enabled`). The envelope
may additionally set the query/result/timeout bounds in the TypeScript shape
above. The custom-repository setting accepts exact `owner/repository` strings
or `{ "repository": "owner/repository", "ref": "..." }` objects. Duplicate
repositories are collapsed case-insensitively; invalid JSON, unknown source or
setting names, unsafe refs, and more than 32 entries fail closed during runtime
construction.

Trusted origins are fixed in code per source. A configured `trustedOrigins`
list may narrow that fixed set but cannot add an arbitrary outbound origin.
Provider credentials are read server-side by their adapter and never accepted
from browser or CLI request data. The current key-only bindings are
`SKILLS_DIRECTORY_API_KEY` and `SKILLHUB_API_KEY`; `SKILLSMP_API_KEY` is
optional and is forwarded only when configured. GitHub code search reads
`GITHUB_TOKEN` or `GH_TOKEN`. Missing key-only credentials remain an explicit
unavailable state, while public adapters can still report provider or rate-limit
failures independently.

## Trust and safety limits

Resolved metadata and acquisition identities are checked at the registry
boundary:

- URLs must use HTTPS, contain no username, password, or fragment, and match
  the exact configured origin when a source trust list is present.
- Paths are bounded and reject absolute paths and traversal components. Digests
  use the `sha256:<64 lowercase hex>` form. Metadata is limited to 32 keys,
  safe key characters, and scalar string/number/boolean/null values; strings
  are bounded to 1,024 characters.
- Source IDs are bounded path-safe identifiers. Adapter labels, titles,
  descriptions, versions, refs, and provider fields have independent size
  limits. These checks prevent provider metadata from becoming an unbounded
  request, cache key, or log record.
- `sourceUrl` and provider-origin fields provide evidence. They do not grant
  permission to fetch arbitrary destinations, and a generic URL/bundle
  acquisition is intentionally not part of v1.
- Native ClawHub downloads may include one documented root `_meta.json` member
  outside the version-file manifest. When present, the worker accepts exactly
  one such member only when it is bounded (at most 64 KiB, subject to the
  normal file limit), valid UTF-8 JSON object data, and its optional `slug`,
  `version`, and `owner`/`ownerHandle` values match the queued native identity.
  Optional `ownerId` and `publishedAt` values are type- and range-bounded. A
  wrapper must expose at least one comparable identity field. If present, the
  worker drops only this reserved metadata member before comparing every
  remaining archive file to the queued `{ path, size, sha256 }` manifest. A
  duplicate, identity-less, malformed, mismatched, or any other extra member
  is rejected as a source integrity failure; the wrapper itself may be absent
  when the manifest and archive otherwise match. This exception is data-only
  and never activates content; the native manifest remains authoritative and
  the OpenClaw archive hash is kept separate.
- Discovery, resolution, import, validation, scanning, and publication never
  execute source scripts, hooks, MCP tools, package-manager commands, or
  candidate instructions. PolySkill tool definitions remain JSON data in the
  emitted `tools.json`, adapter declarations are omitted from the bundle, and
  its generated `SKILL.md` is a wrapper rather than an activation hook.
  Existing required scanner and policy gates remain authoritative; missing or
  failed required evidence denies admission.

## Errors

The registry uses stable error codes so clients can distinguish configuration,
provider, input, and resolution failures. Search exposes adapter failures in
the per-source `error` field while continuing healthy fan-out results.

| Code | HTTP status | Meaning |
| --- | ---: | --- |
| `SOURCE_NOT_FOUND` | 404 | The requested adapter ID is invalid or not configured. |
| `SOURCE_DISABLED` | 403 | Server configuration disabled the selected adapter. |
| `SOURCE_UNAVAILABLE` | 503 | Provider credentials/configuration or provider availability is not usable; `retryable` may be true. |
| `SOURCE_CAPABILITY_UNAVAILABLE` | 501 | The selected adapter does not provide search or resolve. |
| `SOURCE_INVALID_QUERY` | 400 | The query is missing, too short, too long, or contains control characters. |
| `SOURCE_INVALID_EXTERNAL_ID` | 400 | The exact provider identity is missing, too long, or contains control characters. |
| `SOURCE_TIMEOUT` | 504 | A bounded provider operation exceeded its timeout. |
| `SOURCE_RESOLUTION_INVALID` | 502 | The adapter returned malformed identity, metadata, or acquisition data. |
| `SOURCE_ORIGIN_UNTRUSTED` | 502 | A URL or provider origin failed the HTTPS or configured trust-origin check. |

## Client seams

The current Rust client keeps provider access behind the registry:

```text
pskills sources list
pskills sources search <query> [--source <source-id>] [--limit <n>]
pskills install --source <source-id> <external-id>
```

The web client uses the same route shapes through its source discovery view.
Both clients treat search rows as metadata and verify that a resolve response
echoes the requested source identity before using the returned private
resolution. Neither client follows provider URLs directly.

These local client seams do not by themselves prove hosted route exposure,
provider credentials, scanner admission, or a successful hosted install.

## Verified evidence

The shipping gate records the following local evidence for this source feature:

- `pnpm typecheck` passed, the full Vitest gate passed with 110 files and 852
  tests, and 7 opt-in tests were skipped. `pnpm build` also passed. The root
  release logs are `/private/tmp/pskills-source-shipping-tests.log` and
  `/private/tmp/pskills-source-shipping-build.log`.
- Focused source/runtime tests cover the route contract, all-source fanout and
  failure isolation, bounded timeout/query/result behavior, configuration
  revision changes, fixed-origin checks, and malformed source settings. The
  local core/worker fixture passes 3/3 full required-scan transfer cases.
- Local public search and resolve succeeded for nine adapters: the five public
  provider adapters `skillsmp`, `clawhub`, `skillhub-public`, `polyskill`, and
  `tessl`, plus all four curated GitHub adapters
  (`github-openai-skills`, `github-anthropics-skills`, `github-google-skills`,
  and `github-vercel-agent-skills`). This is local runtime metadata evidence,
  not hosted source acceptance.
- Native bytes were acquired locally for one Tessl skill (`tessl-create@1.0.5`,
  one file), one ClawHub release (`wpank/e2e-testing-patterns@1.0.0`, three
  files), and one PolySkill release (`@proreach/outreach@1.0.2`, three files).
  The PolySkill helper verifies the complete native JSON digest, emits the
  supported original files plus the generated `SKILL.md` wrapper, retains tools
  as JSON data, and omits adapter declarations. The ClawHub worker verifies its
  version manifest and the bounded `_meta.json` exception above.
- The published [v0.4.0 release](https://github.com/andymac4182/private-skills/releases/tag/v0.4.0)
  at tag `84f712720dba74508d56f0bcb532393dad24324d` passed fresh-download
  checksum/member-shape verification for all four assets, the release verifier,
  and the Mac arm64 smoke check. Linux QEMU and Windows Wine evidence remain
  nonnative; native CI is waived and no native Linux or Windows CI pass is
  claimed. The separate local Mac source-selector alias install/update/verify
  fixture preserved physical provenance and `sourceSelectors`.
- The source-capable web/API revision
  v0.4.0 at tag `84f712720dba74508d56f0bcb532393dad24324d` produced READY
  Git-linked deployments for registry (`dpl_BZ16uezNRrXDVyQgK8uRqvbtvPHh`),
  builder (`dpl_3uZbigT5xiku53WYMsMxYoXhx7r3`), and upload-reviewer
  (`dpl_3CSVps6nbgFeMb4tG2bnZdw7g64J`); all three reported health 200. This
  proves deployment reachability only. Authenticated source GET/resolve,
  including hosted ClawHub proof, and hosted source acceptance remain pending.

## Remaining hosted and conditional acceptance

The following are still deployment or scope boundaries, rather than missing
local source-contract work:

- Run authenticated search, resolve, and install checks through the composed
  target runtime. The source-capable READY deployments and the Sep13 healthy
  unauthenticated browser check establish reachability only; they do not
  provide this new authenticated mutation proof.
- Hosted ClawHub proof is currently blocked: an approved production environment
  export completed, but `PSKILLS_BOOTSTRAP_TOKEN` was empty. The full export and
  temporary files were removed; no authenticated source request or import
  occurred. Supported credential retrieval did not yield a usable bootstrap
  token, so hosted import remains unverified.
- Configure and exercise the four conditional sources when their deployment
  inputs are available: `skills-directory` (`SKILLS_DIRECTORY_API_KEY`),
  `skillhub-pro` (`SKILLHUB_API_KEY`), `github-code-search` (`GITHUB_TOKEN` or
  `GH_TOKEN`), and `github-custom` (the administrator repository/ref allowlist).
  Their absence is an explicit unavailable/conditional state and does not block
  the verified public adapters.
- Capture hosted provider rate/error behavior, tenant and principal isolation,
  credential secrecy, source-origin enforcement, and no-execution evidence;
  repeat representative native/provider imports through the deployed
  canonical-bundle, required-scanner, policy, authorization, and immutable
  transfer path. The local 3/3 fixture establishes the component handoff.

The source catalog can ship as a local implementation with these hosted and
conditional boundaries recorded. It must not be described as a new hosted
provider launch, or as completion of the separate C1, M6, or M7 milestones,
until their own evidence is complete.
