import { describe, expect, it } from 'vitest';

import {
  createEmbeddingProvider,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_PREPROCESS_VERSION,
  type EmbeddingProviderSdk,
} from '../src/embeddings.js';

function sdkFor(options: {
  embedMany?: (value: { values: string[]; abortSignal?: AbortSignal }) => Promise<unknown>;
  embed?: (value: { value: string; abortSignal?: AbortSignal }) => Promise<unknown>;
  onGateway?: (value: { baseURL?: string; apiKey?: string }) => void;
} = {}): EmbeddingProviderSdk {
  return {
    createGateway: (settings: { baseURL?: string; apiKey?: string } | undefined) => {
      options.onGateway?.(settings ?? {});
      return { embeddingModel: () => ({}) as never };
    },
    embedMany: async (value: { values: string[]; abortSignal?: AbortSignal }) => options.embedMany?.(value) ?? { embeddings: value.values.map(() => [1, 2, 3]) },
    embed: async (value: { value: string; abortSignal?: AbortSignal }) => options.embed?.(value) ?? { embedding: [1, 2, 3] },
  } as unknown as EmbeddingProviderSdk;
}

describe('Gateway embedding provider', () => {
  it('is disabled unless explicitly enabled and uses stable configured profile identity', async () => {
    let constructed = false;
    const disabled = createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'false' }, {
      sdk: {
        createGateway: () => {
          constructed = true;
          return { embeddingModel: () => ({}) as never };
        },
      },
    });
    expect(disabled).toBeUndefined();
    expect(constructed).toBe(false);

    const provider = createEmbeddingProvider({
      PSKILLS_AI_ENABLED: 'true',
      PSKILLS_EMBEDDING_MODEL: 'test/embedding',
      PSKILLS_EMBEDDING_DIMENSIONS: '3',
    }, { sdk: sdkFor() });
    expect(provider?.profile).toEqual({
      id: `gateway:test/embedding:d3:${EMBEDDING_PREPROCESS_VERSION}`,
      model: 'test/embedding',
      dimensions: 3,
    });
  });

  it('calls injected SDK functions for batches and queries without a network', async () => {
    const seen: { batch?: string[]; query?: string; baseURL?: string; apiKey?: string } = {};
    const provider = createEmbeddingProvider({
      PSKILLS_AI_ENABLED: 'true',
      PSKILLS_AI_GATEWAY_BASE_URL: 'https://gateway.example.test/v4/ai',
      AI_GATEWAY_API_KEY: 'test-key',
      PSKILLS_EMBEDDING_DIMENSIONS: '3',
    }, { sdk: sdkFor({
      onGateway: (settings) => {
        seen.baseURL = settings.baseURL;
        seen.apiKey = settings.apiKey;
      },
      embedMany: async ({ values }) => {
        seen.batch = values;
        return { embeddings: values.map((_, index) => [index + 1, 2, 3]) };
      },
      embed: async ({ value }) => {
        seen.query = value;
        return { embedding: [4, 5, 6] };
      },
    }) });
    expect(provider).toBeDefined();

    await expect(provider!.embedMany(['first', 'second'])).resolves.toEqual([[1, 2, 3], [2, 2, 3]]);
    await expect(provider!.embedQuery('query')).resolves.toEqual([4, 5, 6]);
    expect(seen).toEqual({
      batch: ['first', 'second'],
      query: 'query',
      baseURL: 'https://gateway.example.test/v4/ai',
      apiKey: 'test-key',
    });
  });

  it('uses documented defaults and leaves OIDC credential selection to the Gateway', () => {
    let settings: { baseURL?: string; apiKey?: string } | undefined;
    const provider = createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'true' }, { sdk: sdkFor({
      onGateway: (value) => { settings = value; },
    }) });
    expect(provider?.profile).toEqual({
      id: `gateway:${DEFAULT_EMBEDDING_MODEL}:d${DEFAULT_EMBEDDING_DIMENSIONS}:${EMBEDDING_PREPROCESS_VERSION}`,
      model: DEFAULT_EMBEDDING_MODEL,
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    });
    expect(settings).toEqual({});
  });

  it('bounds text input before invoking the SDK', async () => {
    let calls = 0;
    const provider = createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'true', PSKILLS_EMBEDDING_DIMENSIONS: '3' }, { sdk: sdkFor({
      embedMany: async ({ values }) => {
        calls += 1;
        return { embeddings: values.map(() => [1, 2, 3]) };
      },
    }), limits: { maxTextCharacters: 4, maxTotalCharacters: 8, maxTexts: 2 } });

    await expect(provider!.embedMany(['12345'])).rejects.toMatchObject({ code: 'EMBEDDING_INPUT_LIMIT' });
    await expect(provider!.embedMany(['1234', '5678', '9'])).rejects.toMatchObject({ code: 'EMBEDDING_INPUT_LIMIT' });
    expect(calls).toBe(0);

    expect(() => createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'true' }, {
      sdk: sdkFor(),
      limits: { maxTexts: 61 },
    })).toThrowError(/limits configuration is invalid/u);
  });

  it('retries bounded failures and never exposes provider error content', async () => {
    let calls = 0;
    const secret = 'prompt-secret-provider-response';
    const provider = createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'true', PSKILLS_EMBEDDING_DIMENSIONS: '3' }, { sdk: sdkFor({
      embedMany: async ({ values }) => {
        calls += 1;
        if (calls === 1) throw new Error(secret);
        return { embeddings: values.map(() => [1, 2, 3]) };
      },
    }), limits: { maxAttempts: 2, retryDelayMs: 1, requestTimeoutMs: 100 } });

    await expect(provider!.embedMany(['retry'])).resolves.toEqual([[1, 2, 3]]);
    expect(calls).toBe(2);

    const failing = createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'true', PSKILLS_EMBEDDING_DIMENSIONS: '3' }, { sdk: sdkFor({
      embedMany: async () => { throw new Error(secret); },
    }), limits: { maxAttempts: 1, requestTimeoutMs: 100 } });
    await expect(failing!.embedMany(['failure'])).rejects.toSatisfy((error: unknown) => {
      return error instanceof Error && error.message === 'Embedding service request failed' && !error.message.includes(secret);
    });
  });

  it('rejects non-finite or dimension-mismatched model output', async () => {
    const wrongCount = createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'true' }, { sdk: sdkFor({
      embedMany: async () => ({ embeddings: [[1, 2]] }),
    }), limits: { maxAttempts: 1, requestTimeoutMs: 100 } });
    await expect(wrongCount!.embedMany(['bad'])).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });

    const nonFinite = createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'true' }, { sdk: sdkFor({
      embed: async () => ({ embedding: [1, Number.NaN, 3] }),
    }), limits: { maxAttempts: 1, requestTimeoutMs: 100 } });
    await expect(nonFinite!.embedQuery('bad')).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });
  });

  it('aborts timed-out calls within the bounded retry policy', async () => {
    const provider = createEmbeddingProvider({ PSKILLS_AI_ENABLED: 'true' }, { sdk: sdkFor({
      embedMany: async ({ abortSignal }) => await new Promise<never>((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () => reject(new Error('provider timeout payload')), { once: true });
      }),
    }), limits: { maxAttempts: 1, requestTimeoutMs: 5 } });
    await expect(provider!.embedMany(['timeout'])).rejects.toMatchObject({ code: 'EMBEDDING_TIMEOUT' });
  });
});
