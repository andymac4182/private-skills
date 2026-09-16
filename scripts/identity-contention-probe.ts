/**
 * Measure the Better Auth organization-write serialization boundary locally.
 *
 * This probe intentionally uses four independent runtime instances against a
 * disposable loopback PostgreSQL schema. A single runtime's lock connection
 * has max=1, so multiple instances are required to observe PostgreSQL advisory
 * waiters instead of only measuring a client-side queue. The workload uses
 * Better Auth's real invitation and member-role routes; it never contacts an
 * OAuth provider, sends email, or mutates a hosted database.
 *
 * The result is a bounded launch probe, not a capacity claim. It reports the
 * exact number of instances, companies, operations, and the observed lock
 * samples so a larger deployment can repeat the measurement with its own
 * connection and latency profile.
 */

import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

import { makeSignature } from 'better-auth/crypto';
import postgres from 'postgres';

import {
  createIdentityRuntime,
  createIdentityRuntimeConfig,
  IDENTITY_ORGANIZATION_MUTATION_LOCK_KEY,
  type IdentityRuntimeAdmin,
} from '../packages/identity/src/index.js';
import { loopbackDatabaseURL } from '../packages/identity/test/loopback-database.js';

type SqlClient = ReturnType<typeof postgres>;

const BASE_URL = 'http://localhost:5173';
const RUNTIME_COUNT = 4;
const INVITATIONS_PER_SINGLE_COMPANY = 16;
const INVITATION_COMPANY_COUNT = 8;
const INVITATIONS_PER_COMPANY = 2;
const DEMOTION_COMPANY_COUNT = 8;
const OWNERS_PER_DEMOTION_COMPANY = 4;
const LOCK_SAMPLE_INTERVAL_MS = 2;

const databaseURL = loopbackDatabaseURL(
  ['PSKILLS_IDENTITY_CONTENTION_DATABASE_URL', process.env.PSKILLS_IDENTITY_CONTENTION_DATABASE_URL],
  ['PSKILLS_IDENTITY_TEST_DATABASE_URL', process.env.PSKILLS_IDENTITY_TEST_DATABASE_URL],
);

if (!databaseURL) {
  throw new Error('Set PSKILLS_IDENTITY_CONTENTION_DATABASE_URL to a loopback PostgreSQL URL');
}

interface SeedPrincipal {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly token: string;
  readonly memberId: string;
  readonly sessionId: string;
}

interface OrganizationFixture {
  readonly id: string;
  readonly owners: readonly SeedPrincipal[];
}

interface OperationJob {
  readonly kind: 'invitation' | 'demotion';
  readonly organizationId: string;
  readonly principal: SeedPrincipal;
  readonly body: Record<string, unknown>;
  readonly runtimeIndex: number;
}

interface OperationResult {
  readonly durationMs: number;
  readonly status: number | null;
  readonly exception: boolean;
}

interface LockSample {
  readonly elapsedMs: number;
  readonly granted: number;
  readonly waiting: number;
  readonly maxWaitMs: number;
  readonly queryMs: number;
}

interface WorkloadResult {
  readonly name: string;
  readonly operations: number;
  readonly runtimeInstances: number;
  readonly companyCount: number;
  readonly elapsedMs: number;
  readonly throughputPerSecond: number;
  readonly latencyMs: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
    readonly mean: number;
  };
  readonly outcomes: {
    readonly statusCounts: Readonly<Record<string, number>>;
    readonly exceptions: number;
  };
  readonly advisoryLock: {
    readonly maxGranted: number;
    readonly maxWaiting: number;
    readonly samplesWithWaiters: number;
    readonly sampleCount: number;
    readonly maxObservedWaitMs: number;
  };
}

interface ProbeEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'private-skills.identity-write-contention-probe';
  readonly observedAt: string;
  readonly source: {
    readonly gitRevision: string;
    readonly runtime: 'Better Auth organization plugin through IdentityRuntime.handler';
    readonly database: 'loopback PostgreSQL only';
    readonly databaseHost: 'localhost' | '127.0.0.1' | '::1';
    readonly schemaEphemeral: true;
    readonly hostedProviderCalls: 0;
    readonly emailDeliveries: 0;
    readonly productionMutation: false;
  };
  readonly configuration: {
    readonly runtimeInstances: number;
    readonly advisoryLockKey: number;
    readonly lockSampleIntervalMs: number;
    readonly connectionPoolPerRuntime: 'Better Auth max=10; lock pool max=1';
  };
  readonly workload: {
    readonly invitationSingleCompany: {
      readonly companies: number;
      readonly invitationsPerCompany: number;
      readonly route: '/api/auth/organization/invite-member';
    };
    readonly invitationManyCompanies: {
      readonly companies: number;
      readonly invitationsPerCompany: number;
      readonly route: '/api/auth/organization/invite-member';
    };
    readonly ownerDemotionManyCompanies: {
      readonly companies: number;
      readonly ownersPerCompany: number;
      readonly route: '/api/auth/organization/update-member-role';
      readonly targetRole: 'reader';
    };
  };
  readonly results: readonly WorkloadResult[];
  readonly invariants: {
    readonly invitationSingleCompanyPending: number;
    readonly invitationManyCompanyPendingByCompany: Readonly<Record<string, number>>;
    readonly ownerCountByCompany: Readonly<Record<string, number>>;
    readonly ownerDemotionExceptions: number;
    readonly ownerDemotionSuccessfulResponses: number;
    readonly ownerDemotionDeniedResponses: number;
    readonly allCompaniesRetainedOneOwner: true;
  };
  readonly interpretation: {
    readonly globalAdvisoryLockSerializesOrganizationWrites: true;
    readonly crossCompanyWritesShareTheSameLockKey: true;
    readonly observedCapacityClaim: false;
    readonly recommendation: string;
  };
  readonly limits: readonly string[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1));
  return round(values[index]!);
}

function statusCounts(results: readonly OperationResult[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const key = result.status === null ? 'exception' : String(result.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function tableFor(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function principalFor(prefix: string, index: number): SeedPrincipal {
  const stable = `${prefix}-${index}`;
  return {
    id: `${stable}-user`,
    name: `Contention ${stable}`,
    email: `${stable}@example.test`,
    token: `${stable}-session-token`,
    memberId: `${stable}-member`,
    sessionId: `${stable}-session`,
  };
}

async function seedOrganization(
  sql: SqlClient,
  schema: string,
  organization: OrganizationFixture,
  now: Date,
  expiresAt: Date,
): Promise<void> {
  const table = (name: string) => tableFor(schema, name);
  await sql.unsafe(
    `insert into ${table('organization')} ("id","name","slug","createdAt") values ($1,$2,$3,$4)`,
    [organization.id, `Contention ${organization.id}`, organization.id, now],
  );
  for (const principal of organization.owners) {
    await sql.unsafe(
      `insert into ${table('user')} ("id","name","email","emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,$4,$4)`,
      [principal.id, principal.name, principal.email, now],
    );
    await sql.unsafe(
      `insert into ${table('member')} ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'owner',$4)`,
      [principal.memberId, organization.id, principal.id, now],
    );
    await sql.unsafe(
      `insert into ${table('session')} ("id","expiresAt","token","createdAt","updatedAt","userId","activeOrganizationId") values ($1,$2,$3,$4,$4,$5,$6)`,
      [principal.sessionId, expiresAt, principal.token, now, principal.id, organization.id],
    );
  }
}

async function signCookies(
  runtime: IdentityRuntimeAdmin,
  principals: readonly OrganizationFixture[],
): Promise<ReadonlyMap<string, string>> {
  const context = await runtime.auth.$context;
  const cookieName = context.authCookies.sessionToken.name;
  const allPrincipals = principals.flatMap((organization) => organization.owners);
  const values = await Promise.all(allPrincipals.map(async (principal) => [
    principal.token,
    `${cookieName}=${principal.token}.${await makeSignature(principal.token, context.secret)}`,
  ] as const));
  return new Map(values);
}

function requestFor(cookie: string, path: string, body: Record<string, unknown>): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: BASE_URL,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function advisoryLockSample(sql: SqlClient): Promise<Omit<LockSample, 'elapsedMs'>> {
  const started = performance.now();
  const rows = await sql.unsafe<Array<{
    granted?: number | string;
    waiting?: number | string;
    max_wait_ms?: number | string;
  }>>(
    `select
       count(*) filter (where lock.granted)::int as granted,
       count(*) filter (where not lock.granted)::int as waiting,
       coalesce(max(extract(epoch from clock_timestamp() - activity.query_start) * 1000) filter (where not lock.granted), 0)::float8 as max_wait_ms
     from pg_locks lock
     left join pg_stat_activity activity on activity.pid = lock.pid
     where lock.locktype = 'advisory'
       and lock.classid = 0
       and lock.objid = $1`,
    [IDENTITY_ORGANIZATION_MUTATION_LOCK_KEY],
  );
  const row = rows[0] ?? {};
  return {
    granted: Number(row.granted ?? 0),
    waiting: Number(row.waiting ?? 0),
    maxWaitMs: round(Number(row.max_wait_ms ?? 0)),
    queryMs: round(performance.now() - started),
  };
}

async function startLockMonitor(sql: SqlClient): Promise<{
  readonly samples: LockSample[];
  stop(): Promise<void>;
}> {
  const samples: LockSample[] = [];
  let running = true;
  const started = performance.now();
  const loop = (async () => {
    while (running) {
      try {
        const sample = await advisoryLockSample(sql);
        samples.push({ ...sample, elapsedMs: round(performance.now() - started) });
      } catch {
        // A sampling miss is recorded by its absence; it must not affect the
        // identity result or turn a successful write into an auth failure.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_SAMPLE_INTERVAL_MS));
    }
  })();
  return {
    samples,
    async stop(): Promise<void> {
      running = false;
      await loop;
    },
  };
}

async function runWorkload(
  label: string,
  jobs: readonly OperationJob[],
  runtimes: readonly IdentityRuntimeAdmin[],
  sql: SqlClient,
  cookies: ReadonlyMap<string, string>,
  companyCount: number,
): Promise<{ result: WorkloadResult; operationResults: readonly OperationResult[] }> {
  const baseline = await advisoryLockSample(sql);
  if (baseline.granted !== 0 || baseline.waiting !== 0) {
    throw new Error('The local database already has an identity advisory lock; run the probe in isolation');
  }
  const monitor = await startLockMonitor(sql);
  const started = performance.now();
  const operationResults = await Promise.all(jobs.map(async (job): Promise<OperationResult> => {
    const operationStarted = performance.now();
    try {
      const cookie = cookies.get(job.principal.token);
      if (!cookie) throw new Error('missing session fixture');
      const response = await runtimes[job.runtimeIndex]!.handler(requestFor(cookie, job.kind === 'invitation'
        ? '/api/auth/organization/invite-member'
        : '/api/auth/organization/update-member-role', job.body));
      await response.arrayBuffer();
      return {
        durationMs: round(performance.now() - operationStarted),
        status: response.status,
        exception: false,
      };
    } catch {
      return {
        durationMs: round(performance.now() - operationStarted),
        status: null,
        exception: true,
      };
    }
  }));
  const elapsedMs = performance.now() - started;
  await monitor.stop();
  const durations = operationResults.map((result) => result.durationMs).sort((left, right) => left - right);
  const maxGranted = Math.max(0, ...monitor.samples.map((sample) => sample.granted));
  const maxWaiting = Math.max(0, ...monitor.samples.map((sample) => sample.waiting));
  const maxObservedWaitMs = Math.max(0, ...monitor.samples.map((sample) => sample.maxWaitMs));
  const exceptions = operationResults.filter((result) => result.exception).length;
  const result: WorkloadResult = {
    name: label,
    operations: operationResults.length,
    runtimeInstances: runtimes.length,
    companyCount,
    elapsedMs: round(elapsedMs),
    throughputPerSecond: round(operationResults.length / Math.max(elapsedMs / 1000, 0.001)),
    latencyMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: round(durations.at(-1) ?? 0),
      mean: round(durations.reduce((total, value) => total + value, 0) / Math.max(durations.length, 1)),
    },
    outcomes: {
      statusCounts: statusCounts(operationResults),
      exceptions,
    },
    advisoryLock: {
      maxGranted,
      maxWaiting,
      samplesWithWaiters: monitor.samples.filter((sample) => sample.waiting > 0).length,
      sampleCount: monitor.samples.length,
      maxObservedWaitMs,
    },
  };
  return { result, operationResults };
}

async function pendingInvitationCount(sql: SqlClient, schema: string, organizationId: string): Promise<number> {
  const rows = await sql.unsafe<Array<{ count?: number | string }>>(
    `select count(*)::int as count from ${tableFor(schema, 'invitation')} where "organizationId" = $1 and "status" = 'pending'`,
    [organizationId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function ownerCount(sql: SqlClient, schema: string, organizationId: string): Promise<number> {
  const rows = await sql.unsafe<Array<{ count?: number | string }>>(
    `select count(*)::int as count from ${tableFor(schema, 'member')} where "organizationId" = $1 and "role" = 'owner'`,
    [organizationId],
  );
  return Number(rows[0]?.count ?? 0);
}

function invitationJobs(
  organizations: readonly OrganizationFixture[],
  invitationsPerCompany: number,
): OperationJob[] {
  return organizations.flatMap((organization, organizationIndex) => {
    const principal = organization.owners[0]!;
    return Array.from({ length: invitationsPerCompany }, (_, invitationIndex) => ({
      kind: 'invitation' as const,
      organizationId: organization.id,
      principal,
      body: {
        email: `invite-${organizationIndex}-${invitationIndex}@example.test`,
        role: 'reader',
        organizationId: organization.id,
      },
      runtimeIndex: (organizationIndex * invitationsPerCompany + invitationIndex) % RUNTIME_COUNT,
    }));
  });
}

function demotionJobs(organizations: readonly OrganizationFixture[]): OperationJob[] {
  return organizations.flatMap((organization) => organization.owners.map((principal, ownerIndex) => ({
    kind: 'demotion' as const,
    organizationId: organization.id,
    principal,
    body: {
      role: 'reader',
      memberId: principal.memberId,
      organizationId: organization.id,
    },
    runtimeIndex: (organizations.indexOf(organization) * OWNERS_PER_DEMOTION_COMPANY + ownerIndex) % RUNTIME_COUNT,
  })));
}

function makeOrganization(prefix: string, index: number, owners: number): OrganizationFixture {
  const id = `${prefix}-${index}`;
  return {
    id,
    owners: Array.from({ length: owners }, (_, ownerIndex) => principalFor(`${id}-owner`, ownerIndex)),
  };
}

async function runProbe(): Promise<ProbeEvidence> {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const schema = `identity_contention_${runId}`;
  const direct = postgres(databaseURL!, { max: 32, prepare: false });
  const secret = randomBytes(32).toString('base64url');
  const config = createIdentityRuntimeConfig({
    PSKILLS_BETTER_AUTH_ENABLED: 'true',
    DATABASE_URL: databaseURL,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: BASE_URL,
    PSKILLS_BETTER_AUTH_SCHEMA: schema,
    PSKILLS_BETTER_AUTH_VALIDATE_SCHEMA: 'false',
  });
  const runtimes = Array.from({ length: RUNTIME_COUNT }, () => createIdentityRuntime(config));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
  const singleOrganization = makeOrganization(`b31-${runId}-single`, 0, 1);
  const invitationOrganizations = Array.from({ length: INVITATION_COMPANY_COUNT }, (_, index) => makeOrganization(`b31-${runId}-invite`, index, 1));
  const demotionOrganizations = Array.from({ length: DEMOTION_COMPANY_COUNT }, (_, index) => makeOrganization(`b31-${runId}-demote`, index, OWNERS_PER_DEMOTION_COMPANY));
  const allOrganizations = [singleOrganization, ...invitationOrganizations, ...demotionOrganizations];
  try {
    await direct.unsafe('set client_min_messages = warning');
    await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
    await runtimes[0]!.runMigrations();
    for (const organization of allOrganizations) {
      await seedOrganization(direct, schema, organization, now, expiresAt);
    }
    const cookies = await signCookies(runtimes[0]!, allOrganizations);

    const singleInvitationRun = await runWorkload(
      'invitations-one-company',
      invitationJobs([singleOrganization], INVITATIONS_PER_SINGLE_COMPANY),
      runtimes,
      direct,
      cookies,
      1,
    );
    const manyInvitationRun = await runWorkload(
      'invitations-eight-companies',
      invitationJobs(invitationOrganizations, INVITATIONS_PER_COMPANY),
      runtimes,
      direct,
      cookies,
      invitationOrganizations.length,
    );
    const demotionRun = await runWorkload(
      'owner-demotions-eight-companies',
      demotionJobs(demotionOrganizations),
      runtimes,
      direct,
      cookies,
      demotionOrganizations.length,
    );

    const invitationSinglePending = await pendingInvitationCount(direct, schema, singleOrganization.id);
    const invitationManyPendingEntries = await Promise.all(invitationOrganizations.map(async (organization, index) => [
      `company-${index}`,
      await pendingInvitationCount(direct, schema, organization.id),
    ] as const));
    const ownerEntries = await Promise.all(demotionOrganizations.map(async (organization, index) => [
      `company-${index}`,
      await ownerCount(direct, schema, organization.id),
    ] as const));
    const ownerCountByCompany = Object.fromEntries(ownerEntries);
    const ownerDemotionResults = demotionRun.operationResults;
    const ownerDemotionExceptions = ownerDemotionResults.filter((result) => result.exception).length;
    const ownerDemotionSuccessfulResponses = ownerDemotionResults.filter((result) => result.status === 200).length;
    const ownerDemotionDeniedResponses = ownerDemotionResults.filter((result) => result.status !== 200).length;
    if (invitationSinglePending !== INVITATIONS_PER_SINGLE_COMPANY) {
      throw new Error('single-company invitation invariant failed');
    }
    if (invitationManyPendingEntries.some(([, count]) => count !== INVITATIONS_PER_COMPANY)) {
      throw new Error('multi-company invitation invariant failed');
    }
    if (Object.values(ownerCountByCompany).some((count) => count !== 1)) {
      throw new Error('owner demotion invariant failed');
    }
    if (ownerDemotionExceptions !== 0 || ownerDemotionSuccessfulResponses !== DEMOTION_COMPANY_COUNT * (OWNERS_PER_DEMOTION_COMPANY - 1)) {
      throw new Error('owner demotion response invariant failed');
    }

    let databaseHost: 'localhost' | '127.0.0.1' | '::1' = 'localhost';
    try {
      databaseHost = new URL(databaseURL!).hostname as typeof databaseHost;
    } catch {
      // loopbackDatabaseURL already validated this; keep the evidence shape closed.
    }
    return {
      schemaVersion: 1,
      kind: 'private-skills.identity-write-contention-probe',
      observedAt: new Date().toISOString(),
      source: {
        gitRevision: process.env.PSKILLS_IDENTITY_CONTENTION_REVISION?.trim() || 'unspecified',
        runtime: 'Better Auth organization plugin through IdentityRuntime.handler',
        database: 'loopback PostgreSQL only',
        databaseHost,
        schemaEphemeral: true,
        hostedProviderCalls: 0,
        emailDeliveries: 0,
        productionMutation: false,
      },
      configuration: {
        runtimeInstances: RUNTIME_COUNT,
        advisoryLockKey: IDENTITY_ORGANIZATION_MUTATION_LOCK_KEY,
        lockSampleIntervalMs: LOCK_SAMPLE_INTERVAL_MS,
        connectionPoolPerRuntime: 'Better Auth max=10; lock pool max=1',
      },
      workload: {
        invitationSingleCompany: {
          companies: 1,
          invitationsPerCompany: INVITATIONS_PER_SINGLE_COMPANY,
          route: '/api/auth/organization/invite-member',
        },
        invitationManyCompanies: {
          companies: INVITATION_COMPANY_COUNT,
          invitationsPerCompany: INVITATIONS_PER_COMPANY,
          route: '/api/auth/organization/invite-member',
        },
        ownerDemotionManyCompanies: {
          companies: DEMOTION_COMPANY_COUNT,
          ownersPerCompany: OWNERS_PER_DEMOTION_COMPANY,
          route: '/api/auth/organization/update-member-role',
          targetRole: 'reader',
        },
      },
      results: [singleInvitationRun.result, manyInvitationRun.result, demotionRun.result],
      invariants: {
        invitationSingleCompanyPending: invitationSinglePending,
        invitationManyCompanyPendingByCompany: Object.fromEntries(invitationManyPendingEntries),
        ownerCountByCompany,
        ownerDemotionExceptions,
        ownerDemotionSuccessfulResponses,
        ownerDemotionDeniedResponses,
        allCompaniesRetainedOneOwner: true,
      },
      interpretation: {
        globalAdvisoryLockSerializesOrganizationWrites: true,
        crossCompanyWritesShareTheSameLockKey: true,
        observedCapacityClaim: false,
        recommendation: 'Keep the shared advisory lock for the small launch; size runtime and database pools from a larger deployment-specific probe before increasing tenant or write concurrency.',
      },
      limits: [
        'Local loopback PostgreSQL only; no hosted database, OAuth provider, or email transport was contacted.',
        'Four runtime instances, eight companies, 32 demotion writes, and 16 invitation writes are a representative contention sample, not a 1000-tenant capacity test.',
        'Latency includes local Node, PostgreSQL, and Better Auth work and should not be compared directly with hosted production latency.',
        'maxObservedWaitMs is the sampled pg_stat_activity.query_start age for ungranted advisory locks, not an exact per-request lock-wait timer.',
        'The advisory-lock monitor samples pg_locks every 2ms and can under-sample very short waits; sampling adds small query overhead.',
      ],
    };
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await direct.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
    await direct.end();
  }
}

const evidence = await runProbe();
const outputPath = process.env.PSKILLS_IDENTITY_CONTENTION_EVIDENCE_PATH?.trim();
if (outputPath) await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
