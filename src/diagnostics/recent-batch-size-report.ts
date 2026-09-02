import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  BatchSizeSummary,
  PreparedBatchSizeBenchmark,
  RecentBatchSizeBenchmark,
} from "./recent-batch-size-benchmark.js";

export const DEFAULT_BATCH_SIZE_BENCHMARKS_ROOT = resolve(
  ".ghost-following", "diagnostics", "batch-size-benchmarks",
);

export interface BatchSizeBenchmarkFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, options: { encoding: "utf8"; flag: "wx" }): Promise<unknown>;
}

export class BatchSizeBenchmarkWriteError extends Error {
  override readonly name = "BatchSizeBenchmarkWriteError";
}

function fileSystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

export function batchSizeBenchmarkPathFor(
  auditUsername: string,
  timestamp: string,
  root = DEFAULT_BATCH_SIZE_BENCHMARKS_ROOT,
  suffix = 0,
): string {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(auditUsername) ||
      Number.isNaN(new Date(timestamp).getTime()) || !Number.isSafeInteger(suffix) || suffix < 0) {
    throw new RangeError("Invalid batch-size benchmark path data.");
  }
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return join(root, `${auditUsername}-${safeTimestamp}${suffix === 0 ? "" : `-${suffix}`}.json`);
}

export async function writeRecentBatchSizeBenchmark(
  benchmark: RecentBatchSizeBenchmark,
  options: { root?: string; fileSystem?: Partial<BatchSizeBenchmarkFileSystem> } = {},
): Promise<string> {
  const root = options.root ?? DEFAULT_BATCH_SIZE_BENCHMARKS_ROOT;
  const fileSystem: BatchSizeBenchmarkFileSystem = { mkdir, writeFile, ...options.fileSystem };
  try {
    await fileSystem.mkdir(root, { recursive: true });
  } catch (error) {
    throw new BatchSizeBenchmarkWriteError("Could not create the batch-size-benchmarks directory.", { cause: error });
  }
  const contents = JSON.stringify(benchmark, null, 2) + "\n";
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const path = batchSizeBenchmarkPathFor(benchmark.auditUsername, benchmark.benchmarkTimestamp, root, suffix);
    try {
      await fileSystem.writeFile(path, contents, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if (fileSystemCode(error) === "EEXIST") continue;
      throw new BatchSizeBenchmarkWriteError("Could not write the batch-size benchmark result.", { cause: error });
    }
  }
  throw new BatchSizeBenchmarkWriteError("Could not allocate a unique batch-size benchmark filename.");
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function fixed(value: number | null, digits = 2): string {
  return value === null ? "-" : value.toFixed(digits);
}

export function formatBatchSizeBenchmarkPlan(prepared: PreparedBatchSizeBenchmark): string {
  return [
    "Recent Batch Size Benchmark - pre-GraphQL plan",
    "",
    `Audit user: ${prepared.auditUsername}`,
    `Period: ${prepared.period.from} -> ${prepared.period.to} (${prepared.period.days} days)`,
    `Following: ${prepared.following.total}`,
    `Eligible users: ${prepared.following.eligibleUsers}`,
    `Unsupported accounts: ${prepared.following.unsupportedAccounts}`,
    `Sample size: ${prepared.sampling.actualSize}/${prepared.sampling.requestedSize}`,
    "Sampling: deterministic SHA-256",
    `Sizes (execution order): ${prepared.sizes.join(", ")}`,
    `Production default: ${prepared.productionBatchSize}`,
    "Adaptive fallback: disabled for benchmark",
    "",
    "Planned logical batches before retries:",
    ...prepared.plannedLogicalBatches.map(({ configuredBatchSize, batches }) => `  ${configuredBatchSize} -> ${batches}`),
    `Total planned logical batches: ${prepared.totalPlannedLogicalBatches}`,
  ].join("\n");
}

function summaryRow(summary: BatchSizeSummary): string {
  return [
    pad(summary.configuredBatchSize, 5), pad(`${summary.executedBatches}/${summary.plannedBatches}`, 9),
    pad(summary.successfulBatches, 5), pad(summary.processingFailureBatches, 6),
    pad(summary.successfulUsers, 10), pad(summary.retryAttempts, 8),
    pad(summary.totalHttpAttempts, 10), pad(summary.totalElapsedMs.toFixed(2), 10),
    fixed(summary.successfulUsersPerSecond),
  ].join(" ");
}

function comparisonLine(label: string, summary: BatchSizeSummary): string {
  return `${label} size ${summary.configuredBatchSize}: failures=${summary.processingFailureBatches}, attempts=${summary.totalHttpAttempts}, elapsedMs=${summary.totalElapsedMs.toFixed(2)}, users/s=${fixed(summary.successfulUsersPerSecond)}`;
}

export function formatRecentBatchSizeBenchmark(benchmark: RecentBatchSizeBenchmark, savedPath: string): string {
  const lines = [
    "", "Recent Batch Size Benchmark - results", "",
    `${pad("SIZE", 5)} ${pad("BATCHES", 9)} ${pad("OK", 5)} ${pad("FAIL", 6)} ${pad("USERS OK", 10)} ${pad("RETRIES", 8)} ${pad("ATTEMPTS", 10)} ${pad("TIME MS", 10)} USERS/S`,
    ...benchmark.summaries.map(summaryRow),
  ];
  for (const summary of benchmark.summaries) {
    lines.push(
      `Size ${summary.configuredBatchSize} failures: 502=${summary.http502Exhausted}, 504=${summary.http504Exhausted}, RESOURCE_LIMIT=${summary.resourceLimits}, INVALID_BODY=${summary.invalidResponseBodies}`,
    );
  }
  lines.push("");
  if (benchmark.candidate === null) {
    lines.push("No tested batch size completed this sample without processing failures and measurable throughput.");
  } else {
    lines.push(`${benchmark.candidate.rationale}: ${benchmark.candidate.configuredBatchSize} (${benchmark.candidate.successfulUsersPerSecond.toFixed(2)} users/s).`);
  }
  if (!benchmark.productionComparison.included) {
    lines.push("Production default 25 was not included in this benchmark; it was not executed implicitly.");
  } else if (benchmark.productionComparison.production === null) {
    lines.push("Production default 25 was requested but was not reached before the benchmark halted.");
  } else {
    lines.push(comparisonLine("Production", benchmark.productionComparison.production));
    if (benchmark.productionComparison.candidate !== null) {
      lines.push(comparisonLine("Observed candidate", benchmark.productionComparison.candidate));
    }
  }
  if (benchmark.halt !== null) {
    lines.push(
      `Benchmark halted at size ${benchmark.halt.haltedAtSize}, batch ${benchmark.halt.haltedAtBatch}: ${benchmark.halt.haltReason}.`,
      ...(benchmark.halt.resetAt === null ? [] : [`Rate-limit resetAt: ${benchmark.halt.resetAt}`]),
      "Partial results were saved; no automatic wait or resume was performed.",
    );
  }
  lines.push(
    "This is an observation from one deterministic sample/run, not a universal GitHub batch-size limit.",
    "Production configuration was not changed.",
    "", "Saved benchmark:", savedPath,
  );
  return lines.join("\n");
}
