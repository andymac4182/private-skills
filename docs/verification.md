# Verification record

Verified on 9 September 2026. This record separates working runtime checks from deployment to a cloud account.

## Automated checks

- TypeScript: `tsc --noEmit` passes.
- Vitest with real filesystem storage enabled: **62 passed, 1 optional PostgreSQL test skipped** across 15 files.
- The PostgreSQL repository suite also passed separately against a real PostgreSQL 17 container, including serialized concurrent transactions.
- Rust: formatting, Clippy with warnings denied, and **26 tests** pass. Tests cover batch preflight, shared owners, changed files, digest pins, lock contention, interrupted activation, and journal/lock recovery.
- [Native CI](https://github.com/andymac4182/private-skills/actions/runs/34341248542) passed on Linux x86_64, macOS arm64, and Windows x86_64, including tests, builds, and executable help/version smoke checks. The same run built the API and worker container images.
- [Scanner CI](https://github.com/andymac4182/private-skills/actions/runs/34341248538) built and exercised all three pinned scanner images successfully.

## Browser, server, and CLI

The browser was exercised against the actual TanStack/Nitro server with isolated test data and private filesystem storage:

1. Signed in with a token and received a browser session.
2. Selected a real directory containing `SKILL.md`, published through the form, and saw the queued review.
3. Processed the published bytes with the worker and observed the catalog result.
4. Created an exact-version pack through the browser.
5. Enabled required SkillsGuard and disabled unscanned distribution through the policy screen.
6. Rescanned through the browser; the normal Docker worker returned complete, clean evidence and the API resolved the approved release.
7. Inspected the rendered dashboard and catalog; browser console showed no errors or warnings during the checked publication flow.

The built Node production artifact was then run directly. The compiled macOS CLI installed a pack under the current required-scanner policy, verified the installed tree, and reinstalled with `--frozen-lockfile` with `changed:false`. A deliberately changed lockfile digest was rejected without changing installed bytes. Adding a direct owner and removing the pack preserved the shared skill and its verified bytes.

The TS and Rust canonical bundle vector is identical:

```text
artifact: sha256:889118ca6b91622b659ad5f157391c334427f24077c04f71164212667938deff
tree:     sha256:5bb2aafb4e6caa1d0743e36fbe5a23e5a463d87f21149bdc1efbdf5f3c627c9f
```

## Proxy and scanner behavior

The live GitHub acquisition test downloaded the complete `anthropics/skills` `skills/frontend-design` tree at commit `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f`. It stored two files in a 26,197-byte canonical artifact with digest `sha256:e161f07989724b29b1c1b9eee9416ea69747dae664f3c67d6da01af87a59ac48`.

The native `pskills proxy` command completed both a warm cached installation and a cold acquisition → worker approval → operation wait → installation. Warm resolution kept the artifact digest and operation count unchanged. Automated tests check duplicate pending requests, immutable-source conflicts, and required provenance fields. These GitHub acquisition fixtures used the explicit development unscanned policy; scanner enforcement was tested separately below.

Real, network-isolated scanner containers analyzed benign and inert malicious text fixtures:

| Scanner | Benign findings | Malicious findings | Evidence status |
| --- | ---: | ---: | --- |
| Cisco Skill Scanner 2.1.0 | 0 | 4 | Degraded: this release does not expose complete analyzed-file coverage |
| NVIDIA SkillSpector 2.11.1 | 0 | 2 | Degraded: offline OSV fallback is incomplete evidence |
| SkillsGuard source build at `7badb5157f8f9e4dd9ee2acb6e0129636e3147e3` | 0 | 15 | Completed for the supported one-file fixtures |

The real registry and normal Docker worker were also tested together with required SkillsGuard: a clean skill resolved with HTTP 200; the inert malicious skill became `quarantined` and resolution returned HTTP 404. No fixture instructions or skill scripts were executed.

## Storage, edge runtime, and recovery

- Real Files SDK filesystem roundtrip and canonical-byte verification passed.
- Real Files SDK S3-compatible put/get/verified-get/delete/missing-object checks passed against disposable MinIO. See [storage evidence](verification-storage.md).
- The complete Node and Vercel outputs built, and isolated output directories performed authenticated API initialization without relying on the checkout's ancestor `node_modules`.
- Cloudflare's native Wrangler/workerd runtime passed authenticated health, capabilities, resolution, authorization, transfer grant, and a 285-byte digest-checked download through HTTP state/blob gateways backed by Files SDK.
- Native workerd upload also passed: publish → queued operation → exact stored artifact readback, plus direct authenticated gateway POST/GET. This caught and fixed both unsupported redirect behavior and receiver-bound `fetch` behavior.
- A durable recovery test copied quiescent file metadata and real Files SDK object trees, opened fresh services at another origin, resolved the restored skill and pack, and downloaded the original digest. Revoking the restored release denied its transfer while the original metadata and transfer remained unchanged.

See [platform compatibility](../deployment/platform-compatibility.md) for the edge harness and build commands.

## Explicit release boundaries

- No live Vercel or Cloudflare account deployment was created. Their build/native-runtime checks do not establish cloud credentials, routes, provider permissions, or a Git-triggered cloud deployment.
- Nitro portability requires durable backing services. Edge targets use authenticated HTTP gateways and an external scanner worker; filesystem, direct PostgreSQL, and scanner subprocesses belong on a compatible Node/worker host.
- Filesystem and S3-compatible storage have live conformance evidence. Other Files SDK providers require their optional SDK peers, credentials, and provider-specific deployment tests.
- The initial native archives cover Linux x86_64, macOS arm64, and Windows x86_64. Other architectures can build from Rust source but are not claimed as release-tested targets.
- Authentication is configured bearer tokens and signed browser sessions. OIDC/device login is not implemented.
- Inline HTTP uploads default to 3,000,000 bytes; large multipart uploads are not implemented.
- Policy revisions invalidate prior approvals. Skills require rescanning; packs require a new immutable version under the current policy.
- Local deployment-injected scan hooks work and fail closed. Automatic outbound webhook dispatch remains disabled after automatic approval review rejected delivery of job metadata to unspecified external destinations.
