import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  CompositionMeasurement,
  CompositionRunSummary,
  RecentCompositionProbe,
} from "./recent-composition-probe.js";
import { summarizeCompositionIntermittency } from "./recent-composition-probe.js";
import {
  formatRecentCompositionProbe,
  writeRecentCompositionProbe,
} from "./recent-composition-report.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function measurement(overrides: Partial<CompositionMeasurement> = {}): CompositionMeasurement {
  return {
    run: 1,
    nodeId: "R1-TARGET",
    parentNodeId: null,
    strategy: "TARGET",
    depth: 0,
    batchSize: 3,
    logins: ["a", "b", "c"],
    outcome: "HTTP_504_EXHAUSTED",
    errorClass: "HTTP_504",
    httpAttempts: 3,
    elapsedMs: 50,
    requestBodyBytes: 500,
    responseBodyBytes: null,
    graphqlCost: null,
    rateLimitRemaining: null,
    ...overrides,
  };
}

function summary(overrides: Partial<CompositionRunSummary> = {}): CompositionRunSummary {
  return {
    run: 1,
    successfulNodes: 5,
    processingFailureNodes: 1,
    singletonFailures: [],
    smallestSuccessfulBatch: 1,
    largestSuccessfulBatch: 2,
    smallestProcessingFailureBatch: 3,
    largestProcessingFailureBatch: 3,
    nMinusOne: [
      { strategy: "TARGET", requestedBatchSize: 3, measurementNodeId: "R1-TARGET", outcome: "HTTP_504_EXHAUSTED" },
      { strategy: "DROP_FIRST", requestedBatchSize: 2, measurementNodeId: "R1-HR", outcome: "SUCCESS" },
      { strategy: "DROP_MIDDLE", requestedBatchSize: 2, measurementNodeId: "R1-DROP-MIDDLE", outcome: "SUCCESS" },
      { strategy: "DROP_LAST", requestedBatchSize: 2, measurementNodeId: "R1-DROP-LAST", outcome: "SUCCESS" },
    ],
    failureInclusion: [
      { login: "a", timesIncluded: 4, timesIncludedInProcessingFailure: 1, failureInclusionRatio: 0.25 },
    ],
    haltedByNodeId: null,
    ...overrides,
  };
}

function probe(overrides: Partial<RecentCompositionProbe> = {}): RecentCompositionProbe {
  const measurements = [
    measurement(),
    measurement({ nodeId: "R1-HL", parentNodeId: "R1-TARGET", strategy: "HALF_LEFT", depth: 1, batchSize: 1, logins: ["a"], outcome: "SUCCESS", errorClass: null, httpAttempts: 1 }),
    measurement({ nodeId: "R1-HR", parentNodeId: "R1-TARGET", strategy: "HALF_RIGHT", depth: 1, batchSize: 2, logins: ["b", "c"], outcome: "SUCCESS", errorClass: null, httpAttempts: 1 }),
  ];
  return {
    schemaVersion: 1,
    probeTimestamp: "2026-08-28T01:00:00.000Z",
    auditUsername: "AuditUser",
    sourcePath: "source.jsonl",
    sourceIncident: {
      timestamp: "2026-08-26T13:36:53.707Z",
      period: { from: "2025-08-26T12:26:11.722Z", to: "2026-08-26T12:26:11.722Z", days: 365 },
      httpStatus: 504,
      attempts: 3,
      batchSize: 3,
      logins: ["a", "b", "c"],
    },
    selectedTarget: "FULL",
    targetLogins: ["a", "b", "c"],
    runs: 1,
    executedRuns: 1,
    queryVariant: "CURRENT",
    measurements,
    summaries: [summary()],
    intermittency: [],
    ...overrides,
  };
}

describe("recent composition report", () => {
  it("prints the observable tree, N-1 summary, neutral frequency and conservative observation", () => {
    const output = formatRecentCompositionProbe(probe(), "saved.json");
    assert.match(output, /Recent Batch Composition Probe/);
    assert.match(output, /R1-HR\s+R1-TARGET\s+HALF_RIGHT/);
    assert.match(output, /DROP_MIDDLE\s+size 2\s+SUCCESS/);
    assert.match(output, /association only/);
    assert.match(output, /aggregate batch\/composition cost/);
    assert.match(output, /No observed size is a universal GitHub threshold/);
  });

  it("reports singleton branch persistence and observed intermittency without causal wording", () => {
    const intermittency = summarizeCompositionIntermittency([
      measurement({ run: 1, outcome: "SUCCESS", errorClass: null }),
      measurement({ run: 2, nodeId: "R2-TARGET", outcome: "HTTP_504_EXHAUSTED" }),
    ]);
    const value = probe({
      summaries: [summary({ singletonFailures: [{ nodeId: "R1-HR-R", login: "c", outcome: "RESOURCE_LIMIT" }] })],
      intermittency,
    });
    const output = formatRecentCompositionProbe(value, "saved.json");
    assert.match(output, /down to a singleton/);
    assert.match(output, /demonstrating observed intermittency/);
    for (const forbidden of ["culprit", "caused by", "problem user"]) {
      assert.equal(output.toLowerCase().includes(forbidden), false);
    }
  });

  it("ignores global N-1 outcomes when deciding whether composition varied", () => {
    const base = summary();
    const value = probe({
      summaries: [summary({
        nMinusOne: base.nMinusOne.map((item) => item.strategy === "DROP_LAST"
          ? { ...item, outcome: "AUTH_ERROR" }
          : item),
      })],
    });
    const output = formatRecentCompositionProbe(value, "saved.json");
    assert.doesNotMatch(output, /Outcome varied materially with composition/);
  });

  it("reports true same-size variation only for SUCCESS plus processing failure", () => {
    const base = summary();
    const value = probe({
      summaries: [summary({
        nMinusOne: base.nMinusOne.map((item) => item.strategy === "DROP_MIDDLE"
          ? { ...item, outcome: "HTTP_504_EXHAUSTED" }
          : item),
      })],
    });
    const output = formatRecentCompositionProbe(value, "saved.json");
    assert.match(output, /Outcome varied materially with composition among the sampled same-size N-1 groups in this run/);
  });

  it("keeps SUCCESS plus AUTH_ERROR consistent and does not claim processing intermittency", () => {
    const intermittency = summarizeCompositionIntermittency([
      measurement({ run: 1, outcome: "SUCCESS", errorClass: null }),
      measurement({ run: 2, nodeId: "R2-TARGET", outcome: "AUTH_ERROR" }),
    ]);
    assert.equal(intermittency[0]?.status, "CONSISTENT_OBSERVED");
    assert.equal(intermittency[0]?.successCount, 1);
    assert.equal(intermittency[0]?.processingFailureCount, 0);
    assert.equal(intermittency[0]?.otherFailureCount, 1);
    const output = formatRecentCompositionProbe(probe({ intermittency }), "saved.json");
    assert.doesNotMatch(output, /demonstrating observed intermittency/);
  });

  it("writes collision-safe Windows filenames without sensitive payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "composition-report-"));
    roots.push(root);
    const first = await writeRecentCompositionProbe(probe(), { root });
    const second = await writeRecentCompositionProbe(probe(), { root });
    assert.notEqual(first, second);
    assert.match(second, /-1\.json$/);
    const contents = await readFile(first, "utf8");
    const lower = contents.toLowerCase();
    assert.equal(JSON.parse(contents).queryVariant, "CURRENT");
    for (const forbidden of ["authorization", "bearer", "github_token", "contributioncalendar", "totalcommitcontributions", "\query\:", "\variables\:", "\payload\:"]) {
      assert.equal(lower.includes(forbidden), false);
    }
  });
});
