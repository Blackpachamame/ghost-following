import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAccountActivityBatchQuery } from "../github/batch-activity.js";
import type { RecentBatchFailureIncident } from "./recent-batch-failures.js";
import {
  createCompositionBasePlan,
  createCurrentCompositionExecutor,
  isProcessingFailure,
  runRecentCompositionProbe,
  selectCompositionTarget,
  type CompositionNodeExecutor,
  type CompositionNodePlan,
} from "./recent-composition-probe.js";
import type { RecentQueryOutcome } from "./recent-query-comparison.js";

const PERIOD = { from: "2025-08-26T12:26:11.722Z", to: "2026-08-26T12:26:11.722Z", days: 365 };
const RIGHT_13 = [
  "bycedlanalyst", "lateefat1-ajayi", "cursoragent", "imaan187953",
  "BishnuPanigrahi", "DavidASeitz", "sameerkhairkar", "hintz-openai",
  "danielh-pf", "sergio-sisternes-epam", "sproutseedlymain", "jasontang-ai", "ngquockiet",
];
const ORIGINAL_25 = [
  "jamwithai", "AbbyAdj", "CR-Grace", "curseoflove", "frantic-openai",
  "Rorychhattish", "riseandignite", "mahimarawat0707", "nemegrod", "xMikeyy",
  "vietlq-datapot", "fleshwater", ...RIGHT_13,
];

function incident(logins: readonly string[]): RecentBatchFailureIncident {
  return {
    timestamp: "2026-08-26T13:36:53.707Z",
    auditUsername: "PratikDhanave",
    phase: "recent",
    period: PERIOD,
    httpStatus: 504,
    attempts: 3,
    batchSize: logins.length,
    logins: [...logins],
  };
}

function metric(outcome: RecentQueryOutcome) {
  return {
    outcome,
    errorClass: outcome === "SUCCESS" ? null : outcome,
    httpAttempts: outcome === "SUCCESS" ? 1 : 3,
    elapsedMs: 10,
    requestBodyBytes: 100,
    responseBodyBytes: outcome === "SUCCESS" ? 200 : null,
    graphqlCost: outcome === "SUCCESS" ? 1 : null,
    rateLimitRemaining: outcome === "SUCCESS" ? 4999 : null,
  };
}

function executorFor(
  outcome: (node: CompositionNodePlan, run: number) => RecentQueryOutcome,
  calls: CompositionNodePlan[] = [],
): CompositionNodeExecutor {
  return async (node, run) => {
    calls.push(node);
    return metric(outcome(node, run));
  };
}

function successfulPayload(bodyText: string, returnedLogin?: string): unknown {
  const body = JSON.parse(bodyText) as { variables: Record<string, string> };
  const data: Record<string, unknown> = {
    rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-08-26T14:00:00Z" },
  };
  for (const key of Object.keys(body.variables).filter((key) => key.startsWith("login"))) {
    const index = Number(key.slice(5));
    data[`u${index}`] = {
      login: returnedLogin ?? body.variables[key],
      contributionsCollection: {
        startedAt: PERIOD.from,
        endedAt: PERIOD.to,
        hasAnyContributions: true,
        hasAnyRestrictedContributions: false,
        hasActivityInThePast: false,
        restrictedContributionsCount: 0,
        totalCommitContributions: 1,
        totalIssueContributions: 0,
        totalPullRequestContributions: 0,
        totalPullRequestReviewContributions: 0,
        contributionCalendar: { totalContributions: 1 },
      },
    };
  }
  return { data };
}

describe("recent composition target and base plan", () => {
  it("selects FULL 25, LEFT 12 and RIGHT 13 without reordering", () => {
    assert.deepEqual(selectCompositionTarget(ORIGINAL_25, "FULL"), ORIGINAL_25);
    assert.deepEqual(selectCompositionTarget(ORIGINAL_25, "LEFT"), ORIGINAL_25.slice(0, 12));
    assert.deepEqual(selectCompositionTarget(ORIGINAL_25, "RIGHT"), RIGHT_13);
  });

  it("builds TARGET13, halves 6/7 and exact N-1 probes", () => {
    const plan = createCompositionBasePlan(RIGHT_13, 1);
    assert.deepEqual(plan.map(({ strategy, logins }) => [strategy, logins.length]), [
      ["TARGET", 13], ["HALF_LEFT", 6], ["HALF_RIGHT", 7],
      ["DROP_FIRST", 12], ["DROP_MIDDLE", 12], ["DROP_LAST", 12],
    ]);
    assert.deepEqual(plan[3]?.logins, RIGHT_13.slice(1));
    assert.deepEqual(plan[4]?.logins, RIGHT_13.filter((_login, index) => index !== 6));
    assert.deepEqual(plan[5]?.logins, RIGHT_13.slice(0, -1));
  });

  it("deduplicates identical ordered groups before requesting", () => {
    const plan = createCompositionBasePlan(["a", "b", "c"], 1);
    assert.equal(plan.length, 5);
    assert.equal(plan.filter(({ logins }) => JSON.stringify(logins) === JSON.stringify(["b", "c"])).length, 1);
  });

  it("rejects empty targets and unavailable singleton halves", () => {
    assert.throws(() => selectCompositionTarget([], "FULL"));
    assert.throws(() => selectCompositionTarget(["only"], "RIGHT"), /unavailable/);
  });
});

describe("recent composition traversal", () => {
  it("executes every base measurement even when TARGET succeeds", async () => {
    const calls: CompositionNodePlan[] = [];
    const result = await runRecentCompositionProbe(incident(RIGHT_13), "source.jsonl", "FULL", 1, {
      token: "dummy", executor: executorFor(() => "SUCCESS", calls), now: new Date("2026-08-28T01:00:00Z"),
    });
    assert.deepEqual(calls.map(({ strategy }) => strategy), [
      "TARGET", "HALF_LEFT", "HALF_RIGHT", "DROP_FIRST", "DROP_MIDDLE", "DROP_LAST",
    ]);
    assert.equal(result.measurements.length, 6);
  });

  it("descends only a failed half, measures siblings first, and preserves parent/depth", async () => {
    const failures = new Set(["R1-HR", "R1-HR-R", "R1-HR-R-R", "R1-HR-R-R-L"]);
    const result = await runRecentCompositionProbe(incident(RIGHT_13), "source.jsonl", "FULL", 1, {
      token: "dummy",
      executor: executorFor((node) => failures.has(node.nodeId) ? "HTTP_504_EXHAUSTED" : "SUCCESS"),
      now: new Date("2026-08-28T01:00:00Z"),
    });
    const ids = result.measurements.map(({ nodeId }) => nodeId);
    assert.deepEqual(ids.slice(6), [
      "R1-HR-L", "R1-HR-R", "R1-HR-R-L", "R1-HR-R-R", "R1-HR-R-R-L", "R1-HR-R-R-R",
    ]);
    assert.equal(ids.some((id) => id.startsWith("R1-HR-L-")), false);
    const grandchild = result.measurements.find(({ nodeId }) => nodeId === "R1-HR-R-R-L");
    assert.equal(grandchild?.parentNodeId, "R1-HR-R-R");
    assert.equal(grandchild?.depth, 4);
    assert.equal(grandchild?.batchSize, 1);
    assert.deepEqual(result.summaries[0]?.singletonFailures.map(({ nodeId }) => nodeId), ["R1-HR-R-R-L"]);
  });

  it("uses exactly the documented processing-failure descent set", async () => {
    for (const outcome of ["HTTP_502_EXHAUSTED", "HTTP_504_EXHAUSTED", "RESOURCE_LIMIT", "INVALID_RESPONSE_BODY"] as const) {
      assert.equal(isProcessingFailure(outcome), true);
      const result = await runRecentCompositionProbe(incident(["a", "b", "c", "d"]), "source", "FULL", 1, {
        token: "dummy",
        executor: executorFor((node) => node.nodeId === "R1-HR" ? outcome : "SUCCESS"),
      });
      assert.equal(result.measurements.some(({ nodeId }) => nodeId === "R1-HR-L"), true);
    }
  });

  it("does not descend and halts on 503, auth, rate, transport, schema or other fatal outcomes", async () => {
    for (const outcome of ["HTTP_503_EXHAUSTED", "AUTH_ERROR", "RATE_LIMIT", "TRANSPORT_ERROR", "SCHEMA_ERROR", "OTHER_FATAL"] as const) {
      const calls: CompositionNodePlan[] = [];
      const result = await runRecentCompositionProbe(incident(["a", "b", "c", "d"]), "source", "FULL", 3, {
        token: "dummy", executor: executorFor(() => outcome, calls),
      });
      assert.equal(calls.length, 1);
      assert.equal(result.executedRuns, 1);
      assert.equal(result.summaries[0]?.haltedByNodeId, "R1-TARGET");
    }
  });

  it("starts each run from TARGET and permits different adaptive trees", async () => {
    const calls: { run: number; nodeId: string }[] = [];
    const executor: CompositionNodeExecutor = async (node, run) => {
      calls.push({ run, nodeId: node.nodeId });
      return metric(run === 1 && node.nodeId === "R1-HR" ? "HTTP_502_EXHAUSTED" : "SUCCESS");
    };
    const result = await runRecentCompositionProbe(incident(["a", "b", "c", "d"]), "source", "FULL", 2, {
      token: "dummy", executor,
    });
    assert.equal(calls.filter(({ nodeId }) => nodeId.endsWith("TARGET")).length, 2);
    assert.ok(result.measurements.filter(({ run }) => run === 1).length > result.measurements.filter(({ run }) => run === 2).length);
    const intermittent = result.intermittency.find(({ logins }) => JSON.stringify(logins) === JSON.stringify(["c", "d"]));
    assert.equal(intermittent?.status, "INTERMITTENT_OBSERVED");
    assert.equal(intermittent?.successCount, 1);
    assert.equal(intermittent?.processingFailureCount, 1);
  });

  it("summarizes N-1 outcomes and neutral failure-inclusion frequencies", async () => {
    const result = await runRecentCompositionProbe(incident(["a", "b", "c"]), "source", "FULL", 1, {
      token: "dummy",
      executor: executorFor((node) => ["R1-TARGET", "R1-HR"].includes(node.nodeId) ? "RESOURCE_LIMIT" : "SUCCESS"),
    });
    const summary = result.summaries[0]!;
    assert.deepEqual(summary.nMinusOne.map(({ strategy, requestedBatchSize, outcome }) => [strategy, requestedBatchSize, outcome]), [
      ["TARGET", 3, "RESOURCE_LIMIT"], ["DROP_FIRST", 2, "RESOURCE_LIMIT"],
      ["DROP_MIDDLE", 2, "SUCCESS"], ["DROP_LAST", 2, "SUCCESS"],
    ]);
    const a = summary.failureInclusion.find(({ login }) => login === "a")!;
    const b = summary.failureInclusion.find(({ login }) => login === "b")!;
    assert.deepEqual([a.timesIncluded, a.timesIncludedInProcessingFailure], [4, 1]);
    assert.deepEqual([b.timesIncluded, b.timesIncludedInProcessingFailure], [4, 2]);
  });
});

describe("recent composition CURRENT transport", () => {
  it("sends the exact productive CURRENT query and measures request/response bytes and monotonic time", async () => {
    let sent = "";
    const ticks = [10, 25.5];
    const executor = createCurrentCompositionExecutor({
      token: "dummy",
      clock: () => ticks.shift()!,
      sleep: async () => undefined,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent = String(init?.body);
        return new Response(JSON.stringify(successfulPayload(sent)), { status: 200 });
      }) as typeof fetch,
    });
    const node: CompositionNodePlan = {
      nodeId: "R1-TARGET", parentNodeId: null, strategy: "TARGET", depth: 0, logins: ["alice", "bob"],
    };
    const measured = await executor(node, 1, PERIOD);
    const parsedBody = JSON.parse(sent) as { query: string; variables: Record<string, string> };
    const productive = buildAccountActivityBatchQuery(node.logins, PERIOD);
    assert.equal(parsedBody.query, productive.query);
    assert.deepEqual(parsedBody.variables, productive.variables);
    assert.doesNotMatch(parsedBody.query, /RecentQueryComparisonCLASSIFIER_MINIMAL|RecentQueryComparisonNUMERIC_MINIMAL/);
    assert.equal(measured.outcome, "SUCCESS");
    assert.equal(measured.elapsedMs, 15.5);
    assert.equal(measured.requestBodyBytes, Buffer.byteLength(sent, "utf8"));
    assert.ok((measured.responseBodyBytes ?? 0) > 0);
  });

  it("reuses central retry and records 504 -> success on attempt two", async () => {
    let calls = 0;
    let body = "";
    const executor = createCurrentCompositionExecutor({
      token: "dummy",
      sleep: async () => undefined,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        body = String(init?.body);
        return calls === 1
          ? new Response("", { status: 504 })
          : new Response(JSON.stringify(successfulPayload(body)), { status: 200 });
      }) as typeof fetch,
    });
    const measured = await executor(
      { nodeId: "R1-TARGET", parentNodeId: null, strategy: "TARGET", depth: 0, logins: ["alice"] },
      1,
      PERIOD,
    );
    assert.equal(measured.outcome, "SUCCESS");
    assert.equal(measured.httpAttempts, 2);
    assert.equal(calls, 2);
  });

  it("keeps exhausted 504 exact after three central attempts", async () => {
    let calls = 0;
    const executor = createCurrentCompositionExecutor({
      token: "dummy",
      sleep: async () => undefined,
      fetch: (async () => { calls += 1; return new Response("", { status: 504 }); }) as typeof fetch,
    });
    const measured = await executor(
      { nodeId: "R1-TARGET", parentNodeId: null, strategy: "TARGET", depth: 0, logins: ["alice"] },
      1,
      PERIOD,
    );
    assert.equal(measured.outcome, "HTTP_504_EXHAUSTED");
    assert.equal(measured.httpAttempts, 3);
    assert.equal(calls, 3);
  });

  it("turns a returned-login mismatch into SCHEMA_ERROR", async () => {
    const executor = createCurrentCompositionExecutor({
      token: "dummy",
      sleep: async () => undefined,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body);
        return new Response(JSON.stringify(successfulPayload(body, "bob")), { status: 200 });
      }) as typeof fetch,
    });
    const measured = await executor(
      { nodeId: "R1-TARGET", parentNodeId: null, strategy: "TARGET", depth: 0, logins: ["alice"] },
      1,
      PERIOD,
    );
    assert.equal(measured.outcome, "SCHEMA_ERROR");
    assert.equal(measured.httpAttempts, 1);
  });
});
