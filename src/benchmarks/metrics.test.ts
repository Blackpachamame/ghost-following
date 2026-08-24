import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateGraphqlErrors,
  calculateStrategyMetrics,
  isFullySuccessfulStrategy,
  summarizeStrategies,
  type StrategyMetrics,
} from "./metrics.js";

it("aggregates direct costs, timings, bytes, users and errors", () => {
  const metrics = calculateStrategyMetrics({
    strategy: "batch 5",
    batchSize: 5,
    sampleSize: 10,
    remainingBefore: 100,
    observations: [
      {
        durationMs: 20,
        responseBytes: 1_000,
        graphqlCost: 2,
        remaining: 98,
        successfulUsers: 5,
        failedUsers: 0,
        graphqlErrors: 0,
        globalGraphqlErrors: 0,
        partialGraphqlErrors: 0,
        nullUsers: 0,
        httpErrors: 0,
      },
      {
        durationMs: 40,
        responseBytes: 2_000,
        graphqlCost: 3,
        remaining: 95,
        successfulUsers: 3,
        failedUsers: 2,
        graphqlErrors: 2,
        globalGraphqlErrors: 1,
        partialGraphqlErrors: 1,
        nullUsers: 1,
        httpErrors: 0,
      },
    ],
  });

  assert.equal(metrics.httpRequests, 2);
  assert.equal(metrics.totalGraphqlCost, 5);
  assert.equal(metrics.costPerUser, 0.5);
  assert.equal(metrics.durationMs, 60);
  assert.equal(metrics.averageRequestMs, 30);
  assert.equal(metrics.approxResponseBytes, 3_000);
  assert.equal(metrics.successfulUsers, 8);
  assert.equal(metrics.failedUsers, 2);
  assert.equal(metrics.graphqlErrors, 2);
  assert.equal(metrics.globalGraphqlErrors, 1);
  assert.equal(metrics.partialGraphqlErrors, 1);
  assert.equal(metrics.nullUsers, 1);
  assert.equal(metrics.remainingBefore, 100);
  assert.equal(metrics.remainingAfter, 95);
});

describe("aggregateGraphqlErrors", () => {
  it("deduplicates 50 identical messages and preserves compact path examples", () => {
    const aggregated = aggregateGraphqlErrors(
      Array.from({ length: 50 }, (_, index) => ({
        message: "Something went wrong",
        path: `u${index}`,
        scope: "partial" as const,
      })),
    );

    assert.deepEqual(aggregated, [
      {
        message: "Something went wrong",
        count: 50,
        scopes: ["partial"],
        examplePaths: ["u0", "u1", "u2", "u3", "u4"],
      },
    ]);
  });

  it("groups different messages independently", () => {
    const aggregated = aggregateGraphqlErrors([
      ...Array.from({ length: 30 }, () => ({
        message: "First error",
        path: null,
        scope: "global" as const,
      })),
      ...Array.from({ length: 20 }, () => ({
        message: "Second error",
        path: "u0",
        scope: "partial" as const,
      })),
    ]);

    assert.deepEqual(
      aggregated.map(({ message, count }) => ({ message, count })),
      [
        { message: "First error", count: 30 },
        { message: "Second error", count: 20 },
      ],
    );
  });
});

function strategy(
  batchSize: number,
  overrides: Partial<StrategyMetrics> = {},
): StrategyMetrics {
  return {
    strategy: `batch ${batchSize}`,
    batchSize,
    sampleSize: 50,
    httpRequests: Math.ceil(50 / batchSize),
    successfulUsers: 50,
    failedUsers: 0,
    durationMs: 100,
    averageRequestMs: 50,
    totalGraphqlCost: 2,
    costPerUser: 0.04,
    remainingBefore: 100,
    remainingAfter: 98,
    approxResponseBytes: 1_000,
    graphqlErrors: 0,
    globalGraphqlErrors: 0,
    partialGraphqlErrors: 0,
    nullUsers: 0,
    httpErrors: 0,
    graphqlErrorMessages: [],
    ...overrides,
  };
}

describe("successful strategy summary", () => {
  it("only treats complete zero-error results as fully successful", () => {
    assert.equal(isFullySuccessfulStrategy(strategy(25)), true);
    assert.equal(
      isFullySuccessfulStrategy(
        strategy(40, { successfulUsers: 0, failedUsers: 50 }),
      ),
      false,
    );
    assert.equal(
      isFullySuccessfulStrategy(
        strategy(40, {
          successfulUsers: 49,
          failedUsers: 1,
          graphqlErrors: 1,
          partialGraphqlErrors: 1,
        }),
      ),
      false,
    );
  });

  it("excludes faster and cheaper failures from winners and finds the boundary", () => {
    const summary = summarizeStrategies([
      strategy(25, { durationMs: 100 }),
      strategy(30, { durationMs: 90 }),
      strategy(35, { durationMs: 80 }),
      strategy(40, {
        httpRequests: 1,
        durationMs: 1,
        totalGraphqlCost: 1,
        costPerUser: 0.02,
        successfulUsers: 0,
        failedUsers: 50,
        graphqlErrors: 50,
        partialGraphqlErrors: 50,
      }),
      strategy(45, {
        durationMs: 2,
        costPerUser: 0.02,
        successfulUsers: 49,
        failedUsers: 1,
        graphqlErrors: 1,
        partialGraphqlErrors: 1,
      }),
      strategy(50, {
        httpRequests: 1,
        durationMs: 3,
        costPerUser: 0.02,
        successfulUsers: 0,
        failedUsers: 50,
        graphqlErrors: 50,
        partialGraphqlErrors: 50,
      }),
    ]);

    assert.deepEqual(summary, {
      bestRequestReduction: "batch 35",
      lowestCostPerUser: "batch 35",
      bestLatency: "batch 35",
      largestFullySuccessfulBatch: "batch 35",
      firstFailingBatch: "batch 40",
    });
  });
});
