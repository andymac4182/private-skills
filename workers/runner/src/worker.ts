import { materializeBundle, parseSkillBundle, validateArtifactDigest, type MaterializedBundle, type SkillBundleInput } from './bundle.js';
import { artifactDigest, digestBytes, fencingToken, WorkerApiClient, type WorkerClaimedJob, type WorkerApiClientOptions } from './client.js';
import { normalizePolicies, toContractScanResult, type Policy, type ScanResult } from './protocol.js';
import {
  acquireImportJob,
  validateOpenClawSourceFeedFreshness,
  type WorkerAcquisitionOptions,
  type WorkerOpenClawProof,
} from './acquisition.js';
import {
  canonicalMeteredImportIdentity,
  type BillingUsageAdmission,
  type HookConfiguration,
  type ImportRequest,
  type SkillBundle,
  type Upstream,
} from '../../../packages/contracts/src/index.js';
import { encodeBundle } from '../../../packages/storage/src/index.js';
import {
  createDefaultScannerAdapters,
  DockerExecutor,
  evaluatePolicy,
  runConfiguredScanners,
  type CommandExecutor,
  type ScannerAdapter,
} from '../../../packages/scanners/src/index.js';

export interface WorkerRunnerOptions extends WorkerApiClientOptions {
  /** Optional server-side metered admission; omitted for legacy disabled billing. */
  billing?: BillingUsageAdmission;
  adapters?: Map<string, ScannerAdapter> | ScannerAdapter[];
  executor?: CommandExecutor;
  /** Trusted scanner image references, pinned by deployment configuration. */
  scannerImages?: Partial<Record<'cisco-skill-scanner' | 'nvidia-skillspector' | 'skillsguard', string>>;
  pollIntervalMs?: number;
  maxBundleJsonBytes?: number;
  /** @deprecated Retained for caller compatibility; v1 transport always decodes canonical base64. */
  allowUtf8BundleContent?: boolean;
  /** Source acquisition settings; credentials remain named process env refs. */
  acquisition?: WorkerAcquisitionOptions;
  /**
   * Optional durable proof sink owned by the registry/directory integration.
   * It is called only after the completion response confirms the import job
   * and required scanners were accepted; the worker never publishes a feed.
   */
  openClawProofRecorder?: WorkerOpenClawSourceProofRecorder;
  /** Deployment-owned pure/in-process stage hooks. Remote URLs are never invoked by the worker. */
  stageHooks?: LocalStageHook[];
  onEvent?: (event: WorkerEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface WorkerOpenClawSourceProofCompletion {
  tenantId: string;
  completionJobId: string;
  skillId: string;
  entry: WorkerOpenClawProof['entry'];
  sourceArtifact: WorkerOpenClawProof['sourceArtifact'];
}

export interface WorkerOpenClawSourceProofRecorder {
  recordFromCompletion(input: WorkerOpenClawSourceProofCompletion): Promise<unknown>;
}

export type WorkerEvent =
  | { type: 'idle' }
  | { type: 'claimed'; jobId: string; kind: string; attempt?: number }
  | { type: 'completed'; jobId: string; scannerCount: number; allow: boolean }
  | { type: 'failed'; jobId: string; error: string };

export interface RunOnceResult {
  claimed: boolean;
  jobId?: string;
  scannerResults?: ScanResult[];
  allow?: boolean;
  error?: string;
}

export type LocalStage = 'ingest.validate' | 'artifact.evaluate';

export interface LocalStageHookContext {
  stage: LocalStage;
  organizationId: string;
  jobId: string;
  artifactDigest: `sha256:${string}`;
  policyRevision: string;
  files: ReadonlyArray<{ path: string; bytes: number; executable: boolean }>;
  scannerResults?: ReadonlyArray<Pick<ScanResult, 'scannerId' | 'status'>>;
}

export interface LocalStageHook {
  id: string;
  stage: LocalStage;
  mode: 'advisory' | 'required';
  timeoutMs?: number;
  run(context: LocalStageHookContext, signal?: AbortSignal): Promise<boolean | { allow: boolean; reason?: string }>;
}

export class WorkerRunner {
  readonly client: WorkerApiClient;
  private readonly options: WorkerRunnerOptions;
  private readonly adapters: ScannerAdapter[];
  private readonly executor: CommandExecutor;

  constructor(options: WorkerRunnerOptions) {
    this.options = options;
    this.client = new WorkerApiClient(options);
    this.adapters = options.adapters
      ? options.adapters instanceof Map ? [...options.adapters.values()] : options.adapters
      : [...createDefaultScannerAdapters().values()];
    // Isolation is the production baseline. TrustedLocalExecutor is only used
    // by direct adapter tests and must be explicitly injected by the caller.
    this.executor = options.executor ?? new DockerExecutor();
  }

  async runOnce(signal = this.options.signal): Promise<RunOnceResult> {
    const claim = await this.client.claim(signal);
    if (!claim.job) {
      await this.emit({ type: 'idle' });
      return { claimed: false };
    }
    const job = claim.job;
    await this.emit({ type: 'claimed', jobId: job.id, kind: job.kind, attempt: job.attempt });
    const token = fencingToken(job);
    if (job.kind !== 'scan' && job.kind !== 'import') {
      const error = `worker does not execute job kind ${job.kind}`;
      await this.completeFailure(job, token, error, signal);
      return { claimed: true, jobId: job.id, error };
    }

    let materialized: MaterializedBundle | undefined;
    let importedBundle: SkillBundle | undefined;
    let importedProvenance: Awaited<ReturnType<typeof acquireImportJob>>['provenance'] | undefined;
    let importedOpenClawProof: WorkerOpenClawProof | undefined;
    let importedOpenClawSource = false;
    let scanArtifactDigest: `sha256:${string}`;
    let completionSubmitted = false;
    let billing: BillingUsageAdmission | undefined;
    let scanReservationKey: string | undefined;
    let scanReservationAdmitted = false;
    let scanInvocationStarted = false;
    let scanReservationReleased = false;
    const releaseUnusedScanReservation = async (): Promise<void> => {
      if (!billing || !scanReservationKey || !scanReservationAdmitted || scanInvocationStarted || scanReservationReleased) return;
      try {
        await billing.reconcileUsage(job.organizationId, scanReservationKey, { scans: 0 }, `${scanReservationKey}:release`);
        scanReservationReleased = true;
      } catch {
        // A failed correction leaves the reservation charged. Reconciliation
        // must not make a pre-scanner failure look paid when its durable
        // ledger update is uncertain.
      }
    };
    try {
      billing = this.options.billing?.status().enabled === true ? this.options.billing : undefined;
      // Reserve before source acquisition, artifact download, materialization,
      // or scanner execution. The operation key is the durable job identity,
      // so queue-time reservations and worker retries are idempotent.
      if (billing) {
        scanReservationKey = await scanReservationKeyForJob(job);
        await billing.reserveUsage(job.organizationId, { scans: 1 }, scanReservationKey);
        scanReservationAdmitted = true;
      }
      let bundleForScan: SkillBundleInput;
      if (job.kind === 'import') {
        const imported = await acquireImportJob(job, {
          ...(this.options.acquisition ?? {}),
          signal,
        });
        importedBundle = imported.bundle;
        importedProvenance = imported.provenance;
        importedOpenClawProof = imported.openClawProof;
        importedOpenClawSource = imported.openClawSource === true;
        const bytes = encodeBundle(imported.bundle);
        scanArtifactDigest = digestBytes(bytes);
        bundleForScan = toWorkerBundle(imported.bundle);
      } else {
        const bytes = await this.client.downloadArtifact(job, signal);
        scanArtifactDigest = artifactDigest(job);
        validateArtifactDigest(bytes, scanArtifactDigest);
        bundleForScan = parseSkillBundle(bytes, this.options.maxBundleJsonBytes);
      }
      materialized = await materializeBundle(bundleForScan, {
        // The v1 transport is canonical base64. Do not silently reinterpret
        // plain strings as UTF-8 because that would change artifact bytes.
        allowUtf8Content: false,
        requireCanonicalOrder: true,
      });
      const policy = normalizeJobPolicy(job);
      const baseRequest = {
        organizationId: job.organizationId,
        jobId: job.id,
        artifactDigest: scanArtifactDigest,
        policyRevision: policy.revision ?? job.policyRevision ?? 'unknown',
        inputDir: materialized.inputDir,
      } as const;
      await this.runStageHooks(policy, 'ingest.validate', {
        stage: 'ingest.validate',
        organizationId: baseRequest.organizationId,
        jobId: baseRequest.jobId,
        artifactDigest: baseRequest.artifactDigest,
        policyRevision: baseRequest.policyRevision,
        files: materialized.files,
      }, signal);
      const runs = await runConfiguredScanners(baseRequest, normalizePolicies(policy), {
        adapters: this.adapters.map((adapter) => ({
          ...adapter,
          scan: async (request, executor) => {
            // Set the flag before entering provider code. A timeout or thrown
            // promise after this point is an uncertain external invocation and
            // therefore keeps the reserved scan charged.
            scanInvocationStarted = true;
            return adapter.scan(request, executor);
          },
        })),
        executor: this.executor,
        imageForScanner: (id) => this.options.scannerImages?.[id],
      });
      await releaseUnusedScanReservation();
      const evaluation = evaluatePolicy(runs, { allowUnscanned: policy.allowUnscanned });
      // Disabled engines are policy state, not scan evidence. Sending an
      // unsupported zero-file result would make the core reject an otherwise
      // explicitly unscanned development job before policy evaluation.
      const scanResults = runs
        .filter((run) => run.policy.mode !== 'disabled')
        .map((run) => toContractScanResult(run.result));
      await this.runStageHooks(policy, 'artifact.evaluate', {
        stage: 'artifact.evaluate',
        organizationId: baseRequest.organizationId,
        jobId: baseRequest.jobId,
        artifactDigest: baseRequest.artifactDigest,
        policyRevision: baseRequest.policyRevision,
        files: materialized.files,
        scannerResults: scanResults.map((result) => ({ scannerId: result.scannerId, status: result.status })),
      }, signal);
      if (importedOpenClawSource) {
        validateOpenClawSourceFeedFreshness(
          job.openclawSource,
          this.options.acquisition?.openClaw?.now?.() ?? Date.now(),
        );
      }
      if (importedOpenClawSource && this.options.openClawProofRecorder !== undefined && importedOpenClawProof === undefined) {
        throw new Error('OpenClaw source proof entry is required when proof recording is enabled');
      }
      const completion = await this.client.complete(job, {
        scanResults,
        artifactDigest: scanArtifactDigest,
        attempt: job.attempt,
        ...(importedBundle === undefined ? {} : { bundle: importedBundle, provenance: importedProvenance }),
      }, signal);
      completionSubmitted = true;
      if (evaluation.allow && importedOpenClawProof !== undefined && this.options.openClawProofRecorder !== undefined) {
        const skillId = completion.operation?.resourceId;
        if (completion.operation?.state !== 'completed' || typeof skillId !== 'string' || skillId.length === 0) {
          throw new Error('OpenClaw proof completion did not confirm an approved skill');
        }
        await this.options.openClawProofRecorder.recordFromCompletion({
          tenantId: job.organizationId,
          completionJobId: job.id,
          skillId,
          entry: importedOpenClawProof.entry,
          sourceArtifact: importedOpenClawProof.sourceArtifact,
        });
      }
      await this.emit({ type: 'completed', jobId: job.id, scannerCount: scanResults.length, allow: evaluation.allow });
      return { claimed: true, jobId: job.id, scannerResults: scanResults, allow: evaluation.allow };
    } catch (error) {
      const message = sanitizeError(error);
      await releaseUnusedScanReservation();
      if (!completionSubmitted) await this.completeFailure(job, token, message, signal);
      await this.emit({ type: 'failed', jobId: job.id, error: message });
      return { claimed: true, jobId: job.id, error: message };
    } finally {
      await materialized?.cleanup();
    }
  }

  async run(signal = this.options.signal): Promise<void> {
    const pollMs = Math.max(100, this.options.pollIntervalMs ?? 1000);
    while (!signal?.aborted) {
      await this.runOnce(signal);
      if (signal?.aborted) break;
      await delay(pollMs, signal);
    }
  }

  private async completeFailure(job: WorkerClaimedJob, token: string, error: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.complete(job, {
        error,
        artifactDigest: job.artifactDigest ?? job.artifact?.digest,
        attempt: job.attempt,
      }, signal);
    } catch (completionError) {
      // Preserve the original scanner/materialization error for telemetry, but
      // surface fencing/transport failures to the caller so lease retry remains
      // visible to the worker supervisor.
      throw new Error(`${error}; completion failed: ${sanitizeError(completionError)}`);
    }
  }

  private async runStageHooks(
    policy: Policy,
    stage: LocalStage,
    context: LocalStageHookContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const configured = (this.options.stageHooks ?? []).filter((hook) => hook.stage === stage);
    const requiredRemote = (policy.hooks ?? []).filter((hook) => hook.event === stage && hook.mode === 'required');
    for (const hook of requiredRemote) {
      if (!configured.some((candidate) => candidate.id === hook.id)) {
        throw new Error(`required hook ${hook.id} has no in-process implementation`);
      }
    }
    for (const hook of configured) {
      const controller = new AbortController();
      const timeoutMs = Math.max(1, hook.timeoutMs ?? 30_000);
      let rejectTimeout!: (error: Error) => void;
      const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
      const timeout = setTimeout(() => {
        controller.abort();
        rejectTimeout(new Error(`hook ${hook.id} timed out`));
      }, timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const outcome = await Promise.race([hook.run(context, controller.signal), timeoutPromise]);
        const allow = typeof outcome === 'boolean' ? outcome : outcome.allow;
        if (!allow && hook.mode === 'required') {
          const reason = typeof outcome === 'object' && outcome.reason ? `: ${sanitizeError(outcome.reason)}` : '';
          throw new Error(`required hook ${hook.id} rejected ${stage}${reason}`);
        }
      } catch (error) {
        if (hook.mode === 'required') throw error;
        // Advisory hook failures are intentionally metadata-only and do not
        // alter scanner evidence or invoke any external destination.
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }
  }

  private async emit(event: WorkerEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }
}

/**
 * Keep the import worker's scanner input compatible with the base64-only
 * materializer while preserving the registry bundle for completion. The
 * storage package owns the canonical encoder used for the completion digest.
 */
function toWorkerBundle(bundle: SkillBundle): SkillBundleInput {
  return {
    format: 'pskills-bundle-v1',
    files: [...bundle.files]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      .map((file) => ({
        path: file.path,
        content: file.content,
        ...(file.executable === true ? { executable: true } : {}),
      })),
  };
}

function normalizeJobPolicy(job: WorkerClaimedJob): Policy {
  if (job.policy && typeof job.policy === 'object') return job.policy;
  return {
    revision: job.policyRevision ?? 'unknown',
    allowUnscanned: false,
    scanners: job.scanners ?? [],
  };
}

async function scanReservationKeyForJob(job: WorkerClaimedJob): Promise<string> {
  if (
    typeof job.meteredReservationKey === 'string' &&
    /^private-skills:scan:[^\s]{1,512}$/u.test(job.meteredReservationKey)
  ) return job.meteredReservationKey;
  if (job.kind !== 'import') return `private-skills:scan:${job.id}`;
  const importValue = job.import ?? job.importRequest;
  if (!isWorkerObject(importValue)) return `private-skills:scan:${job.id}`;
  const request = importValue as unknown as ImportRequest;
  const policyRevision = job.policyRevision ?? job.policy?.revision;
  if (typeof policyRevision !== 'string' || policyRevision.length === 0) return `private-skills:scan:${job.id}`;
  const includeVersion = request.sourceCatalogId === undefined &&
    request.sourceReference === undefined &&
    request.feedId === undefined &&
    job.openclawSource === undefined;
  const identity = canonicalMeteredImportIdentity({
    organizationId: job.organizationId,
    policyRevision,
    request: includeVersion ? request : { ...request, version: undefined as unknown as string },
    upstream: workerMeteredUpstream(job.upstream),
    sourceAcquisition: job.sourceAcquisition,
    openclawSource: job.openclawSource,
  });
  return `private-skills:scan:${digestBytes(new TextEncoder().encode(identity))}`;
}

function workerMeteredUpstream(value: unknown): Pick<Upstream, 'id' | 'kind' | 'namespace' | 'baseUrl' | 'repositories' | 'configRevision' | 'credentialEnv'> | undefined {
  if (!isWorkerObject(value)) return undefined;
  return {
    id: typeof value.id === 'string' ? value.id : '',
    kind: value.kind as Upstream['kind'],
    namespace: typeof value.namespace === 'string' ? value.namespace : '',
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : undefined,
    repositories: Array.isArray(value.repositories) ? value.repositories as string[] : undefined,
    configRevision: typeof value.configRevision === 'string' ? value.configRevision : undefined,
    credentialEnv: typeof value.credentialEnv === 'string' ? value.credentialEnv : undefined,
  };
}

function isWorkerObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2048);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
