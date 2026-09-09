# Storage verification

Verified 2026-09-09 against a disposable local MinIO S3-compatible service.

- **Files SDK:** `files-sdk@2.4.0`, `files-sdk/s3` adapter
- **Backend image:** `minio/minio:RELEASE.2025-09-07T16-13-09Z`
- **Resolved image digest:** `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`
- **Endpoint:** loopback HTTP with path-style addressing enabled
- **Bucket:** disposable conformance bucket; credentials omitted
- **Object:** 10 binary bytes, digest `sha256:70fdccf05a2f89a29e246074c28c2fd35fe54f9cf8997eb54f93596452c30d3f`

The real `FilesSdkBlobStore` S3 path completed `put`, exact `get`,
`getVerified`, missing-key rejection, `remove`, and post-removal read
rejection. A subsequent S3 listing reported zero remaining objects. The
dedicated MinIO container and volume were removed after the run.
