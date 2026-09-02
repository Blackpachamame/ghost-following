import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FollowedAccount } from "../domain/account.js";
import { prepareBatchSizeBenchmark, runBatchSizeBenchmark } from "./recent-batch-size-benchmark.js";
import {
  batchSizeBenchmarkPathFor,
  formatBatchSizeBenchmarkPlan,
  formatRecentBatchSizeBenchmark,
  writeRecentBatchSizeBenchmark,
} from "./recent-batch-size-report.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
function accounts(count: number): FollowedAccount[] {
  return Array.from({ length: count }, (_, index) => ({
    login: `user-${index}`, id: index + 1, type: "User", htmlUrl: `https://github.com/user-${index}`,
  }));
}
function metric(outcome: "SUCCESS" | "HTTP_504_EXHAUSTED" = "SUCCESS") {
  return {
    outcome, errorClass: outcome === "SUCCESS" ? null : "HTTP_504", httpAttempts: outcome === "SUCCESS" ? 1 : 3,
    elapsedMs: 100, requestBodyBytes: 50, responseBodyBytes: outcome === "SUCCESS" ? 100 : null,
    graphqlCost: outcome === "SUCCESS" ? 1 : null, rateLimitRemaining: 4999, rateLimitResetAt: null,
  };
}

describe("recent batch-size report", () => {
  it("formats the complete pre-live logical request plan", () => {
    const prepared = prepareBatchSizeBenchmark("AuditUser", accounts(200), {
      days: 365, sampleSize: 200, sizes: [6, 8, 10, 12, 15, 25], now: NOW,
    });
    const plan = formatBatchSizeBenchmarkPlan(prepared);
    for (const line of ["6 -> 34", "8 -> 25", "10 -> 20", "12 -> 17", "15 -> 14", "25 -> 8", "Total planned logical batches: 118"]) {
      assert.equal(plan.includes(line), true, `missing ${line}`);
    }
    assert.match(plan, /Adaptive fallback: disabled/);
  });

  it("reports a conservative candidate and explicit production-default absence", async () => {
    const prepared = prepareBatchSizeBenchmark("AuditUser", accounts(50), {
      days: 365, sampleSize: 50, sizes: [10, 8], now: NOW,
    });
    const result = await runBatchSizeBenchmark(prepared, async (_logins, size) => ({ ...metric(), elapsedMs: size === 10 ? 90 : 100 }));
    const report = formatRecentBatchSizeBenchmark(result, "result.json");
    assert.match(report, /Best observed zero-processing-failure throughput in this sample/);
    assert.match(report, /Production default 12 was not included/);
    assert.match(report, /not a universal GitHub batch-size limit/);
  });

  it("does not claim a winner when every completed size has a processing failure", async () => {
    const prepared = prepareBatchSizeBenchmark("AuditUser", accounts(10), {
      days: 365, sampleSize: 50, sizes: [10], now: NOW,
    });
    const result = await runBatchSizeBenchmark(prepared, async () => metric("HTTP_504_EXHAUSTED"));
    assert.equal(result.candidate, null);
    assert.match(formatRecentBatchSizeBenchmark(result, "result.json"), /No tested batch size completed/);
  });

  it("uses schema 1 and collision-safe wx suffixes without overwriting", async () => {
    const prepared = prepareBatchSizeBenchmark("AuditUser", accounts(1), {
      days: 365, sampleSize: 50, sizes: [1], now: NOW,
    });
    const result = await runBatchSizeBenchmark(prepared, async () => metric());
    const paths: string[] = [];
    const saved = await writeRecentBatchSizeBenchmark(result, {
      root: "isolated-root",
      fileSystem: {
        mkdir: async () => undefined,
        writeFile: async (path, data, options) => {
          paths.push(path);
          assert.equal(options.flag, "wx");
          assert.equal(JSON.parse(data).schemaVersion, 1);
          if (paths.length === 1) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        },
      },
    });
    assert.equal(paths.length, 2);
    assert.equal(saved, batchSizeBenchmarkPathFor("AuditUser", NOW.toISOString(), "isolated-root", 1));
  });
});
