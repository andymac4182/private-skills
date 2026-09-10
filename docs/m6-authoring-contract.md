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

The server supports both release-fork and upload-origin drafts. The current
HTTP surface is:

```text
POST /v1/skills/:resourceId/drafts
POST /v1/drafts
GET  /v1/drafts/:draftId
PUT  /v1/drafts/:draftId
POST /v1/drafts/:draftId/publish
GET/POST /v1/drafts/:draftId/reviews
POST /v1/drafts/:draftId/reviews/:resultId/decisions
POST /v1/drafts/:draftId/reviews/:jobId/retry
```

Release-fork creation is `POST /v1/skills/:resourceId/drafts` with
`{ baseDigest }`; upload-origin creation is `POST /v1/drafts` with
`{ name, files }`. Both require an `Idempotency-Key` header. The atomic file
save is `PUT /v1/drafts/:draftId` with `{ expectedRevision, files }`, where
`files` is the complete draft snapshot returned by the Diffs edit callback.
The server canonicalizes path order before sealing, applies compare-and-swap
on `expectedRevision`, computes the canonical digest, and writes a new
immutable blob. Replaying the same idempotency key and payload returns the
same draft; a stale revision returns `DRAFT_CONFLICT` without changing the
draft or its immutable base.

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

Saving, viewing, or reviewing a draft never mutates the base release.
`POST /v1/drafts/:draftId/publish` with `{ expectedRevision, version }` is the
author transition that materializes the draft as a new pending release and
queues the existing required scanner/publish boundary. Scanner failure, policy
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
type UploadReviewBinding = {
  draftId: string;
  draftRevision: number;
  contentDigest: Digest;
  baseReleaseId?: string;
  baseReleaseVersion?: string;
  baseDigest?: Digest;
  policyRevision: string;
};

type UploadReview = {
  id: string;
  jobId: string;
  organizationId: string;
  binding: UploadReviewBinding;
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
revision/digest and is idempotent; `GET` lists sanitized jobs/results without
lease tokens or snapshots. `POST /v1/drafts/:draftId/reviews/:resultId/decisions`
records a publisher decision, while `POST .../reviews/:jobId/retry` requests a
new review job. Any byte/revision, base-release, policy, or reviewer-contract
change makes the old result stale. Findings and human actions are persisted
and audited but cannot mutate the artifact. The reviewer receives only an
authorized snapshot and no registry, storage, scanner, or upstream
credentials.

## Interactive authoring builder Eve

The editor also has a distinct interactive authoring builder. It helps an
authorized publisher build an initial skill from a blank or validated
upload-origin draft (when that draft origin is enabled), and refine a draft
based on an existing immutable release. It is a third workflow, separate from
both the daily consolidation Eve and the upload/edit reviewer Eve:

* daily consolidation Eve proposes common-skill consolidation from its own
  review workflow;
* upload/edit reviewer Eve asynchronously reviews an exact saved draft
  snapshot and records advisory findings; and
* builder Eve holds a bounded conversation with the author and proposes
  file changes for that author's current draft.

Builder Eve may suggest `add`, `edit`, `rename`, and `delete` operations, but a
conversation turn never writes a draft directly. The UI shows a reviewable
proposal diff and the author explicitly applies or rejects it. Proposed
portable routes are:

```text
POST /v1/drafts/:draftId/builder/conversations
GET  /v1/drafts/:draftId/builder/conversations/:conversationId
POST /v1/drafts/:draftId/builder/conversations/:conversationId/messages
GET  /v1/drafts/:draftId/builder/proposals/:proposalId
POST /v1/drafts/:draftId/builder/proposals/:proposalId/apply
POST /v1/drafts/:draftId/builder/proposals/:proposalId/reject
```

The route names are a portable seam, not a claim that these endpoints are
already implemented. A durable conversation and proposal carry the exact
draft context used to produce them:

```ts
type BuilderConversation = {
  id: string;
  organizationId: string;
  draftId: string;
  draftRevision: number;
  draftDigest: Digest;
  baseResourceId: string;
  baseDigest: Digest;
  gateway: string;
  model: string;
  toolRevision: string;
  state: "active" | "stale" | "closed";
};

type SkillBuilderOperation = {
  kind: "add" | "edit" | "rename" | "delete";
  path: string;
  toPath?: string;
  content?: string;
  expectedPathDigest?: Digest;
};

type SkillBuilderProposal = {
  id: string;
  conversationId: string;
  draftId: string;
  baseRevision: number;
  baseDigest: Digest;
  operations: readonly SkillBuilderOperation[];
  diffDigest: Digest;
  rationale: string;
  model: string;
  builderRevision: string;
  state: "proposed" | "applied" | "rejected" | "stale";
};
```

Builder context is bounded by configured file, byte, and model-token limits and
is read from the exact authorized draft revision. Its server-side tool allowlist
may inspect the canonical manifest and bounded text files and construct a
proposal; it has no write, scanner, package-manager, MCP, arbitrary-network,
release, or execution tool. Gateway/model, tool revision, job/idempotency data,
and bounded context limits are persisted for audit. Skill text and conversation
messages are untrusted data, including prompt-injection instructions, and no
credential or storage/provider URL is sent to the browser or model.

Applying a proposal requires `{ expectedRevision, proposalId, idempotencyKey }`.
The server revalidates canonical paths, operation preconditions, the proposal's
bound digest, and the current revision, then performs the same whole-snapshot
CAS and digesting used by draft saves. A successful apply creates one new draft
revision; reject is an audited terminal decision. If the revision or digest has
changed, apply returns an explicit stale/conflict result and does not silently
rebase, overwrite, or apply a partial proposal. A conversation must be rebound
to the new revision before it can propose further changes. The immutable base
release is never mutated.

Builder Eve cannot publish, merge, install, execute content, run a scanner, or
change scanner policy. Existing required scanner and publication gates remain
authoritative; upload/edit review remains advisory unless its separately
versioned optional gate is configured. Missing or stale builder conversations or
proposals never authorize a release.

## Ownership and implementation order

| Owner | First slice | Boundary |
| --- | --- | --- |
| `registry_completion_audit` | release file reads, draft/revision state, CAS, routes, explicit release transition | Portable Request/Response core; reuse bundle validation, `BlobStore`, auth, and required scanner jobs. |
| storage/worker owner | immutable draft blobs, review leases/idempotency, scanner completion | No candidate execution; preserve Files SDK verification and existing policy. |
| Eve/reviewer owner | upload/edit reviewer identity, queue consumer, findings schema, AI Gateway configuration | Separate from daily consolidation Eve; advisory unless an explicit versioned gate is configured. |
| `delivery_audit` | `packages/skill-builder` contract/types plus app conversation/proposal persistence and route integration, apply/reject CAS, and builder E2E evidence | Keep builder tools proposal-only; reuse draft authorization, canonical bundle validation, and the existing scanner/release boundary. |
| `web_ui` | read-only file tree/Diffs route, draft editor/review panel, and builder chat/proposal diff/apply/reject states | `@pierre/trees` for paths; `@pierre/diffs` for read/edit/diff; app owns loading, conversation, and save state. |
| `e2e_tests` / completion audit | cross-tenant, stale-result, scanner-authority, accessibility, and release evidence | Verify exact resource IDs/digests, intended draft/review/new-release writes, and no unintended mutation or change to the immutable base release. |

Implement in this order: M6-VIEW API and fixture, read-only UI, draft CAS and
reload, builder conversation/proposal/apply/reject, editor route, upload/edit
review queue, explicit scanner/release transition, then accessibility and
portability evidence. This keeps each vertical slice useful without implying
that the complete editor, builder, or Eve review is shipped.
