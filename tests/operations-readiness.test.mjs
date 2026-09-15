import assert from "node:assert/strict";
import { test } from "node:test";

import { validateOperationsReadiness } from "../scripts/validate-operations-readiness.mjs";

test("operations runbook matches the current Better Auth and billing boundaries", async () => {
  const report = await validateOperationsReadiness();

  assert.equal(
    report.ok,
    true,
    report.checks.filter(({ ok }) => !ok).map(({ name, detail }) => `${name}: ${detail}`).join("\n"),
  );
  assert.equal(report.auditedRevision, "4016c4b024e13fb55b1cf1375bc998330a3ad0c1");
  assert.ok(report.checks.some(({ name }) => name === "better-auth-schema"));
  assert.ok(report.checks.some(({ name }) => name === "billing-schema"));
  assert.ok(report.checks.some(({ name }) => name === "restore-boundary"));
  assert.ok(report.limitations.some((limitation) => limitation.includes("read-only")));
  assert.ok(report.limitations.some((limitation) => limitation.includes("Better Auth PostgreSQL")));
});
