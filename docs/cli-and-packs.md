# CLI, skill formats, packs, and locks

This document specifies the proposed `pskills` v1 interface. Commands are illustrative; the CLI is not implemented yet. Sources were checked on 9 September 2026.

## Distribution and language

Use Go for standalone Windows, macOS and Linux executables, with AMD64 and ARM64 release artifacts. Normal registry installs require no Node, Python, Git, Docker, WSL or administrator access. Publish checksums and verifiable release provenance; native OS signing depends on configured signing identities. Test released artifacts on real operating systems, documenting any architecture that only has build/emulation coverage. Go supports these target combinations. [Go platforms](https://go.dev/doc/install/source)

TypeScript would share more implementation with the Vercel API, but ordinary npm distribution requires Node. Node can bundle standalone executables; its documented mechanism remains under active development and adds packaging constraints. Rust also supports the target platforms, but introduces another language without a clear advantage for this predominantly HTTP/filesystem client. The Go choice is an engineering recommendation, not a benchmark result. Share versioned JSON Schema/OpenAPI contracts and conformance fixtures with TypeScript. [Node executables](https://nodejs.org/api/single-executable-applications.html), [Rust platforms](https://doc.rust-lang.org/rustc/platform-support.html)

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
| Installation | `pskills install @team/review@1.2.0 --agent codex` |
| Reproduction | `pskills install --frozen-lockfile` |
| Maintenance | `pskills list`, `update`, `outdated`, `remove`, `verify`, `doctor` |
| Authoring | `pskills init`, `validate`, `publish` |
| Packs | `pskills pack show/install/update/remove/validate/publish` |
| Approved upstream import | `pskills import <source> --skill <path>` |
| Scan evidence | `pskills scan status/report <release>` |

Default to project scope; user-wide installation requires `--global`. Select adapters explicitly and record them in project intent. Support `--dry-run`, `--json`, `--non-interactive` and documented exit codes. Progress uses stderr; JSON results use stdout. Unresolved choices fail in non-interactive mode. Scan commands inspect server-side work; installing does not require local scanners.

Imports must match approved server mappings. All downloads pass through registry authorization and policy; server errors or blocked scans never cause a direct-upstream fallback. Existing Vercel `skills` workflows inform familiarity, but this is not a promise of protocol compatibility. [Vercel skills CLI](https://github.com/vercel-labs/skills)

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

`pskills.json` records requested direct skills, packs, version constraints and adapters. `pskills.lock.json` records exact releases/source revisions, registry origins, artifact/tree digests and each member's owners: direct installation or pack identities. Keep tokens, download URLs, timestamps and machine-specific absolute paths out of committed locks. A separate local journal records installed paths and per-file hashes. This distinct filename avoids overwriting Vercel's existing `skills-lock.json`. [Vercel lock implementation](https://raw.githubusercontent.com/vercel-labs/skills/main/src/local-lock.ts)

Resolve a complete pack before writes. Every member must be authorized and policy-approved. Allow one active version per skill identity and target scope; incompatible direct/pack requirements fail with an owner-by-owner explanation. Distinct skills sharing a destination name also fail. V1 never rewrites names or introduces aliases.

Removing a pack removes its ownership only; shared members remain until their final owner is removed. Updates preview additions, removals, version changes and scan decisions. Frozen installation never re-resolves or substitutes versions; a revoked member causes failure and remediation guidance.

## Installation and recovery

Download approved bytes into a content-addressed cache, verify the archive digest, extract into staging, validate the file manifest and tree digest, then activate. Use the versioned canonical digest contract; preserve file bytes and line endings. Copy by default so Windows needs no symlink privileges.

Apply the [proxy extraction defenses](proxy.md#fetch-and-extraction-defenses) again locally, including path traversal, links, Windows reserved names, case/Unicode collisions, expansion limits and trailing dots/spaces. Never execute install scripts or package managers.

Stage replacements on each destination volume, take an installation lock and record a durable journal. Replace directories with rollback/recovery. Multiple pack directories cannot switch through one atomic rename; the guarantee is a recoverable logical operation. Detect disk-full, locked-file and interrupted-write failures while retaining the prior installation.

Compare owned-file hashes before update or removal. Preserve modified and unmanaged files; an explicit backup-and-replace workflow returns its backup location. Uninstall follows recorded ownership, never arbitrary server-supplied deletion paths. Test spaces, non-ASCII usernames, long paths and concurrent commands.

V1 installs require online policy authorization even for locally cached bytes. Obtain an actor-bound install authorization for the full resolved plan, including immutable release/source IDs, pack version/manifest identities, desired member digests and owners. Immediately before activation, revalidate every member and the pack-level decision; a revoked pack cannot be bypassed by cached members or an older successful resolution. Authorization expires after 60 seconds and is renewed only after repeating checks. There is a bounded race between the final server check and local filesystem activation; revocation cannot atomically retract bytes already downloaded or instructions already loaded by an agent. A future offline mode needs an explicit policy and expiring approval receipt.

## Credentials and verification

Use established browser/device authorization with expiring codes and no embedded client secret. Store interactive credentials in OS keyrings; support scoped environment/stdin tokens for headless CI. If a keyring is unavailable, explain configuration instead of silently storing plaintext. [OAuth device flow](https://www.rfc-editor.org/rfc/rfc8628)

Bind credentials to the exact registry origin. Separate read, publish and administrator scopes; redact logs and never commit tokens. Registry credentials never flow upstream or across arbitrary redirects. Server-side GitHub App credentials stay on the server, and explicit namespace routing prevents public fallback.

Release acceptance requires successful private installs and frozen pack reproduction on all three operating systems; real Codex/Claude discovery; shared-member removal; collision and local-edit protection; crash recovery; archive/digest rejection; and tests proving that revoked credentials, stale required scans and unauthorized namespaces cannot obtain fresh artifact access. Preserve existing third-party lockfiles and unrelated skills throughout.
