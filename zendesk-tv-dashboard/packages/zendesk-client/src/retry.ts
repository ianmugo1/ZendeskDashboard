const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export function isRetryableStatusCode(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

export function backoffWithJitterMs(attempt: number, baseMs = 500, maxMs = 15000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return exponential + jitter;
}

export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric)) {
    return Math.max(0, numeric * 1000);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.max(0, parsed - Date.now());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
