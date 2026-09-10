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
  type SkillsShGatewayCredential,
} from '../../../packages/upstreams/src/index.js';
import type { WorkerClaimedJob } from './client.js';

/** Options supplied by the worker supervisor for a source acquisition. */
export interface WorkerAcquisitionOptions extends AcquireSkillOptions {}

const GATEWAY_CREDENTIAL_UNAVAILABLE = 'skills.sh gateway credential unavailable';

/**
 * Build the optional portable gateway credential from supervisor settings.
 * The returned object binds the token to the exact configured base URL; the
 * upstream adapter performs the normalized origin+pathname comparison before
 * invoking it.  Directory credentials are ignored while the directory is
 * disabled, and incomplete settings fail closed when the credential is used.
 */
export function workerAcquisitionOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): WorkerAcquisitionOptions {
  if (env.PSKILLS_DIRECTORY_ENABLED !== 'true') return {};

  const baseUrl = env.PSKILLS_DIRECTORY_GATEWAY_URL;
  const token = env.PSKILLS_DIRECTORY_GATEWAY_TOKEN;
  if (baseUrl === undefined && token === undefined) return {};

  const credential: SkillsShGatewayCredential = {
    baseUrl: baseUrl ?? '',
    getToken: async (signal?: AbortSignal): Promise<string> => {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      if (typeof token !== 'string' || token.length === 0) throw new Error(GATEWAY_CREDENTIAL_UNAVAILABLE);
      return token;
    },
  };
  return { skillsShGatewayCredential: credential };
}

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
  const gateway = (options as WorkerAcquisitionOptions & {
    skillsShGatewayCredential?: unknown;
  }).skillsShGatewayCredential;
  if (candidate === undefined && gateway === undefined) return options;

  const safe: WorkerAcquisitionOptions = { ...options };
  if (candidate !== undefined) {
    if (typeof candidate !== 'function') throw new Error('skills.sh credential unavailable');
    safe.getSkillsShToken = async (signal?: AbortSignal): Promise<string> => {
      try {
        const token = await (candidate as (signal?: AbortSignal) => Promise<unknown>)(signal);
        if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > 4_096 || /[\r\n]/.test(token)) {
          throw new Error('invalid skills.sh credential');
        }
        return token;
      } catch {
        throw new Error('skills.sh credential unavailable');
      }
    };
  }
  if (gateway !== undefined) {
    if (typeof gateway !== 'object' || gateway === null || typeof (gateway as { baseUrl?: unknown }).baseUrl !== 'string' || typeof (gateway as { getToken?: unknown }).getToken !== 'function') {
      throw new Error(GATEWAY_CREDENTIAL_UNAVAILABLE);
    }
    const credential = gateway as SkillsShGatewayCredential;
    safe.skillsShGatewayCredential = {
      baseUrl: credential.baseUrl,
      getToken: async (signal?: AbortSignal): Promise<string> => {
        try {
          const token = await credential.getToken(signal);
          if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > 4_096 || /[\r\n]/.test(token)) {
            throw new Error('invalid skills.sh gateway credential');
          }
          return token;
        } catch {
          throw new Error(GATEWAY_CREDENTIAL_UNAVAILABLE);
        }
      },
    };
  }
  return safe;
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
