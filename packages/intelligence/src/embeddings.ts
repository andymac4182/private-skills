import { createGateway } from '@ai-sdk/gateway';
import {
  embed,
  embedMany,
  type EmbeddingModel,
} from 'ai';
import { MAX_EMBEDDING_DIMENSIONS } from '../../search/src/types.js';

/** Stable preprocessing identity included in every profile id. */
export const EMBEDDING_PREPROCESS_VERSION = 'raw-text-v1';

export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1_536;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Bounds applied before text is sent to the configured embedding service. */
export const EMBEDDING_LIMITS = Object.freeze({
  maxTexts: 60,
  maxTextCharacters: 12_000,
  maxTotalCharacters: 120_000,
  maxAttempts: 3,
  requestTimeoutMs: 15_000,
  retryDelayMs: 100,
});

export interface EmbeddingProfile {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
}

export interface EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  embedMany(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export class EmbeddingProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EmbeddingProviderError';
    this.code = code;
  }
}

interface GatewayProviderLike {
  embeddingModel(modelId: string): EmbeddingModel;
}

interface GatewaySettingsLike {
  baseURL?: string;
  apiKey?: string;
}

type GatewayFactory = (settings?: GatewaySettingsLike) => GatewayProviderLike;

interface EmbedManyOptions {
  model: EmbeddingModel;
  values: string[];
  maxRetries?: number;
  maxParallelCalls?: number;
  abortSignal?: AbortSignal;
}

interface EmbedQueryOptions {
  model: EmbeddingModel;
  value: string;
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

type EmbedManyFunction = (options: EmbedManyOptions) => Promise<unknown>;
type EmbedQueryFunction = (options: EmbedQueryOptions) => Promise<unknown>;

/** SDK seams are intentionally injectable so tests never call a live model. */
export interface EmbeddingProviderSdk {
  createGateway?: GatewayFactory;
  embedMany?: EmbedManyFunction;
  embed?: EmbedQueryFunction;
}

export interface EmbeddingProviderLimits {
  maxTexts: number;
  maxTextCharacters: number;
  maxTotalCharacters: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  retryDelayMs: number;
}

export interface CreateEmbeddingProviderOptions {
  /** SDK seams for tests; production uses the installed AI SDK functions. */
  sdk?: EmbeddingProviderSdk;
  /** Bounded overrides used by tests or a deployment profile. */
  limits?: Partial<EmbeddingProviderLimits>;
}

const DEFAULT_SDK: Required<EmbeddingProviderSdk> = {
  createGateway: createGateway as unknown as GatewayFactory,
  embedMany: embedMany as unknown as EmbedManyFunction,
  embed: embed as unknown as EmbedQueryFunction,
};

/**
 * Create the configured Gateway embedding provider.
 *
 * The provider is deliberately absent unless AI is explicitly enabled. The
 * caller supplies its runtime environment so this module never logs
 * credentials itself. An explicit API key is passed only when configured;
 * otherwise the Gateway SDK retains its Vercel OIDC authentication path.
 */
export function createEmbeddingProvider(
  env: Record<string, string | undefined>,
  options: CreateEmbeddingProviderOptions = {},
): EmbeddingProvider | undefined {
  if (env.PSKILLS_AI_ENABLED !== 'true') return undefined;

  const model = readModel(env.PSKILLS_EMBEDDING_MODEL);
  const dimensions = readDimensions(env.PSKILLS_EMBEDDING_DIMENSIONS);
  const profile: EmbeddingProfile = Object.freeze({
    id: profileId(model, dimensions),
    model,
    dimensions,
  });
  const limits = mergeLimits(options.limits);
  const sdk = {
    ...DEFAULT_SDK,
    ...(options.sdk ?? {}),
  };
  const configuredApiKey = readApiKey(env.AI_GATEWAY_API_KEY);
  const gatewaySettings: GatewaySettingsLike = {
    ...(configuredApiKey === undefined ? {} : { apiKey: configuredApiKey }),
    ...(env.PSKILLS_AI_GATEWAY_BASE_URL === undefined
      ? {}
      : { baseURL: readBaseUrl(env.PSKILLS_AI_GATEWAY_BASE_URL, env) }),
  };

  let gateway: GatewayProviderLike;
  try {
    gateway = sdk.createGateway(gatewaySettings);
  } catch {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding provider configuration is invalid');
  }
  let modelHandle: EmbeddingModel;
  try {
    modelHandle = gateway.embeddingModel(profile.model);
  } catch {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding model configuration is invalid');
  }

  return {
    profile,
    async embedMany(texts: string[]): Promise<number[][]> {
      const values = validateTexts(texts, limits);
      if (values.length === 0) return [];
      const result = await withRetries(
        limits,
        (abortSignal) => sdk.embedMany({
          model: modelHandle,
          values,
          maxRetries: 0,
          maxParallelCalls: 1,
          abortSignal,
        }),
      );
      return validateEmbeddings(result, values.length, profile.dimensions);
    },
    async embedQuery(text: string): Promise<number[]> {
      const values = validateTexts([text], limits);
      const result = await withRetries(
        limits,
        (abortSignal) => sdk.embed({
          model: modelHandle,
          value: values[0]!,
          maxRetries: 0,
          abortSignal,
        }),
      );
      return validateEmbedding(result, profile.dimensions);
    },
  };
}

function readModel(value: string | undefined): string {
  const model = value === undefined || value.trim() === '' ? DEFAULT_EMBEDDING_MODEL : value.trim();
  if (model.length > 96 || /[\u0000-\u001f\u007f]/u.test(model) || /\s/u.test(model)) {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding model configuration is invalid');
  }
  return model;
}

function readDimensions(value: string | undefined): number {
  const dimensions = value === undefined || value.trim() === ''
    ? DEFAULT_EMBEDDING_DIMENSIONS
    : Number(value);
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding dimensions configuration is invalid');
  }
  return dimensions;
}

function readApiKey(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length > 4_096 || /[\r\n]/u.test(value)) {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding credential configuration is invalid');
  }
  return value;
}

function readBaseUrl(value: string, env: Record<string, string | undefined>): string {
  if (value.length === 0 || value.length > 2_048 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding Gateway endpoint configuration is invalid');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding Gateway endpoint configuration is invalid');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && (!isDevelopmentEnvironment(env) || !LOOPBACK_HOSTS.has(url.hostname)))
  ) {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding Gateway endpoint configuration is invalid');
  }
  return value.replace(/\/+$/u, '');
}

function isDevelopmentEnvironment(env: Record<string, string | undefined>): boolean {
  if (env.PSKILLS_ENVIRONMENT === 'production' || env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') return false;
  if (env.PSKILLS_ENVIRONMENT !== undefined) return env.PSKILLS_ENVIRONMENT === 'development' || env.PSKILLS_ENVIRONMENT === 'test';
  return env.NODE_ENV !== 'production' && env.VERCEL_ENV !== 'production';
}

function profileId(model: string, dimensions: number): string {
  return `gateway:${model}:d${dimensions}:${EMBEDDING_PREPROCESS_VERSION}`;
}

function mergeLimits(input?: Partial<EmbeddingProviderLimits>): EmbeddingProviderLimits {
  const limits = { ...EMBEDDING_LIMITS, ...(input ?? {}) };
  const integerKeys: Array<keyof EmbeddingProviderLimits> = [
    'maxTexts',
    'maxTextCharacters',
    'maxTotalCharacters',
    'maxAttempts',
    'requestTimeoutMs',
    'retryDelayMs',
  ];
  for (const key of integerKeys) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) {
      throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding limits configuration is invalid');
    }
  }
  if (
    limits.maxTexts === 0 ||
    limits.maxTextCharacters === 0 ||
    limits.maxTotalCharacters === 0 ||
    limits.maxAttempts === 0 ||
    limits.requestTimeoutMs === 0 ||
    limits.maxTexts > EMBEDDING_LIMITS.maxTexts ||
    limits.maxTextCharacters > EMBEDDING_LIMITS.maxTextCharacters ||
    limits.maxTotalCharacters > EMBEDDING_LIMITS.maxTotalCharacters ||
    limits.maxAttempts > EMBEDDING_LIMITS.maxAttempts ||
    limits.requestTimeoutMs > EMBEDDING_LIMITS.requestTimeoutMs ||
    limits.retryDelayMs > EMBEDDING_LIMITS.retryDelayMs
  ) {
    throw new EmbeddingProviderError('EMBEDDING_CONFIG', 'Embedding limits configuration is invalid');
  }
  return limits;
}

function validateTexts(texts: string[], limits: EmbeddingProviderLimits): string[] {
  if (!Array.isArray(texts) || texts.length > limits.maxTexts) {
    throw new EmbeddingProviderError('EMBEDDING_INPUT_LIMIT', 'Embedding input exceeds the configured batch limit');
  }
  let totalCharacters = 0;
  const values = new Array<string>(texts.length);
  for (let index = 0; index < texts.length; index += 1) {
    const value = texts[index];
    if (typeof value !== 'string') {
      throw new EmbeddingProviderError('EMBEDDING_INPUT_INVALID', 'Embedding input must contain text strings');
    }
    // `String.length` is the bounded UTF-16 length used by the request layer;
    // it avoids copying attacker-controlled strings just to count them.
    const characters = value.length;
    if (characters > limits.maxTextCharacters) {
      throw new EmbeddingProviderError('EMBEDDING_INPUT_LIMIT', 'Embedding input exceeds the configured text limit');
    }
    totalCharacters += characters;
    if (totalCharacters > limits.maxTotalCharacters) {
      throw new EmbeddingProviderError('EMBEDDING_INPUT_LIMIT', 'Embedding input exceeds the configured total limit');
    }
    values[index] = value;
  }
  return values;
}

async function withRetries<T>(
  limits: EmbeddingProviderLimits,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let lastError: EmbeddingProviderError | undefined;
  for (let attempt = 0; attempt < limits.maxAttempts; attempt += 1) {
    try {
      return await withTimeout(operation, limits.requestTimeoutMs);
    } catch (error) {
      lastError = toProviderError(error);
      if (attempt + 1 >= limits.maxAttempts) break;
      await delay(Math.min(1_000, limits.retryDelayMs * (2 ** attempt)));
    }
  }
  throw lastError ?? new EmbeddingProviderError('EMBEDDING_REQUEST_FAILED', 'Embedding service request failed');
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new EmbeddingProviderError('EMBEDDING_TIMEOUT', 'Embedding service request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (timedOut) throw new EmbeddingProviderError('EMBEDDING_TIMEOUT', 'Embedding service request timed out');
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function toProviderError(_error: unknown): EmbeddingProviderError {
  // Provider errors can contain prompts, tokens, request bodies, or response
  // excerpts. Never retain or expose that content in this boundary.
  if (_error instanceof EmbeddingProviderError) return _error;
  return new EmbeddingProviderError('EMBEDDING_REQUEST_FAILED', 'Embedding service request failed');
}

function validateEmbeddings(value: unknown, expectedCount: number, dimensions: number): number[][] {
  if (!isRecord(value) || !Array.isArray(value.embeddings) || value.embeddings.length !== expectedCount) {
    throw new EmbeddingProviderError('EMBEDDING_RESPONSE_INVALID', 'Embedding service returned an invalid response');
  }
  return value.embeddings.map((embedding) => validateVector(embedding, dimensions));
}

function validateEmbedding(value: unknown, dimensions: number): number[] {
  if (!isRecord(value)) {
    throw new EmbeddingProviderError('EMBEDDING_RESPONSE_INVALID', 'Embedding service returned an invalid response');
  }
  return validateVector(value.embedding, dimensions);
}

function validateVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new EmbeddingProviderError('EMBEDDING_RESPONSE_INVALID', 'Embedding service returned an invalid vector');
  }
  return value.slice() as number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
