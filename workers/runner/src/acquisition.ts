import type {
  ImportRequest,
  Job,
  Provenance,
  SkillBundle,
  Upstream,
} from '../../../packages/contracts/src/index.js';
import {
  acquireSkill,
  type AcquireSkillOptions,
  type AcquisitionResult,
} from '../../../packages/upstreams/src/index.js';
import type { WorkerClaimedJob } from './client.js';

/** Options supplied by the worker supervisor for a source acquisition. */
export interface WorkerAcquisitionOptions extends AcquireSkillOptions {}

export interface AcquiredImport {
  bundle: SkillBundle;
  provenance: Provenance;
}

/**
 * Acquire an import job from its administrator-selected source mapping.
 *
 * The claim is treated as untrusted transport data: the worker verifies that
 * the embedded import request and upstream agree before passing them to the
 * source adapter. Credentials remain environment references on the upstream;
 * the claimed job never carries credential bytes.
 */
export async function acquireImportJob(
  job: WorkerClaimedJob,
  options: WorkerAcquisitionOptions = {},
): Promise<AcquiredImport> {
  if (job.kind !== 'import') {
    throw new Error(`cannot acquire job kind ${String(job.kind)}`);
  }
  const upstream = asUpstream(job.upstream);
  const importRequest = asImportRequest(job.import ?? job.importRequest);
  if (importRequest.upstreamId !== upstream.id) {
    throw new Error('claimed import request does not match its upstream');
  }
  if (upstream.organizationId !== job.organizationId) {
    throw new Error('claimed upstream belongs to a different organization');
  }

  // The worker receives a frozen job policy/source mapping from the registry.
  // Pass only the source adapter options through; authorization from the
  // browser or registry caller is deliberately not inherited here.
  const result: AcquisitionResult = await acquireSkill({
    job: job as unknown as Job,
    upstream,
    importRequest,
    ...safeSkillsShOptions(options),
  });
  return result;
}

/**
 * Keep request-scoped directory credential failures out of worker telemetry.
 * The callback is deployment-owned and can throw an OIDC/provider error that
 * contains sensitive context; the source adapter only needs a closed/open
 * credential result, so normalize every callback failure to one safe marker.
 * This wrapper is intentionally applied at the worker boundary, before the
 * options reach the upstream adapter, and never stores the returned token.
 */
function safeSkillsShOptions(options: WorkerAcquisitionOptions): WorkerAcquisitionOptions {
  const candidate = (options as WorkerAcquisitionOptions & {
    getSkillsShToken?: unknown;
  }).getSkillsShToken;
  if (candidate === undefined) return options;
  if (typeof candidate !== 'function') throw new Error('skills.sh credential unavailable');

  return {
    ...options,
    getSkillsShToken: async (signal?: AbortSignal): Promise<string> => {
      try {
        const token = await (candidate as (signal?: AbortSignal) => Promise<unknown>)(signal);
        if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > 4_096 || /[\r\n]/.test(token)) {
          throw new Error('invalid skills.sh credential');
        }
        return token;
      } catch {
        throw new Error('skills.sh credential unavailable');
      }
    },
  } as WorkerAcquisitionOptions;
}

function asUpstream(value: unknown): Upstream {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.organizationId !== 'string' || typeof value.name !== 'string' || (value.kind !== 'github' && value.kind !== 'registry' && value.kind !== 'skills-sh') || typeof value.namespace !== 'string') {
    throw new Error('claimed import job omitted a valid upstream mapping');
  }
  return value as unknown as Upstream;
}

function asImportRequest(value: unknown): ImportRequest {
  if (!isRecord(value) || typeof value.upstreamId !== 'string' || typeof value.path !== 'string' || typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error('claimed import job omitted a valid import request');
  }
  return value as unknown as ImportRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
