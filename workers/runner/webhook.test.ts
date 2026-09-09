import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { invokeWebhookGate, validateWebhookUrl, verifyWebhookSignature } from './src/webhook.js';

const payload = {
  organizationId: 'org-fixture',
  jobId: 'job-fixture',
  attempt: 1,
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  policyRevision: 'policy-fixture',
  event: 'artifact.evaluate' as const,
};

describe('authenticated webhook gates', () => {
  it('requires a bound JSON acceptance and signs the exact body', async () => {
    const secret = 'fixture-webhook-secret-1234';
    let requestBody = '';
    let requestHeaders: Headers | undefined;
    const result = await invokeWebhookGate({
      id: 'gate-fixture',
      url: 'https://hooks.example.test/evaluate',
      secret,
      mode: 'required',
      timeoutSeconds: 2,
    }, payload, {
      fetch: async (_input, init) => {
        requestBody = String(init?.body);
        requestHeaders = new Headers(init?.headers);
        return Response.json({
          accepted: true,
          jobId: payload.jobId,
          artifactDigest: payload.artifactDigest,
          policyRevision: payload.policyRevision,
        });
      },
    });
    expect(result.status).toBe('accepted');
    const timestamp = requestHeaders?.get('x-private-skills-timestamp') ?? '';
    const supplied = requestHeaders?.get('x-private-skills-signature') ?? '';
    const expected = createHmac('sha256', secret).update(`${timestamp}.${requestBody}`).digest('hex');
    expect(supplied).toBe(`sha256=${expected}`);
    expect(verifyWebhookSignature(secret, timestamp, requestBody, supplied)).toBe(true);
  });

  it('fails closed on malformed destinations and response binding', async () => {
    const malformed = await invokeWebhookGate({ id: 'bad', url: 'http://hooks.example.test', secret: 'fixture-webhook-secret-1234', mode: 'required', timeoutSeconds: 1 }, payload);
    expect(malformed.status).toBe('error');
    expect(malformed.error).toContain('HTTPS');

    const mismatched = await invokeWebhookGate({ id: 'mismatch', url: 'https://hooks.example.test', secret: 'fixture-webhook-secret-1234', mode: 'required', timeoutSeconds: 1 }, payload, {
      fetch: async () => Response.json({ accepted: true, jobId: 'other-job', artifactDigest: payload.artifactDigest, policyRevision: payload.policyRevision }),
    });
    expect(mismatched.status).toBe('rejected');
  });

  it('allows loopback HTTP only with the explicit test switch', () => {
    expect(() => validateWebhookUrl('http://127.0.0.1:8080/hook')).toThrow('HTTPS');
    expect(validateWebhookUrl('http://127.0.0.1:8080/hook', true)).toBe('http://127.0.0.1:8080/hook');
  });
});
