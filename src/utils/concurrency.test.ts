import assert from "node:assert/strict";
import { it } from "node:test";
import { mapWithConcurrency } from "./concurrency.js";

it("limits concurrency and preserves result order", async () => {
  let active = 0;
  let maximumActive = 0;

  const results = await mapWithConcurrency([30, 5, 20, 10, 1], 2, async (delay) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return delay * 2;
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(results, [60, 10, 40, 20, 2]);
});

