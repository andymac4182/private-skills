# Product scope

## Goal and assumptions

Give a private team one trusted entry point for its own and upstream agent skills. An administrator decides which namespaces, sources, scanners, and policies are available; developers install a skill or an entire curated pack with a consistent CLI.

Initial assumption: one organization per deployment, with organization IDs throughout the data model so later hosted tenancy does not require removing access boundaries. GitHub is the first sign-in and upstream provider. The product repository is private under the owner's personal GitHub account. The chosen stack is TanStack Start/Router with Nitro for the web/API and Rust for the CLI. Hosting across Nitro server targets and Files SDK-backed storage are explicit product requirements.

## Required v1 capabilities

| Capability | User-visible behavior |
| --- | --- |
| Portable hosting | Deploy the web/API on any server-capable Nitro target; use external worker/gateway services where the target lacks native processes, durable disk, or sufficient transfer limits |
| Storage choice | Configure any existing or custom Files SDK backend that passes the private artifact contract; no domain/API rewrite or mandatory Vercel account |
| Private hosting | Signed-in readers browse permitted skills and download approved versions; private metadata and search results are access controlled too |
| Publishing | Publishers upload complete bundles, inspect validation/scan results, and publish an immutable version when policy allows |
| Proxy and skills.sh pullthrough | A tenant can configure multiple named feeds; the current `skills-sh` feed adapter selects a source by feed plus complete external ID (or a bare ID/URL through the configured default feed) without a per-source mapping or mandatory private alias. Clients receive only an approved registry artifact: cold requests validate/scan/cache under feed-aware provenance/ACLs, warm requests use the approved cache, and explicit refresh failures are surfaced. Unknown/disabled feeds fail before fetch. Verified source references are derived from the origin/repository/exact path or well-known scope; snapshot-only rows retain an explicit unresolved reference and feeds do not rename skills. |
| Packs | Maintainers release named, versioned collections; one install resolves a complete, pinned dependency set |
| CLI management | Login/logout, registries, search/show, publish, install/remove, update, list, outdated, verify, doctor, pack management, scan reports |
| Scanners | Administrators independently enable each of the three recommended engines, choose blocking/advisory mode, and see runtime and coverage |
| Extension hooks | Organization-owned scanner/policy hooks add checks at defined stages, with timeouts, authenticated results, and audit records |
| Revocation | Administrators revoke a version/digest; future resolutions and download authorizations fail, and the CLI reports affected installations on its next online check |

## Journeys

**Private skill author:** initialize a normal skills directory, validate it, publish `@team/review@1.2.0`, watch the ingestion job, review any findings, and see the approved immutable release in the catalog. A blocked release stays quarantined; no download URL is issued to ordinary readers.

**Developer:** run `pskills login --registry https://skills.example.com`, inspect a skill or pack, install it into an explicit project or user scope, and commit the project lockfile. Another machine can perform `pskills install --frozen-lockfile` and receive the identical artifacts.

**Developer:** select a configured feed and complete skills.sh catalog identity
such as source ID `vercel-labs/skills/find-skills`, then run the registry
install flow with the original ID/URL and optional `--feed`. The server may
return a verified source reference for display and lock metadata, but that
reference is not assumed to be a direct CLI input. The first request produces a progress job while the built-in adapter fetches,
validates, scans, and caches the candidate after verifying its source origin/
repository/exact path or well-known scoped identity; later authorized requests
use a matching approved cache without an upstream lookup. The original
external identity remains visible in provenance, and explicit refresh/update
failure does not make an older cache entry appear fresh.

**Proxy administrator:** configure a uniquely named feed with its `skills-sh`
origin, trust/credential settings, optional source restrictions, and readable
prefix metadata. The feed is a discovery list, not a source namespace. Map
`@vendor/*` to one approved upstream only when
using the generic/private proxy mode; that mapping is not a prerequisite for a
public catalog row. The first request produces a progress job while the
registry fetches and scans it. Later authorized requests use the feed-aware
cache. A new branch head or tag target produces a new source revision and scan
rather than replacing previously pinned bytes.

**Pack maintainer:** add named skill versions/ranges, review the resolved contents and scan status, then publish a pack version. That release freezes the whole graph. Updating a member requires a new pack release.

**Security administrator:** enable an engine in advisory mode for calibration, inspect differences, then make it required. Configuration creates a new policy revision, and artifacts lacking the required evidence become pending re-evaluation. Every exception identifies an exact digest/finding, approver, reason, and expiry.

## Web application areas

- Catalog with accessible namespaces, skills, packs, version history, provenance, and search.
- Skill/pack detail with files, license information, resolved members, human-readable version diff, scan summary, and installation command.
- Ingestion activity with fetch, validation, scan, and policy progress; retry and cancellation where safe.
- Quarantine and review queue with findings grouped by engine, bounded/redacted evidence, rescan, and explicit exceptions.
- Administration for memberships, roles, namespace permissions, upstream mappings, scanners, hooks, tokens, and audit logs.

Roles: owner manages the organization; administrator manages access, feed
configuration and optional source restrictions, and policies; publisher releases in granted namespaces;
reader installs approved releases and, when explicitly granted `proxy:resolve`,
may start a bounded cold skills.sh pullthrough; the default reader/publisher
grant remains pending product approval and production verification. Scanner
service identity can act only on assigned jobs. A reader
cannot change source restrictions, scanner policy, publication state, or
aliases. A publisher cannot approve their own policy exceptions unless
separately granted administrator authority.

## Explicit initial boundaries

No execution of skills, installation scripts, or dependency package managers. No public marketplace or billing system. No promise of drop-in compatibility with npm/pip or an undocumented third-party registry API. No automatic installation of MCP servers, agent settings, shell hooks, or arbitrary files outside supported skill directories. Nested packs and arbitrary HTTP/Git providers follow v1.

Scanner approval is evidence under a named policy, not a claim that an agent will execute the skill safely. Unknown/binary content, dynamic downloads, and unresolved references must be visible to policy and reviewers.
