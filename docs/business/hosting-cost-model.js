/*
 * Private Skills hosting cost model.
 *
 * This is intentionally a small, dependency-free model.  It estimates known
 * platform charges only; AI provider usage, taxes, and provider-specific
 * network paths are explicit exclusions.  Prices are the USD list prices
 * recorded in hosting-review.md on 2026-09-15 and must be rechecked before
 * purchase.
 *
 * Run:
 *   node hosting-cost-model.js
 *   node hosting-cost-model.js --csv
 */

const DAYS = 30;

const prices = {
  vercel: {
    proBase: 20,
    usageCredit: 20,
    functionCpuSydneyPerHour: 0.18,
    functionMemorySydneyPerGbHour: 0.0149,
    functionInvocationsPerMillion: 0.6,
    functionIncludedInvocations: 1_000_000,
    sandboxCpuSydneyPerHour: 0.18,
    sandboxMemorySydneyPerGbHour: 0.0212,
    sandboxCreationsPerMillion: 0.6,
    sandboxIncludedCpuHours: 5,
    sandboxIncludedMemoryGbHours: 420,
    sandboxIncludedCreations: 5_000,
    blobStoragePerGbMonth: 0.023,
    blobSimpleOpsPerMillion: 0.4,
    blobAdvancedOpsPerMillion: 5,
    blobTransferPerGb: 0.05,
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
    hobbyBase: 5,
    cpuPerVcpuMonth: 20,
    memoryPerGbMonth: 10,
  },
  render: {
    proWorkspace: 25,
    smallService: 7,
    includedBandwidthGb: 5,
    bandwidthPerGb: 0.15,
  },
  fly: {
    twoSharedCpu4x1GbMachinesPerMonth: 15.56,
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

const scanProfiles = {
  low: { cpuMinutes: 0.5, wallMinutes: 2, memoryGb: 1 },
  base: { cpuMinutes: 1, wallMinutes: 3, memoryGb: 1.5 },
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
  const artifactStorageGb = scenario.teams * scenario.artifactStorageGbPerTeam;
  const dbStorageGb = scenario.teams * scenario.dbStorageGbPerTeam;
  const dbHistoryGb = scenario.teams * scenario.dbHistoryGbPerTeam;
  const dbEgressGb = scenario.teams * scenario.dbEgressGbPerTeam;
  return {
    scans,
    apiRequests,
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
  const memory =
    memoryGbHours * prices.vercel.functionMemorySydneyPerGbHour;
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

function sandboxCost(scenario, profile) {
  const q = quantities(scenario);
  const cpuHours = (q.scans * profile.cpuMinutes) / 60;
  const memoryGbHours =
    (q.scans * profile.memoryGb * profile.wallMinutes) / 60;
  const creations = q.scans;
  const cpu =
    over(cpuHours, prices.vercel.sandboxIncludedCpuHours) *
    prices.vercel.sandboxCpuSydneyPerHour;
  const memory =
    over(memoryGbHours, prices.vercel.sandboxIncludedMemoryGbHours) *
    prices.vercel.sandboxMemorySydneyPerGbHour;
  const creationMillions =
    over(creations, prices.vercel.sandboxIncludedCreations) / 1_000_000;
  const creation =
    creationMillions * prices.vercel.sandboxCreationsPerMillion;
  return {
    total: cpu + memory + creation,
    cpuHours,
    memoryGbHours,
    creations,
    cpu,
    memory,
    creation,
  };
}

function vercelBlobCost(scenario) {
  const q = quantities(scenario);
  const storage =
    q.artifactStorageGb * prices.vercel.blobStoragePerGbMonth;
  const simple =
    (q.scans / 1_000_000) * prices.vercel.blobSimpleOpsPerMillion;
  const advanced =
    (q.publishes / 1_000_000) * prices.vercel.blobAdvancedOpsPerMillion;
  const transfer = q.downloadsGb * prices.vercel.blobTransferPerGb;
  return {
    total: storage + simple + advanced + transfer,
    storage,
    simple,
    advanced,
    transfer,
  };
}

function neonCost(scenario) {
  const q = quantities(scenario);
  const compute = scenario.dbCuHours * prices.neon.launchCuHour;
  const storage = q.dbStorageGb * prices.neon.storagePerGbMonth;
  const history = q.dbHistoryGb * prices.neon.historyPerGbMonth;
  const egress =
    over(q.dbEgressGb, prices.neon.egressIncludedGb) * prices.neon.egressPerGb;
  return { total: compute + storage + history + egress, compute, storage, history, egress };
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

function vercelCost(scenario, profile) {
  const functions = functionCost(scenario);
  const sandbox = sandboxCost(scenario, profile);
  const blob = vercelBlobCost(scenario);
  const neon = neonCost(scenario);
  const usage = functions.total + sandbox.total + blob.total;
  const platformMonthly =
    prices.vercel.proBase + over(usage, prices.vercel.usageCredit);
  return {
    // Vercel's usage credit cannot offset Neon. Keep the database outside the
    // platform calculation so the candidate row is a real stack subtotal.
    total: platformMonthly + neon.total,
    platformMonthly,
    neon: neon.total,
    usage,
    functions: functions.total,
    sandbox: sandbox.total,
    blob: blob.total,
  };
}

function railwayCost(scenario) {
  // One small always-on API/worker service pair represented as 0.5 vCPU + 1GB
  // total.  Scanner execution is external and intentionally excluded.
  const control =
    prices.railway.hobbyBase +
    0.5 * prices.railway.cpuPerVcpuMonth +
    1 * prices.railway.memoryPerGbMonth;
  return { total: control + neonCost(scenario).total + r2Cost(scenario).total, control };
}

function renderCost(scenario) {
  const control = prices.render.proWorkspace + 2 * prices.render.smallService;
  return { total: control + neonCost(scenario).total + r2Cost(scenario).total, control };
}

function flyCost(scenario) {
  const control = prices.fly.twoSharedCpu4x1GbMachinesPerMonth;
  return { total: control + neonCost(scenario).total + r2Cost(scenario).total, control };
}

function cloudflareCost(scenario) {
  const q = quantities(scenario);
  const workerRequests =
    over(q.apiRequests, prices.cloudflare.includedRequests) /
    1_000_000 *
    prices.cloudflare.requestsPerMillion;
  const cpuMs = q.apiRequests * scenario.apiCpuSeconds * 1_000;
  const workerCpu =
    over(cpuMs, prices.cloudflare.includedCpuMs) /
    1_000_000 *
    prices.cloudflare.cpuMsPerMillion;
  const worker = prices.cloudflare.workersPaidBase + workerRequests + workerCpu;
  const total = worker + flyCost(scenario).control + neonCost(scenario).total + r2Cost(scenario).total;
  return { total, worker, workerRequests, workerCpu };
}

function supabaseCost(scenario) {
  const q = quantities(scenario);
  const disk =
    over(q.dbStorageGb, prices.supabase.includedDiskGb) *
    prices.supabase.diskPerGbMonth;
  // This is a Pro + Micro floor.  A larger compute class, PITR, or additional
  // project changes the price and is intentionally not guessed here.
  const egress =
    over(q.dbEgressGb, prices.supabase.includedUncachedEgressGb) *
    prices.supabase.uncachedEgressPerGb;
  return { total: prices.supabase.proBase + disk + egress, disk, egress };
}

function aiFormula(scenario) {
  const q = quantities(scenario);
  return {
    inputTokens: q.aiInputTokens,
    outputTokens: q.aiOutputTokens,
    embeddingTokens: q.embeddingTokens,
    expression:
      `${q.aiInputTokens}/1e6*inputUsdPerM + ${q.aiOutputTokens}/1e6*outputUsdPerM + ${q.embeddingTokens}/1e6*embeddingUsdPerM`,
  };
}

function estimateScenario(scenario) {
  const profiles = Object.fromEntries(
    Object.entries(scanProfiles).map(([name, profile]) => [
      name,
      vercelCost(scenario, profile),
    ]),
  );
  const q = quantities(scenario);
  return {
    scenario,
    quantities: q,
    ai: aiFormula(scenario),
    vercel: profiles,
    portableFly: flyCost(scenario),
    portableRailway: railwayCost(scenario),
    portableRender: renderCost(scenario),
    cloudflareEdge: cloudflareCost(scenario),
    supabaseFloor: supabaseCost(scenario),
  };
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv() {
  const headers = [
    "scenario",
    "teams",
    "candidate",
    "known_usd_low",
    "known_usd_base",
    "known_usd_high",
    "scanner_compute_included",
    "ai_usage_included",
    "notes",
  ];
  const rows = [headers];
  for (const scenario of scenarios) {
    const estimate = estimateScenario(scenario);
    const q = estimate.quantities;
    rows.push([
      scenario.id,
      scenario.teams,
      "vercel-pro-neon-vercel-blob-sandbox",
      dollars(estimate.vercel.low.total),
      dollars(estimate.vercel.base.total),
      dollars(estimate.vercel.high.total),
      "yes-bounded-sandbox",
      "no-dynamic-provider-rate",
      "Vercel Pro credit applied once; Blob private-delivery FDT/FOT excluded",
    ]);
    rows.push([
      scenario.id,
      scenario.teams,
      "fly-node-neon-r2-control-plane",
      dollars(estimate.portableFly.total),
      dollars(estimate.portableFly.total),
      dollars(estimate.portableFly.total),
      "no-external-scanner-required",
      "no",
      "Control plane plus DB/R2 only; scanner runtime and AI are excluded",
    ]);
    rows.push([
      scenario.id,
      scenario.teams,
      "cloudflare-edge-fly-node-neon-r2",
      dollars(estimate.cloudflareEdge.total),
      dollars(estimate.cloudflareEdge.total),
      dollars(estimate.cloudflareEdge.total),
      "no-external-scanner-required",
      "no",
      "Edge front door plus external Node worker; scanner runtime excluded",
    ]);
    rows.push([
      scenario.id,
      scenario.teams,
      "railway-node-neon-r2-control-plane",
      dollars(estimate.portableRailway.total),
      dollars(estimate.portableRailway.total),
      dollars(estimate.portableRailway.total),
      "no-external-scanner-required",
      "no",
      "Hobby plus 0.5 vCPU and 1 GB always-on control plane; scanner excluded",
    ]);
    rows.push([
      scenario.id,
      scenario.teams,
      "render-node-neon-r2-control-plane",
      dollars(estimate.portableRender.total),
      dollars(estimate.portableRender.total),
      dollars(estimate.portableRender.total),
      "no-external-scanner-required",
      "no",
      "Workspace plus two small services; scanner runtime excluded",
    ]);
    rows.push([
      scenario.id,
      scenario.teams,
      "supabase-pro-micro-floor",
      dollars(estimate.supabaseFloor.total),
      dollars(estimate.supabaseFloor.total),
      dollars(estimate.supabaseFloor.total),
      "no",
      "no",
      "Database floor only; larger compute/PITR/additional projects excluded",
    ]);
    // Keep q referenced in the generated script output for easy inspection.
    void q;
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function markdown() {
  const lines = [
    "| Scenario | Vercel low | Vercel base | Vercel high | Fly control | Cloudflare edge + Fly | Railway control | Render control | Supabase floor |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const scenario of scenarios) {
    const e = estimateScenario(scenario);
    lines.push(
      `| ${scenario.label} (${scenario.teams} team${scenario.teams === 1 ? "" : "s"}) | $${dollars(e.vercel.low.total)} | $${dollars(e.vercel.base.total)} | $${dollars(e.vercel.high.total)} | $${dollars(e.portableFly.total)} | $${dollars(e.cloudflareEdge.total)} | $${dollars(e.portableRailway.total)} | $${dollars(e.portableRender.total)} | $${dollars(e.supabaseFloor.total)} |`,
    );
  }
  return lines.join("\n");
}

if (require.main === module) {
  if (process.argv.includes("--csv")) {
    process.stdout.write(`${csv()}\n`);
  } else {
    process.stdout.write(`${markdown()}\n`);
    process.stdout.write("\nAI cost formula uses current provider rates at deployment; no AI rate is hardcoded.\n");
  }
}

module.exports = {
  DAYS,
  prices,
  scanProfiles,
  scenarios,
  quantities,
  estimateScenario,
  csv,
  markdown,
};
