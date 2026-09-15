# Vercel function duration budget

The Vercel build emits a `maxDuration` value in each Nitro serverless
function's `.vc-config.json`. The value is derived from the hosted worker and
tenant reviewer budgets, rounded up to whole seconds, and followed by a
bounded persistence headroom. The generated output is checked after Nitro
finishes and again after it is relocated to the repository-root
`.vercel/output` directory.

The defaults are a 240-second hosted worker budget and a 600-second reviewer
budget. The default headroom is 15 seconds, so the normal generated function
configuration is `maxDuration: 615`. Explicit lower dispatcher budgets are
honored: setting both runtime budgets to 240 seconds emits `maxDuration: 255`,
which fits the 300-second Hobby Fluid Compute limit with the 15-second
headroom. The same lower settings must be present at runtime; if an override
is absent, the source default is used and the immutable runtime guard rejects
the deployment when that default would exceed the generated function budget.

The build accepts these settings:

| Setting | Default | Bound | Purpose |
| --- | ---: | ---: | --- |
| `PSKILLS_HOSTED_WORKER_DISPATCH_MAX_DURATION_MS` | `240000` | `1000`–`900000` ms | Hosted worker runtime budget |
| `PSKILLS_REVIEW_DISPATCH_MAX_DURATION_MS` | `600000` | `1`–`840000` ms | Tenant reviewer runtime budget |
| `PSKILLS_VERCEL_FUNCTION_HEADROOM_SECONDS` | `15` | `5`–`120` s | Time reserved for lease/cursor persistence |
| `PSKILLS_VERCEL_PLAN_MAX_DURATION_SECONDS` | `800` | `1`–`1800` s | Operator-declared maximum for this Vercel plan/configuration |

The build fails when the required runtime budget plus headroom exceeds the
declared plan maximum. Set the plan value from the deployment's actual Vercel
configuration. Vercel's current duration documentation lists a 300-second
maximum for Hobby with Fluid Compute and an 800-second generally available
maximum for Pro and Enterprise; durations above 800 seconds require the
extended beta and Fluid Compute. The 1,800-second value is therefore an
explicit opt-in for an eligible Pro or Enterprise project, not a default.

At runtime, the Vercel build injects the generated duration and headroom into
the Node bundle. Hosted worker and reviewer setup rejects a runtime value that
would exceed the generated duration after headroom, including a source default
when a lower build-time override is missing. This prevents a runtime
environment change after the build from extending work past the immutable
function budget. Node/container and edge builds receive no Vercel value and
retain their normal portable runtime limits.

The duration setting is part of the Vercel Build Output API function config,
not a client-visible response or a secret. The authoritative platform
references are [Vercel function duration configuration](https://vercel.com/docs/functions/configuring-functions/duration),
[Vercel Build Output API function primitives](https://vercel.com/docs/build-output-api/primitives),
and [Nitro's Vercel function configuration guide](https://vercel.com/kb/guide/ship-a-nitro-app-on-vercel).
