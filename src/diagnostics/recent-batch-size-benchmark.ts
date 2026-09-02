import { createHash } from "node:crypto";
import { ACTIVITY_BATCH_SIZE } from "../activity/analyzer.js";
import { createActivityPeriod, type ActivityPeriod } from "../domain/activity.js";
import type { FollowedAccount } from "../domain/account.js";
import type { Sleep } from "../github/retry.js";
import { chunkValues } from "../utils/chunks.js";
import { isProbeHaltingOutcome, isProcessingFailure } from "./recent-composition-probe.js";
import { executeRecentQueryMeasurement, type RecentQueryOutcome } from "./recent-query-comparison.js";
import { MAX_SUPPORTED_DIAGNOSTIC_BATCH_SIZE } from "./recent-diagnostic-limits.js";

export const DEFAULT_BENCHMARK_DAYS = 365;
export const DEFAULT_BENCHMARK_SAMPLE_SIZE = 200;
export const MIN_BENCHMARK_SAMPLE_SIZE = 50;
export const MAX_BENCHMARK_SAMPLE_SIZE = 500;
export const DEFAULT_BENCHMARK_SIZES = [6, 8, 10, 12, 15, 25] as const;
export const MAX_BENCHMARK_BATCH_SIZE = MAX_SUPPORTED_DIAGNOSTIC_BATCH_SIZE;
export const BENCHMARK_SAMPLING_METHOD = "sha256-login" as const;

export interface PreparedBatchSizeBenchmark {
  benchmarkTimestamp: string;
  auditUsername: string;
  period: ActivityPeriod;
  following: { total: number; eligibleUsers: number; unsupportedAccounts: number };
  sampling: { method: typeof BENCHMARK_SAMPLING_METHOD; requestedSize: number; actualSize: number; logins: string[] };
  sizes: number[];
  productionBatchSize: number;
  adaptiveFallback: false;
  plannedLogicalBatches: { configuredBatchSize: number; batches: number }[];
  totalPlannedLogicalBatches: number;
}

export interface BatchSizeMeasurement {
  configuredBatchSize: number;
  batchIndex: number;
  batchSizeActual: number;
  logins: string[];
  outcome: RecentQueryOutcome;
  errorClass: string | null;
  httpAttempts: number;
  elapsedMs: number;
  requestBodyBytes: number;
  responseBodyBytes: number | null;
  graphqlCost: number | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

export interface BatchSizeSummary {
  configuredBatchSize: number;
  plannedBatches: number;
  executedBatches: number;
  completed: boolean;
  usersAttempted: number;
  successfulBatches: number;
  processingFailureBatches: number;
  successfulUsers: number;
  processingFailureUsers: number;
  firstAttemptSuccesses: number;
  retriedSuccesses: number;
  totalHttpAttempts: number;
  retryAttempts: number;
  http502Exhausted: number;
  http504Exhausted: number;
  resourceLimits: number;
  invalidResponseBodies: number;
  totalElapsedMs: number;
  averageBatchElapsedMs: number | null;
  medianBatchElapsedMs: number | null;
  averageSuccessfulBatchElapsedMs: number | null;
  medianSuccessfulBatchElapsedMs: number | null;
  successfulUsersPerSecond: number | null;
  successfulUserRate: number | null;
  observedGraphqlCost: number;
  rateLimitRemaining: number | null;
  totalRequestBodyBytes: number;
  totalObservedResponseBodyBytes: number;
}

export interface BenchmarkHalt {
  halted: true;
  haltedAtSize: number;
  haltedAtBatch: number;
  haltReason: RecentQueryOutcome;
  rateLimitRemaining: number | null;
  resetAt: string | null;
}

export interface BenchmarkCandidate {
  configuredBatchSize: number;
  successfulUsersPerSecond: number;
  rationale: "Best observed zero-processing-failure throughput in this sample";
}

export interface RecentBatchSizeBenchmark extends PreparedBatchSizeBenchmark {
  schemaVersion: 1;
  measurements: BatchSizeMeasurement[];
  summaries: BatchSizeSummary[];
  halt: BenchmarkHalt | null;
  candidate: BenchmarkCandidate | null;
  productionComparison: {
    productionBatchSize: number;
    included: boolean;
    candidateBatchSize: number | null;
    production: BatchSizeSummary | null;
    candidate: BatchSizeSummary | null;
  };
}

export type BatchSizeExecutor = (
  logins: readonly string[], configuredBatchSize: number, batchIndex: number, period: ActivityPeriod,
) => Promise<Omit<BatchSizeMeasurement, "configuredBatchSize" | "batchIndex" | "batchSizeActual" | "logins">>;

export interface BatchSizeExecutionOptions { token: string; fetch?: typeof globalThis.fetch; sleep?: Sleep; clock?: () => number }

export function deterministicSampleLogins(
  auditUsername: string, accounts: readonly FollowedAccount[], requestedSize: number,
): string[] {
  if (!Number.isSafeInteger(requestedSize) || requestedSize < 0) throw new RangeError("Requested sample size must be a non-negative integer.");
  return accounts.filter(({ type }) => type === "User").map(({ login }) => ({
    login,
    normalizedLogin: login.toLowerCase(),
    rank: createHash("sha256").update(`${auditUsername.toLowerCase()}\0${login.toLowerCase()}`, "utf8").digest("hex"),
  })).sort((left, right) => left.rank.localeCompare(right.rank) ||
    left.normalizedLogin.localeCompare(right.normalizedLogin) || left.login.localeCompare(right.login))
    .slice(0, requestedSize).map(({ login }) => login);
}

export function validateBenchmarkSizes(sizes: readonly number[]): number[] {
  if (sizes.length === 0) throw new RangeError("At least one batch size is required.");
  const seen = new Set<number>();
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BENCHMARK_BATCH_SIZE) {
      throw new RangeError(`Batch sizes must be unique integers from 1 to ${MAX_BENCHMARK_BATCH_SIZE}.`);
    }
    if (seen.has(size)) throw new RangeError("Batch sizes must be unique.");
    seen.add(size);
  }
  return [...sizes];
}

export function prepareBatchSizeBenchmark(
  auditUsername: string,
  accounts: readonly FollowedAccount[],
  options: { days: number; sampleSize: number; sizes: readonly number[]; now: Date },
): PreparedBatchSizeBenchmark {
  if (!Number.isSafeInteger(options.sampleSize) || options.sampleSize < MIN_BENCHMARK_SAMPLE_SIZE || options.sampleSize > MAX_BENCHMARK_SAMPLE_SIZE) {
    throw new RangeError(`Sample size must be from ${MIN_BENCHMARK_SAMPLE_SIZE} to ${MAX_BENCHMARK_SAMPLE_SIZE}.`);
  }
  const sizes = validateBenchmarkSizes(options.sizes);
  const eligibleUsers = accounts.filter(({ type }) => type === "User").length;
  const logins = deterministicSampleLogins(auditUsername, accounts, options.sampleSize);
  const plannedLogicalBatches = sizes.map((configuredBatchSize) => ({
    configuredBatchSize,
    batches: logins.length === 0 ? 0 : Math.ceil(logins.length / configuredBatchSize),
  }));
  return {
    benchmarkTimestamp: options.now.toISOString(), auditUsername,
    period: createActivityPeriod(options.now, options.days),
    following: { total: accounts.length, eligibleUsers, unsupportedAccounts: accounts.length - eligibleUsers },
    sampling: { method: BENCHMARK_SAMPLING_METHOD, requestedSize: options.sampleSize, actualSize: logins.length, logins },
    sizes, productionBatchSize: ACTIVITY_BATCH_SIZE, adaptiveFallback: false,
    plannedLogicalBatches,
    totalPlannedLogicalBatches: plannedLogicalBatches.reduce((sum, item) => sum + item.batches, 0),
  };
}

export function partitionBenchmarkSample(logins: readonly string[], size: number): string[][] {
  return chunkValues(logins, size);
}

function resetAtFromHeader(value: string | null): string | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function createCurrentBatchSizeExecutor(options: BatchSizeExecutionOptions): BatchSizeExecutor {
  return async (logins, _configuredBatchSize, batchIndex, period) => {
    let rateLimitResetAt: string | null = null;
    const baseFetch = options.fetch ?? globalThis.fetch;
    const observingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      rateLimitResetAt = resetAtFromHeader(response.headers.get("x-ratelimit-reset")) ?? rateLimitResetAt;
      return response;
    };
    const measurement = await executeRecentQueryMeasurement("CURRENT", batchIndex, { shape: "FULL", logins: [...logins] }, period, {
      token: options.token, fetch: observingFetch,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    return {
      outcome: measurement.outcome, errorClass: measurement.errorClass,
      httpAttempts: measurement.httpAttempts, elapsedMs: measurement.elapsedMs,
      requestBodyBytes: measurement.requestBodyBytes, responseBodyBytes: measurement.responseBodyBytes,
      graphqlCost: measurement.graphqlCost, rateLimitRemaining: measurement.rateLimitRemaining, rateLimitResetAt,
    };
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[midpoint]! : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeBatchSize(
  configuredBatchSize: number, plannedBatches: number, measurements: readonly BatchSizeMeasurement[],
): BatchSizeSummary {
  const successes = measurements.filter(({ outcome }) => outcome === "SUCCESS");
  const processingFailures = measurements.filter(({ outcome }) => isProcessingFailure(outcome));
  const elapsedValues = measurements.map(({ elapsedMs }) => elapsedMs);
  const successfulElapsedValues = successes.map(({ elapsedMs }) => elapsedMs);
  const totalElapsedMs = elapsedValues.reduce((sum, value) => sum + value, 0);
  const usersAttempted = measurements.reduce((sum, item) => sum + item.batchSizeActual, 0);
  const successfulUsers = successes.reduce((sum, item) => sum + item.batchSizeActual, 0);
  const totalHttpAttempts = measurements.reduce((sum, item) => sum + item.httpAttempts, 0);
  const observedRemaining = measurements.map(({ rateLimitRemaining }) => rateLimitRemaining).filter((value): value is number => value !== null);
  return {
    configuredBatchSize, plannedBatches, executedBatches: measurements.length,
    completed: measurements.length === plannedBatches &&
      measurements.every(({ outcome }) => outcome === "SUCCESS" || isProcessingFailure(outcome)),
    usersAttempted, successfulBatches: successes.length, processingFailureBatches: processingFailures.length,
    successfulUsers, processingFailureUsers: processingFailures.reduce((sum, item) => sum + item.batchSizeActual, 0),
    firstAttemptSuccesses: successes.filter(({ httpAttempts }) => httpAttempts === 1).length,
    retriedSuccesses: successes.filter(({ httpAttempts }) => httpAttempts > 1).length,
    totalHttpAttempts, retryAttempts: totalHttpAttempts - measurements.length,
    http502Exhausted: measurements.filter(({ outcome }) => outcome === "HTTP_502_EXHAUSTED").length,
    http504Exhausted: measurements.filter(({ outcome }) => outcome === "HTTP_504_EXHAUSTED").length,
    resourceLimits: measurements.filter(({ outcome }) => outcome === "RESOURCE_LIMIT").length,
    invalidResponseBodies: measurements.filter(({ outcome }) => outcome === "INVALID_RESPONSE_BODY").length,
    totalElapsedMs, averageBatchElapsedMs: average(elapsedValues), medianBatchElapsedMs: median(elapsedValues),
    averageSuccessfulBatchElapsedMs: average(successfulElapsedValues), medianSuccessfulBatchElapsedMs: median(successfulElapsedValues),
    successfulUsersPerSecond: totalElapsedMs > 0 ? successfulUsers / (totalElapsedMs / 1_000) : null,
    successfulUserRate: usersAttempted > 0 ? successfulUsers / usersAttempted : null,
    observedGraphqlCost: measurements.reduce((sum, item) => sum + (item.graphqlCost ?? 0), 0),
    rateLimitRemaining: observedRemaining.at(-1) ?? null,
    totalRequestBodyBytes: measurements.reduce((sum, item) => sum + item.requestBodyBytes, 0),
    totalObservedResponseBodyBytes: measurements.reduce((sum, item) => sum + (item.responseBodyBytes ?? 0), 0),
  };
}

export function selectBenchmarkCandidate(summaries: readonly BatchSizeSummary[]): BenchmarkCandidate | null {
  const candidates = summaries.filter((summary) => summary.completed && summary.processingFailureBatches === 0 && summary.successfulUsersPerSecond !== null);
  candidates.sort((left, right) => right.successfulUsersPerSecond! - left.successfulUsersPerSecond! ||
    left.totalElapsedMs - right.totalElapsedMs || left.totalHttpAttempts - right.totalHttpAttempts ||
    right.configuredBatchSize - left.configuredBatchSize);
  const winner = candidates[0];
  return winner === undefined ? null : {
    configuredBatchSize: winner.configuredBatchSize,
    successfulUsersPerSecond: winner.successfulUsersPerSecond!,
    rationale: "Best observed zero-processing-failure throughput in this sample",
  };
}

export async function runBatchSizeBenchmark(
  prepared: PreparedBatchSizeBenchmark, executor: BatchSizeExecutor,
): Promise<RecentBatchSizeBenchmark> {
  const measurements: BatchSizeMeasurement[] = [];
  let halt: BenchmarkHalt | null = null;
  for (const size of prepared.sizes) {
    const batches = partitionBenchmarkSample(prepared.sampling.logins, size);
    for (let index = 0; index < batches.length; index += 1) {
      const logins = batches[index]!;
      const metric = await executor(logins, size, index + 1, prepared.period);
      const measurement: BatchSizeMeasurement = {
        configuredBatchSize: size, batchIndex: index + 1, batchSizeActual: logins.length, logins: [...logins], ...metric,
      };
      measurements.push(measurement);
      if (isProbeHaltingOutcome(measurement.outcome)) {
        halt = {
          halted: true, haltedAtSize: size, haltedAtBatch: index + 1, haltReason: measurement.outcome,
          rateLimitRemaining: measurement.rateLimitRemaining, resetAt: measurement.rateLimitResetAt,
        };
        break;
      }
    }
    if (halt !== null) break;
  }
  const summaries = prepared.sizes.filter((size) => measurements.some((item) => item.configuredBatchSize === size) ||
    (prepared.sampling.actualSize === 0 && halt === null)).map((size) => summarizeBatchSize(
      size,
      prepared.plannedLogicalBatches.find((item) => item.configuredBatchSize === size)!.batches,
      measurements.filter((item) => item.configuredBatchSize === size),
    ));
  const candidate = selectBenchmarkCandidate(summaries);
  const production = summaries.find(({ configuredBatchSize }) => configuredBatchSize === prepared.productionBatchSize) ?? null;
  const candidateSummary = candidate === null ? null : summaries.find(({ configuredBatchSize }) => configuredBatchSize === candidate.configuredBatchSize) ?? null;
  return {
    schemaVersion: 1, ...prepared, measurements, summaries, halt, candidate,
    productionComparison: {
      productionBatchSize: prepared.productionBatchSize,
      included: prepared.sizes.includes(prepared.productionBatchSize),
      candidateBatchSize: candidate?.configuredBatchSize ?? null,
      production, candidate: candidateSummary,
    },
  };
}
