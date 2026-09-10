import { describe, expect, it } from 'vitest';
import { UploadReviewApiError } from '../../../apps/upload-reviewer/agent/lib/api.js';
import { retryUnboundPrepare } from '../../../apps/upload-reviewer/agent/lib/prepare-retry.js';

describe('upload-review prepare handshake retry', () => {
  it('recovers after a binding delay beyond the former 700ms budget', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await retryUnboundPrepare(
      async () => {
        calls += 1;
        if (calls < 5) throw new UploadReviewApiError(404);
        return 'prepared';
      },
      new AbortController().signal,
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    expect(result).toBe('prepared');
    expect(calls).toBe(5);
    expect(waits).toEqual([100, 200, 400, 800]);
    expect(waits.slice(0, 3).reduce((total, value) => total + value, 0)).toBe(700);
    expect(waits.reduce((total, value) => total + value, 0)).toBeGreaterThan(700);
  });
});
