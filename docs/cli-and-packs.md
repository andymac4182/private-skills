# CLI, skill formats, packs, and locks

This document specifies the proposed `pskills` v1 interface and records the
current skills.sh install syntax. The Rust CLI supports the original complete
skills.sh ID/URL plus `--feed`; broader protocol parity and a published release
remain separate acceptance work. Sources were checked on 9 September 2026.

## Distribution and language

Use Rust for standalone Windows, macOS and Linux executables, with AMD64 and ARM64 release artifacts. Normal registry installs require no Rust compiler, Cargo, Node, Python, Git, Docker, WSL or administrator access. Publish checksums and verifiable release provenance; native OS signing depends on configured signing identities. Test released artifacts on real operating systems, documenting any architecture that only has build/emulation coverage. Rust documents support by target triple and tier; set minimum OS versions and native dependency requirements for the tested binaries. [Rust platforms](https://doc.rust-lang.org/rustc/platform-support.html)

Use a Cargo workspace with a thin `pskills-cli` binary crate and a reusable `pskills-core` crate for protocol, installation, ownership, and recovery. Commit Cargo.lock, pin the toolchain, and define a minimum supported Rust version during M0. Share language-neutral JSON Schema/OpenAPI contracts and conformance fixtures with the TanStack/Nitro TypeScript server; generate or validate Rust serialization against those contracts. Run formatting, Clippy, unit/contract tests, and native installation tests in CI. Cargo workspaces share a lockfile and support workspace-wide commands. [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html)

## Skill identity and compatibility

Preserve the standard skill directory: `SKILL.md` containing YAML frontmatter and Markdown, plus supporting files. Validate required `name`/`description`, naming constraints and relative references. Keep registry versions, access control, provenance and scan decisions outside skill content. This registry and pack protocol is an application extension to the content standard. [Agent Skills specification](https://agentskills.io/specification)

`@team/review@1.2.0` means namespace `team`, skill `review`, release `1.2.0`. Namespace is distinct from organization: internal identity also includes organization, registry origin and resource kind. Published releases are immutable; changing content requires another version. Channels resolve to exact releases. Source-only imports use immutable source revisions and digests, without fabricated semantic versions. [SemVer](https://semver.org/)

Initial adapters:

| Target | Project directory | User directory |
| --- | --- | --- |
| Codex | `<project>/.agents/skills` | `<home>/.agents/skills` |
| Claude Code | `<project>/.claude/skills` | `<home>/.claude/skills` |
| Universal | `<project>/.agents/skills` | Explicit user-selected skills root |

These Codex and Claude locations follow their native documentation. Examples: `/Users/alex/.agents/skills`, `/home/alex/.agents/skills`, and `C:\Users\Alex\.agents\skills`; resolve home through OS APIs. Universal is a directory convention, not a claim that every agent discovers it. Confirm discovery in real-agent tests before shipping; Cursor and Copilot follow a compatibility spike. [Codex locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills), [Claude locations](https://code.claude.com/docs/en/skills#choose-where-skills-load)

Preserve agent-specific metadata without enabling extra products. Claude reserves `synced` and can treat a skill containing `.claude-plugin/plugin.json` as a plugin with hooks/MCP capabilities. Reject that reserved destination and plugin-enabling bundles in its adapter; broader artifact admission must uphold the product's no-plugin-install boundary. Skill runtime portability remains separate from CLI portability. [Claude skill rules](https://code.claude.com/docs/en/skills#choose-where-skills-load)

## Command reference

| Purpose | Proposed commands |
| --- | --- |
| Authentication | `pskills login --registry <url>`, `logout`, `whoami` |
| Registry configuration | `pskills registry add/list/remove` |
| Discovery | `pskills search`, `show @team/review`, `versions @team/review` |
| Installation | `pskills install @team/review@1.2.0 --agent codex` or `pskills install <full-source-id-or-exact-supported-url> --feed <feed> --agent codex` |
| Reproduction | `pskills install --frozen-lockfile` |
| Maintenance | `pskills list`, `update`, `outdated`, `remove`, `verify`, `doctor` |
| Authoring | `pskills init`, `validate`, `publish` |
| Packs | `pskills pack show/install/update/remove/validate/publish` |
| Generic approved upstream import | `pskills import <source> --skill <path>` (advanced mapping-controlled path) |
| Scan evidence | `pskills scan status/report <release>` |

Default to project scope; user-wide installation requires `--global`. Select adapters explicitly and record them in project intent. Support `--dry-run`, `--json`, `--non-interactive` and documented exit codes. Progress uses stderr; JSON results use stdout. Unresolved choices fail in non-interactive mode. Scan commands inspect server-side work; installing does not require local scanners.

The built-in `skills-sh` path accepts the original complete source ID or exact
supported skills.sh URL plus an optional `--feed`; if omitted, the configured
default feed is selected. The CLI does not accept a feed alias as a substitute
for the source ID. The server derives its source reference only after verifying
origin/repository/exact path or a well-known scoped identity; that reference is
provenance/lock metadata, not a supported direct CLI input. Install continues
to use the original skills.sh ID/URL plus the optional `--feed`.
The operation does not require a per-source mapping, private alias, or
caller-supplied private name/version. Unknown or disabled feeds fail before
catalog access. A reader with install and explicit `proxy:resolve` permission
may start a bounded cold pullthrough or install an approved warm release; the server performs source resolution, validation,
scanner/policy admission, and cache selection. Generic upstream imports still
require an administrator's explicit mapping or source policy. All downloads
pass through registry authorization and policy; server errors, required
scanner failures, or blocked scans never cause a direct-upstream fallback.
Existing Vercel `skills` workflows inform familiarity, but this is not a promise
of protocol or drop-in CLI compatibility, including unmodified `npx skills`
behavior. [Vercel skills CLI](https://github.com/vercel-labs/skills)

## Packs and deterministic locks

A pack draft uses the following shape:

```json
{
  "schemaVersion": 1,
  "kind": "pack",
  "name": "@team/web",
  "version": "1.0.0",
  "description": "Web engineering skills",
  "skills": [
    { "ref": "@team/review", "version": "^1.2.0" },
    { "ref": "@team/accessibility", "version": "2.0.1" }
  ]
}
```

Publishing resolves every range and freezes exact member releases and digests. Updating membership requires a new pack release. V1 excludes nested packs and implicit skill dependencies.

A published v1 pack belongs to one registry/organization, including any locally mirrored upstream members. A project may use several registries: the CLI partitions the plan by origin/organization, obtains separate authorizations, and completes all final validations before activation. Each registry receives only its own member metadata and credentials; failure anywhere prevents activation of the combined operation.

`pskills.json` records requested direct skills, packs, version constraints and adapters. `pskills.lock.json` records exact releases/source revisions, registry origins, artifact/tree digests and each member's owners: direct installation or pack identities. For a `skills-sh` member, the lock retains the selected feed membership, complete original external ID/source URL, verified canonical source identity when available, and server-resolved immutable revision; it never substitutes a mandatory feed alias or an invented upstream SemVer. Snapshot-only metadata records its unresolved status and does not invent a physical path. Keep tokens, download URLs, timestamps and machine-specific absolute paths out of committed locks. A separate local journal records installed paths and per-file hashes. This distinct filename avoids overwriting Vercel's existing `skills-lock.json`. [Vercel lock implementation](https://raw.githubusercontent.com/vercel-labs/skills/main/src/local-lock.ts)

Resolve a complete pack before writes. Every member must be authorized and policy-approved. Allow one active version per skill identity and target scope; incompatible direct/pack requirements fail with an owner-by-owner explanation. Distinct skills sharing a destination name also fail. V1 never rewrites names or introduces aliases.

Removing a pack removes its ownership only; shared members remain until their final owner is removed. Updates preview additions, removals, version changes and scan decisions. Frozen installation never re-resolves or substitutes versions; a revoked member causes failure and remediation guidance.

## Installation and recovery

For a full skills.sh ID selected through a configured feed, the first install
starts or joins one server-side pullthrough operation. The server fetches
detail/source bytes into quarantine,
validates the complete bundle, runs all required scanners and policy checks,
and stores only an approved immutable release. A later warm install uses the
approved registry cache without another upstream lookup after a fresh
actor-bound authorization. Concurrent cold requests for one tenant, external
identity, and resolved revision join one operation and produce one fetch,
scanner set, and sealed artifact. An explicit update or refresh rechecks the
source; a failed recheck is reported and never relabels an older cache entry as
fresh. Download approved bytes into a content-addressed cache, verify the
archive digest, extract into staging, validate the file manifest and tree
digest, then activate. Use the versioned canonical digest contract; preserve
file bytes and line endings. Copy by default so Windows needs no symlink
privileges.

Consume the registry's provider-neutral transfer descriptor: either an approved private signed URL or an authenticated gateway URL with narrowly scoped transfer headers. Do not assume S3/Vercel URLs, always-available range requests, or direct storage signing. Forward only descriptor-authorized headers to its exact origin, never the registry session token. Files SDK runs on the server/gateway; the Rust CLI contains no storage-provider SDK or credentials.

Apply the [proxy extraction defenses](proxy.md#fetch-and-extraction-defenses) again locally, including path traversal, links, Windows reserved names, case/Unicode collisions, expansion limits and trailing dots/spaces. Never execute install scripts or package managers.

Stage replacements on each destination volume, take an installation lock and record a durable journal. Replace directories with rollback/recovery. Multiple pack directories cannot switch through one atomic rename; the guarantee is a recoverable logical operation. Detect disk-full, locked-file and interrupted-write failures while retaining the prior installation.

Compare owned-file hashes before update or removal. Preserve modified and unmanaged files; an explicit backup-and-replace workflow returns its backup location. Uninstall follows recorded ownership, never arbitrary server-supplied deletion paths. Test spaces, non-ASCII usernames, long paths and concurrent commands.

V1 installs require online policy authorization even for locally cached bytes. Obtain an actor-bound install authorization for the full resolved plan, including immutable release/source IDs, pack version/manifest identities, desired member digests and owners. Immediately before activation, revalidate every member and the pack-level decision; a revoked pack cannot be bypassed by cached members or an older successful resolution. Authorization expires after 60 seconds and is renewed only after repeating checks. There is a bounded race between the final server check and local filesystem activation; revocation cannot atomically retract bytes already downloaded or instructions already loaded by an agent. A future offline mode needs an explicit policy and expiring approval receipt.

## Credentials and verification

Use established browser/device authorization with expiring codes and no embedded client secret. Store interactive credentials in OS keyrings; support scoped environment/stdin tokens for headless CI. If a keyring is unavailable, explain configuration instead of silently storing plaintext. [OAuth device flow](https://www.rfc-editor.org/rfc/rfc8628)

Bind credentials to the exact registry origin. Separate read, publish and administrator scopes; redact logs and never commit tokens. Registry credentials never flow upstream or across arbitrary redirects. Server-side GitHub App credentials stay on the server, and explicit namespace routing prevents public fallback.

Reader install permission plus explicit `proxy:resolve` is required to request
a cold skills.sh pullthrough or consume its resulting approved warm cache entry,
subject to the registry's current authorization and scanner evidence. The
default reader/publisher grant remains pending explicit product approval and
production verification; owner/admin grants may exercise the route. It does not grant source-policy,
scanner, publication, or mapping changes. Catalog browsing remains metadata
only; the CLI receives bytes only through an authorized transfer after the
registry has admitted the exact candidate.

Release acceptance requires successful private installs and frozen pack reproduction on all three operating systems; real Codex/Claude discovery; shared-member removal; collision and local-edit protection; crash recovery; archive/digest rejection; and tests proving that revoked credentials, stale required scans and unauthorized namespaces cannot obtain fresh artifact access. Preserve existing third-party lockfiles and unrelated skills throughout.
