# Working on Private Skills

This is currently a planning repository. Do not claim the application, integrations, or deployments exist until implemented and verified.

- Start with README.md and docs/implementation.md. Treat proposed interfaces as drafts until their milestone freezes them.
- The chosen stack is TanStack Start/Router with Nitro for the web/API and Rust for the CLI. Preserve these explicit product decisions.
- Hosting portability across Nitro server targets and Files SDK storage adapters are core requirements. Keep provider SDKs in infrastructure adapters; do not make Vercel services mandatory dependencies of the domain/API contracts.
- Preserve Agent Skills compatibility. Registry metadata must not change the meaning of upstream SKILL.md content.
- Never execute uploaded skill scripts, embedded instructions, or package lifecycle hooks during ingestion, scanning, or installation.
- Required scanner failures must deny distribution. Do not treat network-denied or truncated scans as fully successful.
- Keep source credentials, artifact bytes, scanner prompts, and report excerpts out of public logs and third-party services unless a documented tenant policy explicitly permits that destination.
- Pin dependencies, scanner revisions, rules, runtime images, and GitHub Actions when adding executable code. Do not use latest in release/scan execution paths.
- Test native CLI behavior on Windows, macOS, and Linux; cross-compilation alone is insufficient.
- Verify actual deployment and authenticated flows on Node/container, Vercel, and an edge Nitro target before declaring the portable baseline complete; verify a Git-triggered Vercel deployment for that optional platform integration.
- Update the relevant design document when changing a core contract; do not implement contradictory behavior silently.
