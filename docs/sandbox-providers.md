# Sandbox provider adapters

`packages/sandbox-provider/src/index.ts` is the first provider adapter for the
scanner runtime. It exposes a small `SandboxSdk` shape that is compatible with
`packages/scanners/src/sandbox-executor.ts` while keeping the ComputeSDK
provider object behind a Node-only dynamic import boundary.

## Vercel adapter

The enabled provider is Vercel. A call to `createSandboxProvider` creates a
provider handle for one caller. It does not modify the ComputeSDK singleton,
register process-global providers, or enable provider fallback. The configured
`PSKILLS_SANDBOX_PROVIDER` value is read only when the configured loader is
created; any value other than `vercel` is rejected synchronously.

The runtime inputs are pinned to:

| Package | Required version |
| --- | --- |
| `computesdk` | `4.1.4` |
| `@computesdk/provider` | `2.1.5` |
| `@computesdk/vercel` | `1.7.33` |
| `@vercel/sandbox` | `3.2.2` |

The root dependency manifest and lockfile own those pins. The adapter accepts
version evidence from its module seam and records whether all expected versions
were verified, unknown, or mismatched. A known mismatch is rejected before a
remote sandbox is created; an unknown native version is recorded as unknown and
must be resolved by deployment verification before enabling a production scan.

The adapter passes the scanner's complete creation contract to
`@computesdk/vercel`: immutable image or snapshot source, vCPU resources,
timeout, `networkPolicy: 'deny-all'`, `persistent: false`, and the request
abort signal. It also configures `ports: []` and `daemonSsePort: false`; this
prevents the generic adapter from exposing its default daemon SSE port, which
the scanner does not need. It then calls the generated ComputeSDK sandbox's
`getInstance()` and verifies native metadata before returning it to the
scanner. The returned native bridge requires:

- argv command execution, detached command handles, logs, wait, and kill;
- byte-oriented file writes and reads, file stats, and directory creation;
- `networkPolicy: 'deny-all'`, `persistent: false`, the requested immutable
  image or snapshot, the requested timeout, and the requested vCPU count; and
- native `stop()` cleanup whose errors remain visible to the scanner.

The generic ComputeSDK `runCommand` and `destroy` methods are deliberately not
used. The Vercel provider implements the generic command method as `sh -c` and
buffers output; its generic destroy method catches cleanup errors. The scanner
needs native argv and native cleanup semantics, so capability verification fails
before staged files can be transferred when those controls are absent.

If the provider returns a remote sandbox but `getInstance()` fails, the adapter
attempts the generated provider's destroy method only as an orphan-cleanup
fallback. That upstream method may swallow its own errors, so the adapter
always throws a `cleanup-failed` error stating that cleanup is unverified. A
normal native handle never uses generic destroy; native `stop()` is preferred
and its failure propagates.

Operators may supply Vercel credentials explicitly as
`auth: { token, teamId, projectId }`. The complete object is required; partial
credentials are rejected. For ambient authentication, the adapter calls the
official `@vercel/oidc` request-scoped helper immediately before each sandbox
creation and validates the token's tenant claims. The helper token is not
cached. If the helper cannot obtain a token for the current request, identity
resolution fails closed with `invalid-auth`; the adapter does not fall back to
a process-global PAT or to an implicit `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/
`VERCEL_PROJECT_ID` environment trio. `allowEnvironmentAuth: false` disables
ambient OIDC and therefore requires the explicit `auth` object. Credential
values are never copied into sandbox options or error messages.

**Migration note:** older deployment descriptions that called the legacy
environment trio “environment auth” are obsolete. Ambient Vercel auth now means
the official request-scoped OIDC helper only. The explicit `auth` option remains
the operator-controlled path for hosts that cannot provide request context;
using it does not enable an implicit environment fallback.

## Provider expansion

The public selection function is intentionally an explicit switch rather than a
mutable registry. A future adapter can add a provider-specific branch after it
has its own capability contract and tests. It must prove network denial,
non-persistence, immutable source identity, argv-safe commands, byte-safe file
operations, bounded logs, command termination, and cleanup failure behavior
before it can receive tenant bytes.

ComputeSDK's generic provider contract does not prove those properties. E2B
has native network, timeout, stream, kill, and byte-file controls, but its
command API is shell-string based in the current adapter and therefore remains
disabled for hostile scanner input until an argv boundary and output cap are
proved. Daytona exposes network block-all, lifecycle, and command timeout
options, but its command and generic filesystem paths are shell-string based and
generic output capture is unbounded; it also remains disabled. A provider
failure must not fall through to a provider with different isolation semantics.

Primary references:

- [ComputeSDK Vercel adapter](https://github.com/computesdk/computesdk/blob/main/packages/vercel/src/index.ts)
- [ComputeSDK provider factory](https://github.com/computesdk/computesdk/blob/main/packages/provider/src/factory.ts)
- [Vercel Sandbox native API](https://github.com/vercel/sandbox)
- [E2B sandbox options](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/sandboxApi.ts)
- [Daytona network limits](https://www.daytona.io/docs/en/network-limits/)

## Live Vercel proof

On 2026-09-10 the installed exact dependency set was exercised against a real
Vercel Sandbox using the adapter in
`packages/sandbox-provider/src/index.ts`. The run used the immutable
`skillsguard` snapshot reference recorded in `work/scanner-snapshot.json`:

```text
snapshot:snap_3h78aAzaNZfWEG91t4hgAhi4ecim
revision:7badb5157f8f4e9dd9ee2acb6e0129636e3147e3
artifact:sha256:b13362de4598007678c8371bc26e9ce2284f1d3c21e4f8c386a614c24df6de53
```

The installed versions were `computesdk@4.1.4`,
`@computesdk/provider@2.1.5`, `@computesdk/vercel@1.7.33`, and the deduped
native `@vercel/sandbox@3.2.2`. The adapter configured deny-all networking,
non-persistent execution, no exposed ports or daemon SSE bridge, and a
120-second scanner timeout. The current scanner boundary staged one bounded
`SKILL.md` file and capped command output at 1 MiB for each case.

`work/verify-computesdk-scanner.ts` completed both real scans. The benign
fixture completed with one analyzed file and zero findings. The inert malicious
fixture completed with one analyzed file and 15 findings, including critical
prompt-injection findings. The complete machine-readable results are in
`work/computesdk-scanner-evidence.json`; fixture text was static documentation
and was never executed. This proves the current adapter, snapshot provenance,
native operations, cleanup path, and scanner roundtrip in the tested runtime.
It does not qualify other ComputeSDK providers or replace deployment-specific
credential, quota, and recovery verification.

The current production evidence verifies the separately configured native
fallback scanner path. The ComputeSDK production path remains pending after a
pre-analysis request-context authentication failure; the local proof above is
not a production ComputeSDK acceptance claim.
