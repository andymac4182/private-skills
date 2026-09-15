/*
 * Private Skills hosting cost model.
 *
 * This is a dependency-free planning model. Provider prices are current USD
 * list prices checked on 2026-09-15; workload, cache, worker-capacity, AI,
 * and operating-overhead values are explicit planning assumptions. Recheck
 * the linked provider sources before approving spend.
 *
 * Run:
 *   node docs/business/hosting-cost-model.js
 *   node docs/business/hosting-cost-model.js --csv
 *
 * The model deliberately keeps provider adapters separate. A portable row is
 * complete only when its scanner executor is priced; Render and Supabase rows
 * remain non-comparable control-plane floors until an accepted executor is
 * measured.
 */

import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const PRICE_CHECKED_ON = "2026-09-15";
const DAYS = 30;
const HOURS_PER_MONTH = DAYS * 24;

const priceSources = {
  vercelPricing: "https://vercel.com/pricing",
  vercelSydney: "https://vercel.com/docs/pricing/regional-pricing/syd1",
  vercelRegional: "https://vercel.com/docs/pricing/regional-pricing",
  vercelBlob: "https://vercel.com/docs/vercel-blob/usage-and-pricing",
  vercelSandbox: "https://vercel.com/docs/sandbox/pricing",
  vercelCdn: "https://vercel.com/docs/manage-cdn-usage",
  vercelAiGateway: "https://vercel.com/docs/ai-gateway/pricing",
  railwayPlans: "https://docs.railway.com/pricing/plans",
  railwayBilling: "https://docs.railway.com/pricing/understanding-your-bill",
  renderPricing: "https://render.com/pricing",
  renderBandwidth: "https://render.com/docs/outbound-bandwidth",
  flyPricing: "https://fly.io/pricing/",
  cloudflareWorkers: "https://developers.cloudflare.com/workers/platform/pricing/",
  cloudflareR2: "https://developers.cloudflare.com/r2/pricing/",
  neonPricing: "https://neon.com/pricing",
  neonNoMinimum: "https://neon.com/blog/new-usage-based-pricing",
  supabasePricing: "https://supabase.com/pricing",
  s3Pricing: "https://aws.amazon.com/s3/pricing/",
  openAiModels: "https://developers.openai.com/api/docs/models",
  openAiGpt5Mini: "https://developers.openai.com/api/docs/models/gpt-5-mini",
  openAiEmbeddingSmall:
    "https://developers.openai.com/api/docs/models/text-embedding-3-small",
};

const prices = {
  vercel: {
    proBase: 20,
    usageCredit: 20,
    functionCpuSydneyPerHour: 0.18,
    functionMemorySydneyPerGbHour: 0.0149,
    functionInvocationsPerMillion: 0.6,
    functionIncludedInvocations: 1_000_000,
    sandboxCpuSydneyPerHour: 0.18,
    sandboxMemorySydneyPerGbHour: 0.0298,
    sandboxDataTransferSydneyPerGb: 0.16,
    // These are Hobby quotas. Pro meters all Sandbox usage against its
    // monthly credit, so the Pro billing model uses zero included units.
    sandboxHobbyIncludedCpuHours: 5,
    sandboxHobbyIncludedMemoryGbHours: 420,
    sandboxHobbyIncludedCreations: 5_000,
    sandboxHobbyIncludedDataTransferGb: 20,
    sandboxIncludedCpuHours: 0,
    sandboxIncludedMemoryGbHours: 0,
    sandboxIncludedCreations: 0,
    sandboxIncludedDataTransferGb: 0,
    sandboxCreationsPerMillion: 0.6,
    blobStoragePerGbMonth: 0.025,
    blobSimpleOpsPerMillion: 0.44,
    blobAdvancedOpsPerMillion: 5.5,
    blobTransferPerGb: 0.053,
    fastDataTransferSydneyPerGb: 0.16,
    fastDataTransferIncludedGb: 1_000,
    fastOriginTransferSydneyPerGb: 0.29,
    fastOriginTransferIncludedGb: 10,
    privateDataTransferSydneyPerGb: 0.197,
    aiGatewayFreeCredit: 5,
    sandboxConcurrentPro: 10_000,
  },
  neon: {
    launchCuHour: 0.106,
    storagePerGbMonth: 0.35,
    historyPerGbMonth: 0.2,
    egressIncludedGb: 100,
    egressPerGb: 0.1,
  },
  r2: {
    standardStoragePerGbMonth: 0.015,
    classAOpsPerMillion: 4.5,
    classBOpsPerMillion: 0.36,
    includedStorageGbMonths: 10,
    includedClassAOps: 1_000_000,
    includedClassBOps: 10_000_000,
  },
  s3: {
    standardStoragePerGbMonth: 0.023,
    getPerThousand: 0.0004,
    putPerThousand: 0.005,
    internetEgressIncludedGb: 100,
    internetEgressReferencePerGb: 0.09,
  },
  railway: {
    hobbySubscription: 5,
    hobbyUsageCredit: 5,
    // Kept as an alias for callers of the earlier model.
    hobbyBase: 5,
    cpuPerVcpuMonth: 20,
    memoryPerGbMonth: 10,
    networkEgressPerGb: 0.05,
    vmCpuPerVcpuMonth: 50,
    vmMemoryPerGbMonth: 50,
    vmNetworkEgressPerGb: 0.05,
    vmScannerCpuVcpu: 1,
    vmScannerMemoryGb: 2,
  },
  render: {
    proWorkspace: 25,
    smallService: 7,
    includedBandwidthGb: 25,
    bandwidthPerGb: 0.15,
  },
  fly: {
    // Two shared-cpu-4x/1 GB machines at $7.78/month each.
    controlMachinesPerMonth: 15.56,
    twoSharedCpu4x1GbMachinesPerMonth: 15.56,
    // One shared-cpu-8x/2 GB machine, used as an assumed warm scan worker.
    scannerUnitPerMonth: 15.56,
    scannerUnitMemoryGb: 2,
    networkEgressPerGb: 0.04,
  },
  cloudflare: {
    workersPaidBase: 5,
    includedRequests: 10_000_000,
    requestsPerMillion: 0.3,
    includedCpuMs: 30_000_000,
    cpuMsPerMillion: 0.02,
  },
  supabase: {
    proBase: 25,
    includedDiskGb: 8,
    diskPerGbMonth: 0.125,
    includedUncachedEgressGb: 250,
    uncachedEgressPerGb: 0.09,
    includedCachedEgressGb: 250,
    cachedEgressPerGb: 0.03,
  },
};

const aiRates = {
  "gpt-5.6-luna": {
    inputUsdPerMillion: 0.2,
    outputUsdPerMillion: 1.2,
    source: priceSources.openAiModels,
  },
  "gpt-5-mini": {
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 2,
    source: priceSources.openAiGpt5Mini,
  },
};

const embeddingRates = {
  "text-embedding-3-small": {
    usdPerMillion: 0.02,
    source: priceSources.openAiEmbeddingSmall,
  },
};

const planningAssumptions = Object.freeze({
  aiModel: "gpt-5.6-luna",
  embeddingModel: "text-embedding-3-small",
  // Product artifacts are private by default. Change these for a public CDN
  // or measured cache pattern; they are not provider-measured values.
  privateBlobDeliveryFraction: 1,
  privateBlobCacheMissFraction: 0.25,
  // false is a conservative usage-based stress case. Flat Rate CDN changes
  // FDT treatment and must be confirmed for the account before purchase.
  vercelFlatRateCdn: false,
  scannerHeadroom: 2,
  scannerConcurrencyPerUnit: 1,
  scannerUnitMemoryGb: 2,
  scannerEgressGbPerScan: 0.002,
  // The provider allocates two GB per vCPU. Use the provider's two-vCPU
  // default conservatively until a deployment trace proves a one-vCPU
  // request is consistently honored by the adapter.
  vercelSandboxVcpus: 2,
  vercelSandboxMemoryGbPerVcpu: 2,
  vercelSandboxMemoryMinimumMinutes: 1,
  operatingOverheadUsd: Object.freeze({
    "launch-1-team": 50,
    "growth-100-teams": 150,
    "scale-1000-teams": 500,
  }),
});

const scanProfiles = {
  // memoryGb is the portable worker working-set assumption. Vercel Sandbox
  // billing uses the allocated vCPU-derived memory in sandboxCost below.
  low: { cpuMinutes: 0.5, wallMinutes: 2, memoryGb: 2 },
  base: { cpuMinutes: 1, wallMinutes: 3, memoryGb: 2 },
  high: { cpuMinutes: 2, wallMinutes: 6, memoryGb: 2 },
};

const scenarios = [
  {
    id: "launch-1-team",
    label: "Launch",
    teams: 1,
    apiRequestsPerTeam: 30_000,
    apiCpuSeconds: 0.02,
    apiWallSeconds: 0.1,
    apiMemoryGb: 2,
    apiEgressGbPerTeam: 0.1,
    activeArtifactsPerTeam: 30,
    scansPerArtifactPerDay: 1,
    publishesPerTeam: 30,
    importsPerTeam: 10,
    artifactStorageGbPerTeam: 0.5,
    dbStorageGbPerTeam: 0.25,
    dbHistoryGbPerTeam: 0.05,
    dbCuHours: 140,
    dbEgressGbPerTeam: 0.1,
    downloadsGbPerTeam: 1,
    aiCallsPerTeam: 200,
    aiInputTokensPerCall: 2_000,
    aiOutputTokensPerCall: 500,
    embeddingCallsPerTeam: 30,
    embeddingTokensPerCall: 5_000,
  },
  {
    id: "growth-100-teams",
    label: "100 teams",
    teams: 100,
    apiRequestsPerTeam: 30_000,
    apiCpuSeconds: 0.02,
    apiWallSeconds: 0.1,
    apiMemoryGb: 2,
    apiEgressGbPerTeam: 0.1,
    activeArtifactsPerTeam: 30,
    scansPerArtifactPerDay: 1,
    publishesPerTeam: 30,
    importsPerTeam: 10,
    artifactStorageGbPerTeam: 0.5,
    dbStorageGbPerTeam: 0.25,
    dbHistoryGbPerTeam: 0.05,
    dbCuHours: 720,
    dbEgressGbPerTeam: 0.1,
    downloadsGbPerTeam: 1,
    aiCallsPerTeam: 200,
    aiInputTokensPerCall: 2_000,
    aiOutputTokensPerCall: 500,
    embeddingCallsPerTeam: 30,
    embeddingTokensPerCall: 5_000,
  },
  {
    id: "scale-1000-teams",
    label: "1,000 teams",
    teams: 1_000,
    apiRequestsPerTeam: 30_000,
    apiCpuSeconds: 0.02,
    apiWallSeconds: 0.1,
    apiMemoryGb: 2,
    apiEgressGbPerTeam: 0.1,
    activeArtifactsPerTeam: 30,
    scansPerArtifactPerDay: 1,
    publishesPerTeam: 30,
    importsPerTeam: 10,
    artifactStorageGbPerTeam: 0.5,
    dbStorageGbPerTeam: 0.25,
    dbHistoryGbPerTeam: 0.05,
    dbCuHours: 3_000,
    dbEgressGbPerTeam: 0.1,
    downloadsGbPerTeam: 1,
    aiCallsPerTeam: 200,
    aiInputTokensPerCall: 2_000,
    aiOutputTokensPerCall: 500,
    embeddingCallsPerTeam: 30,
    embeddingTokensPerCall: 5_000,
  },
];

const dollars = (value) => Number(value.toFixed(2));
const over = (value, included) => Math.max(0, value - included);

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(name + " must be a finite number");
  }
  return value;
}

function envBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(name + " must be true or false");
}

function assertFraction(name, value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(name + " must be between 0 and 1");
  }
}

function resolveAssumptions(overrides = {}) {
  const overrideOverhead = overrides.operatingOverheadUsd ?? {};
  const assumptions = {
    ...planningAssumptions,
    aiModel: process.env.PSKILLS_HOSTING_AI_MODEL ?? planningAssumptions.aiModel,
    embeddingModel:
      process.env.PSKILLS_HOSTING_EMBEDDING_MODEL ??
      planningAssumptions.embeddingModel,
    privateBlobDeliveryFraction: envNumber(
      "PSKILLS_HOSTING_PRIVATE_BLOB_FRACTION",
      planningAssumptions.privateBlobDeliveryFraction,
    ),
    privateBlobCacheMissFraction: envNumber(
      "PSKILLS_HOSTING_PRIVATE_BLOB_CACHE_MISS",
      planningAssumptions.privateBlobCacheMissFraction,
    ),
    vercelFlatRateCdn: envBoolean(
      "PSKILLS_HOSTING_VERCEL_FLAT_RATE_CDN",
      planningAssumptions.vercelFlatRateCdn,
    ),
    scannerHeadroom: envNumber(
      "PSKILLS_HOSTING_SCANNER_HEADROOM",
      planningAssumptions.scannerHeadroom,
    ),
    scannerConcurrencyPerUnit: envNumber(
      "PSKILLS_HOSTING_SCANNER_CONCURRENCY_PER_UNIT",
      planningAssumptions.scannerConcurrencyPerUnit,
    ),
    scannerUnitMemoryGb: envNumber(
      "PSKILLS_HOSTING_SCANNER_UNIT_MEMORY_GB",
      planningAssumptions.scannerUnitMemoryGb,
    ),
    scannerEgressGbPerScan: envNumber(
      "PSKILLS_HOSTING_SCANNER_EGRESS_GB_PER_SCAN",
      planningAssumptions.scannerEgressGbPerScan,
    ),
    vercelSandboxVcpus: envNumber(
      "PSKILLS_HOSTING_VERCEL_SANDBOX_VCPUS",
      planningAssumptions.vercelSandboxVcpus,
    ),
    vercelSandboxMemoryGbPerVcpu: envNumber(
      "PSKILLS_HOSTING_VERCEL_SANDBOX_MEMORY_GB_PER_VCPU",
      planningAssumptions.vercelSandboxMemoryGbPerVcpu,
    ),
    vercelSandboxMemoryMinimumMinutes: envNumber(
      "PSKILLS_HOSTING_VERCEL_SANDBOX_MEMORY_MINUTES",
      planningAssumptions.vercelSandboxMemoryMinimumMinutes,
    ),
    operatingOverheadUsd: {
      ...planningAssumptions.operatingOverheadUsd,
      "launch-1-team": envNumber(
        "PSKILLS_HOSTING_OPS_OVERHEAD_LAUNCH_USD",
        planningAssumptions.operatingOverheadUsd["launch-1-team"],
      ),
      "growth-100-teams": envNumber(
        "PSKILLS_HOSTING_OPS_OVERHEAD_100_USD",
        planningAssumptions.operatingOverheadUsd["growth-100-teams"],
      ),
      "scale-1000-teams": envNumber(
        "PSKILLS_HOSTING_OPS_OVERHEAD_1000_USD",
        planningAssumptions.operatingOverheadUsd["scale-1000-teams"],
      ),
      ...overrideOverhead,
    },
    ...overrides,
  };
  assumptions.operatingOverheadUsd = {
    ...planningAssumptions.operatingOverheadUsd,
    ...assumptions.operatingOverheadUsd,
    ...overrideOverhead,
  };

  assertFraction(
    "privateBlobDeliveryFraction",
    assumptions.privateBlobDeliveryFraction,
  );
  assertFraction(
    "privateBlobCacheMissFraction",
    assumptions.privateBlobCacheMissFraction,
  );
  if (!Number.isFinite(assumptions.scannerHeadroom) || assumptions.scannerHeadroom < 1) {
    throw new Error("scannerHeadroom must be at least 1");
  }
  if (
    !Number.isFinite(assumptions.scannerConcurrencyPerUnit) ||
    assumptions.scannerConcurrencyPerUnit <= 0
  ) {
    throw new Error("scannerConcurrencyPerUnit must be greater than 0");
  }
  if (
    !Number.isFinite(assumptions.scannerUnitMemoryGb) ||
    assumptions.scannerUnitMemoryGb <= 0
  ) {
    throw new Error("scannerUnitMemoryGb must be greater than 0");
  }
  if (
    !Number.isFinite(assumptions.scannerEgressGbPerScan) ||
    assumptions.scannerEgressGbPerScan < 0
  ) {
    throw new Error("scannerEgressGbPerScan must be non-negative");
  }
  if (
    !Number.isFinite(assumptions.vercelSandboxVcpus) ||
    assumptions.vercelSandboxVcpus < 1 ||
    !Number.isInteger(assumptions.vercelSandboxVcpus)
  ) {
    throw new Error("vercelSandboxVcpus must be a positive integer");
  }
  if (
    !Number.isFinite(assumptions.vercelSandboxMemoryGbPerVcpu) ||
    assumptions.vercelSandboxMemoryGbPerVcpu <= 0
  ) {
    throw new Error("vercelSandboxMemoryGbPerVcpu must be greater than 0");
  }
  if (
    !Number.isFinite(assumptions.vercelSandboxMemoryMinimumMinutes) ||
    assumptions.vercelSandboxMemoryMinimumMinutes <= 0
  ) {
    throw new Error("vercelSandboxMemoryMinimumMinutes must be greater than 0");
  }
  if (!aiRates[assumptions.aiModel]) {
    throw new Error("Unknown AI model: " + assumptions.aiModel);
  }
  if (!embeddingRates[assumptions.embeddingModel]) {
    throw new Error("Unknown embedding model: " + assumptions.embeddingModel);
  }
  return assumptions;
}

function quantities(scenario) {
  const scans =
    scenario.teams *
    scenario.activeArtifactsPerTeam *
    scenario.scansPerArtifactPerDay *
    DAYS;
  const apiRequests = scenario.teams * scenario.apiRequestsPerTeam;
  const publishes = scenario.teams * scenario.publishesPerTeam;
  const imports = scenario.teams * scenario.importsPerTeam;
  const downloadsGb = scenario.teams * scenario.downloadsGbPerTeam;
  const apiEgressGb = scenario.teams * scenario.apiEgressGbPerTeam;
  const artifactStorageGb = scenario.teams * scenario.artifactStorageGbPerTeam;
  const dbStorageGb = scenario.teams * scenario.dbStorageGbPerTeam;
  const dbHistoryGb = scenario.teams * scenario.dbHistoryGbPerTeam;
  const dbEgressGb = scenario.teams * scenario.dbEgressGbPerTeam;
  return {
    scans,
    apiRequests,
    apiEgressGb,
    publishes,
    imports,
    downloadsGb,
    artifactStorageGb,
    dbStorageGb,
    dbHistoryGb,
    dbEgressGb,
    queueJobs: scans + publishes + imports,
    aiInputTokens:
      scenario.teams *
      scenario.aiCallsPerTeam *
      scenario.aiInputTokensPerCall,
    aiOutputTokens:
      scenario.teams *
      scenario.aiCallsPerTeam *
      scenario.aiOutputTokensPerCall,
    embeddingTokens:
      scenario.teams *
      scenario.embeddingCallsPerTeam *
      scenario.embeddingTokensPerCall,
  };
}

function functionCost(scenario) {
  const q = quantities(scenario);
  const cpuHours = (q.apiRequests * scenario.apiCpuSeconds) / 3_600;
  const memoryGbHours =
    (q.apiRequests * scenario.apiWallSeconds * scenario.apiMemoryGb) / 3_600;
  const invocationMillions =
    over(q.apiRequests, prices.vercel.functionIncludedInvocations) / 1_000_000;
  const cpu = cpuHours * prices.vercel.functionCpuSydneyPerHour;
  const memory = memoryGbHours * prices.vercel.functionMemorySydneyPerGbHour;
  const invocations =
    invocationMillions * prices.vercel.functionInvocationsPerMillion;
  return {
    total: cpu + memory + invocations,
    cpuHours,
    memoryGbHours,
    invocationMillions,
    cpu,
    memory,
    invocations,
  };
}

function scannerCapacity(scenario, profile, options = {}) {
  const assumptions = resolveAssumptions(options);
  const q = quantities(scenario);
  const cpuHours = (q.scans * profile.cpuMinutes) / 60;
  const wallHours = (q.scans * profile.wallMinutes) / 60;
  const memoryBillingMinutes = Math.max(
    assumptions.vercelSandboxMemoryMinimumMinutes,
    profile.wallMinutes,
  );
  const memoryGbHours =
    (q.scans * profile.memoryGb * memoryBillingMinutes) / 60;
  const averageConcurrent = wallHours / HOURS_PER_MONTH;
  const targetConcurrent = Math.max(
    1,
    Math.ceil(averageConcurrent * assumptions.scannerHeadroom),
  );
  const workerUnits = Math.max(
    1,
    Math.ceil(targetConcurrent / assumptions.scannerConcurrencyPerUnit),
  );
  return {
    cpuHours,
    wallHours,
    memoryBillingMinutes,
    memoryGbHours,
    averageConcurrent,
    targetConcurrent,
    workerUnits,
    scannerEgressGb: q.scans * assumptions.scannerEgressGbPerScan,
    unitMemoryGb: assumptions.scannerUnitMemoryGb,
    memoryFitsUnit: profile.memoryGb <= assumptions.scannerUnitMemoryGb,
  };
}

function sandboxCost(scenario, profile, options = {}) {
  const assumptions = resolveAssumptions(options);
  const capacity = scannerCapacity(scenario, profile, assumptions);
  const q = quantities(scenario);
  const creations = q.scans;
  const allocatedMemoryGb =
    assumptions.vercelSandboxVcpus *
    assumptions.vercelSandboxMemoryGbPerVcpu;
  const memoryBillingMinutes = Math.max(
    assumptions.vercelSandboxMemoryMinimumMinutes,
    profile.wallMinutes,
  );
  const memoryGbHours =
    (creations * allocatedMemoryGb * memoryBillingMinutes) / 60;
  // Pro meters every Sandbox resource against the account credit. The
  // zero-included values are retained in prices for an explicit plan model.
  const cpu =
    capacity.cpuHours * prices.vercel.sandboxCpuSydneyPerHour;
  const memory =
    memoryGbHours * prices.vercel.sandboxMemorySydneyPerGbHour;
  const creation =
    (creations / 1_000_000) * prices.vercel.sandboxCreationsPerMillion;
  const dataTransfer =
    capacity.scannerEgressGb * prices.vercel.sandboxDataTransferSydneyPerGb;
  return {
    total: cpu + memory + creation + dataTransfer,
    cpuHours: capacity.cpuHours,
    wallHours: capacity.wallHours,
    memoryGbHours,
    allocatedVcpus: assumptions.vercelSandboxVcpus,
    allocatedMemoryGb,
    memoryBillingMinutes,
    creations,
    scannerEgressGb: capacity.scannerEgressGb,
    targetConcurrent: capacity.targetConcurrent,
    workerUnits: capacity.workerUnits,
    memoryFitsUnit: capacity.memoryFitsUnit,
    cpu,
    memory,
    creation,
    dataTransfer,
  };
}

function vercelBlobCost(scenario, options = {}) {
  const assumptions = resolveAssumptions(options);
  const q = quantities(scenario);
  const storage =
    q.artifactStorageGb * prices.vercel.blobStoragePerGbMonth;
  const simple =
    (q.scans / 1_000_000) * prices.vercel.blobSimpleOpsPerMillion;
  const advanced =
    (q.publishes / 1_000_000) * prices.vercel.blobAdvancedOpsPerMillion;

  // Private Blob delivery is function-mediated. On a cache miss the function
  // fetches from Blob, then sends the response to the browser. Public direct
  // delivery is represented as Blob transfer only; replace these fractions
  // with measured request-path shares before adopting a long-term provider.
  const privateDeliveryGb =
    q.downloadsGb * assumptions.privateBlobDeliveryFraction;
  const publicDeliveryGb = q.downloadsGb - privateDeliveryGb;
  const privateCacheMissGb =
    privateDeliveryGb * assumptions.privateBlobCacheMissFraction;
  const blobDataTransferGb = publicDeliveryGb + privateCacheMissGb;
  const fastDataTransferGb = privateDeliveryGb;
  const fastOriginTransferGb = privateDeliveryGb + privateCacheMissGb;
  const blobDataTransfer =
    blobDataTransferGb * prices.vercel.blobTransferPerGb;
  const fastDataTransfer = assumptions.vercelFlatRateCdn
    ? 0
    : over(
        fastDataTransferGb,
        prices.vercel.fastDataTransferIncludedGb,
      ) * prices.vercel.fastDataTransferSydneyPerGb;
  const fastOriginTransfer =
    over(
      fastOriginTransferGb,
      prices.vercel.fastOriginTransferIncludedGb,
    ) * prices.vercel.fastOriginTransferSydneyPerGb;
  const transfer = blobDataTransfer + fastDataTransfer + fastOriginTransfer;
  return {
    total: storage + simple + advanced + transfer,
    storage,
    simple,
    advanced,
    transfer,
    privateDeliveryGb,
    publicDeliveryGb,
    privateCacheMissGb,
    blobDataTransferGb,
    fastDataTransferGb,
    fastOriginTransferGb,
    blobDataTransfer,
    fastDataTransfer,
    fastOriginTransfer,
    flatRateCdnApplied: assumptions.vercelFlatRateCdn,
  };
}

function neonCost(scenario) {
  const q = quantities(scenario);
  const compute = scenario.dbCuHours * prices.neon.launchCuHour;
  const storage = q.dbStorageGb * prices.neon.storagePerGbMonth;
  const history = q.dbHistoryGb * prices.neon.historyPerGbMonth;
  const egress =
    over(q.dbEgressGb, prices.neon.egressIncludedGb) * prices.neon.egressPerGb;
  return {
    total: compute + storage + history + egress,
    compute,
    storage,
    history,
    egress,
  };
}

function r2Cost(scenario) {
  const q = quantities(scenario);
  const storage =
    over(q.artifactStorageGb, prices.r2.includedStorageGbMonths) *
    prices.r2.standardStoragePerGbMonth;
  const classA =
    (over(q.publishes, prices.r2.includedClassAOps) / 1_000_000) *
    prices.r2.classAOpsPerMillion;
  const classB =
    (over(q.scans, prices.r2.includedClassBOps) / 1_000_000) *
    prices.r2.classBOpsPerMillion;
  return { total: storage + classA + classB, storage, classA, classB };
}

function s3Cost(scenario) {
  const q = quantities(scenario);
  const storage = q.artifactStorageGb * prices.s3.standardStoragePerGbMonth;
  const gets = (q.scans / 1_000) * prices.s3.getPerThousand;
  const puts = (q.publishes / 1_000) * prices.s3.putPerThousand;
  const egress =
    over(q.downloadsGb, prices.s3.internetEgressIncludedGb) *
    prices.s3.internetEgressReferencePerGb;
  return { total: storage + gets + puts + egress, storage, gets, puts, egress };
}

function vercelCost(scenario, profile, options = {}) {
  const functions = functionCost(scenario);
  const sandbox = sandboxCost(scenario, profile, options);
  const blob = vercelBlobCost(scenario, options);
  const neon = neonCost(scenario);
  const usage = functions.total + sandbox.total + blob.total;
  const usageOverage = over(usage, prices.vercel.usageCredit);
  const platformMonthly = prices.vercel.proBase + usageOverage;
  return {
    // The Vercel usage credit cannot offset Neon. Keep the database outside
    // the platform calculation so this is a real stack subtotal.
    total: platformMonthly + neon.total,
    platformMonthly,
    usage,
    usageOverage,
    neon: neon.total,
    functions: functions.total,
    sandbox: sandbox.total,
    blob: blob.total,
    functionDetail: functions,
    sandboxDetail: sandbox,
    blobDetail: blob,
    scannerPriced: true,
  };
}

function railwayVmScannerCost(scenario, profile, options = {}) {
  const assumptions = resolveAssumptions(options);
  const capacity = scannerCapacity(scenario, profile, assumptions);
  const monthlyUnit =
    prices.railway.vmScannerCpuVcpu * prices.railway.vmCpuPerVcpuMonth +
    prices.railway.vmScannerMemoryGb * prices.railway.vmMemoryPerGbMonth;
  const capacityCost = capacity.workerUnits * monthlyUnit;
  const egress =
    capacity.scannerEgressGb * prices.railway.vmNetworkEgressPerGb;
  return {
    total: capacityCost + egress,
    capacityCost,
    egress,
    monthlyUnit,
    workerUnits: capacity.workerUnits,
    targetConcurrent: capacity.targetConcurrent,
    scannerEgressGb: capacity.scannerEgressGb,
    basis: "assumed-warm-Railway-VM-beta-capacity",
    acceptedIsolation: false,
  };
}

function railwayControlCost(scenario) {
  const q = quantities(scenario);
  const cpu = 0.5 * prices.railway.cpuPerVcpuMonth;
  const memory = prices.railway.memoryPerGbMonth;
  const networkEgress = q.apiEgressGb * prices.railway.networkEgressPerGb;
  const resourceUsage = cpu + memory + networkEgress;
  const creditApplied = Math.min(
    resourceUsage,
    prices.railway.hobbyUsageCredit,
  );
  const overage = over(resourceUsage, prices.railway.hobbyUsageCredit);
  const total = prices.railway.hobbySubscription + overage;
  return {
    total,
    subscription: prices.railway.hobbySubscription,
    resourceUsage,
    cpu,
    memory,
    networkEgress,
    creditApplied,
    overage,
    basis: "Hobby-subscription-plus-resource-overage-after-5-dollar-credit",
  };
}

function railwayCost(scenario, profile = scanProfiles.base, options = {}) {
  const control = railwayControlCost(scenario);
  const scanner = railwayVmScannerCost(scenario, profile, options);
  const neon = neonCost(scenario);
  const r2 = r2Cost(scenario);
  return {
    total: control.total + scanner.total + neon.total + r2.total,
    control: control.total,
    scanner: scanner.total,
    neon: neon.total,
    r2: r2.total,
    controlDetail: control,
    scannerDetail: scanner,
    scannerPriced: true,
  };
}

function renderCost(scenario) {
  const q = quantities(scenario);
  const control = prices.render.proWorkspace + 2 * prices.render.smallService;
  const bandwidth =
    over(q.apiEgressGb, prices.render.includedBandwidthGb) *
    prices.render.bandwidthPerGb;
  return {
    total: control + bandwidth + neonCost(scenario).total + r2Cost(scenario).total,
    control,
    bandwidth,
    scannerPriced: false,
    basis: "control-plane-floor-no-accepted-scanner-executor",
  };
}

function flyScannerCost(scenario, profile, options = {}) {
  const assumptions = resolveAssumptions(options);
  const capacity = scannerCapacity(scenario, profile, assumptions);
  const capacityCost =
    capacity.workerUnits * prices.fly.scannerUnitPerMonth;
  const egress =
    capacity.scannerEgressGb * prices.fly.networkEgressPerGb;
  return {
    total: capacityCost + egress,
    capacityCost,
    egress,
    monthlyUnit: prices.fly.scannerUnitPerMonth,
    workerUnits: capacity.workerUnits,
    targetConcurrent: capacity.targetConcurrent,
    scannerEgressGb: capacity.scannerEgressGb,
    basis: "assumed-warm-Fly-2GB-worker-capacity",
  };
}

function flyCost(scenario, profile = scanProfiles.base, options = {}) {
  const q = quantities(scenario);
  const control = prices.fly.controlMachinesPerMonth;
  const apiEgress = q.apiEgressGb * prices.fly.networkEgressPerGb;
  const scanner = flyScannerCost(scenario, profile, options);
  const neon = neonCost(scenario);
  const r2 = r2Cost(scenario);
  return {
    total: control + apiEgress + scanner.total + neon.total + r2.total,
    control,
    apiEgress,
    scanner: scanner.total,
    neon: neon.total,
    r2: r2.total,
    scannerDetail: scanner,
    scannerPriced: true,
  };
}

function cloudflareCost(
  scenario,
  profile = scanProfiles.base,
  options = {},
) {
  const q = quantities(scenario);
  const workerRequests =
    (over(q.apiRequests, prices.cloudflare.includedRequests) / 1_000_000) *
    prices.cloudflare.requestsPerMillion;
  const cpuMs = q.apiRequests * scenario.apiCpuSeconds * 1_000;
  const workerCpu =
    (over(cpuMs, prices.cloudflare.includedCpuMs) / 1_000_000) *
    prices.cloudflare.cpuMsPerMillion;
  const worker = prices.cloudflare.workersPaidBase + workerRequests + workerCpu;
  const fly = flyCost(scenario, profile, options);
  return {
    total: worker + fly.total,
    worker,
    workerRequests,
    workerCpu,
    control: fly.control,
    apiEgress: fly.apiEgress,
    scanner: fly.scanner,
    neon: fly.neon,
    r2: fly.r2,
    scannerDetail: fly.scannerDetail,
    scannerPriced: true,
  };
}

function supabaseCost(scenario) {
  const q = quantities(scenario);
  const disk =
    over(q.dbStorageGb, prices.supabase.includedDiskGb) *
    prices.supabase.diskPerGbMonth;
  // This is a Pro + Micro floor. A larger compute class, PITR, or additional
  // project changes the price and is intentionally not guessed here.
  const egress =
    over(q.dbEgressGb, prices.supabase.includedUncachedEgressGb) *
    prices.supabase.uncachedEgressPerGb;
  return {
    total: prices.supabase.proBase + disk + egress,
    disk,
    egress,
    scannerPriced: false,
    basis: "database-floor-no-accepted-scanner-executor",
  };
}

function aiFormula(scenario, options = {}) {
  const assumptions = resolveAssumptions(options);
  const q = quantities(scenario);
  const model = aiRates[assumptions.aiModel];
  const embedding = embeddingRates[assumptions.embeddingModel];
  const input = (q.aiInputTokens / 1_000_000) * model.inputUsdPerMillion;
  const output = (q.aiOutputTokens / 1_000_000) * model.outputUsdPerMillion;
  const embeddings =
    (q.embeddingTokens / 1_000_000) * embedding.usdPerMillion;
  const providerCost = input + output + embeddings;
  return {
    inputTokens: q.aiInputTokens,
    outputTokens: q.aiOutputTokens,
    embeddingTokens: q.embeddingTokens,
    aiModel: assumptions.aiModel,
    embeddingModel: assumptions.embeddingModel,
    inputUsdPerMillion: model.inputUsdPerMillion,
    outputUsdPerMillion: model.outputUsdPerMillion,
    embeddingUsdPerMillion: embedding.usdPerMillion,
    input,
    output,
    embeddings,
    providerCost,
    total: providerCost,
    gatewayFreeCredit: prices.vercel.aiGatewayFreeCredit,
    creditTreatment:
      "account-level AI Gateway credit is reported separately and not applied to per-scenario provider spend",
    expression:
      String(q.aiInputTokens) +
      "/1e6*" +
      String(model.inputUsdPerMillion) +
      " + " +
      String(q.aiOutputTokens) +
      "/1e6*" +
      String(model.outputUsdPerMillion) +
      " + " +
      String(q.embeddingTokens) +
      "/1e6*" +
      String(embedding.usdPerMillion),
    source: model.source,
    embeddingSource: embedding.source,
  };
}

function withPlanning(cost, ai, operatingOverheadUsd) {
  return {
    ...cost,
    ai: ai.providerCost,
    operatingOverheadUsd,
    allIn: cost.scannerPriced
      ? cost.total + ai.providerCost + operatingOverheadUsd
      : null,
  };
}

function profileMap(builder) {
  return Object.fromEntries(
    Object.entries(scanProfiles).map(([name, profile]) => [
      name,
      builder(profile),
    ]),
  );
}

function estimateScenario(scenario, options = {}) {
  const assumptions = resolveAssumptions(options);
  const q = quantities(scenario);
  const ai = aiFormula(scenario, assumptions);
  const operatingOverheadUsd =
    assumptions.operatingOverheadUsd[scenario.id] ?? 0;
  const planned = (builder, scannerPriced = true) =>
    profileMap((profile) =>
      withPlanning(
        { ...builder(profile), scannerPriced },
        ai,
        operatingOverheadUsd,
      ),
    );
  const portableRender = withPlanning(
    renderCost(scenario),
    ai,
    operatingOverheadUsd,
  );
  const supabaseFloor = withPlanning(
    supabaseCost(scenario),
    ai,
    operatingOverheadUsd,
  );
  return {
    scenario,
    assumptions,
    quantities: q,
    ai,
    operatingOverheadUsd,
    vercel: planned((profile) => vercelCost(scenario, profile, assumptions)),
    portableFly: planned((profile) => flyCost(scenario, profile, assumptions)),
    portableRailway: planned((profile) =>
      railwayCost(scenario, profile, assumptions),
    ),
    portableRender,
    cloudflareEdge: planned((profile) =>
      cloudflareCost(scenario, profile, assumptions),
    ),
    supabaseFloor,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function csv() {
  const headers = [
    "scenario",
    "teams",
    "candidate",
    "known_usd_low",
    "known_usd_base",
    "known_usd_high",
    "ai_usd_base",
    "operating_overhead_usd",
    "all_in_usd_base",
    "scanner_target_concurrency_low",
    "scanner_target_concurrency_base",
    "scanner_target_concurrency_high",
    "scanner_worker_units_low",
    "scanner_worker_units_base",
    "scanner_worker_units_high",
    "scanner_compute_included",
    "ai_usage_included",
    "basis",
    "notes",
  ];
  const rows = [headers];
  for (const scenario of scenarios) {
    const estimate = estimateScenario(scenario);
    const capacities = (candidate) =>
      ["low", "base", "high"].map((profile) => ({
        targetConcurrent:
          (candidate[profile]?.scannerDetail ??
            candidate[profile]?.sandboxDetail)?.targetConcurrent ?? "",
        workerUnits:
          (candidate[profile]?.scannerDetail ??
            candidate[profile]?.sandboxDetail)?.workerUnits ?? "",
      }));
    const push = ({
      candidate,
      values,
      scannerCompute,
      aiIncluded,
      basis,
      notes,
    }) => {
      const capacity = capacities(values);
      rows.push([
        scenario.id,
        scenario.teams,
        candidate,
        dollars(values.low?.total ?? values.total),
        dollars(values.base?.total ?? values.total),
        dollars(values.high?.total ?? values.total),
        dollars(estimate.ai.providerCost),
        dollars(estimate.operatingOverheadUsd),
        values.base?.allIn === null || values.allIn === null
          ? ""
          : dollars(values.base?.allIn ?? values.allIn),
        capacity[0].targetConcurrent,
        capacity[1].targetConcurrent,
        capacity[2].targetConcurrent,
        capacity[0].workerUnits,
        capacity[1].workerUnits,
        capacity[2].workerUnits,
        scannerCompute,
        aiIncluded,
        basis,
        notes,
      ]);
    };
    push({
      candidate: "vercel-pro-neon-vercel-blob-sandbox",
      values: estimate.vercel,
      scannerCompute: "yes-bounded-sandbox",
      aiIncluded: "provider-rates-modeled-credit-separate",
      basis: "provider-rate-plus-assumed-workload",
      notes:
        "Sydney Blob BDT/FDT/FOT modeled; FDT is usage-based unless VERCEL_FLAT_RATE_CDN=true; Pro Sandbox usage is metered with a conservative 2-vCPU/4-GB allocation",
    });
    push({
      candidate: "fly-node-neon-r2-with-fly-scanner",
      values: estimate.portableFly,
      scannerCompute: "yes-assumed-Fly-2GB-worker",
      aiIncluded: "provider-rates-modeled-credit-separate",
      basis: "provider-rate-plus-assumed-warm-worker",
      notes:
        "One shared-cpu-8x/2GB warm unit per concurrent scan; capacity and egress are planning assumptions",
    });
    push({
      candidate: "cloudflare-edge-fly-node-neon-r2-with-fly-scanner",
      values: estimate.cloudflareEdge,
      scannerCompute: "yes-assumed-Fly-2GB-worker",
      aiIncluded: "provider-rates-modeled-credit-separate",
      basis: "provider-rate-plus-assumed-warm-worker",
      notes:
        "Workers Paid edge plus Fly scanner; Hyperdrive/Better Auth runtime fit still requires an explicit acceptance spike",
    });
    push({
      candidate: "railway-node-neon-r2-with-railway-vm-scanner",
      values: estimate.portableRailway,
      scannerCompute: "yes-assumed-Railway-VM-beta-worker",
      aiIncluded: "provider-rates-modeled-credit-separate",
      basis: "provider-rate-plus-assumed-beta-worker",
      notes:
        "Hobby $5 subscription includes $5 resource credit; VM scanner uses $50/vCPU-month and $50/GB-month beta rates; isolation is unaccepted",
    });
    push({
      candidate: "render-node-neon-r2-control-plane-floor",
      values: estimate.portableRender,
      scannerCompute: "no-unpriced-executor",
      aiIncluded: "provider-rates-modeled-credit-separate",
      basis: "floor-only",
      notes:
        "Pro workspace, two small services, and API bandwidth only; scanner executor remains unpriced so all-in is blank",
    });
    push({
      candidate: "supabase-pro-micro-database-floor",
      values: estimate.supabaseFloor,
      scannerCompute: "no-unpriced-executor",
      aiIncluded: "provider-rates-modeled-credit-separate",
      basis: "floor-only",
      notes:
        "Pro + Micro database floor; larger compute, PITR, additional projects, scanner, and object delivery excluded",
    });
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function range(candidate, field) {
  return ["low", "base", "high"]
    .map((profile) => "$" + dollars(candidate[profile][field]))
    .join(" / ");
}

function markdown() {
  const lines = [
    "Prices checked " +
      PRICE_CHECKED_ON +
      "; AI defaults to gpt-5.6-luna + text-embedding-3-small. Values are USD/month.",
    "",
    "| Scenario | Vercel all-in low / base / high | Fly all-in low / base / high | Cloudflare + Fly all-in low / base / high | Railway VM all-in low / base / high | Render floor | Supabase floor | Base worker units |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const scenario of scenarios) {
    const e = estimateScenario(scenario);
    lines.push(
      "| " +
        scenario.label +
        " (" +
        scenario.teams +
        " team" +
        (scenario.teams === 1 ? "" : "s") +
        ") | " +
        range(e.vercel, "allIn") +
        " | " +
        range(e.portableFly, "allIn") +
        " | " +
        range(e.cloudflareEdge, "allIn") +
        " | " +
        range(e.portableRailway, "allIn") +
        " | floor $" +
        dollars(e.portableRender.total) +
        " | floor $" +
        dollars(e.supabaseFloor.total) +
        " | " +
        e.portableFly.base.scannerDetail.workerUnits +
        " |",
    );
  }
  lines.push(
    "",
    "All-in rows include provider subtotal + modelled AI provider spend + operating overhead. Render and Supabase are floors because their scanner executor is unpriced.",
  );
  return lines.join("\n");
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;

if (isMain) {
  if (process.argv.includes("--csv")) {
    process.stdout.write(csv() + "\n");
  } else {
    process.stdout.write(markdown() + "\n");
    process.stdout.write(
      "\nAI Gateway credit is account-level and reported separately; provider spend is modelled at the selected current rates.\n",
    );
  }
}

export {
  DAYS,
  HOURS_PER_MONTH,
  PRICE_CHECKED_ON,
  aiFormula,
  aiRates,
  cloudflareCost,
  csv,
  embeddingRates,
  estimateScenario,
  flyCost,
  flyScannerCost,
  functionCost,
  markdown,
  neonCost,
  planningAssumptions,
  priceSources,
  prices,
  quantities,
  railwayCost,
  railwayVmScannerCost,
  renderCost,
  r2Cost,
  resolveAssumptions,
  s3Cost,
  sandboxCost,
  scanProfiles,
  scannerCapacity,
  scenarios,
  supabaseCost,
  vercelBlobCost,
  vercelCost,
};
