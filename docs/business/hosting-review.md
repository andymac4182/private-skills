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

The launch identity boundary now composes Better Auth 1.7.5, the company-scoped API-token authenticator, and the tenant router in the Node runtime, using Kysely 0.29.5 and `kysely-postgres-js` 4.0.0 against the existing PostgreSQL database. Better Auth remains opt-in through the identity runtime configuration and the legacy fallback stays available while deployment configuration and live acceptance evidence are completed. Node is the low-risk runtime for that driver path.

Vercel Pro is $20/month with $20 of included usage credit. That covers the platform portion of a small launch and keeps deployment, CDN, Node functions, and the current sandbox integration in one operational surface. The cost model estimates **$34.94/month at one team**, **$650.19–$1,770.39/month at 100 teams**, and **$6,088.18–$17,290.18/month at 1,000 teams** for the Vercel, Neon, Blob, and bounded-scan vendor subtotal. With the default AI rate and an explicit operating-overhead allowance, the planning totals are **$85.14/month at launch**, **$820.49–$1,940.69/month at 100 teams**, and **$6,791.18–$17,993.18/month at 1,000 teams**. These figures use current Sydney list prices; workload, cache, scanner capacity, AI usage, and operating overhead remain assumptions.

The 1,000-team figure is a cost scenario, not a throughput claim. At one scan per active artifact per day, 1,000 teams create 900,000 sandbox runs/month, or about 1,250 runs/hour. With a three-minute base scan this averages 62.5 concurrent scans; the model reserves 125 worker slots with 2x headroom. Pro currently lists 10,000 concurrent sandboxes, so the modeled count is below the published account envelope, but queue age, scan freshness, spend, and image/startup behavior still require an acceptance load test. Treat 100 teams as the first serious capacity test and move scanning to a dedicated worker pool before the 24-hour freshness contract is at risk.

## Launch plan and controls

Before launch, keep the change set bounded to deployment and operational controls:

1. Deploy the existing Nitro Node build to Vercel Pro in the Sydney region where practical. Keep the state and storage provider settings on their gateway/Files SDK seams; do not move domain code to Vercel-only SDKs.
2. Use one Neon Launch project for shared multi-tenant Postgres. Set a deployment-level connection pool, tenant predicates, statement timeouts, and spend alerts. Do not create one database/project per team: the fixed per-project economics and operational surface would grow with every tenant.
3. Use the existing Files SDK Vercel Blob adapter for canonical bundles and reports if its private delivery path is acceptable. Keep object keys tenant-scoped and signed. Preserve the S3 and R2 adapters so high egress can be moved without changing the API.
4. Run the hosted worker route with `CRON_SECRET`, immutable scanner image/snapshot references, deny-all sandbox networking, and the current 2,000-file/10 MiB-file/100 MiB-expanded-input policy. Spread 24-hour scans across the day; do not schedule every tenant at one timestamp.
5. Put a spend ceiling and alerts on Vercel, Neon, and the object store. Record per-tenant `scan_count`, scan CPU/memory seconds, bundle bytes, object egress bytes, AI input/output tokens, and queue age. Cost attribution is needed before any provider switch is justified.
6. Keep a Node worker deployment recipe ready. It can claim the same PostgreSQL job rows and use the Docker scanner executor on a dedicated host once the concurrency trigger below fires. This is an incremental worker move, not a web/API rewrite.

## Workload assumptions

The model is a transparent planning baseline, not a provider quote. It uses a 30-day month and USD list prices checked on 15 September 2026. Source-verified inputs are the provider price cards and the composed Node/Better Auth/API-token/tenant-router architecture. There is no production telemetry in these rows: workload, private-cache behavior, scanner capacity, AI volume, and operating overhead are planning assumptions. The artifact is dependency-free and can be rerun with `node docs/business/hosting-cost-model.js`.

| Input | Launch | 100 teams | 1,000 teams |
|---|---:|---:|---:|
| Active artifacts per team | 30 | 30 | 30 |
| Scan freshness | 1 per artifact/day | 1 per artifact/day | 1 per artifact/day |
| Sandbox scans/month | 900 | 90,000 | 900,000 |
| API requests/team/month | 30,000 | 30,000 | 30,000 |
| API active CPU/request | 20 ms | 20 ms | 20 ms |
| API memory/request | 2 GB for 100 ms | 2 GB for 100 ms | 2 GB for 100 ms |
| API egress/team/month | 0.1 GB | 0.1 GB | 0.1 GB |
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

| Profile | Active CPU/scan | Wall time/scan | Portable worker memory |
|---|---:|---:|---:|
| Low | 0.5 min | 2 min | 2 GB |
| Base | 1 min | 3 min | 2 GB |
| High | 2 min | 6 min | 2 GB |

Vercel Sandbox cost uses allocated resources rather than observed RSS. The default model reserves 2 vCPUs and 4 GB (2 GB per vCPU) for each Sandbox profile, matching the provider default allocation conservatively; set `PSKILLS_HOSTING_VERCEL_SANDBOX_VCPUS=1` only after a deployment trace confirms that the adapter's one-vCPU request is honored. Provisioned memory is billed in at least one-minute increments. Portable worker capacity uses the 2 GB working-set assumption in the table and must be re-sized if a scanner image needs more.

Every scan is modeled as one sandbox creation and one simple Blob read; every publish is one advanced Blob operation. These operation counts are assumptions until request traces are available. Scanner output transfer is assumed to be 0.002 GB/scan, with 2x headroom for worker capacity. User downloads are assumed to be private function-mediated delivery with a 25% Blob cache-miss rate; the model includes the resulting Blob Data Transfer, Fast Data Transfer, and Fast Origin Transfer legs. It does not assume that every internal PostgreSQL read becomes public egress.

The model keeps durable queue jobs in PostgreSQL, as the repository does today. At the base workload there are 940 jobs/team/month; an eventual Vercel Queues adapter would still be below its 1M included API operations through 1,000 teams under these assumptions, but its event shape, retry semantics, and storage retention would need a separate acceptance test.

```text
AI monthly cost = input_tokens / 1e6 * input_USD_per_M
                + output_tokens / 1e6 * output_USD_per_M
                + embedding_tokens / 1e6 * embedding_USD_per_M
```

At the base workload, the model produces 0.4M input tokens, 0.1M output tokens, and 0.15M embedding tokens per team/month. The default source-checked rates are gpt-5.6-luna at $0.20/M input and $1.20/M output plus text-embedding-3-small at $0.02/M tokens, which is $0.203/team/month: $0.20 at launch, $20.30 at 100 teams, and $203 at 1,000 teams after rounding. Set `PSKILLS_HOSTING_AI_MODEL=gpt-5-mini` to use the model's alternate $0.25/M input and $2/M output rates. Vercel AI Gateway documents zero markup and a $5/month free credit, but that credit is account-level and the model reports provider spend before applying it.

The configurable inputs are `PSKILLS_HOSTING_PRIVATE_BLOB_FRACTION`, `PSKILLS_HOSTING_PRIVATE_BLOB_CACHE_MISS`, `PSKILLS_HOSTING_VERCEL_FLAT_RATE_CDN`, `PSKILLS_HOSTING_SCANNER_HEADROOM`, `PSKILLS_HOSTING_SCANNER_EGRESS_GB_PER_SCAN`, and the three `PSKILLS_HOSTING_OPS_OVERHEAD_*` variables. The default monthly operating-overhead allowance is $50/$150/$500 for launch/100/1,000 teams. It is a planning allowance for alerting, logs, incident response, image maintenance, and support time, not a provider charge.

## Known monthly cost scenarios

The full rows are in [hosting-cost-model.csv](./hosting-cost-model.csv), and the formulas are in [hosting-cost-model.js](./hosting-cost-model.js). All values below are USD/month before tax. Each row carries a provider subtotal, modelled AI spend, operating-overhead allowance, and scanner-capacity fields. The model marks Render and Supabase as floors because their scanner executor is not priced.

**Vercel stack subtotal with the modeled bounded Sandbox scanner:**

| Workload | Low scan profile | Base scan profile | High scan profile |
|---|---:|---:|---:|
| Launch, 1 team | **$34.94** | **$34.94** | **$34.94** |
| 100 teams | **$650.19** | **$963.99** | **$1,770.39** |
| 1,000 teams | **$6,088.18** | **$9,226.18** | **$17,290.18** |

These rows include Vercel Pro, Node function usage, Sydney Blob storage/operation/transfer legs, the bounded Sandbox scanner, and Neon Launch. The Pro credit is applied only to Vercel usage, not to Neon. The scan profiles are the low/base/high assumptions above.

**Vercel all-in planning total (provider subtotal + AI + operating overhead):**

| Workload | Low scan profile | Base scan profile | High scan profile | Base target worker slots |
|---|---:|---:|---:|---:|
| Launch, 1 team | **$85.14** | **$85.14** | **$85.14** | 1 |
| 100 teams | **$820.49** | **$1,134.29** | **$1,940.69** | 13 |
| 1,000 teams | **$6,791.18** | **$9,929.18** | **$17,993.18** | 125 |

**Portable scan-priced planning totals (base profile):**

| Candidate | Launch | 100 teams | 1,000 teams | Base scanner capacity | Basis |
|---|---:|---:|---:|---:|---|
| Fly Node + Neon + R2 + assumed Fly scanner | $96.34 | $482.41 | $3,162.41 | 1 / 13 / 125 warm units | One assumed 2 GB Fly worker per target slot |
| Cloudflare edge + Fly Node + Neon + R2 + assumed Fly scanner | $101.34 | $488.01 | $3,184.81 | 1 / 13 / 125 warm units | Edge front door plus the same assumed Fly worker |
| Railway Node + Neon + R2 + assumed Railway VM scanner | $235.24 | $2,236.47 | $19,990.85 | 1 / 13 / 125 warm units | Railway VM beta rate; isolation is not accepted |

Portable low/base/high rows are in the CSV. The Fly and Railway scanner lines are priced capacity assumptions rather than measured production traces; confirm image startup, memory, queueing, and egress with a representative scan before selecting a portable executor.

**Non-comparable control-plane floors:**

| Candidate | Launch | 100 teams | 1,000 teams | Excluded from the floor |
|---|---:|---:|---:|---|
| Render Node + Neon + R2 | $53.94 | $125.67 | $473.10 | Scanner executor, image distribution, retries, and AI |
| Supabase Pro + Micro | $25 | $27.13 | $55.25 | Larger compute, PITR, extra projects, scanner, object delivery, and AI |

The floor rows include the current control-plane prices and the modeled API bandwidth where applicable. Their all-in field is blank in the CSV because no accepted scanner executor is priced. AI and operating overhead are shown separately so a reviewer can see the missing components without mistaking a floor for a total.

The Vercel model now includes private Blob delivery as a path-sensitive calculation. With the default 100% private fraction and 25% cache-miss fraction, it counts Blob Data Transfer for store-to-function misses, Fast Data Transfer for the function-to-browser response, and Fast Origin Transfer for the store-to-function and function-to-browser legs, with the published Sydney allowances applied. Set the cache and private-fraction variables from observed traces before budgeting. `Private Data Transfer` is a separate Sydney SKU for static-IP/private-backend traffic and is not charged to the ordinary Blob path here.

## Price cards and source evidence

Prices were checked against official provider pages on 15 September 2026. The pages can change; the links are the source of truth before purchase. Prices are in USD and the model excludes VAT/GST/taxes.

The model's 15 September date is the source-check date, not a claim that every vendor page was published that day. The linked Vercel regional page currently shows a 13 February 2026 update, the Sandbox page a 2 September 2026 update, the Workers page a 28 August 2026 update, the R2 page a 7 August 2026 update, and the AI Gateway page a 10 February 2026 update. Railway, Render, Fly, Neon, Supabase, and OpenAI pages should be rechecked at purchase because their visible page dates and regional prices can change independently.

| Provider / component | Unit price or included amount used | Operational fact that affects this product | Source |
|---|---|---|---|
| Vercel Pro | $20/month + $20 included usage credit | Pro is the commercial team plan; credits are consumed across usage | [Vercel pricing](https://vercel.com/pricing) |
| Vercel Functions, Sydney (`syd1`) | $0.180/active CPU-hour; $0.0149/provisioned GB-hour; $0.60/1M invocations after 1M included | CPU pauses on I/O with Fluid Compute; memory remains billed while the instance lives | [Fluid Compute pricing](https://vercel.com/docs/functions/usage-and-pricing) |
| Vercel Node functions | 800 seconds GA max on Pro/Enterprise; up to 1,800 seconds (30 min) beta per function | A scan cannot be an unbounded request; use a job row plus a bounded sandbox | [Function duration](https://vercel.com/docs/functions/configuring-functions/duration) |
| Vercel Sandbox | Hobby quotas are 5 CPU-h, 420 GB-h memory, 5,000 creations, and 20 GB transfer; Pro meters all usage against its $20/month credit. Sydney `syd1` rates used here are $0.180/CPU-hour, $0.0298/GB-hour memory, $0.16/GB transfer, and $0.60/1M creations | Pro lists 10,000 concurrent sandboxes; the current worker is one-shot and deny-all network. Each vCPU includes 2 GB and provisioned memory has a one-minute minimum | [Sandbox pricing](https://vercel.com/docs/sandbox/pricing) and [Sydney regional pricing](https://vercel.com/docs/pricing/regional-pricing/syd1) |
| Vercel Blob | Sydney rates are $0.025/GB-month; $0.44/1M simple ops; $5.50/1M advanced ops; $0.053/GB Blob Data Transfer; the model applies 1 TB Fast Data Transfer and 10 GB Fast Origin Transfer allowances | Pro Blob is usage-based; private function-mediated delivery can add Blob transfer, FOT on store/function legs, and FDT on the browser response | [Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), [CDN usage](https://vercel.com/docs/manage-cdn-usage), and [Sydney regional pricing](https://vercel.com/docs/pricing/regional-pricing/syd1) |
| Vercel Queues (optional) | 1M API operations included; $0.60/1M after | Current durable job source is PostgreSQL; Queues would be a later adapter decision | [Vercel pricing](https://vercel.com/pricing) |
| Vercel AI Gateway | $5/month free credit; provider list prices with zero markup; the credit is account-level and may not apply after credits are purchased | The model reports provider spend before applying the account credit and keeps model selection configurable | [AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing) |
| OpenAI gpt-5.6-luna | $0.20/1M input tokens; $1.20/1M output tokens | Default planning model for cost-sensitive volume; provider rates and model availability can change | [OpenAI model catalog](https://developers.openai.com/api/docs/models) |
| OpenAI gpt-5-mini | $0.25/1M input tokens; $2/1M output tokens | Alternate model selected with `PSKILLS_HOSTING_AI_MODEL=gpt-5-mini` | [GPT-5 mini pricing](https://developers.openai.com/api/docs/models/gpt-5-mini) |
| OpenAI text-embedding-3-small | $0.02/1M input tokens | Default embedding assumption; persisted token counts are needed for tenant caps | [Embedding pricing](https://developers.openai.com/api/docs/models/text-embedding-3-small) |
| Cloudflare Workers Paid | $5/month/account; 10M requests and 30M CPU-ms included; then $0.30/1M requests and $0.02/1M CPU-ms; no egress/throughput fee | Paid invocation has up to 5 minutes CPU (default 30s); 128 MB isolate memory; Cron/Queue CPU max 15 min | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Cloudflare R2 Standard | $0.015/GB-month; $4.50/1M Class A; $0.36/1M Class B; 10 GB, 1M A, 10M B free monthly; internet egress free | Strong fit for high-download bundles if signed delivery can remain outside the API | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Cloudflare Hyperdrive | Included in Workers Paid; paid database queries unlimited (Free 100,000/day) | It does not make a Node `postgres-js`/Better Auth stack automatically edge-compatible; driver and transaction behavior need a spike | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Railway Hobby | $5/month subscription with a $5 resource-usage credit; RAM $10/GB-month; CPU $20/vCPU-month; egress $0.05/GB | The model charges the $5 subscription plus resource overage after the credit. Railway VM beta is $50/vCPU-month and $50/GB-month; scanner isolation is unaccepted | [Railway plans](https://docs.railway.com/pricing/plans) and [billing](https://docs.railway.com/pricing/understanding-your-bill) |
| Render | Pro workspace $25/month; small service from $7/month; 25 GB outbound bandwidth included then $0.15/GB | Background workers and Workflows are useful for queues, but scanner isolation still needs an accepted executor | [Render pricing](https://render.com/pricing) and [outbound bandwidth](https://render.com/docs/outbound-bandwidth) |
| Fly Machines | `shared-cpu-4x`/1 GB shown at $7.78/month; the assumed 2 GB scanner unit is $15.56/month; volumes $0.15/GB-month; Oceania egress $0.04/GB | Long-running Node/Docker worker is possible; scanner capacity is assumed warm units and backups, HA, and runbooks remain our responsibility | [Fly pricing](https://fly.io/pricing/) |
| Neon Launch | Usage based; $0.106/CU-hour, $0.35/GB-month storage, $0.20/GB-month history, 100 GB egress included then $0.10/GB; no monthly minimum; typical spend shown as about $15/month | Existing PostgreSQL/JSONB/pgvector shape maps directly; one shared project avoids per-tenant project fees | [Neon pricing](https://neon.com/pricing) and [usage-based pricing update](https://neon.com/blog/new-usage-based-pricing) |
| Neon Scale | $0.222/CU-hour and $0.35/GB-month storage on the pricing page; higher compute/restore/network controls | A later database tier decision; not assumed in the scenario model | [Neon pricing](https://neon.com/pricing) |
| Supabase Pro | $25/month; first project included; $10/month compute credit covers one Micro; 8 GB disk then $0.125/GB; 250 GB egress then $0.09/GB; cached egress then $0.03/GB | Good bundled Postgres alternative, but it does not remove the current worker/scanner and identity migration work | [Supabase pricing](https://supabase.com/pricing) |
| AWS S3 Standard | $0.023/GB-month reference; Standard GET $0.0004/1,000 and PUT/LIST $0.005/1,000 in the pricing examples; transfer is region/tier dependent | Best neutral Files SDK target; storage is cheap, but public Internet egress can dominate and exact region quote is required | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| AWS Lambda | $0.20/1M requests after 1M free; ARM duration first tier $0.0000133334/GB-second; 15-minute max timeout | Useful for small dispatchers, not a replacement for the current Nitro server or scanner worker | [Lambda pricing](https://aws.amazon.com/lambda/pricing/) and [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |

## Candidate assessment

### Vercel + Neon + Blob + Sandbox: launch choice

This path matches the current repository and its opt-in hosted identity/worker composition. Vercel supports Node 24, Fluid Compute, cron, and the current ComputeSDK/Sandbox adapter. The app can keep Better Auth, PostgreSQL, and object storage behind the existing runtime/provider interfaces. The main cost driver is not web/API traffic; it is daily sandbox execution and private object delivery once each active artifact must be rescanned within 24 hours.

Use spend management to pause or alert before an accidental scan loop consumes the Pro credit. Keep scanner reports and bytes out of user responses and third-party logs. Pin image digests/snapshot references, deny network by default, and write the completed evidence state only after the job's lease/fencing token is valid.

### Fly + Neon + R2: portable worker escape hatch

Fly has the lowest modeled fixed Node control-plane price and can run a long-lived process or container. It is a reasonable next step when a worker must poll PostgreSQL continuously or run Docker without Vercel request-duration limits. The model includes one assumed warm 2 GB scanner unit per target slot, so its portable total is reviewable while remaining explicitly unmeasured. The price table is region-selected, and production operation needs backups, multi-machine placement, deployment rollback, scanner image patching, and a failure drill.

### Railway + Neon + R2: simple Node operations

Railway is attractive for a small always-on Node API/worker and private service networking. Its Hobby plan is a $5 subscription with a $5 resource-usage credit; the model charges that subscription plus resource overage after the credit, including modeled API egress. The beta VM product is priced at $50/vCPU-month and $50/GB-month, so the model's warm scanner capacity is an explicit price sensitivity rather than an accepted scanner isolation solution. Use it for a control worker only after confirming where the scanner executor runs.

### Render + Neon + R2: managed background worker

Render gives a clear background-worker and workflow shape. The modeled Pro workspace plus two small services starts around $39 before database and object storage, with 25 GB of outbound bandwidth included. It is a credible control-plane alternative if the team values a continuous worker and managed deploys. Render's service price does not prove that untrusted scanner binaries are isolated, so its CSV row remains a floor and retains the current Sandbox or a separately validated Docker host.

### Cloudflare Workers + R2 + external Node worker: later edge front door

Cloudflare has excellent egress economics: Workers Paid starts at $5 and R2 Internet egress is free. It can eventually serve a stateless edge/API front door while a Node worker and PostgreSQL remain elsewhere. The current repository edge profile relies on authenticated HTTP state/CAS/blob gateways and cannot run the scanner or Eve Node path in the isolate. Hyperdrive is included, but Better Auth 1.7.5 plus Kysely 0.29.5 plus `kysely-postgres-js` 4.0.0 still needs an explicit Hyperdrive/driver/transaction spike. The model includes an assumed external Fly scanner; do not make this the Friday launch migration.

### Supabase Postgres and AWS S3: component alternatives

Supabase Pro is a useful managed Postgres alternative with backups, a Micro compute credit, pgvector extensions, and bundled quotas. Its $25 floor is close to Neon at launch, but compute class, PITR, extra projects, and egress can change the result. There is no tangible launch benefit in moving an existing Postgres state repository before the deadline.

S3 is the most neutral Files SDK target and is a good contingency for object storage. Its standard storage price is comparable with Vercel Blob, while R2 is cheaper for Internet egress. Choose S3 when compatibility, lifecycle controls, and region placement matter more than egress price; choose R2 after measuring download volume and validating signed delivery.

## Scale and migration triggers

These are proposed operational gates to validate with load tests; they are not claims about capacity already proven by the repository.

**Move scanner execution off Vercel Sandbox when any of the following persists for two billing periods or one release-critical week:**

- planned target concurrency exceeds 8,000 (80% of the published 10,000-concurrent Pro envelope), sandbox creation throttles, or the queue's p95 age exceeds 6 hours;
- p95 scan duration exceeds 8 minutes or any tenant misses the 24-hour evidence expiry window;
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

- **Scanner isolation cost is the largest unknown.** The model prices a bounded Vercel Sandbox from provider rates and prices Fly/Railway capacity from assumed warm units, but no production scan trace exists. Dedicated Docker/Fly/Railway/Render worker cost must be measured after a representative image is accepted. A lower control-plane number is not a lower total until that executor is priced.
- **Vercel private Blob delivery is path-sensitive.** The model includes Blob Data Transfer, Fast Data Transfer, and Fast Origin Transfer using an assumed 25% cache-miss fraction. Instrument cache misses, response bytes, and provider meter data before selecting a long-term storage provider.
- **AI spend is external and dynamic.** AI Gateway passes through provider list rates without markup; model and embedding prices change. The model uses gpt-5.6-luna by default and reports the account-level $5 gateway credit separately. Persist per-generation model, token counts, provider, and cost estimate so tenant usage can be capped.
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

To test an alternate AI or delivery assumption without editing source, set environment variables before the command, for example:

`PSKILLS_HOSTING_AI_MODEL=gpt-5-mini PSKILLS_HOSTING_PRIVATE_BLOB_CACHE_MISS=0.10 node docs/business/hosting-cost-model.js`

The script contains the assumptions, provider unit prices, scenario quantities, AI token formula, scanner-capacity formula, transfer legs, and candidate subtotal calculations. Update the source links and rerun the artifact before approving spend; no account credentials or provider mutations are required.
