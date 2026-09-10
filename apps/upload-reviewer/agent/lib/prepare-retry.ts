import { UploadReviewApiError } from './api.js';

// The job-specific prepare handshake normally binds immediately. Keep a
// bounded fallback for older sessions that lack the handshake header; the
// total wait is 3.1s, still below the 45s request budget.
const PREPARE_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600] as const;

export type PrepareRequest<T> = () => Promise<T>;
export type PrepareWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

/**
 * Eve creates a session and starts its first turn in one request; there is no
 * dormant-session API. The registry binds the returned session id immediately
 * after the request is accepted, so a first prepare can briefly race that
 * binding. Retry only the opaque-session 404 path, with a bounded budget.
 */
export async function retryUnboundPrepare<T>(
  request: PrepareRequest<T>,
  signal: AbortSignal,
  wait: PrepareWait = waitForRetry,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof UploadReviewApiError) || error.status !== 404 || attempt >= PREPARE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await wait(PREPARE_RETRY_DELAYS_MS[attempt]!, signal);
    }
  }
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('upload review prepare was aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('upload review prepare was aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
