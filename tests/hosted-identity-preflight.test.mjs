import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";

import {
  evaluateHostedIdentityPreflight,
  EXPECTED_CONFIG_NAMES,
  probeLoopbackIdentityConfig,
  probeLoopbackPostgres,
  parseConfigNamesInventory,
  verifyLocalGitSource,
} from "../scripts/hosted-identity-preflight.mjs";

const SOURCE_SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const PLAN_DIGEST = `sha256:${"0".repeat(64)}`;

const configNames = [
  "PSKILLS_ENVIRONMENT",
  "PSKILLS_ORGANIZATION_ID",
  "PSKILLS_BETTER_AUTH_ENABLED",
  "BETTER_AUTH_URL",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PSKILLS_BETTER_AUTH_AUTO_MIGRATE",
  "PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA",
  "PSKILLS_COMPANY_SSO_AUTO_MIGRATE",
  "PSKILLS_API_TOKEN_AUTO_MIGRATE",
  "PSKILLS_STATE_PROVIDER",
  "PSKILLS_STORAGE_PROVIDER",
  "BLOB_READ_WRITE_TOKEN",
  "PSKILLS_BOOTSTRAP_TOKENS",
  "PSKILLS_SESSION_SECRET",
];

function passingInput(overrides = {}) {
  return {
    sourceSha: SOURCE_SHA,
    expectedSourceSha: SOURCE_SHA,
    defaultOrganizationId: "default",
    environment: {
      name: "production",
      configNames,
      safeValues: {
        PSKILLS_ENVIRONMENT: "production",
        PSKILLS_ORGANIZATION_ID: "default",
        PSKILLS_BETTER_AUTH_ENABLED: "true",
        PSKILLS_BETTER_AUTH_AUTO_MIGRATE: "false",
        PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: "true",
        PSKILLS_COMPANY_SSO_AUTO_MIGRATE: "false",
        PSKILLS_API_TOKEN_AUTO_MIGRATE: "false",
        PSKILLS_STATE_PROVIDER: "postgres",
      },
    },
    schemaReadback: {
      status: "ready",
      betterAuthSchema: "public",
      migrationPlan: {
        reviewed: true,
        applied: true,
        planDigest: PLAN_DIGEST,
        tableNames: ["user", "account", "session", "verification", "organization", "member", "invitation", "rateLimit", "ssoProvider"],
      },
      tablesReadBack: true,
      companySso: { privateTableReadBack: true, mirrorReadBack: true, bindingMatch: true },
      serviceTokens: {
        tableReadBack: true,
        hashesPreserved: true,
        revocationFieldsReadBack: true,
        schemaCompatibility: "passed",
        tableSchema: "public",
        tableName: "private_skills_service_tokens",
      },
      registry: { tableReadBack: true, stateRevisionsReadBack: true },
      objects: { inventoryReadBack: true, digestsVerified: true },
    },
    adoption: {
      status: "passed",
      organizationId: "default",
      authenticatedBetterAuthUser: true,
      emailVerified: true,
      ownerProofVerified: true,
      membershipBound: true,
      atomic: true,
      markerRecorded: true,
      replaySafe: true,
      selectionSource: "server-configured",
      implicitSocialAdoption: false,
      emailDomainInference: false,
      browserHeaderSelection: false,
      firstUserInference: false,
    },
    backup: {
      status: "ready",
      domains: ["better-auth", "company-sso", "service-tokens", "billing", "registry", "objects"],
      consistentSnapshot: true,
      fenceActive: true,
      encrypted: true,
      secretValuesExcluded: true,
      objectDigestsVerified: true,
      legacyAccessPreserved: true,
    },
    rollback: {
      status: "ready",
      previousDeploymentAvailable: true,
      legacyPathRetained: true,
      legacySmokePassed: true,
      legacyAccessPreserved: true,
      additiveSchemaOnly: true,
      noDownMigration: true,
      forwardFixAllowed: true,
      fenceReleaseBlockedUntilMatrix: true,
    },
    twoCompany: {
      status: "passed",
      companyCount: 2,
      companies: [
        { sessionMembership: true, activeOrganization: true, serviceToken: true, ssoBinding: true, registryMetadata: true, sealedObject: true, search: true, workerJob: true },
        { sessionMembership: true, activeOrganization: true, serviceToken: true, ssoBinding: true, registryMetadata: true, sealedObject: true, search: true, workerJob: true },
      ],
      crossTenantDenials: {
        sessionMembership: true,
        activeOrganizationSwitch: true,
        serviceToken: true,
        ssoBinding: true,
        registryMetadata: true,
        sealedObject: true,
        search: true,
        workerJob: true,
      },
      sameDisplayNameFixture: true,
      providerCallbacks: true,
      legacyFallback: true,
      recordedWithoutSecrets: true,
    },
    liveChecks: {
      sourceRevision: verifyLocalGitSource({ root: process.cwd(), expectedSourceSha: SOURCE_SHA }),
    },
    ...overrides,
  };
}

test("passes only when complete sanitized evidence and a local Git check are present", () => {
  const report = evaluateHostedIdentityPreflight(passingInput());

  assert.equal(report.ready, true, JSON.stringify(report.blockers));
  assert.equal(report.configuredNameValuesPrinted, false);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.migrationOrder.slice(0, 5), [
    "fence-and-backup",
    "review-better-auth-plan",
    "apply-better-auth-schema",
    "apply-company-sso-schema-and-mirror",
    "prove-service-token-schema-compatibility",
  ]);
  assert.equal(JSON.stringify(report).includes("PLAN_DIGEST"), false);
  assert.equal(report.validatedEvidence.ready, true);
  assert.equal(report.verifiedLiveChecks.ready, true);
});

test("never treats evidence attestations as live readiness", () => {
  const report = evaluateHostedIdentityPreflight(passingInput({ liveChecks: undefined }));

  assert.equal(report.validatedEvidence.ready, true);
  assert.equal(report.verifiedLiveChecks.ready, false);
  assert.equal(report.ready, false);
  assert.equal(report.blockers.some(({ name }) => name === "local-git-source-revision"), true);
});

test("does not promote a manually asserted live-pass boolean into readiness", () => {
  const report = evaluateHostedIdentityPreflight(passingInput({
    liveChecks: {
      sourceRevision: {
        status: "pass",
        verified: true,
        kind: "git-rev-parse",
        actualSourceSha: SOURCE_SHA,
        detail: "forged live evidence",
      },
    },
  }));

  assert.equal(report.validatedEvidence.ready, true);
  assert.equal(report.verifiedLiveChecks.ready, false);
  assert.equal(report.blockers.some(({ name }) => name === "local-git-source-revision"), true);
});

test("keeps config inventory name-only when a source line contains an accidental value", () => {
  const names = parseConfigNamesInventory(`DATABASE_URL\tconfigured\nBETTER_AUTH_SECRET=accidental-secret\n${EXPECTED_CONFIG_NAMES.join(" ")}`);
  assert.equal(names.has("DATABASE_URL"), true);
  assert.equal(names.has("BETTER_AUTH_SECRET"), true);
  assert.equal(JSON.stringify([...names]).includes("accidental-secret"), false);
});

test("does not advertise ignored restore, test, or historical credential aliases", () => {
  const names = parseConfigNamesInventory([
    "PSKILLS_STORAGE_PREFIX",
    "PSKILLS_BILLING_POSTGRES_URL",
    "PSKILLS_SKILLS_SH_TOKEN",
    "PSKILLS_SKILLS_SH_FALLBACK_TOKEN",
    "PSKILLS_DIRECTORY_TOKEN",
    "API_TOKEN_SESSION_COOKIE",
  ].join("\n"));

  for (const name of [
    "PSKILLS_STORAGE_PREFIX",
    "PSKILLS_BILLING_POSTGRES_URL",
    "PSKILLS_SKILLS_SH_TOKEN",
    "PSKILLS_SKILLS_SH_FALLBACK_TOKEN",
    "PSKILLS_DIRECTORY_TOKEN",
    "API_TOKEN_SESSION_COOKIE",
  ]) {
    assert.equal(names.has(name), false, `${name} must not be treated as a hosted runtime setting`);
  }
});

test("holds activation while B27 token-schema compatibility remains unresolved", () => {
  const input = passingInput({
    schemaReadback: {
      ...passingInput().schemaReadback,
      serviceTokens: { ...passingInput().schemaReadback.serviceTokens, schemaCompatibility: "held" },
    },
  });
  const report = evaluateHostedIdentityPreflight(input);

  assert.equal(report.ready, false);
  assert.deepEqual(report.blockers.find(({ name }) => name === "b27-token-schema-compatibility"), {
    name: "b27-token-schema-compatibility",
    status: "blocked",
    detail: "B27 remains held; custom Better Auth schema may move existing token lookup",
  });
});

test("rejects adoption selected by a browser header or email-domain inference", () => {
  const baseline = passingInput().adoption;
  const report = evaluateHostedIdentityPreflight(passingInput({
    adoption: { ...baseline, selectionSource: "request-header", browserHeaderSelection: true },
  }));

  assert.equal(report.ready, false);
  assert.equal(report.blockers.some(({ name }) => name === "explicit-default-organization-adoption"), true);
});

test("requires legacy access evidence before allowing a reversible identity switch", () => {
  const report = evaluateHostedIdentityPreflight(passingInput({
    environment: { ...passingInput().environment, configNames: configNames.filter((name) => name !== "PSKILLS_BOOTSTRAP_TOKENS") },
  }));

  assert.equal(report.ready, false);
  assert.equal(report.blockers.some(({ name }) => name === "legacy-access-configuration"), true);
});

test("does not accept secret-bearing safe-value files", () => {
  assert.throws(
    () => evaluateHostedIdentityPreflight(passingInput({
      environment: { ...passingInput().environment, safeValues: { BETTER_AUTH_SECRET: "secret" } },
    })),
    /safeValues contains an unsupported key/u,
  );
});

test("runs the public identity-config probe only against the exact loopback route", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      protocolVersion: 1,
      enabled: true,
      basePath: "/api/auth",
      providers: [],
      organization: { enabled: true },
      bootstrap: { requiresExplicitOwnerClaim: true, implicitSocialTenantAdoption: false },
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await probeLoopbackIdentityConfig(`http://127.0.0.1:${address.port}/auth/identity/config`);
    assert.equal(result.status, "pass");
    assert.equal(result.verified, true);
    const rejected = await probeLoopbackIdentityConfig("https://identity.example.test/auth/identity/config");
    assert.equal(rejected.status, "blocked");
    assert.equal(rejected.verified, false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("refuses a non-loopback PostgreSQL probe before loading a database client", async () => {
  const result = await probeLoopbackPostgres("postgres://db.example.test/private-skills");
  assert.equal(result.status, "blocked");
  assert.equal(result.verified, false);
  assert.match(result.detail, /loopback/u);
});

test("CLI emits a sanitized blocked report and no evidence values", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-skills-identity-preflight-"));
  try {
    const namesPath = join(root, "vercel-env-names.txt");
    const safePath = join(root, "safe-values.json");
    const evidencePath = join(root, "evidence.json");
    await writeFile(namesPath, "PSKILLS_BOOTSTRAP_TOKENS\nPSKILLS_SESSION_SECRET\n", "utf8");
    await writeFile(safePath, JSON.stringify({ PSKILLS_ENVIRONMENT: "production" }), "utf8");
    await writeFile(evidencePath, JSON.stringify({ backup: { status: "blocked", privateNote: "do-not-print" } }), "utf8");

    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [
        "scripts/hosted-identity-preflight.mjs",
        "--config-names-file", namesPath,
        "--safe-values-file", safePath,
        "--evidence-file", evidencePath,
        "--source-sha", SOURCE_SHA,
        "--expected-source-sha", SOURCE_SHA,
        "--json",
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    });

    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes("do-not-print"), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.readOnly, true);
    assert.equal(report.configuredNameValuesPrinted, false);
    assert.equal(report.ready, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runbook keeps the operator command read-only and ordered around B27", async () => {
  const document = await readFile("docs/business/hosted-identity-preflight.md", "utf8");

  assert.match(document, /vercel env ls production/u);
  assert.match(document, /vercel env pull/u);
  assert.match(document, /B27/u);
  assert.match(document, /owner-authenticated/u);
  assert.match(document, /two-company/u);
  for (const step of ["Fence registry writes", "Generate the Better Auth plan", "Apply the reviewed company SSO schema", "Prove service-token schema compatibility", "Read back registry state", "Switch traffic only after"]) {
    assert.match(document, new RegExp(step, "u"));
  }
});
