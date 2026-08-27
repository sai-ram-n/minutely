/**
 * Retry with exponential backoff.
 *
 * Lives in the ai/ layer because retry is a provider concern — no route or
 * socket handler should ever contain retry logic. Kept in its own module so the
 * timing behaviour can be unit tested directly with fake timers, which is the
 * piece most likely to break silently.
 */

/**
 * Error carrying the HTTP status that caused it, so retry decisions can be made
 * on status rather than by string-matching a message.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {{ retryAfterSeconds?: number, body?: string }} [details]
   */
  constructor(status, message, details = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.body = details.body;
  }
}

/**
 * Which failures are worth retrying.
 *
 * 429 is rate limiting — the case this exists for. 5xx is a transient server
 * problem. Network-level errors have no status at all. A 4xx other than 429 is
 * our own bug (bad key, malformed request) and retrying it just burns quota.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  // fetch() rejects with a TypeError on DNS/connection failures.
  return error instanceof TypeError;
}

/**
 * Delay before a given attempt, in milliseconds.
 *
 * Exponential: baseDelayMs * 2^(attempt-1), so 1s, 2s, 4s with the defaults.
 * A server-sent Retry-After always wins, because guessing shorter than what the
 * API explicitly asked for is how you get rate limited again immediately.
 * Jitter spreads retries out rather than having every chunk retry in lockstep.
 *
 * @param {number} attempt  1-based: the attempt that just failed
 * @param {{ baseDelayMs: number, maxDelayMs: number, jitter: boolean, retryAfterSeconds?: number }} options
 * @returns {number}
 */
export function backoffDelay(attempt, options) {
  const { baseDelayMs, maxDelayMs, jitter, retryAfterSeconds } = options;

  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
    return Math.min(retryAfterSeconds * 1000, maxDelayMs);
  }

  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);

  // Full jitter across the lower half, keeping delays bounded and predictable
  // enough to reason about while still de-synchronising concurrent callers.
  return jitter ? capped / 2 + Math.random() * (capped / 2) : capped;
}

/**
 * @typedef {Object} RetryOptions
 * @property {number} [attempts]      Total attempts including the first. Default 3.
 * @property {number} [baseDelayMs]   Default 1000.
 * @property {number} [maxDelayMs]    Default 20000.
 * @property {boolean} [jitter]       Default true. Tests disable it.
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(info: { attempt: number, attempts: number, delayMs: number, error: Error }) => void} [onRetry]
 */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying retryable failures with exponential backoff.
 *
 * Rethrows the last error once attempts are exhausted, so the caller can mark
 * the work failed rather than leaving it stuck forever.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 20000,
    jitter = true,
    sleep = defaultSleep,
    onRetry,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const canRetry = isRetryable(error) && attempt < attempts;
      if (!canRetry) throw error;

      const delayMs = backoffDelay(attempt, {
        baseDelayMs,
        maxDelayMs,
        jitter,
        retryAfterSeconds:
          error instanceof HttpError ? error.retryAfterSeconds : undefined,
      });

      onRetry?.({ attempt, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw lastError;
}
