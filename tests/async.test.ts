import { describe, expect, it, vi } from "vitest";
import { retry, TimeoutError, HttpStatusError, isRetryableError } from "../src/core/async";

describe("retry", () => {
  it("returns on first success without retrying", async () => {
    const fn = vi.fn(async () => "value");
    await expect(retry(fn, { attempts: 3 })).resolves.toBe("value");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("succeeds after transient failures", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error(`fail ${n}`);
      return "recovered";
    });
    const onAttempt = vi.fn();
    await expect(retry(fn, { attempts: 3, onAttempt })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onAttempt).toHaveBeenCalledTimes(2); // before retry 2 and retry 3
  });

  it("throws the last error at the attempt cap", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always");
    });
    await expect(retry(fn, { attempts: 3 })).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when retryable returns false", async () => {
    const fn = vi.fn(async () => {
      throw new HttpStatusError(404);
    });
    await expect(retry(fn, { attempts: 3, retryable: isRetryableError })).rejects.toBeInstanceOf(HttpStatusError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors (timeout, 5xx, network)", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n === 1) throw new HttpStatusError(503);
      if (n === 2) throw new TimeoutError("x", 10);
      return "ok";
    });
    await expect(retry(fn, { attempts: 3, retryable: isRetryableError })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("isRetryableError", () => {
  it("timeouts and network/server errors are retryable; 4xx is not", () => {
    expect(isRetryableError(new TimeoutError("x", 1))).toBe(true);
    expect(isRetryableError(new HttpStatusError(0))).toBe(true);
    expect(isRetryableError(new HttpStatusError(500))).toBe(true);
    expect(isRetryableError(new HttpStatusError(503))).toBe(true);
    expect(isRetryableError(new HttpStatusError(404))).toBe(false);
    expect(isRetryableError(new HttpStatusError(403))).toBe(false);
    expect(isRetryableError(new Error("plain"))).toBe(true); // unknown = network-ish, retryable
  });
});
