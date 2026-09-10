import { describe, expect, it } from 'vitest';
import { UploadReviewApiError } from '../apps/upload-reviewer/agent/lib/api.js';
import { retryUnboundPrepare } from '../apps/upload-reviewer/agent/lib/prepare-retry.js';

describe('upload reviewer session binding race', () => {
  it('retries only bounded unbound-session responses until the registry binding is visible', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const value = await retryUnboundPrepare(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new UploadReviewApiError(404);
        return 'prepared';
      },
      new AbortController().signal,
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );
    expect(value).toBe('prepared');
    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it('does not retry an authorization or server response', async () => {
    const waits: number[] = [];
    await expect(retryUnboundPrepare(
      async () => { throw new UploadReviewApiError(500); },
      new AbortController().signal,
      async (milliseconds) => { waits.push(milliseconds); },
    )).rejects.toMatchObject({ status: 500 });
    expect(waits).toEqual([]);
  });
});
