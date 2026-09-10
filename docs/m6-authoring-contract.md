# M6 authoring contract

Status: active implementation sketch, incomplete. This document fixes the
smallest backend/UI seams for M6; the checkable release gates remain in
[`completion-criteria.md`](completion-criteria.md). M6 does not change the
existing scanner authority or silently expand the G0/C1 release checklist.

## Capability boundary

The official [`@pierre/diffs` documentation](https://diffs.com/docs) and
[source README](https://raw.githubusercontent.com/pierrecomputer/pierre/main/packages/diffs/README.md)
provide file/diff rendering and a beta client-side editor. The separate
[`@pierre/trees` package](https://raw.githubusercontent.com/pierrecomputer/pierre/main/packages/trees/README.md)
provides path-first file-tree UI. They do not provide Private Skills
authorization, storage, draft persistence, review jobs, scanner policy, or
release publication. The application owns those boundaries.

Before M6-EDITOR can pass, the implementation must record exact compatible
`@pierre/diffs` and `@pierre/trees` versions in the package manifest and lock,
with primary release/registry provenance. The current homepage version label
is useful discovery evidence, not a dependency pin or acceptance proof.

## Resource identity and read-only view

`SkillVersion.id` is already the immutable release resource ID. M6 must use it
directly; it must not invent a skill-parent/version-child identity for the
file view.

Proposed portable routes:

```text
GET /v1/skills/:resourceId/files
GET /v1/skills/:resourceId/file?path=<canonical-relative-path>
```

The manifest response contains the selected `resourceId`, release/version
metadata, canonical artifact digest, and entries shaped like:

```ts
type ReleaseFileEntry = {
  path: string;
  sizeBytes: number;
  digest: Digest;
  kind: "text" | "binary" | "oversize";
  contentAvailable: boolean;
};
```

The file response returns full bounded text only for an authorized exact path
from a current approved, scan-valid release. Release-file reads use reader
authorization; draft-file reads and writes use separate publisher/owner draft
authorization and never inherit release approval:

```ts
type ReleaseFileContent = {
  resourceId: string;
  artifactDigest: Digest;
  path: string;
  contentDigest: Digest;
  content: string;
};
```

Binary and oversize entries return bounded metadata/state without pretending
that truncated bytes are text. The server reads and validates the canonical
bundle through the existing storage abstraction; blob keys, provider URLs,
storage credentials, and scanner credentials never reach the browser. Path
authorization is tenant/namespace/principal scoped and compares the exact
canonical path after the existing safe-path validation.

## Draft and release transitions

The editor starts a draft explicitly from an immutable `SkillVersion`:

```text
POST /v1/drafts
GET  /v1/drafts/:draftId
GET  /v1/drafts/:draftId/files
PUT  /v1/drafts/:draftId/files
POST /v1/drafts/:draftId/reviews
POST /v1/drafts/:draftId/release
```

The initial create body is `{ baseResourceId, idempotencyKey }`; this first
slice starts from an existing immutable release. A later upload-origin slice
may create a draft from a validated upload, but this contract does not claim
that new-upload draft creation is implemented. The atomic file-save
body is `{ expectedRevision, files }`, where `files` is the complete canonical
draft snapshot returned by the Diffs edit callback. The server validates the
whole snapshot, applies compare-and-swap on `expectedRevision`, computes the
canonical digest, and writes a new immutable blob. A later patch optimization
must preserve this snapshot/CAS contract.

The durable state is split between metadata and sealed blobs:

```ts
type Draft = {
  id: string;
  organizationId: string;
  baseResourceId: string;       // immutable SkillVersion.id
  baseDigest: Digest;
  currentRevision: number;
  currentDigest: Digest;
  currentRevisionId: string;
  state: "editing" | "reviewing" | "scan-pending" | "ready" |
    "released" | "discarded" | "conflict";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type DraftRevision = {
  id: string;
  draftId: string;
  revision: number;
  digest: Digest;
  artifact: StoredBlob;
  manifest: ReleaseFileEntry[];
  createdBy: string;
  createdAt: string;
};
```

Stale writes return an explicit conflict/rebase response. Saving, viewing, or
reviewing a draft never mutates the base release. `POST .../release` is the
only author transition that materializes the draft as a new release and queues
the existing required scanner/publish boundary. Scanner failure, policy
failure, authorization failure, or digest mismatch blocks admission.

## Upload/edit Eve

Upload/edit review is a separate identity, queue, token, route, and state
contract from daily consolidation Eve. The default policy is advisory:
existing required scanners remain authoritative, and Eve cannot publish,
merge, install, execute candidate content, change policy, or grant scanner
approval. A separately versioned product policy may opt into an additional Eve
review gate; without that policy, a missing or stale Eve result is not a new
implicit publication blocker.

```ts
type UploadReview = {
  id: string;
  organizationId: string;
  draftId: string;
  draftRevision: number;
  draftDigest: Digest;
  baseResourceId: string;
  policyRevision: string;
  reviewerRevision: string;
  model: string;
  state: "pending" | "running" | "passed" | "failed" | "stale";
  idempotencyKey: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
};

type UploadReviewFinding = {
  id: string;
  reviewId: string;
  path?: string;
  line?: number;
  severity: "info" | "low" | "medium" | "high" | "critical";
  category: string;
  summary: string;
  evidence?: string;
  decision?: "open" | "acknowledged" | "dismissed";
};
```

`POST /v1/drafts/:draftId/reviews` binds the job to the exact current
revision/digest and is idempotent. Any byte/revision, base-release, policy, or
reviewer-contract change makes the old result stale. Findings and human
actions are persisted and audited but cannot mutate the artifact. The reviewer
receives only an authorized snapshot and no registry, storage, scanner, or
upstream credentials.

## Ownership and implementation order

| Owner | First slice | Boundary |
| --- | --- | --- |
| `registry_completion_audit` | release file reads, draft/revision state, CAS, routes, explicit release transition | Portable Request/Response core; reuse bundle validation, `BlobStore`, auth, and required scanner jobs. |
| storage/worker owner | immutable draft blobs, review leases/idempotency, scanner completion | No candidate execution; preserve Files SDK verification and existing policy. |
| Eve/reviewer owner | upload/edit reviewer identity, queue consumer, findings schema, AI Gateway configuration | Separate from daily consolidation Eve; advisory unless an explicit versioned gate is configured. |
| `web_ui` | read-only file tree/Diffs route, then draft editor/review panel | `@pierre/trees` for paths; `@pierre/diffs` for read/edit/diff; app owns loading and save state. |
| `e2e_tests` / completion audit | cross-tenant, stale-result, scanner-authority, accessibility, and release evidence | Verify exact resource IDs/digests, intended draft/review/new-release writes, and no unintended mutation or change to the immutable base release. |

Implement in this order: M6-VIEW API and fixture, read-only UI, draft CAS and
reload, editor route, upload/edit review queue, explicit scanner/release
transition, then accessibility and portability evidence. This keeps the first
vertical slice useful without implying that editing or Eve review is shipped.
