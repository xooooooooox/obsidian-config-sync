// Timeout + retry primitives for network work. Obsidian's requestUrl has no timeout and can
// hang indefinitely on a stalled connection; withTimeout bounds each attempt and retry gives
// idempotent downloads a few tries before surfacing the failure (repo rule: idempotent
// operations retry with warnings, then raise the last error).

export class TimeoutError extends Error {
  constructor(public label: string, public ms: number) {
    super(`timed out after ${ms}ms: ${label}`);
    this.name = "TimeoutError";
  }
}

export class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

// A definitive 4xx means "won't ever succeed" — don't retry it. Timeouts, network failures
// (status 0), and 5xx are transient and worth another attempt; an unknown error is treated
// as network-ish and retried.
export function isRetryableError(err: Error): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof HttpStatusError) return err.status === 0 || err.status >= 500;
  return true;
}

export interface RetryOptions {
  attempts: number; // total tries, e.g. 3 = 1 initial + 2 retries
  retryable?: (err: Error) => boolean; // default: retry everything
  onAttempt?: (nextAttempt: number, err: Error) => void; // called before each retry (nextAttempt is 2-based)
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error;
      lastErr = err;
      const canRetry = opts.retryable === undefined || opts.retryable(err);
      if (!canRetry || attempt === opts.attempts) throw err;
      opts.onAttempt?.(attempt + 1, err);
    }
  }
  throw lastErr ?? new Error("retry called with attempts < 1"); // loop always returns/throws when attempts >= 1
}
