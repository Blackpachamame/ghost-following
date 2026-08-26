import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecentBatchFailureIncident } from "./recent-batch-failures.js";
import {
  compareRecentQueryParity,
  createRecentQueryShapes,
  executeRecentQueryMeasurement,
  runRecentQueryComparison,
  type RecentQueryMeasurement,
} from "./recent-query-comparison.js";

const PERIOD = { from: "2025-08-25T00:00:00.000Z", to: "2026-08-25T00:00:00.000Z", days: 365 };
const SHAPE = { shape: "FULL" as const, logins: ["Alice"] };
const noSleep = async () => undefined;

function graphQLPayload(bodyText: string, options: { booleanActive?: boolean; numericTotal?: number; returnedLogin?: string } = {}): unknown {
  const body = JSON.parse(bodyText) as { variables: Record<string, string> };
  const data: Record<string, unknown> = { rateLimit: { cost: 1, limit: 5000, remaining: 4998, resetAt: "2026-08-25T02:00:00.000Z" } };
  for (const key of Object.keys(body.variables).filter((key) => key.startsWith("login"))) {
    const index = Number(key.slice(5));
    const login = body.variables[key]!;
    const active = options.booleanActive ?? true;
    const total = options.numericTotal ?? (active ? 1 : 0);
    data[`u${index}`] = { login: options.returnedLogin ?? login, contributionsCollection: {
      startedAt: PERIOD.from, endedAt: PERIOD.to,
      hasAnyContributions: active, hasAnyRestrictedContributions: false, hasActivityInThePast: false,
      restrictedContributionsCount: 0, totalCommitContributions: total,
      totalIssueContributions: 0, totalPullRequestContributions: 0,
      totalPullRequestReviewContributions: 0, contributionCalendar: { totalContributions: total },
    } };
  }
  return { data };
}

function successFetch(seen?: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    seen?.push(body);
    return new Response(JSON.stringify(graphQLPayload(body)), { status: 200 });
  }) as typeof fetch;
}

function incident(count: number): RecentBatchFailureIncident {
  const logins = Array.from({ length: count }, (_, index) => `user-${index}`);
  return { timestamp: "2026-08-25T01:40:41.234Z", auditUsername: "AuditUser", phase: "recent",
    period: PERIOD, httpStatus: 504, attempts: 3, batchSize: count, logins };
}

describe("recent query comparison runner", () => {
  it("plans exact fixed shapes for 25, even, odd, two and singleton batches", () => {
    assert.deepEqual(createRecentQueryShapes(incident(25).logins).map((item) => item.logins.length), [25, 12, 13]);
    assert.deepEqual(createRecentQueryShapes(incident(24).logins).map((item) => item.logins.length), [24, 12, 12]);
    assert.deepEqual(createRecentQueryShapes(incident(13).logins).map((item) => item.logins.length), [13, 6, 7]);
    assert.deepEqual(createRecentQueryShapes(incident(2).logins).map((item) => item.logins.length), [2, 1, 1]);
    assert.deepEqual(createRecentQueryShapes(incident(1).logins).map((item) => item.logins.length), [1]);
  });

  it("runs variants and shapes sequentially in deterministic order", async () => {
    const seen: string[] = [];
    const result = await runRecentQueryComparison(incident(2), "source.jsonl", 1, {
      token: "test-token", fetch: successFetch(seen), sleep: noSleep, now: new Date("2026-08-25T03:00:00Z"),
    });
    assert.deepEqual(result.measurements.map(({ variant, shape, batchSize }) => [variant, shape, batchSize]), [
      ["CURRENT", "FULL", 2], ["CURRENT", "LEFT", 1], ["CURRENT", "RIGHT", 1],
      ["CLASSIFIER_MINIMAL", "FULL", 2], ["CLASSIFIER_MINIMAL", "LEFT", 1], ["CLASSIFIER_MINIMAL", "RIGHT", 1],
      ["NUMERIC_MINIMAL", "FULL", 2], ["NUMERIC_MINIMAL", "LEFT", 1], ["NUMERIC_MINIMAL", "RIGHT", 1],
    ]);
    assert.equal(seen.length, 9);
  });

  it("records retry success attempts, exact UTF-8 request bytes, response bytes and monotonic elapsed", async () => {
    let calls = 0;
    let sent = "";
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1; sent = String(init?.body);
      if (calls === 1) return new Response("gateway", { status: 504 });
      return new Response(JSON.stringify(graphQLPayload(sent)), { status: 200 });
    }) as typeof fetch;
    const ticks = [10, 22.345];
    const measured = await executeRecentQueryMeasurement("CURRENT", 1, SHAPE, PERIOD, {
      token: "secret", fetch: fetcher, sleep: noSleep, clock: () => ticks.shift()!,
    });
    assert.equal(measured.outcome, "SUCCESS");
    assert.equal(measured.httpAttempts, 2);
    assert.equal(measured.elapsedMs, 12.35);
    assert.equal(measured.requestBodyBytes, Buffer.byteLength(sent, "utf8"));
    assert.equal(measured.responseBodyBytes, Buffer.byteLength(JSON.stringify(graphQLPayload(sent)), "utf8"));
  });

  it("normalizes exhausted 502, 503 and 504 with three attempts and no hidden split", async () => {
    for (const status of [502, 503, 504]) {
      let calls = 0;
      const measured = await executeRecentQueryMeasurement("CURRENT", 1, SHAPE, PERIOD, {
        token: "secret", sleep: noSleep,
        fetch: (async () => { calls += 1; return new Response("", { status }); }) as typeof fetch,
      });
      assert.equal(measured.outcome, `HTTP_${status}_EXHAUSTED`);
      assert.equal(measured.httpAttempts, 3);
      assert.equal(calls, 3);
      assert.deepEqual(measured.logins, ["Alice"]);
    }
  });

  it("retries invalid JSON within the central budget and reports exhaustion", async () => {
    let calls = 0;
    const measured = await executeRecentQueryMeasurement("CURRENT", 1, SHAPE, PERIOD, {
      token: "secret", sleep: noSleep,
      fetch: (async () => { calls += 1; return new Response("not-json", { status: 200 }); }) as typeof fetch,
    });
    assert.equal(measured.outcome, "INVALID_RESPONSE_BODY");
    assert.equal(measured.httpAttempts, 3);
    assert.equal(measured.responseBodyBytes, 8);
    assert.equal(calls, 3);
  });

  it("records exhausted allowlisted transport failures with three attempts", async () => {
    let calls = 0;
    const measured = await executeRecentQueryMeasurement("CURRENT", 1, SHAPE, PERIOD, {
      token: "secret", sleep: noSleep,
      fetch: (async () => {
        calls += 1;
        throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
      }) as typeof fetch,
    });
    assert.equal(measured.outcome, "TRANSPORT_ERROR");
    assert.equal(measured.httpAttempts, 3);
    assert.equal(calls, 3);
  });

  it("retries allowlisted body-read failures within the central budget", async () => {
    let calls = 0;
    const measured = await executeRecentQueryMeasurement("CURRENT", 1, SHAPE, PERIOD, {
      token: "secret", sleep: noSleep,
      fetch: (async () => {
        calls += 1;
        const stream = new ReadableStream({ start(controller) {
          const failure = Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" });
          controller.error(failure);
        } });
        return new Response(stream, { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(measured.outcome, "INVALID_RESPONSE_BODY");
    assert.equal(measured.httpAttempts, 3);
    assert.equal(calls, 3);
  });

  it("records an unclassified body-read failure without retrying it", async () => {
    let calls = 0;
    const measured = await executeRecentQueryMeasurement("CURRENT", 1, SHAPE, PERIOD, {
      token: "secret", sleep: noSleep,
      fetch: (async () => {
        calls += 1;
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error("broken body")); } }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(measured.outcome, "INVALID_RESPONSE_BODY");
    assert.equal(measured.httpAttempts, 1);
    assert.equal(calls, 1);
  });

  it("does not retry auth or rate-limit HTTP responses", async () => {
    for (const [status, outcome, headers] of [
      [401, "AUTH_ERROR", undefined], [403, "AUTH_ERROR", undefined],
      [403, "RATE_LIMIT", { "x-ratelimit-remaining": "0" }], [429, "RATE_LIMIT", undefined],
    ] as const) {
      let calls = 0;
      const measured = await executeRecentQueryMeasurement("CURRENT", 1, SHAPE, PERIOD, {
        token: "secret", sleep: noSleep,
        fetch: (async () => { calls += 1; return new Response("", {
          status, ...(headers === undefined ? {} : { headers }),
        }); }) as typeof fetch,
      });
      assert.equal(measured.outcome, outcome);
      assert.equal(measured.httpAttempts, 1);
      assert.equal(calls, 1);
    }
  });

  it("records GraphQL RESOURCE_LIMIT and login mismatch without succeeding", async () => {
    const resource = await executeRecentQueryMeasurement("NUMERIC_MINIMAL", 1, SHAPE, PERIOD, {
      token: "secret", sleep: noSleep,
      fetch: (async () => new Response(JSON.stringify({
        data: { u0: null, rateLimit: { cost: 9, limit: 5000, remaining: 4900, resetAt: "2026-08-25T02:00:00Z" } },
        errors: [{ message: "Resource limits for this query exceeded.", path: ["u0"] }],
      }))) as typeof fetch,
    });
    assert.equal(resource.outcome, "RESOURCE_LIMIT");
    assert.equal(resource.graphqlCost, 9);
    const mismatch = await executeRecentQueryMeasurement("CLASSIFIER_MINIMAL", 1, SHAPE, PERIOD, {
      token: "secret", sleep: noSleep,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(
        graphQLPayload(String(init?.body), { returnedLogin: "Bob" }),
      ))) as typeof fetch,
    });
    assert.equal(mismatch.outcome, "SCHEMA_ERROR");
  });

  it("detects classification and detail matches and mismatches", () => {
    const measurement = (variant: RecentQueryMeasurement["variant"], classification: "ACTIVE" | "NO_RECENT_VISIBLE_ACTIVITY", total: number): RecentQueryMeasurement => ({
      variant, run: 1, shape: "FULL", batchSize: 1, logins: ["Alice"], outcome: "SUCCESS",
      errorClass: null, elapsedMs: 1, requestBodyBytes: 1, responseBodyBytes: 1, httpAttempts: 1,
      graphqlCost: 1, rateLimitRemaining: 1, accounts: [{ login: "Alice", classification,
        ...(variant === "CLASSIFIER_MINIMAL" ? {} : { details: {
          totalContributions: total, commitContributions: total, issueContributions: 0,
          pullRequestContributions: 0, pullRequestReviewContributions: 0, restrictedContributionsCount: 0,
        } }) }],
    });
    const matching = compareRecentQueryParity([
      measurement("CURRENT", "ACTIVE", 1),
      measurement("CLASSIFIER_MINIMAL", "ACTIVE", 0),
      measurement("NUMERIC_MINIMAL", "ACTIVE", 1),
    ]);
    assert.equal(matching[0]?.classificationParity, "MATCH");
    assert.equal(matching[1]?.classificationParity, "MATCH");
    assert.equal(matching[1]?.detailParity, "MATCH");
    const parity = compareRecentQueryParity([
      measurement("CURRENT", "ACTIVE", 1),
      measurement("CLASSIFIER_MINIMAL", "NO_RECENT_VISIBLE_ACTIVITY", 0),
      measurement("NUMERIC_MINIMAL", "ACTIVE", 2),
    ]);
    assert.equal(parity[0]?.classificationParity, "MISMATCH");
    assert.deepEqual(parity[0]?.classificationMismatches, ["Alice"]);
    assert.equal(parity[0]?.detailParity, "NOT_APPLICABLE");
    assert.equal(parity[1]?.classificationParity, "MATCH");
    assert.equal(parity[1]?.detailParity, "MISMATCH");
    assert.deepEqual(parity[1]?.detailMismatches, ["Alice"]);
  });

  it("marks parity not comparable when either request failed", () => {
    const failed: RecentQueryMeasurement = { variant: "CURRENT", run: 1, shape: "FULL", batchSize: 1,
      logins: ["Alice"], outcome: "HTTP_504_EXHAUSTED", errorClass: "HTTP_504", elapsedMs: 1,
      requestBodyBytes: 1, responseBodyBytes: null, httpAttempts: 3, graphqlCost: null, rateLimitRemaining: null };
    const candidate = { ...failed, variant: "NUMERIC_MINIMAL" as const };
    assert.equal(compareRecentQueryParity([failed, candidate])[0]?.classificationParity, "NOT_COMPARABLE");
  });
});
