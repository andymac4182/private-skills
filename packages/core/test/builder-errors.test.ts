import { describe, expect, it } from 'vitest';
import { createBuilderBffHandler } from '../src/builder.js';
import type {
  Authenticator,
  BlobStore,
  Principal,
  StateRepository,
} from '../../contracts/src/index.js';
import type { AuthoringHandlerDependencies } from '../../authoring/src/index.js';

describe('skill builder BFF error boundary', () => {
  it('does not expose an internal repository error message', async () => {
    const marker = 'repository-secret-marker-7b5b6f';
    const repository = {
      read: async () => {
        throw new Error(marker);
      },
      transaction: async () => {
        throw new Error('unused');
      },
    } as unknown as StateRepository;
    const handler = createBuilderBffHandler({
      repository,
      blobs: {} as BlobStore,
      auth: {} as Authenticator,
      config: {
        organizationId: 'org-test',
        publicOrigin: 'https://registry.example.test',
        maxBodyBytes: 1024 * 1024,
      },
      authoring: {} as AuthoringHandlerDependencies,
      runtime: {
        appOrigin: 'https://builder.example.test',
        serviceToken: 'service-token',
        eveToken: 'eve-token',
      },
    });
    const principal: Principal = {
      organizationId: 'org-test',
      subject: 'publisher',
      roles: ['publisher'],
    };

    const response = await handler(
      new Request('https://registry.example.test/v1/drafts/draft-1/builder/session?revision=1&digest=sha256:0000000000000000000000000000000000000000000000000000000000000000'),
      principal,
    );

    expect(response).toBeDefined();
    if (!response) throw new Error('builder route did not return a response');
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ code: 'BUILDER_UNAVAILABLE', message: 'The skill builder is unavailable.' });
    expect(JSON.stringify(body)).not.toContain(marker);
  });
});
