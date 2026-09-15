# Authenticated CLI distribution

The web application serves the reviewed `pskills` binaries through the
authenticated company route `/v1/cli/releases`. The marketing site links to
the app origin, so a public page never proxies a private archive or exposes a
source checkout.

`GET /v1/cli/releases` returns the current browser-safe manifest. It includes
the release version, archive names, byte sizes, SHA-256 digests, target
triples, verification qualification, and whether each private object is
provisioned. `GET
/v1/cli/releases/{version}/{target}/download` requires an authenticated
member of the selected organization with a member role and both
`registry:read` and `artifacts:download` when the principal has explicit
scopes. The response is a private, no-store attachment with an exact
`Content-Length`, `ETag`, and `X-PSKILLS-RELEASE-DIGEST` header. The route
rechecks the size and SHA-256 digest after reading the provider bytes.

The pinned metadata is v0.4.0 from the private GitHub release tag
`84f712720dba74508d56f0bcb532393dad24324d`. The server keeps that private
repository and tag provenance in its pinned server manifest, while the browser
projection omits it. No request path fetches GitHub or accepts a caller
supplied URL, storage key, or archive name.

## Registering private release objects

The default manifest is intentionally metadata-only: it has no storage keys
and therefore cannot serve an archive until an operator registers verified
objects. Set `PSKILLS_CLI_RELEASE_MANIFEST` to a strict JSON manifest matching
the host-neutral contract in `packages/cli-release/src/index.ts`. Each asset
may add an opaque `storageKey` that points to an immutable object already
stored through the configured Files SDK or HTTP `BlobStore`, for example:

```json
{
  "protocolVersion": 1,
  "version": "0.4.0",
  "releaseTag": "v0.4.0",
  "source": {
    "kind": "github-release",
    "repository": "andymac4182/private-skills",
    "tag": "v0.4.0",
    "tagCommit": "84f712720dba74508d56f0bcb532393dad24324d"
  },
  "checksums": {
    "filename": "SHA256SUMS",
    "size": 309,
    "digest": "sha256:02c6bf4296ee344aa9d6846e5848ba00920112361093205a7bb95ef688688889"
  },
  "assets": [
    {
      "target": "aarch64-apple-darwin",
      "platform": "macos",
      "architecture": "arm64",
      "filename": "pskills-aarch64-apple-darwin.tar.gz",
      "archive": "tar.gz",
      "member": "pskills",
      "size": 2673030,
      "digest": "sha256:<64 lowercase hex characters>",
      "storageKey": "sealed/<registered-object-key>"
    }
  ],
  "verification": {
    "nativeProofTargets": ["aarch64-apple-darwin"],
    "nativeTestWaivedTargets": []
  }
}
```

The example digest is a placeholder and must not be used. Copy the exact
digest from the verified release manifest. The server rejects unknown target
triples, archive/member mismatches, duplicate files, unsafe storage keys,
incorrect sizes, malformed digests, and verification sets that do not cover
the configured assets. A storage read that does not match the manifest fails
with `CLI_RELEASE_INTEGRITY` and returns no bytes.

For a disposable Node development or test run only, set
`PSKILLS_CLI_RELEASE_ROOT` to a server-owned fixture directory. The runtime
uses the filesystem provider only when an asset has no `storageKey` and the
environment is explicitly `development` or `test`; hosted production uses
the private BlobStore path. The fixture provider validates both the resolved
filename and symlink target against its root.

## Verification boundary

The three v0.4.0 archive descriptors and `SHA256SUMS` were verified from the
private release. Native smoke evidence covers `aarch64-apple-darwin` on
Apple Silicon macOS. Linux x86_64 and Windows x86_64 archives are listed in
the release metadata, but native Linux and Windows validation was waived for
this delivery, so the manifest labels those assets as `native-test-waived` and
the app keeps their download state explicit. Intel macOS is not a packaged
target in this release.
