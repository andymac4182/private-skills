# Draft contracts

These JSON Schemas use draft 2020-12. They make the planned payload shapes concrete; they do not implement a registry or cover the whole API. The first implementation milestone must freeze them alongside OpenAPI, generate Go/TypeScript types, and add shared conformance vectors.

- [Pack draft](skill-pack.schema.json): human-authored member constraints. Published packs resolve every entry to immutable versions/digests.
- [Scan result](scan-result.schema.json): runner-normalized engine evidence. Policy decisions are separate.

JSON Schema alone cannot prove access control, archive path safety, SemVer resolution, scan coverage completeness, cryptographic integrity, or callback authenticity. Enforce these semantic invariants in application code. `ref` names use a deliberately portable ASCII registry namespace grammar; the skill-content validator separately follows the Agent Skills specification.

Example hashes and IDs are illustrative; they do not refer to real artifacts or scan runs. Version and revision strings in scanner examples are placeholders for the implementation spike, never executable release pins.

## Canonical artifact proposal

M1 will freeze a `tar-gzip-v1` encoder with shared vectors: sorted relative UTF-8 paths, fixed archive timestamps/ownership, only ordinary files/directories, and normalized permitted mode bits. The server produces the distribution archive once; clients verify its SHA-256 instead of regenerating compression output. Content bytes and line endings remain unchanged. Archive normalization metadata is distinct from changing skill instructions.

The tree manifest records each relative path, byte size, permitted mode, and file SHA-256 in stable path order, plus a format version. Its digest is SHA-256 of the UTF-8 [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785) representation. Reject Unicode/case path collisions before manifest creation; do not rely on JSON canonicalization to normalize filenames. Go and TypeScript must agree on the shared manifest vectors before the format is declared stable. Exact TAR header/extension and gzip settings remain an M1 protocol decision, not an implemented compatibility claim.
