# Local authoring timeout review — 2026-09-16

This record investigates two authoring tests that timed out during an earlier
full-suite run. It was collected in the detached verification checkout
`/private/tmp/private-skills-business-billing-authoring-timeout-review` at
source commit `46d18aedcfb141d6c0ebaf78ea1a3ded5178fbf8` (`46d18ae`,
`fix(worker): carry metered reservation generations`). The checkout was clean
before and after verification. Node was `v24.20.0`, pnpm was `11.19.0`, and
dependencies came from `CI=true pnpm install --frozen-lockfile`.

## Original observations

The earlier full-suite run reported two failures:

| Test | Reported result |
| --- | --- |
| `packages/authoring/test/draft-delta.test.ts` — `keeps unchanged sealed bytes server-side and replays one CAS revision` | timed out at the 15,000 ms default test budget; Vitest reported 15,703 ms |
| `tests/e2e/authoring-large-delta.test.ts` — `keeps the 3.5 MiB file sealed while applying three small edits below the hosting cap and replaying CAS idempotently` | timed out at its 40,000 ms test budget; Vitest reported 45,495 ms |

That run reported 168 passed and 17 skipped files, 1,215 passed and 38
skipped tests, and two failures.

## Isolated reproduction

The existing timeout settings were left unchanged. Each failing test was run
by its exact file, then both files were run together:

| Command | Result |
| --- | --- |
| `node_modules/.bin/vitest run packages/authoring/test/draft-delta.test.ts --reporter=verbose` | 1 passed; test 2,788 ms; suite 3.10 s |
| `node_modules/.bin/vitest run tests/e2e/authoring-large-delta.test.ts --reporter=verbose` | 1 passed; test 22,587 ms; suite 23.39 s |
| `node_modules/.bin/vitest run packages/authoring/test/draft-delta.test.ts tests/e2e/authoring-large-delta.test.ts --reporter=verbose` | 2 passed; draft 3,622 ms, large delta 27,489 ms; suite 28.03 s |
| `node_modules/.bin/vitest run packages/authoring/test tests/e2e/authoring-large-delta.test.ts --reporter=verbose` | 31 passed; draft 3,831 ms, large delta 24,385 ms; suite 25.32 s |
| `node_modules/.bin/vitest run --reporter=verbose` | 1,217 passed and 38 skipped tests; 170 passed and 17 skipped files; suite 33.24 s |

A second normal full-suite run using the JSON reporter also passed all 1,217
tests and 38 skips. Its sanitized per-file timings were 5,447 ms for
`draft-delta.test.ts` and 27,394 ms for `authoring-large-delta.test.ts`.
The large test creates, hashes, seals, reads, and decodes a 3.5 MiB fixture;
its duration increased under suite concurrency but remained below its existing
40,000 ms budget in this checkout.

## Assessment and boundary

The timeout was not reproduced in the isolated checkout, by either test alone,
the two-file run, the authoring-focused suite, or the normal full suite. The
large byte-processing fixture shows measurable duration sensitivity under
concurrency, so transient host or process contention is a plausible
explanation for the earlier run. These checks do not prove that contention was
the original root cause, and no authoring runtime defect was demonstrated.

Commit `46d18ae` has no changes under `packages/authoring` or
`tests/e2e/authoring-large-delta.test.ts`; the authoring billing edits in the
separate runtime integration worktree were not modified. No timeout was
increased, no assertion was removed, and no source or test fix is warranted by
this evidence. Hosted/current-candidate acceptance is outside this local
timing review.
