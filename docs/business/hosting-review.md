# Private Skills business hosting review

**Decision date:** 15 September 2026 (Brisbane)
**Launch target:** Friday 18 September 2026
**Scope:** hosted private agent-skills SaaS, including Nitro web/API, PostgreSQL sessions and tenant state, JSONB/pgvector search, bundle storage, 24-hour scan freshness, queued jobs, Eve review, and AI Gateway usage.

## Recommendation

Launch with the existing Vercel and Node path:

```text
Browser / CLI
      |
Vercel Pro, Nitro Node / Fluid Compute
      |-------------------- Neon PostgreSQL (one shared tenant-aware database)
      |-------------------- Files SDK -> Vercel Blob (keep S3/R2 adapters)
      |
cron dispatcher -> PostgreSQL durable job row -> bounded Vercel Sandbox scan
                                                    (deny-all network)
Eve reviewer -------------------------------------> AI Gateway / provider
```

This is the smallest change that preserves the checked repository's portability seams. Keep the web/API on a Node Nitro preset, use Neon Postgres for the existing state and `pgvector` path, retain the Files SDK adapter, and use the existing ComputeSDK/Vercel Sandbox adapter only for bounded scanner jobs. With the tenant dispatcher enabled, each cron invocation visits at most 32 Better Auth organizations and invokes at most 2 jobs per organization (64 worker attempts under the shipped defaults), within a 240-second dispatch budget and a 300-second fenced lease. The organization cursor, lease, and retry backoff are durable PostgreSQL state; the cron is a liveness signal, not a durable queue. Successful interactive publish/import/rescan drains remain separately bounded to two jobs through Nitro's `waitUntil` hook.

The launch identity boundary must remain compatible with the planned Better Auth 1.7.5, Kysely 0.29.5, and `kysely-postgres-js` 4.0.0 stack against the existing PostgreSQL database. The reviewed commit still contains the source token/session implementation, so this note records a launch compatibility constraint rather than claiming that Better Auth is already integrated. Node is the low-risk runtime for that driver path.

Vercel Pro is $20/month with $20 of included usage credit. That covers the platform portion of a small launch and keeps deployment, CDN, Node functions, and the current sandbox integration in one operational surface. The cost model estimates **$34.94/month at one team**, **$287.80–$1,010.80/month at 100 teams**, and **$2,526.48–$9,756.48/month at 1,000 teams** for Vercel Pro, Neon Launch, and the modeled scan, Blob, and function usage. The range is scan duration/memory sensitivity; it excludes AI provider spend, taxes, and delivery paths whose price depends on cache and private-response behavior. At 100 teams the base case is $502.30/month; at 1,000 it is $4,671.48/month.

The 1,000-team figure is a cost scenario, not a throughput claim. At one scan per active artifact per day, 1,000 teams create 900,000 sandbox runs/month, or about 1,250 runs/hour. With a three-minute base scan this needs about 63 concurrent sandboxes on average, while Pro lists 10 concurrent sandboxes. Treat 100 teams as the first serious capacity test and move scanning to a dedicated worker pool before the 24-hour freshness contract is at risk.

## Launch plan and controls

Before launch, keep the change set bounded to deployment and operational controls:

1. Deploy the existing Nitro Node build to Vercel Pro in the Sydney region where practical. Keep the state and storage provider settings on their gateway/Files SDK seams; do not move domain code to Vercel-only SDKs.
2. Use one Neon Launch project for shared multi-tenant Postgres. Set a deployment-level connection pool, tenant predicates, statement timeouts, and spend alerts. Do not create one database/project per team: the fixed per-project economics and operational surface would grow with every tenant.
3. Use the existing Files SDK Vercel Blob adapter for canonical bundles and reports if its private delivery path is acceptable. Keep object keys tenant-scoped and signed. Preserve the S3 and R2 adapters so high egress can be moved without changing the API.
4. Run the hosted worker route with `CRON_SECRET`, immutable scanner image/snapshot references, deny-all sandbox networking, and the current 2,000-file/10 MiB-file/100 MiB-expanded-input policy. Spread 24-hour scans across the day; do not schedule every tenant at one timestamp.
5. Put a spend ceiling and alerts on Vercel, Neon, and the object store. Record per-tenant `scan_count`, scan CPU/memory seconds, bundle bytes, object egress bytes, AI input/output tokens, and queue age. Cost attribution is needed before any provider switch is justified.
6. Keep a Node worker deployment recipe ready. It can claim the same PostgreSQL job rows and use the Docker scanner executor on a dedicated host once the concurrency trigger below fires. This is an incremental worker move, not a web/API rewrite.

## Workload assumptions

The model is a transparent planning baseline, not a provider quote. It uses a 30-day month and USD list prices captured on 15 September 2026. The artifact is dependency-free and can be rerun with `node hosting-cost-model.js`.

| Input | Launch | 100 teams | 1,000 teams |
|---|---:|---:|---:|
| Active artifacts per team | 30 | 30 | 30 |
| Scan freshness | 1 per artifact/day | 1 per artifact/day | 1 per artifact/day |
| Sandbox scans/month | 900 | 90,000 | 900,000 |
| API requests/team/month | 30,000 | 30,000 | 30,000 |
| API active CPU/request | 20 ms | 20 ms | 20 ms |
| API memory/request | 2 GB for 100 ms | 2 GB for 100 ms | 2 GB for 100 ms |
| Canonical object storage/team | 0.5 GB | 0.5 GB | 0.5 GB |
| User downloads/team/month | 1 GB | 1 GB | 1 GB |
| Neon compute | 140 CU-h | 720 CU-h | 3,000 CU-h |
| Neon database storage | 0.25 GB/team | 0.25 GB/team | 0.25 GB/team |
| Neon history storage | 0.05 GB/team | 0.05 GB/team | 0.05 GB/team |
| Publishes/imports/team/month | 30 / 10 | 30 / 10 | 30 / 10 |
| AI calls/team/month | 200 | 200 | 200 |
| AI tokens/call | 2,000 input + 500 output | 2,000 input + 500 output | 2,000 input + 500 output |
| Embedding calls/team/month | 30 × 5,000 tokens | 30 × 5,000 tokens | 30 × 5,000 tokens |

The scan range is:

| Profile | Active CPU/scan | Wall time/scan | Memory/scan |
|---|---:|---:|---:|
| Low | 0.5 min | 2 min | 1 GB |
| Base | 1 min | 3 min | 1.5 GB |
| High | 2 min | 6 min | 2 GB |

Every scan is modeled as one sandbox creation. The model counts one simple Blob read per scan, one advanced Blob operation per publish, and 1 GB/month of user downloads per team. It does not assume that every internal PostgreSQL read becomes public egress. It also does not price AI: use the formula below with the provider's current model catalog at deployment.

The model keeps durable queue jobs in PostgreSQL, as the repository does today. At the base workload there are 940 jobs/team/month; an eventual Vercel Queues adapter would still be below its 1M included API operations through 1,000 teams under these assumptions, but its event shape, retry semantics, and storage retention would need a separate acceptance test.

```text
AI monthly cost = input_tokens / 1e6 * input_USD_per_M
                + output_tokens / 1e6 * output_USD_per_M
                + embedding_tokens / 1e6 * embedding_USD_per_M
```

At the base workload, the model produces 0.4M input tokens, 0.1M output tokens, and 0.15M embedding tokens per team/month. Vercel AI Gateway documents zero markup and a $5/month free credit, but the model leaves both AI credit application and provider token rates outside the platform subtotal.

## Known monthly cost scenarios

The full rows are in [hosting-cost-model.csv](./hosting-cost-model.csv), and the formulas are in [hosting-cost-model.js](./hosting-cost-model.js). All values below are USD/month before tax. The two tables intentionally separate a scan-enabled Vercel stack subtotal from portable control-plane floors, so the rows are not presented as like-for-like totals.

**Vercel stack subtotal with the modeled bounded Sandbox scanner:**

| Workload | Low scan profile | Base scan profile | High scan profile |
|---|---:|---:|---:|
| Launch, 1 team | **$34.94** | **$34.94** | **$34.94** |
| 100 teams | **$287.80** | **$502.30** | **$1,010.80** |
| 1,000 teams | **$2,526.48** | **$4,671.48** | **$9,756.48** |

These rows include Vercel Pro, Node function usage, modeled Blob list-rate components, and Neon Launch. The Pro credit is applied only to Vercel usage, not to Neon. The scan profiles are the low/base/high assumptions above.

**Portable control-plane floor with scanner and AI explicitly unpriced:**

| Candidate | Launch | 100 teams | 1,000 teams | Included floor |
|---|---:|---:|---:|---|
| Fly Node API/worker + Neon + R2 | $30.50 | $102.23 | $438.41 | Two 1-GB shared machines, Neon, and R2 |
| Cloudflare edge + Fly Node worker + Neon + R2 | $35.50 | $107.83 | $460.81 | Workers Paid, edge request/CPU usage, two Fly machines, Neon, and R2 |
| Railway Node API/worker + Neon + R2 | $39.94 | $111.67 | $447.85 | Hobby plus modeled 0.5 vCPU/1 GB always-on control plane, Neon, and R2 |
| Render Node API/worker + Neon + R2 | $53.94 | $125.67 | $461.85 | Pro workspace plus two smallest modeled services, Neon, and R2 |
| Supabase Pro + Micro floor | $25 | $27.13 | $55.25 | Database floor; larger compute, PITR, extra projects, scanner, and AI are excluded |

The portable rows are not total hosting estimates. Add a measured scanner worker, image distribution, retry policy, and regional egress quote before comparing them with the scan-enabled Vercel row. If a portable stack still calls Vercel Sandbox, add the relevant Vercel scan profile; if it uses Docker/Fly/Railway/Render execution, leave the scanner line marked unknown until a representative trace is measured.

The Vercel model charges the documented Blob transfer reference rate for the modeled direct downloads, then explicitly excludes the separate Fast Data Transfer/Fast Origin Transfer legs. Pro's Flat Rate CDN includes a transfer allowance, while private function-mediated delivery can add both store-to-function and function-to-browser legs. The $100-team and $1,000-team Vercel values therefore require a delivery-path check before budgeting approval; they are not a promise that a particular cache pattern will cost exactly that amount.

## Price cards and source evidence

Prices were checked against official provider pages on 15 September 2026. The pages can change; the links are the source of truth before purchase. Prices are in USD and the model excludes VAT/GST/taxes.

| Provider / component | Unit price or included amount used | Operational fact that affects this product | Source |
|---|---|---|---|
| Vercel Pro | $20/month + $20 included usage credit | Pro is the commercial team plan; credits are consumed across usage | [Vercel pricing](https://vercel.com/pricing) |
| Vercel Functions, Sydney (`syd1`) | $0.180/active CPU-hour; $0.0149/provisioned GB-hour; $0.60/1M invocations after 1M included | CPU pauses on I/O with Fluid Compute; memory remains billed while the instance lives | [Fluid Compute pricing](https://vercel.com/docs/functions/usage-and-pricing) |
| Vercel Node functions | 800 seconds GA max on Pro/Enterprise; up to 1,800 seconds (30 min) beta per function | A scan cannot be an unbounded request; use a job row plus a bounded sandbox | [Function duration](https://vercel.com/docs/functions/configuring-functions/duration) |
| Vercel Sandbox | 5 CPU-h, 420 GB-h memory, 5,000 creations, and 20 GB transfer included; $0.128/h starting CPU, $0.0212/GB-h memory, $0.60/1M creations; Sydney compute uses regional pricing in the model | Pro lists 10 concurrent sandboxes; the current worker is one-shot and deny-all network | [Vercel pricing](https://vercel.com/pricing) |
| Vercel Blob | $0.023/GB-month; $0.40/1M simple ops; $5/1M advanced ops; $0.05/GB data transfer reference | Pro Blob is usage-based; private delivery can add Blob transfer, FOT, FDT, and another FOT leg | [Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing) |
| Vercel Queues (optional) | 1M API operations included; $0.60/1M after | Current durable job source is PostgreSQL; Queues would be a later adapter decision | [Vercel pricing](https://vercel.com/pricing) |
| Vercel AI Gateway | $5/month free tier; provider list prices, zero markup; pay-as-you-go credits after free tier | Model catalog and provider rates are dynamic; AI spend is an explicit model variable | [AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing) |
| Cloudflare Workers Paid | $5/month/account; 10M requests and 30M CPU-ms included; then $0.30/1M requests and $0.02/1M CPU-ms; no egress/throughput fee | Paid invocation has up to 5 minutes CPU (default 30s); 128 MB isolate memory; Cron/Queue CPU max 15 min | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Cloudflare R2 Standard | $0.015/GB-month; $4.50/1M Class A; $0.36/1M Class B; 10 GB, 1M A, 10M B free monthly; internet egress free | Strong fit for high-download bundles if signed delivery can remain outside the API | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Cloudflare Hyperdrive | Included in Workers Paid; paid database queries unlimited (Free 100,000/day) | It does not make a Node `postgres-js`/Better Auth stack automatically edge-compatible; driver and transaction behavior need a spike | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Railway Hobby | $5/month subscription with $5 resource credit; RAM $10/GB-month; CPU $20/vCPU-month; egress $0.05/GB | Easy Node service economics; standard service is not assumed to provide privileged Docker scanner isolation; Railway VM beta is $50/vCPU- and GB-month | [Railway plans](https://docs.railway.com/pricing/plans) |
| Render | Pro workspace $25/month; small service from $7/month; 5 GB bandwidth then $0.15/GB | Background workers and Workflows are useful for queues, but scanner isolation still needs an accepted executor | [Render pricing](https://render.com/pricing) and [background workers](https://render.com/docs/background-workers) |
| Fly Machines | `shared-cpu-4x`/1 GB shown at $7.78/month; volumes $0.15/GB-month; Oceania egress $0.04/GB | Long-running Node/Docker worker is possible; backups, HA, and operational runbooks remain our responsibility | [Fly pricing](https://fly.io/pricing/) |
| Neon Launch | Usage based; $0.106/CU-hour, $0.35/GB-month storage, $0.20/GB-month history, 100 GB egress included then $0.10/GB; typical spend shown as about $15/month | Existing PostgreSQL/JSONB/pgvector shape maps directly; one shared project avoids per-tenant project fees | [Neon pricing](https://neon.com/pricing) |
| Neon Scale | $0.222/CU-hour and $0.35/GB-month storage on the pricing page; higher compute/restore/network controls | A later database tier decision; not assumed in the scenario model | [Neon pricing](https://neon.com/pricing) |
| Supabase Pro | $25/month; first project included; $10/month compute credit covers one Micro; 8 GB disk then $0.125/GB; 250 GB egress then $0.09/GB; cached egress then $0.03/GB | Good bundled Postgres alternative, but it does not remove the current worker/scanner and identity migration work | [Supabase pricing](https://supabase.com/pricing) |
| AWS S3 Standard | $0.023/GB-month reference; Standard GET $0.0004/1,000 and PUT/LIST $0.005/1,000 in the pricing examples; transfer is region/tier dependent | Best neutral Files SDK target; storage is cheap, but public Internet egress can dominate and exact region quote is required | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| AWS Lambda | $0.20/1M requests after 1M free; ARM duration first tier $0.0000133334/GB-second; 15-minute max timeout | Useful for small dispatchers, not a replacement for the current Nitro server or scanner worker | [Lambda pricing](https://aws.amazon.com/lambda/pricing/) and [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |

## Candidate assessment

### Vercel + Neon + Blob + Sandbox: launch choice

This path matches the current repository and its optional hosted worker. Vercel supports Node 24, Fluid Compute, cron, and the current ComputeSDK/Sandbox adapter. The app can keep PostgreSQL and object storage behind the existing provider interfaces. The main cost driver is not web/API traffic; it is daily sandbox execution once each active artifact must be rescanned within 24 hours.

Use spend management to pause or alert before an accidental scan loop consumes the Pro credit. Keep scanner reports and bytes out of user responses and third-party logs. Pin image digests/snapshot references, deny network by default, and write the completed evidence state only after the job's lease/fencing token is valid.

### Fly + Neon + R2: portable worker escape hatch

Fly has the lowest modeled fixed Node control-plane price and can run a long-lived process or container. It is a reasonable next step when a worker must poll PostgreSQL continuously or run Docker without Vercel request-duration limits. The price table is region-selected, and production operation needs backups, multi-machine placement, deployment rollback, scanner image patching, and a failure drill. The model excludes scanner CPU/memory because the correct machine shape depends on actual scan traces.

### Railway + Neon + R2: simple Node operations

Railway is attractive for a small always-on Node API/worker and private service networking. Its Hobby plan is $5 with a $5 resource credit, and standard CPU/memory pricing is easy to model. The beta VM product is priced at $50/vCPU-month and $50/GB-month, so it is not a presumed scanner isolation solution. Use it for a control worker only after confirming where the scanner executor runs.

### Render + Neon + R2: managed background worker

Render gives a clear background-worker and workflow shape. The modeled Pro workspace plus two small services starts around $39 before database and object storage. It is a credible alternative if the team values a continuous worker and managed deploys. Render's service price does not prove that untrusted scanner binaries are isolated; retain the current Sandbox or a separately validated Docker host.

### Cloudflare Workers + R2 + external Node worker: later edge front door

Cloudflare has excellent egress economics: Workers Paid starts at $5 and R2 Internet egress is free. It can eventually serve a stateless edge/API front door while a Node worker and PostgreSQL remain elsewhere. The current repository edge profile relies on authenticated HTTP state/CAS/blob gateways and cannot run the scanner or Eve Node path in the isolate. Hyperdrive is included, but Better Auth 1.7.5 plus Kysely 0.29.5 plus `kysely-postgres-js` 4.0.0 needs an explicit Hyperdrive/driver/transaction spike. Do not make this the Friday launch migration.

### Supabase Postgres and AWS S3: component alternatives

Supabase Pro is a useful managed Postgres alternative with backups, a Micro compute credit, pgvector extensions, and bundled quotas. Its $25 floor is close to Neon at launch, but compute class, PITR, extra projects, and egress can change the result. There is no tangible launch benefit in moving an existing Postgres state repository before the deadline.

S3 is the most neutral Files SDK target and is a good contingency for object storage. Its standard storage price is comparable with Vercel Blob, while R2 is cheaper for Internet egress. Choose S3 when compatibility, lifecycle controls, and region placement matter more than egress price; choose R2 after measuring download volume and validating signed delivery.

## Scale and migration triggers

These are proposed operational gates to validate with load tests; they are not claims about capacity already proven by the repository.

**Move scanner execution off Vercel Sandbox when any of the following persists for two billing periods or one release-critical week:**

- planned scans exceed 150/hour (75% of the listed 10-concurrent Pro sandbox envelope at a three-minute scan), or the queue's p95 age exceeds 6 hours;
- p95 scan duration exceeds 8 minutes, sandbox creation throttles, or any tenant misses the 24-hour evidence expiry window;
- the sandbox line exceeds 30% of monthly gross margin or exceeds the approved spend ceiling;
- a scan needs more than the bounded function/sandbox input, memory, or duration limits.

**Normalize PostgreSQL state before broad 1,000-team onboarding when measurements show pressure:**

- p95 `state_write_ms` exceeds 100 ms or p95 row-lock wait exceeds 250 ms for 15 minutes under representative load;
- a hot per-organization JSONB state row exceeds 256 KiB, or repeatedly exceeds 1 MiB after compaction;
- `PostgresStateRepository` write amplification or serialization causes queue age, auth latency, or scan lease renewal failures;
- pgvector search p95 exceeds 100 ms after tenant and vector indexes are present, or the embedding table approaches 1 million vectors without an ANN/index plan.

The current repository stores substantial per-organization state, including scans/jobs/grants/analytics collections, in a transactional JSONB row. Per-organization concurrency therefore serializes writes and row bytes grow with history. The first normalization targets should be scan/job lease rows, grants/entitlements, and analytics counters; keep the stable state-provider interface while moving hot collections to tables and adding targeted indexes. Run a representative multi-tenant load test before calling 1,000 teams supported.

**Move object delivery from Vercel Blob when:**

- measured monthly Internet download volume is above 100 GB and the private path creates material FDT/FOT charges;
- object storage or transfer exceeds 20% of hosting spend; or
- an S3/R2 lifecycle, retention, or regional data requirement becomes material.

The migration should be a Files SDK adapter/configuration change. Do not rewrite domain/API code.

## Risks and unresolved evidence

- **Scanner isolation cost is the largest unknown.** The model has measured-like CPU/memory assumptions but no production scan trace. Dedicated Docker/Fly/Railway/Render worker cost must be measured after a representative image is accepted. A lower control-plane number is not a lower total until that executor is priced.
- **Vercel private Blob delivery is path-sensitive.** Public direct hits, cached hits, and Function-mediated private responses have different transfer legs. Instrument cache misses and bytes before selecting a long-term storage provider.
- **AI spend is external and dynamic.** AI Gateway passes through provider list rates without markup; model and embedding prices change. Persist per-generation model, token counts, provider, and cost estimate so tenant usage can be capped.
- **PostgreSQL row shape is the scale risk.** Neon/Supabase pricing says little about lock contention from a whole-org JSONB transaction. The thresholds above need a load-test result and production telemetry.
- **Cloudflare edge is a separate runtime decision.** Nitro source portability does not establish that Better Auth, `postgres-js`, Kysely transactions, Eve, or scanner execution work inside Workers. Validate a small auth/read/write/streaming spike before committing to it.
- **AWS container/queue totals are deliberately unquoted.** Fargate/ECS, NAT, ALB, CloudWatch, and cross-region transfer depend on region and topology. An invented all-in AWS quote would be less useful than a measured worker trace.

## Reproducibility

From this directory:

```sh
node docs/business/hosting-cost-model.js
node docs/business/hosting-cost-model.js --csv
node --check docs/business/hosting-cost-model.js
```

The script contains the assumptions, provider unit prices, scenario quantities, AI token formula, and candidate subtotal calculations. Update the price card and rerun the artifact before approving spend; no account credentials or provider mutations are required.
