# Working on Private Skills

This is currently a planning repository. Do not claim the application, integrations, or deployments exist until implemented and verified.

- Start with README.md and docs/implementation.md. Treat proposed interfaces as drafts until their milestone freezes them.
- Preserve Agent Skills compatibility. Registry metadata must not change the meaning of upstream SKILL.md content.
- Never execute uploaded skill scripts, embedded instructions, or package lifecycle hooks during ingestion, scanning, or installation.
- Required scanner failures must deny distribution. Do not treat network-denied or truncated scans as fully successful.
- Keep source credentials, artifact bytes, scanner prompts, and report excerpts out of public logs and third-party services unless a documented tenant policy explicitly permits that destination.
- Pin dependencies, scanner revisions, rules, runtime images, and GitHub Actions when adding executable code. Do not use latest in release/scan execution paths.
- Test native CLI behavior on Windows, macOS, and Linux; cross-compilation alone is insufficient.
- Verify an actual Git-triggered Vercel deployment before marking deployment automation complete.
- Update the relevant design document when changing a core contract; do not implement contradictory behavior silently.
