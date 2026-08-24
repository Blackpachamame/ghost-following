import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBatchActivityQuery } from "./batch-query.js";
import {
  executeStrategy,
  formatBenchmarkResults,
  parseBatchResponse,
  planBatchSizes,
  runBatchingBenchmark,
  sanitizeGraphqlErrorMessage,
} from "./graphql-batching.js";

const period = {
  from: "2025-08-24T00:00:00.000Z",
  to: "2026-08-24T00:00:00.000Z",
  days: 365,
};

function validUser(login: string) {
  return {
    login,
    contributionsCollection: {
      hasAnyContributions: true,
      hasAnyRestrictedContributions: false,
      restrictedContributionsCount: 0,
      contributionCalendar: { totalContributions: 3 },
    },
  };
}

describe("parseBatchResponse", () => {
  it("distinguishes partial GraphQL errors and null users", () => {
    const query = buildBatchActivityQuery(["one", "two"], period);
    const parsed = parseBatchResponse(
      JSON.stringify({
        data: {
          u0: validUser("one"),
          u1: null,
          rateLimit: { cost: 2, remaining: 98 },
        },
        errors: [{ message: "User unavailable", path: ["u1"] }],
      }),
      query,
    );

    assert.equal(parsed.successfulUsers, 1);
    assert.equal(parsed.failedUsers, 1);
    assert.equal(parsed.graphqlErrors, 1);
    assert.equal(parsed.partialGraphqlErrors, 1);
    assert.equal(parsed.globalGraphqlErrors, 0);
    assert.equal(parsed.nullUsers, 1);
    assert.equal(parsed.graphqlCost, 2);
    assert.equal(parsed.remaining, 98);
    assert.deepEqual(parsed.graphqlErrorDetails, [
      { message: "User unavailable", path: "u1", scope: "partial" },
    ]);
  });

  it("treats a global GraphQL failure as failure for the whole batch", () => {
    const query = buildBatchActivityQuery(["one", "two"], period);
    const parsed = parseBatchResponse(
      JSON.stringify({
        data: null,
        errors: [{ message: "Global failure" }],
      }),
      query,
    );

    assert.equal(parsed.successfulUsers, 0);
    assert.equal(parsed.failedUsers, 2);
    assert.equal(parsed.globalGraphqlErrors, 1);
    assert.equal(parsed.partialGraphqlErrors, 0);
  });

  it("rejects invalid JSON without throwing away the series", () => {
    const query = buildBatchActivityQuery(["one"], period);
    assert.deepEqual(parseBatchResponse("not json", query), {
      successfulUsers: 0,
      failedUsers: 1,
      graphqlErrors: 1,
      globalGraphqlErrors: 1,
      partialGraphqlErrors: 0,
      nullUsers: 0,
      graphqlErrorDetails: [
        {
          message: "Response body is not valid JSON",
          path: null,
          scope: "global",
        },
      ],
    });
  });

  it("sanitizes multiline messages before retaining them", () => {
    assert.equal(
      sanitizeGraphqlErrorMessage("first\nsecond\tthird"),
      "first second third",
    );
  });
});

it("records an HTTP failure against every user in the failed chunk", async () => {
  const clockValues = [0, 15];
  const result = await executeStrategy({
    strategy: "batch 5",
    batchSize: 5,
    logins: ["one", "two"],
    period,
    token: "obvious-test-placeholder",
    fetch: (async () => new Response("server error", { status: 500 })) as typeof fetch,
    clock: () => clockValues.shift() ?? 15,
    remainingBefore: 100,
  });

  assert.equal(result.httpRequests, 1);
  assert.equal(result.httpErrors, 1);
  assert.equal(result.successfulUsers, 0);
  assert.equal(result.failedUsers, 2);
  assert.equal(result.durationMs, 15);
  assert.equal(result.approxResponseBytes, Buffer.byteLength("server error"));
  assert.match(
    formatBenchmarkResults([result], result.remainingAfter),
    /global GraphQL 0, partial GraphQL 0, null users 0, HTTP 1/,
  );
});

it("prints 50 identical GraphQL messages once with their count", async () => {
  const logins = Array.from({ length: 50 }, (_, index) => `user-${index}`);
  const data = Object.fromEntries(logins.map((_login, index) => [`u${index}`, null]));
  const result = await executeStrategy({
    strategy: "batch 50",
    batchSize: 50,
    logins,
    period,
    token: "obvious-test-placeholder",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          data: {
            ...data,
            rateLimit: { cost: 1, remaining: 99 },
          },
          errors: logins.map((_login, index) => ({
            message: "Alias limit exceeded\nfor this query",
            path: [`u${index}`],
          })),
        }),
        { status: 200 },
      )) as typeof fetch,
    clock: (() => {
      const values = [0, 10];
      return () => values.shift() ?? 10;
    })(),
    remainingBefore: 100,
  });

  const output = formatBenchmarkResults([result], result.remainingAfter);
  assert.match(output, /50× "Alias limit exceeded for this query"/);
  assert.equal((output.match(/Alias limit exceeded/g) ?? []).length, 1);
  assert.match(output, /example paths: u0, u1, u2, u3, u4/);
  assert.match(output, /No fully successful strategy was observed/);
});

it("reduces and deduplicates batch sizes for small samples", () => {
  assert.deepEqual(planBatchSizes(18), [
    { requested: 5, effective: 5 },
    { requested: 10, effective: 10 },
    { requested: 25, effective: 18 },
  ]);
  assert.deepEqual(planBatchSizes(1), []);
  assert.deepEqual(
    planBatchSizes(50).map(({ effective }) => effective),
    [5, 10, 25, 30, 35, 40, 45, 50],
  );
});

describe("runBatchingBenchmark", () => {
  it("requires GITHUB_TOKEN without making a request", async () => {
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    let fetchCalled = false;
    const errors: string[] = [];
    try {
      const exitCode = await runBatchingBenchmark(["owner"], {
        fetch: (async () => {
          fetchCalled = true;
          return new Response("{}");
        }) as typeof fetch,
        io: { log() {}, error: (message) => errors.push(message) },
      });
      assert.equal(exitCode, 1);
      assert.equal(fetchCalled, false);
      assert.deepEqual(errors, ["GITHUB_TOKEN is required for this benchmark."]);
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });

  it("runs a deterministic one-user benchmark entirely from mocked APIs", async () => {
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "benchmark-test-token";
    const logs: string[] = [];
    const requests: Array<{ url: string; body: string }> = [];
    const clockValues = [0, 12];
    const fetchMock = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      if (init?.method !== "POST") {
        return new Response(
          JSON.stringify([
            {
              login: "sample-user",
              id: 1,
              type: "User",
              html_url: "https://github.com/sample-user",
            },
          ]),
          { status: 200 },
        );
      }
      const request = JSON.parse(String(init.body)) as { query: string };
      if (request.query.includes("BenchmarkRateLimit")) {
        return new Response(
          JSON.stringify({
            data: { rateLimit: { cost: 1, limit: 5000, remaining: 4999 } },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            u0: validUser("sample-user"),
            rateLimit: { cost: 1, remaining: 4998 },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const exitCode = await runBatchingBenchmark(["owner"], {
        fetch: fetchMock,
        now: new Date("2026-08-24T00:00:00.000Z"),
        clock: () => clockValues.shift() ?? 12,
        io: { log: (message) => logs.push(message), error() {} },
      });

      assert.equal(exitCode, 0);
      assert.equal(requests.length, 3);
      assert.match(logs[0] ?? "", /Benchmark sample: 1 users/);
      assert.match(logs[0] ?? "", /Period: 365 days/);
      assert.match(logs[1] ?? "", /Initial GraphQL remaining: 4999 \/ 5000/);
      assert.match(logs[2] ?? "", /individual/);
      assert.match(logs[2] ?? "", /Final GraphQL remaining: 4998/);
      assert.doesNotMatch(logs.join("\n"), /benchmark-test-token/);
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });
});
