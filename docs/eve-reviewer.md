# Eve common-skill reviewer

`apps/reviewer` is a separate Eve 0.52.3 application. It runs one bounded,
authenticated daily review and records proposals for a human to inspect. The
reviewer cannot publish or merge skills, edit source, install packages, or run
candidate content.

## Runtime surface

The app has only two authored tools and no Eve connections, skills, sandbox, or
default built-in tools (`defaultTools: false`):

- `prepare_review` calls the fixed deployment endpoint
  `${PSKILLS_REGISTRY_API_URL}/internal/reviewer/prepare`.
- `submit_review` calls the fixed deployment endpoint
  `${PSKILLS_REGISTRY_API_URL}/internal/reviewer/complete`.

The model cannot choose the destination URL. The API helper rejects endpoint
paths outside those two routes, rejects credentials/query data in the base URL,
requires HTTPS outside loopback development, bounds request/response bodies,
rejects redirects, and uses a 45-second request timeout. Candidate `SKILL.md`
text is quoted comparison data and is never loaded as Eve instructions or a
tool. `submit_review` accepts only `skillIds` returned by the current prepared
snapshot; the registry API remains authoritative for artifact digests, leases,
and candidate identity. Candidate selection, organization authorization, and
semantic-search/indexing policy remain root API responsibilities; this app has
no catalog index or arbitrary search connection.

`prepare_review` keeps the `runId`, `leaseToken`, and candidate snapshot in Eve
durable private state using `defineState(name, initial)`, `get()`, and
`update(current => next)`. The lease token is never returned in a tool result
or included in model-visible instructions. A completed or already-completed
run does not write a second proposal. An empty candidate set returns without a
completion write; the API's short-lived lease expiry handles that no-op run.

The agent limit is 10 minutes per session, 100,000 input tokens, 10,000 output
tokens, and USD 0.50 of model token cost. The tools also limit preparation to
two calls and submission to one call. No `agent/instrumentation.ts` is authored,
so Eve's default local traces contain metadata rather than candidate content;
the deployment must keep content export disabled in its runtime observability
configuration.

## Authentication

`agent/channels/eve.ts` replaces the default channel auth with a constant-time
comparison of a static production bearer token. It returns a service principal
only for a matching token and never enables Eve's `placeholderAuth`, local-dev
auth, or anonymous production access. `GET /eve/v1/health` is Eve's public
health probe; the info and session routes require the bearer token.

The internal reviewer token is separate from the Eve route token. Keep both in
the deployment secret store. Do not place either token in candidate text, a
model prompt, a URL, or a client bundle.

## Configuration

All of the following are runtime environment variables unless noted otherwise.

| Variable | Required | Meaning |
| --- | --- | --- |
| `PSKILLS_EVE_API_TOKEN` | yes | Bearer token accepted by Eve session/info routes. |
| `PSKILLS_REGISTRY_API_URL` | yes | Root API origin/base path. The reviewer appends only the two fixed internal paths. HTTPS is required in production. |
| `PSKILLS_REVIEWER_TOKEN` | yes | Service bearer sent to the root reviewer routes. |
| `PSKILLS_REVIEW_MODEL` | no | Gateway `provider/model` id; defaults to `openai/gpt-5.6-luna`. |
| `PSKILLS_REVIEW_CRON` | no | Five-field UTC cron expression; defaults to `0 22 * * *` (08:00 Australia/Brisbane). Changing it requires a rebuild because Eve discovers schedules during the build. |
| `AI_GATEWAY_API_KEY` | one Gateway credential | Standard AI SDK Gateway API key. |
| `VERCEL_OIDC_TOKEN` | Vercel alternative | Used by `@ai-sdk/gateway` when no API key is supplied in a linked Vercel deployment. |
| `PSKILLS_AI_GATEWAY_BASE_URL` | no | Explicit Gateway base URL for a controlled deployment or loopback test. HTTPS is required in production; credentials, query strings, and fragments are rejected. |
| `PSKILLS_AI_GATEWAY_TEAM_ID` | no | Optional Vercel team id/slug passed to the Gateway for scoped credentials. |

The model id is deployment configuration, not model input. The agent selects
the string at `session.started`; at `step.started` it creates an AI SDK Gateway
`LanguageModel` with the configured base URL and credential. Eve 0.52.3 permits
live `LanguageModel` values at step scope, which is the supported way to apply a
custom Gateway base URL without inventing an Eve environment variable. With no
custom base URL, the AI SDK Gateway default is used. OIDC remains available by
leaving `AI_GATEWAY_API_KEY` unset in a Vercel-linked runtime.

## Scheduling and manual runs

The authored schedule is `agent/schedules/daily-review.ts`:

```text
0 22 * * *  (UTC)  =  08:00 Australia/Brisbane
```

Each schedule fire starts a new Eve session with a fixed prompt. The prompt
requires exactly one preparation and at most one bounded submission. The root
tool sends the deterministic idempotency key `common-skill-review:YYYY-MM-DD`
(UTC); the root API owns the daily claim and must keep retries for that day
idempotent, so a retry cannot create a second lease or proposal.

At `session.started`, the reviewer records a bounded invocation audit in Eve
durable state before model work begins. The hook uses the framework-owned
`channel.kind === "schedule"` signal; the authored `daily-review` name is
fixed by the schedule file. The prepare tool sends the same safe metadata with
the existing Eve session ID to the root API. Other session channels and
principals, including manual API sessions, are recorded as `source: "api"`.
Each invocation gets an application-generated opaque ID and an
application-observed ISO timestamp. Eve 0.52.3 does not expose the provider
cron request ID through the
public authored context, so the generated ID is never presented as one. Review
runs retain this bounded provenance alongside `eveSessionId`; active and
completed idempotent duplicates keep the original claimant, while failed or
expired lease reclamation records the new claimant. Provider execution logs
still need to be paired with the persisted session and run IDs before claiming
a calendar-triggered production run.

The provenance hook also emits one-line `private-skills.reviewer.invocation`
records for scheduled sessions. Each record contains only the opaque Eve
session, invocation, stream-event, and optional run IDs; the fixed schedule
identity; the bounded phase/status; and ISO timestamps (plus a failure code
`session_failed` when the session fails). Eve exposes failure codes as open
strings, so the original code is deliberately not copied. `started`, `status`,
`completed`, and `failed` phases
make the provider runtime log a discovery surface when no `ReviewRun` exists.
The record deliberately omits Eve state, prompts, messages, candidate text,
reports, credentials, and tool payloads. These logs must still be paired with
the authenticated Eve stream and registry metadata before asserting a causal
scheduled run.

The invocation audit lives in Eve's durable session state until `prepare_review`
calls the root API. The root `ReviewRun` record is created only after a
nonempty approved snapshot is claimed, so a scheduled session that never calls
the tool, or a no-candidate invocation, may have no corresponding review row;
provider session/workflow metadata remains necessary for that evidence.

The durable audit distinguishes a response with an existing run ID and no
candidates (`not_claimed`, because another session owns the active lease) from
a response with no run ID (`no_candidates`, because the approved snapshot was
empty). Both keep the existing public `prepare_review` result shape. A failed
prepare request is recorded as `request_failed`; a completion request whose
response is lost is recorded as `submission_uncertain`, because the remote
completion may already have committed. A cached prepare does not erase that
uncertainty. The one-call submission budget prevents an automatic repost or
reconciliation in the same session; authoritative API/run data must resolve
the outcome. A known successful completion RPC records `completed`.

An authenticated backend can start the same fixed prompt through Eve's Client
SDK. The caller, not the model, supplies the host and bearer token:

```ts
import { Client } from "eve/client";

const client = new Client({
  host: process.env.PSKILLS_EVE_ORIGIN!,
  auth: { bearer: () => process.env.PSKILLS_EVE_API_TOKEN! },
  redirect: "error",
});

await client.health();
const { response } = await client.sessions.create({
  message: "Run the daily common-skill review. Call prepare_review once, compare only its returned candidates, and submit bounded proposals once.",
});
const result = await response.result();
console.log({ sessionId: response.sessionId, result });
```

`Client` is a server-side control surface. Do not expose the token or this
manual trigger in the browser.

## Build and run

From `apps/reviewer`:

```bash
pnpm typecheck
pnpm build
pnpm start
```

`eve build` writes the compiled agent and schedule into the app's `.eve/` and
`.output/` artifacts. Vercel or a self-hosted runtime must provide the runtime
secrets above; a build-time placeholder is not an authentication strategy.
