import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TokenAuthenticator,
  type BootstrapTokenConfig,
} from '../../packages/auth/src/index.js';
import {
  createMemoryStateRepository,
  defaultRegistryState,
  type StateRepository,
} from '../../packages/database/src/index.js';
import {
  createRegistryHandler,
  type RegistryHandler,
  type RegistryDirectoryClient,
  type RegistryHandlerDependencies,
} from '../../packages/core/src/index.js';
import { createNodeFilesSdkBlobStore } from '../../packages/storage/src/node.js';
import type {
  Policy,
  RegistryConfiguration,
} from '../../packages/contracts/src/index.js';

export const E2E_ORIGIN = 'http://registry.test';
export const E2E_ORGANIZATION = 'org-e2e';
export const E2E_TOKEN = 'e2e-user-token';
export const E2E_WORKER_TOKEN = 'e2e-worker-token';

export interface LocalRegistryHarness {
  readonly handler: RegistryHandler;
  readonly origin: string;
  readonly token: string;
  readonly workerToken: string;
  readonly repository: StateRepository;
  readonly root: string;
  readonly close: () => Promise<void>;
}

export interface LocalRegistryOptions {
  readonly origin?: string;
  readonly organizationId?: string;
  readonly token?: string;
  readonly workerToken?: string;
  readonly policy?: Policy;
  readonly directory?: RegistryDirectoryClient;
  /** Exact catalog base represented by the injected directory fixture. */
  readonly directoryBaseUrl?: string;
  readonly trustedSkillsShBaseUrls?: readonly string[];
  readonly allowLoopbackUpstreams?: boolean;
  /** Inject durable state for composition tests without changing production wiring. */
  readonly repository?: StateRepository;
  /** Reuse a caller-owned Files SDK root when constructing a second handler. */
  readonly storageRoot?: string;
}

/**
 * Construct an HTTP-level registry with production-shaped auth and the real
 * Files SDK filesystem adapter. The policy is deliberately explicit: the
 * test registry is a development registry that allows unscanned distribution.
 */
export async function createLocalRegistryHarness(
  options: LocalRegistryOptions = {},
): Promise<LocalRegistryHarness> {
  const origin = options.origin ?? E2E_ORIGIN;
  const organizationId = options.organizationId ?? E2E_ORGANIZATION;
  const token = options.token ?? E2E_TOKEN;
  const workerToken = options.workerToken ?? E2E_WORKER_TOKEN;
  const root = options.storageRoot ?? await mkdtemp(join(tmpdir(), 'private-skills-e2e-'));
  const ownsRoot = options.storageRoot === undefined;

  const developmentState = defaultRegistryState({
    production: false,
    allowUnscanned: true,
    policyRevision: 'development-unscanned',
  });
  const repository = options.repository ?? createMemoryStateRepository({
    stateFactory: () =>
      options.policy
        ? { ...developmentState, policy: structuredClone(options.policy) }
        : structuredClone(developmentState),
  });

  const userConfig: BootstrapTokenConfig = {
    id: 'e2e-user',
    token,
    organizationId,
    subject: 'e2e-user',
    roles: ['owner', 'admin', 'publisher', 'reader'],
    namespaces: ['@acme'],
    scopes: ['registry:*'],
  };
  const workerConfig: BootstrapTokenConfig = {
    id: 'e2e-worker',
    token: workerToken,
    organizationId,
    subject: 'e2e-worker',
    roles: ['worker'],
    kind: 'worker',
    worker: true,
    scopes: ['jobs:*'],
  };
  const auth = new TokenAuthenticator({
    environment: 'test',
    tokens: [userConfig],
    workerTokens: [workerConfig],
    sessionSecret: 'e2e-session-secret-that-is-long-enough',
    publicOrigin: origin,
    allowedOrigins: [origin],
  });
  await auth.ready();

  const blobs = await createNodeFilesSdkBlobStore({
    provider: 'fs',
    root,
    prefix: 'private-registry',
  });
  const config: RegistryConfiguration = {
    publicOrigin: origin,
    maxBodyBytes: 2 * 1024 * 1024,
    organizationId,
    leaseSeconds: 60,
    allowLoopbackUpstreams: options.allowLoopbackUpstreams,
    ...(options.trustedSkillsShBaseUrls === undefined ? {} : { trustedSkillsShBaseUrls: options.trustedSkillsShBaseUrls }),
  };
  const directoryBaseUrl = options.directoryBaseUrl ?? 'https://skills.sh';
  const directoryForBase = (baseUrl: string): RegistryDirectoryClient | undefined =>
    baseUrl === directoryBaseUrl ? options.directory : undefined;
  const dependencies: RegistryHandlerDependencies = {
    repository,
    blobs,
    auth,
    config,
    directory: options.directory,
    directoryForBase,
  };

  return {
    handler: createRegistryHandler(dependencies),
    origin,
    token,
    workerToken,
    repository,
    root,
    close: async () => {
      if (ownsRoot) await rm(root, { recursive: true, force: true });
    },
  };
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export async function request(
  handler: RegistryHandler,
  origin: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  let body = requestInit.body;
  if (json !== undefined) {
    body = jsonBody(json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return handler(
    new Request(new URL(path, origin), {
      ...requestInit,
      body,
      headers,
    }),
  );
}

export async function jsonResponse<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export function bundleFor(skillName: string, description = 'An end-to-end skill'): {
  format: 'pskills-bundle-v1';
  files: { path: string; content: string }[];
} {
  const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
  return {
    format: 'pskills-bundle-v1',
    files: [
      {
        path: 'SKILL.md',
        content: base64(`---\nname: ${skillName}\ndescription: ${description}\n---\n\nUse this skill safely.\n`),
      },
      { path: 'README.md', content: base64(`# ${skillName}\n`) },
    ],
  };
}

export function scannerResult(
  artifactDigest: string,
  jobId: string,
  scannerId: 'cisco-skill-scanner' | 'nvidia-skillspector' | 'skillsguard',
  status: 'completed' | 'degraded' | 'error' | 'timeout' | 'unsupported',
  organizationId = E2E_ORGANIZATION,
  policyRevision = 'required-scanner-policy',
): Record<string, unknown> {
  return {
    id: `scan-${scannerId}-${jobId}`,
    organizationId,
    jobId,
    artifactDigest,
    policyRevision,
    scannerId,
    engineVersion: 'e2e-test-engine',
    rulesRevision: 'e2e-test-rules',
    configurationHash: 'e2e-test-config',
    status,
    findings: [],
    coverage: {
      filesEnumerated: 2,
      filesAnalyzed: status === 'completed' ? 2 : 0,
      filesSkipped: 0,
      filesUnsupported: 0,
      limitations: [],
      externalDestinations: [],
    },
    createdAt: new Date().toISOString(),
    durationMs: 1,
    ...(status === 'completed' ? {} : { error: 'scanner unavailable in e2e test' }),
  };
}
