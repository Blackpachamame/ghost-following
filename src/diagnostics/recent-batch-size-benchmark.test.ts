import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FollowedAccount } from "../domain/account.js";
import { buildAccountActivityBatchQuery } from "../github/batch-activity.js";
import {
  createCurrentBatchSizeExecutor, deterministicSampleLogins, median, partitionBenchmarkSample,
  prepareBatchSizeBenchmark, runBatchSizeBenchmark, selectBenchmarkCandidate, summarizeBatchSize,
  MAX_BENCHMARK_BATCH_SIZE,
  type BatchSizeMeasurement, type PreparedBatchSizeBenchmark,
} from "./recent-batch-size-benchmark.js";
import type { RecentQueryOutcome } from "./recent-query-comparison.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const PERIOD = { from: "2025-09-01T12:00:00.000Z", to: NOW.toISOString(), days: 365 };
function account(login: string, type = "User", id = 1): FollowedAccount {
  return { login, type, id, htmlUrl: `https://github.com/${login}` };
}
function accounts(count: number): FollowedAccount[] {
  return Array.from({ length: count }, (_, index) => account(`user-${index}`, "User", index + 1));
}
function prepared(sizes: readonly number[], count = 25): PreparedBatchSizeBenchmark {
  return prepareBatchSizeBenchmark("AuditUser", accounts(count), { days: 365, sampleSize: 50, sizes, now: NOW });
}
function metric(outcome: RecentQueryOutcome = "SUCCESS", attempts = 1, elapsedMs = 100) {
  return {
    outcome, errorClass: outcome === "SUCCESS" ? null : outcome, httpAttempts: attempts, elapsedMs,
    requestBodyBytes: 10, responseBodyBytes: outcome === "SUCCESS" ? 20 : null,
    graphqlCost: outcome === "SUCCESS" ? 2 : null, rateLimitRemaining: outcome === "SUCCESS" ? 4999 : null,
    rateLimitResetAt: null,
  };
}
function measurement(overrides: Partial<BatchSizeMeasurement> = {}): BatchSizeMeasurement {
  return {
    configuredBatchSize: 10, batchIndex: 1, batchSizeActual: 10,
    logins: accounts(10).map(({ login }) => login), ...metric(), ...overrides,
  };
}
function graphQLPayload(bodyText: string): unknown {
  const body = JSON.parse(bodyText) as { variables: Record<string, string> };
  const data: Record<string, unknown> = {
    rateLimit: { cost: 2, limit: 5000, remaining: 4998, resetAt: "2026-09-01T13:00:00.000Z" },
  };
  for (const key of Object.keys(body.variables).filter((key) => key.startsWith("login"))) {
    const index = Number(key.slice(5));
    data[`u${index}`] = { login: body.variables[key], contributionsCollection: {
      startedAt: PERIOD.from, endedAt: PERIOD.to,
      hasAnyContributions: true, hasAnyRestrictedContributions: false, hasActivityInThePast: false,
      restrictedContributionsCount: 0, totalCommitContributions: 1, totalIssueContributions: 0,
      totalPullRequestContributions: 0, totalPullRequestReviewContributions: 0,
      contributionCalendar: { totalContributions: 1 },
    } };
  }
  return { data };
}

describe("recent batch-size preparation", () => {
  it("filters exact User accounts and caps the deterministic sample", () => {
    const source = [account("one", "User", 1), account("org", "Organization", 2), account("bot", "Bot", 3)];
    const value = prepareBatchSizeBenchmark("Audit", source, { days: 365, sampleSize: 50, sizes: [1], now: NOW });
    assert.deepEqual(value.sampling.logins, ["one"]);
    assert.deepEqual(value.following, { total: 3, eligibleUsers: 1, unsupportedAccounts: 2 });
  });

  it("produces the same normalized SHA-256 ordering across REST order and username casing", () => {
    const source = [account("Zulu", "User", 1), account("ALICE", "User", 2), account("Bob", "User", 3)];
    const first = deterministicSampleLogins("AuditUser", source, 3).map((login) => login.toLowerCase());
    const second = deterministicSampleLogins("AUDITUSER", [...source].reverse().map((item) => ({ ...item, login: item.login.toLowerCase() })), 3)
      .map((login) => login.toLowerCase());
    assert.deepEqual(first, second);
  });

  it("plans consecutive chunking, including partial 10 and 12 batches", () => {
    const logins = accounts(25).map(({ login }) => login);
    assert.deepEqual(partitionBenchmarkSample(logins, 10).map(({ length }) => length), [10, 10, 5]);
    assert.deepEqual(partitionBenchmarkSample(logins, 12).map(({ length }) => length), [12, 12, 1]);
    const value = prepared([6, 8, 10, 12, 15, 25]);
    assert.deepEqual(value.plannedLogicalBatches.map(({ batches }) => batches), [5, 4, 3, 3, 2, 1]);
    assert.equal(value.totalPlannedLogicalBatches, 18);
    assert.equal(MAX_BENCHMARK_BATCH_SIZE, 25);
  });
});

describe("recent batch-size execution", () => {
  it("preserves size order, restarts at sample zero, reuses one period, and executes partial batches", async () => {
    const value = prepared([12, 10]);
    const seen: { size: number; logins: readonly string[]; period: object }[] = [];
    const result = await runBatchSizeBenchmark(value, async (logins, size, _batch, period) => {
      seen.push({ size, logins: [...logins], period }); return metric();
    });
    assert.deepEqual(seen.map(({ size, logins }) => [size, logins.length]), [[12, 12], [12, 12], [12, 1], [10, 10], [10, 10], [10, 5]]);
    assert.equal(seen[0]?.logins[0], seen[3]?.logins[0]);
    assert.equal(seen.every(({ period }) => period === value.period), true);
    assert.equal(result.halt, null);
  });

  it("continues after every processing failure without adaptive splitting", async () => {
    for (const outcome of ["HTTP_502_EXHAUSTED", "HTTP_504_EXHAUSTED", "RESOURCE_LIMIT", "INVALID_RESPONSE_BODY"] as const) {
      const sizes: number[] = [];
      const result = await runBatchSizeBenchmark(prepared([10]), async (logins, _size, batch) => {
        sizes.push(logins.length); return metric(batch === 1 ? outcome : "SUCCESS", batch === 1 ? 3 : 1);
      });
      assert.deepEqual(sizes, [10, 10, 5]);
      assert.equal(result.summaries[0]?.processingFailureBatches, 1);
      assert.equal(result.summaries[0]?.processingFailureUsers, 10);
      assert.equal(result.summaries[0]?.successfulUsers, 15);
    }
  });

  it("halts current and future sizes for every global outcome and preserves reset metadata", async () => {
    for (const outcome of ["HTTP_503_EXHAUSTED", "RATE_LIMIT", "AUTH_ERROR", "TRANSPORT_ERROR", "SCHEMA_ERROR", "OTHER_FATAL"] as const) {
      let calls = 0;
      const result = await runBatchSizeBenchmark(prepared([10, 12]), async () => {
        calls += 1; return { ...metric(outcome), rateLimitRemaining: 0, rateLimitResetAt: "2026-09-01T13:00:00.000Z" };
      });
      assert.equal(calls, 1);
      assert.deepEqual(result.halt, {
        halted: true, haltedAtSize: 10, haltedAtBatch: 1, haltReason: outcome,
        rateLimitRemaining: 0, resetAt: "2026-09-01T13:00:00.000Z",
      });
      assert.equal(result.summaries[0]?.completed, false);
    }
  });

  it("never treats a global outcome in the final planned batch as a completed candidate", async () => {
    const result = await runBatchSizeBenchmark(prepared([25]), async () => metric("RATE_LIMIT"));
    assert.equal(result.summaries[0]?.executedBatches, 1);
    assert.equal(result.summaries[0]?.plannedBatches, 1);
    assert.equal(result.summaries[0]?.completed, false);
    assert.equal(result.candidate, null);
  });

  it("uses exact productive CURRENT query, central retry and byte metrics, with no minimal variants", async () => {
    let calls = 0;
    let sent = "";
    const executor = createCurrentBatchSizeExecutor({
      token: "test-token", sleep: async () => undefined,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls += 1; sent = String(init?.body);
        if (calls === 1) return new Response("gateway", { status: 504 });
        return new Response(JSON.stringify(graphQLPayload(sent)), { status: 200, headers: { "x-ratelimit-reset": "1788267600" } });
      }) as typeof fetch,
    });
    const observed = await executor(["Alice", "Bob"], 2, 1, PERIOD);
    const body = JSON.parse(sent) as { query: string; variables: Record<string, string> };
    const expected = buildAccountActivityBatchQuery(["Alice", "Bob"], PERIOD);
    assert.equal(body.query, expected.query);
    assert.deepEqual(body.variables, expected.variables);
    assert.equal(sent.includes("CLASSIFIER_MINIMAL") || sent.includes("NUMERIC_MINIMAL"), false);
    assert.equal(observed.outcome, "SUCCESS");
    assert.equal(observed.httpAttempts, 2);
    assert.equal(observed.requestBodyBytes, Buffer.byteLength(sent, "utf8"));
    assert.equal(observed.responseBodyBytes, Buffer.byteLength(JSON.stringify(graphQLPayload(sent)), "utf8"));
    assert.equal(calls, 2);
  });
});

describe("recent batch-size aggregation", () => {
  it("calculates users, attempts, timings, cost and only observed bytes", () => {
    const summary = summarizeBatchSize(10, 3, [
      measurement({ batchIndex: 1, httpAttempts: 1, elapsedMs: 100, graphqlCost: 2, rateLimitRemaining: 99 }),
      measurement({ batchIndex: 2, httpAttempts: 2, elapsedMs: 200, graphqlCost: 3, rateLimitRemaining: 96 }),
      measurement({ batchIndex: 3, batchSizeActual: 5, logins: ["a", "b", "c", "d", "e"], outcome: "HTTP_504_EXHAUSTED", httpAttempts: 3, elapsedMs: 300, responseBodyBytes: null, graphqlCost: null, rateLimitRemaining: null }),
    ]);
    assert.deepEqual({ ok: summary.successfulUsers, failed: summary.processingFailureUsers, first: summary.firstAttemptSuccesses,
      retried: summary.retriedSuccesses, attempts: summary.totalHttpAttempts, retries: summary.retryAttempts },
    { ok: 20, failed: 5, first: 1, retried: 1, attempts: 6, retries: 3 });
    assert.equal(summary.totalElapsedMs, 600);
    assert.equal(summary.averageBatchElapsedMs, 200);
    assert.equal(summary.medianBatchElapsedMs, 200);
    assert.equal(summary.successfulUsersPerSecond, 20 / 0.6);
    assert.equal(summary.successfulUserRate, 0.8);
    assert.equal(summary.observedGraphqlCost, 5);
    assert.equal(summary.rateLimitRemaining, 96);
    assert.equal(summary.totalRequestBodyBytes, 30);
    assert.equal(summary.totalObservedResponseBodyBytes, 40);
  });

  it("handles odd/even medians and zero throughput denominators", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
    assert.equal(summarizeBatchSize(10, 0, []).successfulUsersPerSecond, null);
  });

  it("selects only completed zero-failure throughput with documented tie-breaks", () => {
    const base = summarizeBatchSize(10, 1, [measurement({ elapsedMs: 1_000 })]);
    const larger = { ...base, configuredBatchSize: 12 };
    assert.equal(selectBenchmarkCandidate([base, larger])?.configuredBatchSize, 12);
    assert.equal(selectBenchmarkCandidate([{ ...base, processingFailureBatches: 1 }]), null);
    assert.equal(selectBenchmarkCandidate([{ ...base, completed: false }]), null);
  });

  it("does not execute production 12 implicitly when it was not requested", async () => {
    const seen: number[] = [];
    const result = await runBatchSizeBenchmark(prepared([10]), async (_logins, size) => { seen.push(size); return metric(); });
    assert.equal(seen.includes(12), false);
    assert.equal(result.productionComparison.included, false);
    assert.equal(result.productionComparison.production, null);
  });

  it("locates production 12 when explicitly included while still accepting diagnostic size 25", async () => {
    const result = await runBatchSizeBenchmark(prepared([25, 12]), async () => metric());
    assert.equal(result.productionBatchSize, 12);
    assert.equal(result.productionComparison.productionBatchSize, 12);
    assert.equal(result.productionComparison.included, true);
    assert.equal(result.productionComparison.production?.configuredBatchSize, 12);
  });
});
