# Install into a separate directory

The Rust `pskills` client accepts an absolute skill root with the global
`--directory` option. The option points at the directory that will contain the
installed skill folders. It does not add another `.agents/skills` or
`.claude/skills` segment, and it does not change the home directory or the
credential store.

The directory may be new. The client creates the missing directory when it
prepares local installation state. The path must be absolute. Paths containing
`..`, an existing file, or a user-created symbolic-link component are rejected;
the client canonicalizes the existing part of the destination before it writes
files.

Use a different absolute root for each isolated installation profile. These
examples use the `universal` adapter, which has the same default root as the
Codex adapter but records a separate adapter target in the lock file.

## Absolute paths by operating system

macOS:

```console
pskills --directory /Users/<you>/private-skills --agent universal install @team/review@1.2.3
```

Linux:

```console
pskills --directory /home/<you>/private-skills --agent universal install @team/review@1.2.3
```

Windows PowerShell:

```powershell
.\pskills.exe --directory 'C:\Users\<you>\private-skills' --agent universal install '@team/review@1.2.3'
```

Replace the examples with a real absolute path for the current account. The
CLI receives the path from the shell; use its fully expanded absolute form
rather than relying on a shell-specific home-directory abbreviation.

## Agent and scope selection

Without `--directory`, the client resolves the root from the current working
directory, the selected agent, and the selected scope:

| Scope | `--agent codex` or `--agent universal` | `--agent claude` |
| --- | --- | --- |
| Project (default) | `<current-directory>/.agents/skills` | `<current-directory>/.claude/skills` |
| Global (`--global`) | `<home>/.agents/skills` | `<home>/.claude/skills` |

`codex` is the default agent. `universal` resolves to the same `.agents/skills`
root as `codex`; it is not a fan-out install into both agent roots. It records
`universal` in the lock target, so a frozen lockfile made for `codex` is not
silently reused by a `universal` command. `claude` selects `.claude/skills`
and applies the Claude adapter's bundle checks, including its reserved and
plugin-enabling paths.

When `--directory` is present, that absolute path is the root for every agent
and for either scope. `--global` still selects global lock semantics, but it
does not append a home or agent directory to the explicit path. The agent
selection continues to affect the lock target and adapter validation.

The local state files are placed as follows:

| Invocation | Lock file | Journal file |
| --- | --- | --- |
| Default project root (`.agents/skills` or `.claude/skills`) | `<project>/pskills.lock.json` | `<root>/.pskills-journal.json` |
| Explicit root with project scope | `<root>/pskills.lock.json` | `<root>/.pskills-journal.json` |
| Global scope, including an explicit root | `<root>/.pskills.lock.json` | `<root>/.pskills-journal.json` |

The default project roots are recognized specially so their lock belongs to
the project. An explicit path that is not the conventional `.agents/skills` or
`.claude/skills` location keeps its project lock inside the custom root. An
installed skill is activated at `<root>/<skill-name>`.

## Isolated local workflow

Run every local command with the same directory, agent, and scope. The
registry login is independent of this choice; authenticate to the registry
before installing and keep its token out of command history and documentation.

```console
# Install one exact version into the selected root.
pskills --directory /Users/<you>/private-skills --agent universal install @team/review@1.2.3

# List the journal entries for that root.
pskills --directory /Users/<you>/private-skills --agent universal --json list

# Recompute each installed tree and fail if any entry has changed.
pskills --directory /Users/<you>/private-skills --agent universal --json verify

# Remove the direct ownership for the skill from that same root.
pskills --directory /Users/<you>/private-skills --agent universal remove @team/review
```

`list` and `verify` read the local journal and do not require a registry
argument. `remove` can identify a unique direct owner from the local lock; when
the same skill was installed from more than one registry, pass the same
registry origin used for the install with `--registry` so the owner is
unambiguous. Keep the directory and agent options identical to the install.

The same commands on Windows use the same flags and a Windows absolute path:

```powershell
.\pskills.exe --directory 'C:\Users\<you>\private-skills' --agent universal --json list
.\pskills.exe --directory 'C:\Users\<you>\private-skills' --agent universal --json verify
.\pskills.exe --directory 'C:\Users\<you>\private-skills' --agent universal remove '@team/review'
```

## Frozen lockfile installs

`--frozen-lockfile` prevents selecting a new version. It requires a matching
registry, agent, and scope target in the local lock, then checks the resolved
version, artifact digest, skill name, and installed tree digest before
activation. It still contacts the registry to resolve and transfer the pinned
artifact, so it is a reproducibility check rather than an offline install.

Create or update the lock entry first, then repeat the install with the same
absolute root and an exact version:

```console
pskills --directory /Users/<you>/private-skills --agent universal install @team/review@1.2.3
pskills --directory /Users/<you>/private-skills --agent universal --frozen-lockfile install @team/review@1.2.3
```

The frozen command fails if the lock has no matching entry, if the requested
version differs from the lock, or if the registry resolution or transferred
tree has changed. Use the same `--global` flag that was used to create the
lock target when the custom root is paired with global scope.

## Packs in a separate root

Pack installation uses the same root, agent, scope, lock, and journal rules as
single-skill installation. It resolves every member, verifies the member
digests, and activates all members as one local transaction. The pack and its
member ownership records are written to the same lock file; removing a pack
removes only that pack's ownership, so a member shared by another owner stays
installed.

```console
pskills --directory /Users/<you>/private-skills --agent universal pack install @team/starter-pack@1.0.0
pskills --directory /Users/<you>/private-skills --agent universal --frozen-lockfile pack install @team/starter-pack@1.0.0
pskills --directory /Users/<you>/private-skills --agent universal pack remove @team/starter-pack
```

The frozen pack command checks the locked pack version and manifest digest as
well as each member's version, artifact digest, and tree digest. `pack list`,
`pack show`, and `pack publish` are registry or source-file operations; use
the directory options on `pack install` and `pack remove` when they should
operate on the isolated local root.

The behavior described here is implemented by
[`crates/pskills-core/src/paths.rs`](../crates/pskills-core/src/paths.rs),
[`crates/pskills-core/src/install.rs`](../crates/pskills-core/src/install.rs),
and [`crates/pskills-cli/src/main.rs`](../crates/pskills-cli/src/main.rs).
