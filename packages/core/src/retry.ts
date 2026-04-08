export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 120;
  const maxDelayMs = options.maxDelayMs ?? 1500;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;

      if (attempt === attempts || !shouldRetry(error, attempt)) {
        break;
      }

      const jitter = Math.floor(Math.random() * 50);
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1) + jitter, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
