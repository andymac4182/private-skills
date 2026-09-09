# Scanning, policy, and extension hooks

## Three separate responsibilities

An **engine adapter** runs a pinned scanner against a sealed skill directory and normalizes its evidence. A **policy evaluator** decides whether evidence permits distribution. An **event hook** integrates administrator-owned checks and downstream systems. A scanner exit code or webhook HTTP 200 is not itself an approval.

Built-in adapters: `cisco-skill-scanner`, `nvidia-skillspector`, and `skillsguard`. Each has `disabled`, `advisory`, or `required` mode. Recommended first-run configuration is Cisco required after adapter acceptance, NVIDIA and SkillsGuard advisory; administrators can require all three. All software executes on the server, so CLI users need none of its runtimes.

See [scanner research](scanners.md) for licensing, commands, actual egress behavior, limitations, and alternatives. These adapters are planned, not implemented.

## Safe execution contract

The coordinator selects the engine image by digest, reviewed source revision, configuration hash, and policy revision. It creates a fresh ephemeral scanner environment with an empty home, immutable input, bounded output, and no upstream or production credentials. Input is a canonical extracted bundle whose file manifest matches the distribution archive. A fresh environment is required between organizations and jobs.

Source fetching is a separate phase. Scanners receive local input, not an upstream URL; they cannot download a different branch or quietly expand their scope. Deny network by default. Optional OSV metadata lookups, LLM analysis, or custom remote scanners require an administrator-configured destination and documented data categories. Content-bearing egress is visibly different from dependency-coordinate egress.

Use fixed argument arrays, never a publisher-controlled shell command. Do not install bundle dependencies or execute bundle code, MCP servers, package lifecycle hooks, or instructions in `SKILL.md`. Preinstall scanners and models into trusted images. Scanned files cannot supply scanner config, baselines, rules, or suppression settings. If an upstream engine cannot ignore embedded suppressions, expose that limitation and keep the adapter advisory until a tested remedy exists; do not alter the distributed bytes to disguise the problem.

The coordinator verifies output size, JSON schema, job identity, digest, scanner revision, and execution metadata. It hashes input again after the run where enforcement cannot guarantee read-only access. Scanner-written claims about their own version or artifact digest are corroborated by the runner. Reports are untrusted text: sanitize rendering and redact secrets before logs or notifications.

## Normalized scan result

The [draft result schema](../contracts/scan-result.schema.json) and [example](../examples/scan-result.json) describe:

- Schema version, organization, job/invocation ID, immutable artifact digest, policy revision.
- Adapter ID/version, upstream engine version, pinned rules revision, configuration hash, execution duration.
- Status: `completed`, `degraded`, `error`, `timeout`, or `unsupported`. `completed` can contain blocking findings; it does not mean safe. Disabled engines are policy configuration, not successful runs.
- Coverage: enumerated, analyzed, skipped, and unsupported file counts; limitations; external destinations actually used.
- Findings: stable rule ID/fingerprint, normalized severity, category, message, relative file/line, optional redacted evidence, and source engine detail retained in the raw report.

Reports never contain artifact access credentials. Raw reports/SARIF live in private report storage with tighter administrative permissions than ordinary skill download. Metrics and CLI summaries contain bounded redacted content.

## Decision rules

| Condition | Distribution decision |
| --- | --- |
| Invalid archive, identity, or manifest | Reject before scanners |
| Required engine has high/critical finding | Quarantine; reviewer can grant only a scoped, expiring exception |
| Required engine error, timeout, invalid JSON, zero analyzed files, unsupported required content, or missing evidence | Block with a scan error/pending state; never a pass |
| Required engine degraded coverage | Block unless the policy explicitly accepts that exact limitation and records it in the decision |
| Required engine completes below configured threshold | Satisfies that engine's policy condition only |
| Advisory engine finding/error | Record and display; baseline and other required gates still apply |
| New policy, engine version, rules, or config | Reuse applicable evidence only by exact cache key, otherwise rescan |
| All optional scanners disabled | Baseline validation still runs; display “security scanners disabled” |
| Revoked digest/version/source | Deny regardless of prior scan evidence |

Administrators set severity thresholds per engine because scores are not calibrated across products. Do not average vendor risk scores or use majority voting to override a required finding. Required engines must agree with their own configured criteria. Source/package policies may make requirements stricter than organization defaults but cannot weaken them.

Exceptions contain digest, finding fingerprint or explicitly named coverage limitation, approver, rationale, expiry, and policy revision. No exception can make malformed archives, unauthorized sources, or digest mismatches installable. Expired exceptions force re-evaluation. An administrator changing/disabling a requirement creates an audited policy revision; a skill author cannot do so through a manifest.

## Hooks

| Hook | When | Can block? |
| --- | --- | --- |
| `ingest.validate` | Complete artifact safely extracted, before scanning | Yes; organization-owned metadata/license/provenance rules |
| `scan.execute` | Sealed artifact ready | Yes; built-in or custom scanner adapter |
| `artifact.evaluate` | All required evidence collected, before approval | Yes; custom policy checks |
| `pack.evaluate` | Pack member set fixed | Yes; all member permissions/decisions plus aggregate metadata and cross-skill rules |
| `download.authorize` | Before every new download grant | Yes; local fast evaluator checks current ACL, revocation, policy, and grant limits |
| `artifact.approved`, `artifact.quarantined`, `artifact.revoked`, `scan.completed`, `pack.published` | After committed state transition | Notifications only; failure does not undo an already committed decision |

`download.authorize` consumes persisted policy state; remote checks run asynchronously before approval so download requests do not depend on an unbounded third-party callback. Packs receive their own immutable manifest digest and decision, and reference each member's decision; ordinary single-skill engines do not automatically analyze interactions between members. A combined-content scan can be an additional hook, never a substitute for each member's scan.

Custom adapters are administrator-registered runner integrations with pinned executables and allowlisted settings. Custom webhooks carry `eventId`, `organizationId`, `jobId`, `attempt`, `artifactDigest`, `policyRevision`, `deadline`, and a bounded payload. HMAC signatures cover the exact body and timestamp; rotate secrets, reject old signatures, deduplicate event IDs, and verify response/callback job bindings. Use per-attempt nonces and authenticated result ingestion. Webhook destinations obey the same SSRF/redirect protections as upstreams.

Default hooks receive metadata only. An explicit content-enabled scanner may get read access to a single quarantined artifact for a bounded period. This is a privileged scanner grant, distinct from ordinary client distribution. It can never read all quarantine or issue approved downloads.

Required hooks have bounded retries with backoff and a deadline; exhausting them leaves the artifact blocked. Notification hooks use an outbox and at-least-once delivery with dead-letter inspection. Replays do not duplicate publication or approvals. Expensive custom code is never loaded into the web API process.

## Freshness and verification

Cache scan evidence by organization, artifact digest, adapter/engine revision, rules/model revision, and configuration hash. Bind the final decision additionally to release/source-revision identity, namespace/source permissions, pack version/manifest when applicable, effective policy revisions, and decision expiry. Evidence for identical bytes may be reusable; authorization for one resource never authorizes another. Before pack activation, the install authorization service rechecks the aggregate pack decision and all desired members, including locally cached or retained members. Suggested initial evidence lifetime is seven days; explicit revocation or newly required rules invalidates new distribution authorizations immediately. The value is configurable and must be measured against scan volume and risk.

Acceptance fixtures cover benign internal skills, nested scripts, unusual filenames, encoded text, code fences, inline ignores, malicious configuration, skipped/binary content, unexpected network calls, corrupt output, timeouts, and policy changes during a job. Test each adapter with the exact pinned release before allowing it to be required. No detector can guarantee future agent behavior; the UI states what was checked and under which policy.
