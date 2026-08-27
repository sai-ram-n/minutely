/**
 * Retry and backoff behaviour.
 *
 * Uses an injected sleep that records delays instead of waiting, so the timing
 * contract is asserted exactly and the suite stays fast.
 */

import { describe, it, expect, vi } from "vitest";
import { withRetry, backoffDelay, isRetryable, HttpError } from "../src/ai/retry.js";

/** Records what withRetry would have waited, without actually waiting. */
function recordingSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  return { delays, sleep };
}

const noJitter = { jitter: false };

describe("isRetryable", () => {
  it("retries 429 — the rate limit case this exists for", () => {
    expect(isRetryable(new HttpError(429, "rate limited"))).toBe(true);
  });

  it("retries 5xx as transient", () => {
    expect(isRetryable(new HttpError(500, "boom"))).toBe(true);
    expect(isRetryable(new HttpError(503, "unavailable"))).toBe(true);
  });

  it("retries network-level failures, which carry no status", () => {
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });

  it("does NOT retry 4xx other than 429 — that is our bug, and retrying burns quota", () => {
    expect(isRetryable(new HttpError(401, "bad key"))).toBe(false);
    expect(isRetryable(new HttpError(400, "malformed"))).toBe(false);
    expect(isRetryable(new HttpError(404, "no such model"))).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("doubles: 1s, 2s, 4s", () => {
    const options = { baseDelayMs: 1000, maxDelayMs: 20000, jitter: false };
    expect(backoffDelay(1, options)).toBe(1000);
    expect(backoffDelay(2, options)).toBe(2000);
    expect(backoffDelay(3, options)).toBe(4000);
  });

  it("caps at maxDelayMs so a long sequence cannot wait absurdly", () => {
    const options = { baseDelayMs: 1000, maxDelayMs: 5000, jitter: false };
    expect(backoffDelay(10, options)).toBe(5000);
  });

  it("honours a server-sent Retry-After over its own guess", () => {
    const delay = backoffDelay(1, {
      baseDelayMs: 1000,
      maxDelayMs: 20000,
      jitter: false,
      retryAfterSeconds: 7,
    });
    expect(delay).toBe(7000);
  });

  it("still caps a Retry-After that asks for an unreasonable wait", () => {
    const delay = backoffDelay(1, {
      baseDelayMs: 1000,
      maxDelayMs: 20000,
      jitter: false,
      retryAfterSeconds: 3600,
    });
    expect(delay).toBe(20000);
  });

  it("keeps jittered delays within the lower half of the capped value", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = backoffDelay(2, { baseDelayMs: 1000, maxDelayMs: 20000, jitter: true });
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });
});

describe("withRetry", () => {
  it("returns immediately on success without sleeping", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, { sleep, ...noJitter });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries a 429 three times total and backs off 1s then 2s", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new HttpError(429, "rate limited"));

    await expect(
      withRetry(fn, { attempts: 3, baseDelayMs: 1000, sleep, ...noJitter }),
    ).rejects.toThrow("rate limited");

    // 3 attempts means 2 waits between them — never a trailing sleep.
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("stops retrying as soon as a call succeeds", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(429, "rate limited"))
      .mockResolvedValue({ text: "recovered" });

    const result = await withRetry(fn, { sleep, ...noJitter });

    expect(result).toEqual({ text: "recovered" });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
  });

  it("does not retry a non-retryable error, and does not sleep", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new HttpError(401, "invalid api key"));

    await expect(withRetry(fn, { sleep, ...noJitter })).rejects.toThrow("invalid api key");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("rethrows the final error so the caller can mark the work failed", async () => {
    const { sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new HttpError(503, "service unavailable"));

    await expect(
      withRetry(fn, { attempts: 2, sleep, ...noJitter }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("uses a 429's Retry-After for the wait instead of exponential backoff", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(429, "slow down", { retryAfterSeconds: 5 }))
      .mockResolvedValue("ok");

    await withRetry(fn, { sleep, ...noJitter });

    expect(delays).toEqual([5000]);
  });

  it("reports each retry so rate limiting is visible in logs, not silent", async () => {
    const { sleep } = recordingSleep();
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new HttpError(429, "rate limited"));

    await expect(
      withRetry(fn, { attempts: 3, sleep, onRetry, ...noJitter }),
    ).rejects.toThrow();

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, attempts: 3, delayMs: 1000 });
    expect(onRetry.mock.calls[1][0]).toMatchObject({ attempt: 2, attempts: 3, delayMs: 2000 });
  });

  it("honours a single-attempt configuration by not retrying at all", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new HttpError(429, "rate limited"));

    await expect(withRetry(fn, { attempts: 1, sleep, ...noJitter })).rejects.toThrow();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
