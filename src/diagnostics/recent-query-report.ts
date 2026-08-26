import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RecentQueryComparison, RecentQueryMeasurement } from "./recent-query-comparison.js";
import type { RecentQueryVariant } from "./recent-query-variants.js";

export const DEFAULT_QUERY_COMPARISONS_ROOT = resolve(
  ".ghost-following", "diagnostics", "query-comparisons",
);

export interface RecentQueryReportFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, options: { encoding: "utf8"; flag: "wx" }): Promise<unknown>;
}

export class RecentQueryReportWriteError extends Error {
  override readonly name = "RecentQueryReportWriteError";
}

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

function safeTimestamp(timestamp: string): string { return timestamp.replace(/[:.]/g, "-"); }

export function recentQueryReportPathFor(
  auditUsername: string, timestamp: string, root = DEFAULT_QUERY_COMPARISONS_ROOT, suffix = 0,
): string {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(auditUsername) ||
      Number.isNaN(new Date(timestamp).getTime()) || !Number.isSafeInteger(suffix) || suffix < 0) {
    throw new RangeError("Invalid query comparison path data.");
  }
  return join(root, `${auditUsername}-${safeTimestamp(timestamp)}${suffix === 0 ? "" : `-${suffix}`}.json`);
}

export async function writeRecentQueryComparison(
  comparison: RecentQueryComparison,
  options: { root?: string; fileSystem?: Partial<RecentQueryReportFileSystem> } = {},
): Promise<string> {
  const root = options.root ?? DEFAULT_QUERY_COMPARISONS_ROOT;
  const fs: RecentQueryReportFileSystem = { mkdir, writeFile, ...options.fileSystem };
  try { await fs.mkdir(root, { recursive: true }); }
  catch (error) { throw new RecentQueryReportWriteError("Could not create query-comparisons directory.", { cause: error }); }
  const contents = JSON.stringify(comparison, null, 2) + "\n";
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const path = recentQueryReportPathFor(comparison.auditUsername, comparison.comparisonTimestamp, root, suffix);
    try {
      await fs.writeFile(path, contents, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if (code(error) === "EEXIST") continue;
      throw new RecentQueryReportWriteError("Could not write query comparison result.", { cause: error });
    }
  }
  throw new RecentQueryReportWriteError("Could not allocate a unique query comparison filename.");
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function pad(value: string | number, width: number): string { return String(value).padEnd(width); }

function count(measurements: readonly RecentQueryMeasurement[], outcome: string): number {
  return measurements.filter((item) => item.outcome === outcome).length;
}

function variantStats(measurements: readonly RecentQueryMeasurement[], variant: RecentQueryVariant): string {
  const times = measurements.filter((item) => item.variant === variant && item.outcome === "SUCCESS").map((item) => item.elapsedMs);
  if (times.length === 0) return `${variant}: no successful elapsed samples`;
  const average = times.reduce((sum, value) => sum + value, 0) / times.length;
  return `${variant}: average ${average.toFixed(2)} ms; median ${median(times)!.toFixed(2)} ms (${times.length} successes)`;
}

export function formatRecentQueryComparison(comparison: RecentQueryComparison, savedPath: string): string {
  const lines = [
    "Recent Query Comparison", "",
    `Audit user: ${comparison.auditUsername}`,
    `Source incident: ${comparison.sourceIncident.timestamp}`,
    `Source HTTP status: ${comparison.sourceIncident.httpStatus}`,
    `Period: ${comparison.sourceIncident.period.from} -> ${comparison.sourceIncident.period.to}`,
    `Original batch size: ${comparison.sourceIncident.batchSize}`,
    `Runs: ${comparison.runs}`, "",
    `${pad("VARIANT", 20)} ${pad("RUN", 4)} ${pad("SHAPE", 6)} ${pad("SIZE", 5)} ${pad("OUTCOME", 24)} ${pad("TRY", 4)} ${pad("MS", 9)} ${pad("REQ BYTES", 10)} COST`,
  ];
  for (const item of comparison.measurements) {
    lines.push(`${pad(item.variant, 20)} ${pad(item.run, 4)} ${pad(item.shape, 6)} ${pad(item.batchSize, 5)} ${pad(item.outcome, 24)} ${pad(item.httpAttempts, 4)} ${pad(item.elapsedMs.toFixed(2), 9)} ${pad(item.requestBodyBytes, 10)} ${item.graphqlCost ?? "-"}`);
  }
  const classificationMismatches = comparison.parity.filter((item) => item.classificationParity === "MISMATCH").length;
  const detailMismatches = comparison.parity.filter((item) => item.detailParity === "MISMATCH").length;
  lines.push(
    "", "Experimental summary",
    `Successful combinations: ${count(comparison.measurements, "SUCCESS")}`,
    `Exhausted 502: ${count(comparison.measurements, "HTTP_502_EXHAUSTED")}`,
    `Exhausted 503: ${count(comparison.measurements, "HTTP_503_EXHAUSTED")}`,
    `Exhausted 504: ${count(comparison.measurements, "HTTP_504_EXHAUSTED")}`,
    `Resource limits: ${count(comparison.measurements, "RESOURCE_LIMIT")}`,
    `Classification parity mismatches: ${classificationMismatches}`,
    `Detail parity mismatches: ${detailMismatches}`,
    ...comparison.variants.map(({ name }) => variantStats(comparison.measurements, name)),
  );
  if (comparison.runs === 1) lines.push("One run is a sample, not a robust latency statistic.");
  if (classificationMismatches > 0) {
    lines.push("Observation: classification mismatches were detected; semantic equivalence was not observed in this sample.");
  } else {
    const currentFailures = comparison.measurements.filter((item) => item.variant === "CURRENT" && item.shape === "FULL" && item.outcome !== "SUCCESS");
    const minimalSuccess = comparison.measurements.filter((item) => item.variant === "CLASSIFIER_MINIMAL" && item.shape === "FULL" && item.outcome === "SUCCESS");
    lines.push(currentFailures.length > 0 && minimalSuccess.length > 0
      ? "Observation: CURRENT full failed while CLASSIFIER_MINIMAL full succeeded in at least one sampled run; this does not establish a general fix."
      : "Observation: this sample does not establish a clear query-shape advantage.");
  }
  lines.push("", "Saved comparison:", savedPath);
  return lines.join("\n");
}
