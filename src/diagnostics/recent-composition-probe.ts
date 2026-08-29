import type { ActivityPeriod } from "../domain/activity.js";
import type { Sleep } from "../github/retry.js";
import type { RecentBatchFailureIncident } from "./recent-batch-failures.js";
import {
  executeRecentQueryMeasurement,
  type RecentQueryMeasurement,
  type RecentQueryOutcome,
} from "./recent-query-comparison.js";

export const COMPOSITION_TARGETS = ["FULL", "LEFT", "RIGHT"] as const;
export type CompositionTarget = (typeof COMPOSITION_TARGETS)[number];

export const COMPOSITION_STRATEGIES = [
  "TARGET",
  "HALF_LEFT",
  "HALF_RIGHT",
  "DROP_FIRST",
  "DROP_MIDDLE",
  "DROP_LAST",
] as const;
export type CompositionStrategy = (typeof COMPOSITION_STRATEGIES)[number];

export const PROCESSING_FAILURE_OUTCOMES = new Set<RecentQueryOutcome>([
  "HTTP_502_EXHAUSTED",
  "HTTP_504_EXHAUSTED",
  "RESOURCE_LIMIT",
  "INVALID_RESPONSE_BODY",
]);

export const PROBE_HALTING_OUTCOMES = new Set<RecentQueryOutcome>([
  "HTTP_503_EXHAUSTED",
  "RATE_LIMIT",
  "AUTH_ERROR",
  "TRANSPORT_ERROR",
  "SCHEMA_ERROR",
  "OTHER_FATAL",
]);

export interface CompositionNodePlan {
  nodeId: string;
  parentNodeId: string | null;
  strategy: CompositionStrategy;
  depth: number;
  logins: string[];
}

export interface CompositionMeasurement extends CompositionNodePlan {
  run: number;
  batchSize: number;
  outcome: RecentQueryOutcome;
  errorClass: string | null;
  httpAttempts: number;
  elapsedMs: number;
  requestBodyBytes: number;
  responseBodyBytes: number | null;
  graphqlCost: number | null;
  rateLimitRemaining: number | null;
}

export interface CompositionProbeResultReference {
  strategy: "TARGET" | "DROP_FIRST" | "DROP_MIDDLE" | "DROP_LAST";
  requestedBatchSize: number;
  measurementNodeId: string | null;
  outcome: RecentQueryOutcome | null;
}

export interface CompositionFailureInclusion {
  login: string;
  timesIncluded: number;
  timesIncludedInProcessingFailure: number;
  failureInclusionRatio: number;
}

export interface CompositionRunSummary {
  run: number;
  successfulNodes: number;
  processingFailureNodes: number;
  singletonFailures: { nodeId: string; login: string; outcome: RecentQueryOutcome }[];
  smallestSuccessfulBatch: number | null;
  largestSuccessfulBatch: number | null;
  smallestProcessingFailureBatch: number | null;
  largestProcessingFailureBatch: number | null;
  nMinusOne: CompositionProbeResultReference[];
  failureInclusion: CompositionFailureInclusion[];
  haltedByNodeId: string | null;
}

export interface CompositionIntermittency {
  logins: string[];
  observations: number;
  successCount: number;
  processingFailureCount: number;
  otherFailureCount: number;
  status: "CONSISTENT_OBSERVED" | "INTERMITTENT_OBSERVED";
}

export interface RecentCompositionProbe {
  schemaVersion: 1;
  probeTimestamp: string;
  auditUsername: string;
  sourcePath: string;
  sourceIncident: Omit<RecentBatchFailureIncident, "auditUsername" | "phase" | "logins"> & { logins: string[] };
  selectedTarget: CompositionTarget;
  targetLogins: string[];
  runs: number;
  executedRuns: number;
  queryVariant: "CURRENT";
  measurements: CompositionMeasurement[];
  summaries: CompositionRunSummary[];
  intermittency: CompositionIntermittency[];
}

export interface CompositionExecutionOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: Sleep;
  clock?: () => number;
}

export type CompositionNodeExecutor = (
  node: CompositionNodePlan,
  run: number,
  period: ActivityPeriod,
) => Promise<Omit<CompositionMeasurement, keyof CompositionNodePlan | "run" | "batchSize">>;

export function isProcessingFailure(outcome: RecentQueryOutcome): boolean {
  return PROCESSING_FAILURE_OUTCOMES.has(outcome);
}

export function isProbeHaltingOutcome(outcome: RecentQueryOutcome): boolean {
  return PROBE_HALTING_OUTCOMES.has(outcome);
}

export function selectCompositionTarget(logins: readonly string[], target: CompositionTarget): string[] {
  if (logins.length === 0) throw new RangeError("Composition probe requires source logins.");
  if (target === "FULL") return [...logins];
  if (logins.length === 1) throw new RangeError(`${target} is unavailable for a singleton source incident.`);
  const midpoint = Math.floor(logins.length / 2);
  return target === "LEFT" ? logins.slice(0, midpoint) : logins.slice(midpoint);
}

function nodeId(run: number, suffix: string): string {
  return `R${run}-${suffix}`;
}

function halves(logins: readonly string[]): [string[], string[]] {
  const midpoint = Math.floor(logins.length / 2);
  return [logins.slice(0, midpoint), logins.slice(midpoint)];
}

export function compositionGroupKey(logins: readonly string[]): string {
  return JSON.stringify(logins);
}

export function createCompositionBasePlan(targetLogins: readonly string[], run: number): CompositionNodePlan[] {
  if (targetLogins.length === 0 || !Number.isSafeInteger(run) || run < 1) {
    throw new RangeError("Composition base plan requires logins and a positive run.");
  }
  const targetId = nodeId(run, "TARGET");
  const candidates: CompositionNodePlan[] = [{
    nodeId: targetId, parentNodeId: null, strategy: "TARGET", depth: 0, logins: [...targetLogins],
  }];
  if (targetLogins.length > 1) {
    const [left, right] = halves(targetLogins);
    candidates.push(
      { nodeId: nodeId(run, "HL"), parentNodeId: targetId, strategy: "HALF_LEFT", depth: 1, logins: left },
      { nodeId: nodeId(run, "HR"), parentNodeId: targetId, strategy: "HALF_RIGHT", depth: 1, logins: right },
    );
  }
  if (targetLogins.length >= 3) {
    const middle = Math.floor(targetLogins.length / 2);
    candidates.push(
      { nodeId: nodeId(run, "DROP-FIRST"), parentNodeId: null, strategy: "DROP_FIRST", depth: 0, logins: targetLogins.slice(1) },
      { nodeId: nodeId(run, "DROP-MIDDLE"), parentNodeId: null, strategy: "DROP_MIDDLE", depth: 0, logins: targetLogins.filter((_login, index) => index !== middle) },
      { nodeId: nodeId(run, "DROP-LAST"), parentNodeId: null, strategy: "DROP_LAST", depth: 0, logins: targetLogins.slice(0, -1) },
    );
  }
  const seen = new Set<string>();
  return candidates.filter(({ logins: values }) => {
    const key = compositionGroupKey(values);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function metricFromRecent(measurement: RecentQueryMeasurement): Omit<CompositionMeasurement, keyof CompositionNodePlan | "run" | "batchSize"> {
  return {
    outcome: measurement.outcome,
    errorClass: measurement.errorClass,
    httpAttempts: measurement.httpAttempts,
    elapsedMs: measurement.elapsedMs,
    requestBodyBytes: measurement.requestBodyBytes,
    responseBodyBytes: measurement.responseBodyBytes,
    graphqlCost: measurement.graphqlCost,
    rateLimitRemaining: measurement.rateLimitRemaining,
  };
}

export function createCurrentCompositionExecutor(options: CompositionExecutionOptions): CompositionNodeExecutor {
  return async (node, run, period) => metricFromRecent(
    await executeRecentQueryMeasurement(
      "CURRENT", run, { shape: "FULL", logins: node.logins }, period, options,
    ),
  );
}

interface RunState {
  measurements: CompositionMeasurement[];
  byGroup: Map<string, CompositionMeasurement>;
  descendedGroups: Set<string>;
  haltedByNodeId: string | null;
}

function dropGroups(targetLogins: readonly string[]): {
  strategy: "DROP_FIRST" | "DROP_MIDDLE" | "DROP_LAST";
  logins: string[];
}[] {
  if (targetLogins.length < 3) return [];
  const middle = Math.floor(targetLogins.length / 2);
  return [
    { strategy: "DROP_FIRST", logins: targetLogins.slice(1) },
    { strategy: "DROP_MIDDLE", logins: targetLogins.filter((_login, index) => index !== middle) },
    { strategy: "DROP_LAST", logins: targetLogins.slice(0, -1) },
  ];
}

async function executeNode(
  state: RunState,
  node: CompositionNodePlan,
  run: number,
  period: ActivityPeriod,
  executor: CompositionNodeExecutor,
): Promise<CompositionMeasurement> {
  const key = compositionGroupKey(node.logins);
  const existing = state.byGroup.get(key);
  if (existing !== undefined) return existing;
  const metric = await executor(node, run, period);
  const measurement: CompositionMeasurement = {
    ...node,
    run,
    batchSize: node.logins.length,
    ...metric,
  };
  state.measurements.push(measurement);
  state.byGroup.set(key, measurement);
  if (isProbeHaltingOutcome(measurement.outcome)) {
    state.haltedByNodeId = measurement.nodeId;
  }
  return measurement;
}

async function descendFailedHalf(
  state: RunState,
  parent: CompositionMeasurement,
  run: number,
  period: ActivityPeriod,
  executor: CompositionNodeExecutor,
): Promise<void> {
  if (
    state.haltedByNodeId !== null ||
    parent.batchSize <= 1 ||
    !isProcessingFailure(parent.outcome)
  ) return;
  const parentKey = compositionGroupKey(parent.logins);
  if (state.descendedGroups.has(parentKey)) return;
  state.descendedGroups.add(parentKey);
  const [left, right] = halves(parent.logins);
  const children: CompositionNodePlan[] = [
    {
      nodeId: parent.nodeId + "-L",
      parentNodeId: parent.nodeId,
      strategy: "HALF_LEFT",
      depth: parent.depth + 1,
      logins: left,
    },
    {
      nodeId: parent.nodeId + "-R",
      parentNodeId: parent.nodeId,
      strategy: "HALF_RIGHT",
      depth: parent.depth + 1,
      logins: right,
    },
  ];
  const measuredChildren: CompositionMeasurement[] = [];
  for (const child of children) {
    if (state.haltedByNodeId !== null) break;
    measuredChildren.push(await executeNode(state, child, run, period, executor));
  }
  for (const child of measuredChildren) {
    if (state.haltedByNodeId !== null) break;
    await descendFailedHalf(state, child, run, period, executor);
  }
}

function minOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function maxOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function referenceFor(
  strategy: CompositionProbeResultReference["strategy"],
  logins: readonly string[],
  state: RunState,
): CompositionProbeResultReference {
  const measurement = state.byGroup.get(compositionGroupKey(logins));
  return {
    strategy,
    requestedBatchSize: logins.length,
    measurementNodeId: measurement?.nodeId ?? null,
    outcome: measurement?.outcome ?? null,
  };
}

export function summarizeCompositionRun(
  run: number,
  targetLogins: readonly string[],
  state: Pick<RunState, "measurements" | "byGroup" | "haltedByNodeId">,
): CompositionRunSummary {
  const successful = state.measurements.filter(({ outcome }) => outcome === "SUCCESS");
  const processingFailures = state.measurements.filter(({ outcome }) => isProcessingFailure(outcome));
  const inclusion = new Map<string, CompositionFailureInclusion>();
  for (const measurement of state.measurements) {
    for (const login of measurement.logins) {
      const key = login.toLowerCase();
      const current = inclusion.get(key) ?? {
        login,
        timesIncluded: 0,
        timesIncludedInProcessingFailure: 0,
        failureInclusionRatio: 0,
      };
      current.timesIncluded += 1;
      if (isProcessingFailure(measurement.outcome)) {
        current.timesIncludedInProcessingFailure += 1;
      }
      inclusion.set(key, current);
    }
  }
  const failureInclusion = [...inclusion.values()].map((item) => ({
    ...item,
    failureInclusionRatio: item.timesIncludedInProcessingFailure / item.timesIncluded,
  })).sort((left, right) =>
    right.failureInclusionRatio - left.failureInclusionRatio ||
    right.timesIncludedInProcessingFailure - left.timesIncludedInProcessingFailure ||
    left.login.localeCompare(right.login),
  );
  const nMinusOne: CompositionProbeResultReference[] = [
    referenceFor("TARGET", targetLogins, state as RunState),
    ...dropGroups(targetLogins).map(({ strategy, logins }) => referenceFor(strategy, logins, state as RunState)),
  ];
  return {
    run,
    successfulNodes: successful.length,
    processingFailureNodes: processingFailures.length,
    singletonFailures: processingFailures
      .filter(({ batchSize }) => batchSize === 1)
      .map(({ nodeId, logins, outcome }) => ({ nodeId, login: logins[0]!, outcome })),
    smallestSuccessfulBatch: minOrNull(successful.map(({ batchSize }) => batchSize)),
    largestSuccessfulBatch: maxOrNull(successful.map(({ batchSize }) => batchSize)),
    smallestProcessingFailureBatch: minOrNull(processingFailures.map(({ batchSize }) => batchSize)),
    largestProcessingFailureBatch: maxOrNull(processingFailures.map(({ batchSize }) => batchSize)),
    nMinusOne,
    failureInclusion,
    haltedByNodeId: state.haltedByNodeId,
  };
}

export function summarizeCompositionIntermittency(
  measurements: readonly CompositionMeasurement[],
): CompositionIntermittency[] {
  const groups = new Map<string, CompositionMeasurement[]>();
  for (const measurement of measurements) {
    const key = compositionGroupKey(measurement.logins);
    const current = groups.get(key) ?? [];
    current.push(measurement);
    groups.set(key, current);
  }
  return [...groups.values()]
    .filter((items) => new Set(items.map(({ run }) => run)).size > 1)
    .map((items) => {
      const successCount = items.filter(({ outcome }) => outcome === "SUCCESS").length;
      const processingFailureCount = items.filter(({ outcome }) => isProcessingFailure(outcome)).length;
      const otherFailureCount = items.length - successCount - processingFailureCount;
      return {
        logins: [...items[0]!.logins],
        observations: items.length,
        successCount,
        processingFailureCount,
        otherFailureCount,
        status: successCount > 0 && processingFailureCount > 0
          ? "INTERMITTENT_OBSERVED" as const
          : "CONSISTENT_OBSERVED" as const,
      };
    });
}

export async function runRecentCompositionProbe(
  incident: RecentBatchFailureIncident,
  sourcePath: string,
  target: CompositionTarget,
  runs: number,
  options: CompositionExecutionOptions & { now?: Date; executor?: CompositionNodeExecutor },
): Promise<RecentCompositionProbe> {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 3) {
    throw new RangeError("Runs must be an integer from 1 to 3.");
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError("A valid probe timestamp is required.");
  const targetLogins = selectCompositionTarget(incident.logins, target);
  const executor = options.executor ?? createCurrentCompositionExecutor(options);
  const measurements: CompositionMeasurement[] = [];
  const summaries: CompositionRunSummary[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const state: RunState = {
      measurements: [],
      byGroup: new Map(),
      descendedGroups: new Set(),
      haltedByNodeId: null,
    };
    const basePlan = createCompositionBasePlan(targetLogins, run);
    for (const node of basePlan) {
      if (state.haltedByNodeId !== null) break;
      await executeNode(state, node, run, incident.period, executor);
    }
    for (const strategy of ["HALF_LEFT", "HALF_RIGHT"] as const) {
      if (state.haltedByNodeId !== null) break;
      const half = state.measurements.find((item) => item.strategy === strategy && item.parentNodeId === `R${run}-TARGET`);
      if (half !== undefined) await descendFailedHalf(state, half, run, incident.period, executor);
    }
    measurements.push(...state.measurements);
    summaries.push(summarizeCompositionRun(run, targetLogins, state));
    if (state.haltedByNodeId !== null) break;
  }
  return {
    schemaVersion: 1,
    probeTimestamp: now.toISOString(),
    auditUsername: incident.auditUsername,
    sourcePath,
    sourceIncident: {
      timestamp: incident.timestamp,
      period: { ...incident.period },
      httpStatus: incident.httpStatus,
      attempts: incident.attempts,
      batchSize: incident.batchSize,
      logins: [...incident.logins],
    },
    selectedTarget: target,
    targetLogins,
    runs,
    executedRuns: summaries.length,
    queryVariant: "CURRENT",
    measurements,
    summaries,
    intermittency: summarizeCompositionIntermittency(measurements),
  };
}
