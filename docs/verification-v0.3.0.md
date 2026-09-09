# v0.3.0 verification checkpoint

Date: 2026-09-10. Status: implementation in progress; not a production acceptance claim.

## Implemented scope

- Authenticated skills.sh listing, search, Official, detail, external audit, and governed import routes; Rust directory commands and cloud views.
- Topics link to upstream topic pages and launch clearly labeled internal searches. Unlisted pack links support metadata preview; existing private packs remain installable. Automatic external pack migration is deferred.
- Import acquisition supports catalog snapshots, immutable GitHub resolution, and bounded well-known discovery. External identity and digests survive private release and CLI lock serialization.
- ComputeSDK abstracts the hosted sandbox boundary. Vercel is the qualified provider; other providers require conformance evidence before enablement.

## Evidence collected

- Directory route tests cover cold queueing, warm reuse, authorization, exact source metadata, and a source found on catalog page 19.
- End-to-end fixtures exercise the registry, worker, acquisition, and storage together: scan approval precedes resolution, warm requests avoid upstream fetches, and revocation or a missing required scanner denies installation.
- Acquisition regressions cover bounded decompression, archive integrity, symlinks, public CDN artifacts without catalog credentials, and private-network rejection.
- Real Vercel sandboxes through ComputeSDK scanned benign and inert malicious fixtures using the pinned scanner snapshot. Both completed and were stopped; the malicious fixture produced findings.
- Desktop 1280px and mobile 390px browser checks found no overflow or browser errors. These checks used disabled integrations and verify loading/error states and navigation, not populated live catalog data.
- The full TypeScript suite passes: 178 tests passed and two environment-dependent tests skipped. Both application TypeScript checks pass.
- Rust checks pass: four CLI tests, 23 core tests, and 11 installation safety tests, including the shared standard-skill metadata fixture.
- [CI run 34389979645](https://github.com/andymac4182/private-skills/actions/runs/34389979645) passed for `be59ece45ea574a7398974076f34d1c23dce83c6`: web checks/builds, native macOS ARM64/Linux x64/Windows x64 Rust checks and binary smoke tests, and the Node container build. This evidence is specific to that revision; later changes require their own checks.
- Final Vercel and Cloudflare builds pass with the YAML metadata parser. Vercel output verification resolves all four sandbox SDKs from an isolated directory and validates 29 relocated output links.

## Remaining acceptance gates

Live skills.sh authentication is disabled. Automatic approval review rejected sending this project's Vercel OIDC token to the skills.sh API and adding the credential callback without explicit destination authorization. No workaround was applied. Full catalog pagination, representative live imports, and the v0.3 production deployment remain unverified.

The existing v0.2 production deployment remains available. Git-triggered deployment additionally requires the account owner's GitHub Vercel app security-key step. CLI deployment evidence does not satisfy that separate gate.

See [completion criteria](completion-criteria.md), [catalog design and review](skills-sh.md), and [sandbox provider contract](sandbox-providers.md) for the full remaining scope.
