import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const auditedRevision = "4016c4b024e13fb55b1cf1375bc998330a3ad0c1";

const requiredFiles = [
  "docs/business/operations-readiness.md",
  "docs/identity.md",
  "packages/identity/src/index.ts",
  "packages/identity/src/company-sso-repository.ts",
  "packages/api-tokens/src/index.ts",
  "packages/database/src/postgres.ts",
  "packages/billing/src/repository.ts",
  "packages/storage/src/files.ts",
  "packages/storage/src/node.ts",
  "docs/restore-rehearsal.md",
  "docs/operations.md",
  "docs/eve-reviewer.md",
  "apps/reviewer/agent/lib/config.ts",
  "docs/business/launch-acceptance.md",
];

const check = (name, ok, detail) => ({ name, ok, detail });

async function readSources(root) {
  const entries = await Promise.all(
    requiredFiles.map(async (relativePath) => [
      relativePath,
      await readFile(resolve(root, relativePath), "utf8"),
    ]),
  );
  return new Map(entries);
}

function includesAll(text, values) {
  return values.every((value) => text.includes(value));
}

/**
 * Check that the operations runbook still describes the current source
 * boundaries. This deliberately performs no network, database, provider, or
 * application-data operation.
 */
export async function validateOperationsReadiness({ root = repositoryRoot } = {}) {
  const sources = await readSources(root);
  const document = sources.get("docs/business/operations-readiness.md");
  const identity = sources.get("packages/identity/src/index.ts");
  const companySso = sources.get("packages/identity/src/company-sso-repository.ts");
  const apiTokens = sources.get("packages/api-tokens/src/index.ts");
  const registry = sources.get("packages/database/src/postgres.ts");
  const billing = sources.get("packages/billing/src/repository.ts");
  const storage = sources.get("packages/storage/src/files.ts");
  const storageNode = sources.get("packages/storage/src/node.ts");
  const restore = sources.get("docs/restore-rehearsal.md");
  const launchAcceptance = sources.get("docs/business/launch-acceptance.md");
  const eveConfig = sources.get("apps/reviewer/agent/lib/config.ts");
  const eveDocs = sources.get("docs/eve-reviewer.md");

  const betterAuthModels = [
    "`user`",
    "`account`",
    "`session`",
    "`verification`",
    "`organization`",
    "`member`",
    "`invitation`",
    "`rateLimit`",
  ];
  const billingSuffixes = [
    "_customers",
    "_subscriptions",
    "_usage",
    "_webhook_events",
    "_usage_operations",
  ];

  const currentAcceptanceReferences = launchAcceptance.includes("apps/web/src/tenant-identity-route.postgres.integration.test.ts")
    && launchAcceptance.includes("tests/e2e/multi-tenant-postgres-acceptance.test.ts");
  const historicalAcceptanceReferences = launchAcceptance.includes("m3-better-auth-tenant-acceptance.md")
    && launchAcceptance.includes("multi-tenant-better-auth-acceptance.test.ts");

  const checks = [
    check(
      "audited-revision",
      document.includes(auditedRevision),
      `runbook records ${auditedRevision}`,
    ),
    check(
      "no-release-decision",
      /no release on operations evidence/i.test(document),
      "runbook keeps hosted multi-tenant operations evidence open",
    ),
    check(
      "luna-model",
      eveConfig.includes('"openai/gpt-5.6-luna"') && eveDocs.includes("openai/gpt-5.6-luna") && document.includes("openai/gpt-5.6-luna"),
      "runbook and Eve sources retain the configured Luna model default",
    ),
    check(
      "better-auth-schema",
      includesAll(document, betterAuthModels) && document.includes("`ssoProvider`") && identity.includes("getIdentityMigrations") && identity.includes("runMigrations") && identity.includes("rateLimit"),
      "runbook names the current Better Auth planner and configured model set",
    ),
    check(
      "company-sso-schema",
      document.includes("private_skills_company_sso_providers") && document.includes("ssoProvider") && document.includes("01a3650") && companySso.includes("DEFAULT_COMPANY_SSO_TABLE") && companySso.includes("organization_id"),
      "runbook names the private SSO table and the adopted Better Auth mirror boundary",
    ),
    check(
      "service-token-schema",
      document.includes("private_skills_service_tokens") && apiTokens.includes("private_skills_service_tokens") && apiTokens.includes("organization_id") && apiTokens.includes("autoMigrate"),
      "runbook names the separate tenant-scoped service-token schema",
    ),
    check(
      "registry-schema",
      document.includes("private_skills_registry_state") && registry.includes("private_skills_registry_state") && registry.includes("state jsonb"),
      "runbook names the per-organization registry state table",
    ),
    check(
      "billing-schema",
      includesAll(document, billingSuffixes.map((suffix) => `private_skills_billing${suffix}`)) && includesAll(billing, billingSuffixes) && billing.includes("organization_id"),
      "runbook and billing source retain all five billing table boundaries",
    ),
    check(
      "restore-boundary",
      document.includes("registry-only") && /not a tenant backup/i.test(document) && document.includes("Better Auth") && document.includes("billing") && restore.includes("allowUnscanned: true"),
      "runbook distinguishes registry/object recovery from identity and billing recovery",
    ),
    check(
      "object-provider-proof",
      document.includes("files-sdk/fs")
        && document.includes("FilesSdkBlobStore.getVerified")
        && document.includes("local filesystem provider")
        && storage.includes("class FilesSdkBlobStore")
        && storage.includes("getVerified")
        && storageNode.includes('case "fs"')
        && storageNode.includes("files-sdk/fs")
        && storageNode.includes("createNodeFilesClient"),
      "runbook records the real Files SDK filesystem provider and verified restored-byte readback",
    ),
    check(
      "authorization-restore-checks",
      document.includes("getSession") && document.includes("membership") && document.includes("tenant or service mismatch") && document.includes("sealed"),
      "runbook requires restored session, membership, tenant-binding, and object checks",
    ),
    check(
      "migration-safety",
      document.includes("expand/contract") && document.includes("forward fix") && document.includes("rateLimit"),
      "runbook covers additive migration, forward-fix, and rate-limit recovery decisions",
    ),
    check(
      "billing-replay-safety",
      document.includes("idempotency") && document.includes("unbound events") && document.includes("webhook"),
      "runbook preserves billing event and usage reservation replay boundaries",
    ),
    check(
      "scanner-and-eve-gates",
      document.includes("required scanner") && document.includes("Eve") && document.includes("publish policy"),
      "runbook keeps scanner admission and Eve publication bounded during recovery",
    ),
    check(
      "acceptance-reference-status",
      document.includes("2bbfe28") && document.includes("reference gap is recorded as resolved") && (currentAcceptanceReferences || historicalAcceptanceReferences),
      currentAcceptanceReferences
        ? "launch checklist points at the current PostgreSQL acceptance tests"
        : "audited launch checklist still has historical links; the runbook records their resolved replacement",
    ),
  ];

  const limitations = [
    "read-only source/document check; no network, credentials, provider calls, database writes, or application-data mutation",
    "live Better Auth PostgreSQL migration and schema readback are not proven when the opt-in integration database environment is absent",
    "billing provider, webhook reconciliation, and Eve cost reservation integration are not proven by this validator",
    "the local PostgreSQL/Files SDK rehearsal and its hosted/runtime counterparts are not executed by this read-only validator",
  ];

  return {
    ok: checks.every(({ ok }) => ok),
    auditedRevision,
    checks,
    limitations,
  };
}

function printHuman(report) {
  for (const result of report.checks) {
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}\n`);
  }
  process.stdout.write(`operations-readiness: ${report.ok ? "PASS" : "FAIL"} (${report.auditedRevision})\n`);
  for (const limitation of report.limitations) process.stdout.write(`LIMITATION ${limitation}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const report = await validateOperationsReadiness();
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`operations-readiness: ERROR ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
