# Verification record

This file records implementation evidence, not a claim that every hosting/provider combination has been deployed.

## First working checkpoint — 2026-09-09

- TanStack/Nitro development server: browser sign-in page and live health indicator verified.
- Authenticated API: `/health`, `/v1/me`, and private catalog returned 200; anonymous registry requests rejected by integration tests.
- Published `@team/hello@0.1.0` through HTTP, processed it with the real worker under explicitly unscanned development policy, and resolved the approved immutable artifact.
- Built native macOS Rust CLI: health, whoami, install, verify, and list succeeded against the running server. Installed artifact digest matched the shared TS/Rust canonical vector.
- `FILES_SDK_LIVE=1 pnpm check`: TypeScript passed; 51 tests passed and one optional live PostgreSQL test skipped.
- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`, and `cargo test --workspace --all-targets --locked` passed (7 Rust tests).
- Node, Vercel, and Cloudflare builds succeeded. Isolated Node/Vercel output authenticated initialization was exercised without ancestor node_modules. These are build/runtime checks, not hosted deployment evidence.
- Runtime and worker Docker images built; local container API health passed. Enabled scanner execution requires a controller with access to an isolated executor.

## Acceptance still in progress

Native Windows/Linux CI, live upstream cold/hot proxy, real three-engine scan acceptance, end-to-end built edge behavior, pack/recovery scenarios, and final regression review are still being checked.

Automatic outbound webhook dispatch is disabled. Automatic approval review rejected delivery of registry job metadata to unspecified external destinations. Deployment-injected in-process stage hooks are implemented; required hook failures deny approval.
