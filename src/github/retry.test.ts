import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_RETRY_AFTER_MS,
  requestWithTransientRetry,
  retryDelayMs,
  TransientTransportRetryExhaustedError,
} from "./retry.js";

function transportError(code: string): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket failure"), { code }),
  });
}

describe("transient request retry", () => {
  it("retries only explicitly recognized transport codes", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await requestWithTransientRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw transportError("ECONNRESET");
        return new Response("ok", { status: 200 });
      },
      { sleep: async (delay) => void delays.push(delay) },
    );

    assert.equal(result.attempts, 2);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [1_000]);

    let unsafeAttempts = 0;
    await assert.rejects(
      requestWithTransientRetry(
        async () => {
          unsafeAttempts += 1;
          throw new TypeError("invalid request argument");
        },
        { sleep: async () => undefined },
      ),
      TypeError,
    );
    assert.equal(unsafeAttempts, 1);
  });

  it("stops recognized transport retries after three total attempts", async () => {
    let attempts = 0;
    const delays: number[] = [];
    await assert.rejects(
      requestWithTransientRetry(
        async () => {
          attempts += 1;
          throw transportError("UND_ERR_SOCKET");
        },
        { sleep: async (delay) => void delays.push(delay) },
      ),
      (error: unknown) => {
        assert.ok(error instanceof TransientTransportRetryExhaustedError);
        assert.equal(error.attempts, 3);
        assert.ok(error.cause instanceof TypeError);
        return true;
      },
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1_000, 2_000]);
  });
});

describe("Retry-After delay", () => {
  it("uses a valid numeric value only for an already retryable response", () => {
    assert.equal(
      retryDelayMs(
        new Response("", {
          status: 502,
          headers: { "retry-after": "3" },
        }),
        1,
      ),
      3_000,
    );
  });

  it("falls back for invalid values and caps unexpectedly large values", () => {
    assert.equal(
      retryDelayMs(
        new Response("", {
          status: 503,
          headers: { "retry-after": "not-a-number" },
        }),
        2,
      ),
      2_000,
    );
    assert.equal(
      retryDelayMs(
        new Response("", {
          status: 504,
          headers: { "retry-after": "999" },
        }),
        1,
      ),
      MAX_RETRY_AFTER_MS,
    );
  });
});
