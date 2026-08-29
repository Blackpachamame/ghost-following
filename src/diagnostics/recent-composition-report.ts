import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isProcessingFailure,
  type CompositionMeasurement,
  type CompositionRunSummary,
  type RecentCompositionProbe,
} from "./recent-composition-probe.js";

export const DEFAULT_COMPOSITION_PROBES_ROOT = resolve(
  ".ghost-following", "diagnostics", "composition-probes",
);

export interface CompositionProbeFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, options: { encoding: "utf8"; flag: "wx" }): Promise<unknown>;
}

export class CompositionProbeWriteError extends Error {
  override readonly name = "CompositionProbeWriteError";
}

function fileSystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function windowsSafeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

export function compositionProbePathFor(
  auditUsername: string,
  timestamp: string,
  root = DEFAULT_COMPOSITION_PROBES_ROOT,
  suffix = 0,
): string {
  if (
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(auditUsername) ||
    Number.isNaN(new Date(timestamp).getTime()) ||
    !Number.isSafeInteger(suffix) ||
    suffix < 0
  ) throw new RangeError("Invalid composition probe path data.");
  return join(
    root,
    `${auditUsername}-${windowsSafeTimestamp(timestamp)}${suffix === 0 ? "" : `-${suffix}`}.json`,
  );
}

export async function writeRecentCompositionProbe(
  probe: RecentCompositionProbe,
  options: { root?: string; fileSystem?: Partial<CompositionProbeFileSystem> } = {},
): Promise<string> {
  const root = options.root ?? DEFAULT_COMPOSITION_PROBES_ROOT;
  const fileSystem: CompositionProbeFileSystem = { mkdir, writeFile, ...options.fileSystem };
  try {
    await fileSystem.mkdir(root, { recursive: true });
  } catch (error) {
    throw new CompositionProbeWriteError("Could not create the composition-probes directory.", { cause: error });
  }
  const contents = JSON.stringify(probe, null, 2) + "\n";
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const path = compositionProbePathFor(probe.auditUsername, probe.probeTimestamp, root, suffix);
    try {
      await fileSystem.writeFile(path, contents, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if (fileSystemCode(error) === "EEXIST") continue;
      throw new CompositionProbeWriteError("Could not write the composition probe result.", { cause: error });
    }
  }
  throw new CompositionProbeWriteError("Could not allocate a unique composition probe filename.");
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function valueOrDash(value: number | null): string {
  return value === null ? "-" : String(value);
}

function nMinusOneLines(summary: CompositionRunSummary): string[] {
  return summary.nMinusOne.map((item) =>
    `  ${pad(item.strategy, 12)} size ${pad(item.requestedBatchSize, 3)} ${item.outcome ?? "NOT_MEASURED"}`,
  );
}

function sameSizeCompositionVaried(summary: CompositionRunSummary): boolean {
  const drops = summary.nMinusOne.filter(({ strategy, outcome }) => strategy !== "TARGET" && outcome !== null);
  const hasSuccess = drops.some(({ outcome }) => outcome === "SUCCESS");
  const hasProcessingFailure = drops.some(
    ({ outcome }) => outcome !== null && isProcessingFailure(outcome),
  );
  return hasSuccess && hasProcessingFailure;
}

function automaticObservations(
  probe: RecentCompositionProbe,
  summary: CompositionRunSummary,
  measurements: readonly CompositionMeasurement[],
): string[] {
  const lines: string[] = [];
  const target = measurements.find(({ strategy }) => strategy === "TARGET");
  const halves = measurements.filter(({ parentNodeId }) => parentNodeId === target?.nodeId);
  const drops = summary.nMinusOne.filter(({ strategy }) => strategy !== "TARGET");
  if (
    target !== undefined &&
    isProcessingFailure(target.outcome) &&
    halves.length === 2 && halves.every(({ outcome }) => outcome === "SUCCESS") &&
    drops.length === 3 && drops.every(({ outcome }) => outcome === "SUCCESS")
  ) {
    lines.push("This run is consistent with aggregate batch/composition cost; no smaller failing half was reproduced.");
  }
  if (summary.singletonFailures.length > 0) {
    lines.push("A processing failure remained observable along a measured composition branch down to a singleton in this run.");
  }
  if (sameSizeCompositionVaried(summary)) {
    lines.push("Outcome varied materially with composition among the sampled same-size N-1 groups in this run.");
  }
  if (probe.intermittency.some(({ status }) => status === "INTERMITTENT_OBSERVED")) {
    lines.push("The same exact ordered group produced both success and failure across runs, demonstrating observed intermittency.");
  }
  if (lines.length === 0) {
    lines.push("This sample does not establish a stable size threshold or an individual causal explanation.");
  }
  return lines;
}

export function formatRecentCompositionProbe(
  probe: RecentCompositionProbe,
  savedPath: string,
): string {
  const successfulMeasurements = probe.measurements.filter(({ outcome }) => outcome === "SUCCESS");
  const processingFailureMeasurements = probe.measurements.filter(({ outcome }) => isProcessingFailure(outcome));
  const lines = [
    "Recent Batch Composition Probe",
    "",
    `Audit user: ${probe.auditUsername}`,
    `Source incident: ${probe.sourceIncident.timestamp}`,
    `Period: ${probe.sourceIncident.period.from} -> ${probe.sourceIncident.period.to}`,
    `Source batch: ${probe.sourceIncident.batchSize}`,
    `Selected target: ${probe.selectedTarget}`,
    `Target size: ${probe.targetLogins.length}`,
    `Runs: ${probe.runs}`,
    ...(probe.executedRuns === probe.runs ? [] : [`Executed runs before halt: ${probe.executedRuns}`]),
  ];
  for (const summary of probe.summaries) {
    const runMeasurements = probe.measurements.filter(({ run }) => run === summary.run);
    lines.push(
      "", `RUN ${summary.run}`, "",
      `${pad("NODE", 22)} ${pad("PARENT", 22)} ${pad("STRATEGY", 13)} ${pad("SIZE", 5)} ${pad("OUTCOME", 24)} ${pad("TRY", 4)} MS`,
    );
    for (const item of runMeasurements) {
      lines.push(
        `${pad(item.nodeId, 22)} ${pad(item.parentNodeId ?? "-", 22)} ${pad(item.strategy, 13)} ${pad(item.batchSize, 5)} ${pad(item.outcome, 24)} ${pad(item.httpAttempts, 4)} ${item.elapsedMs.toFixed(2)}`,
      );
    }
    lines.push(
      "", `Successful nodes: ${summary.successfulNodes}`,
      `Processing-failure nodes: ${summary.processingFailureNodes}`,
      `Singleton failures: ${summary.singletonFailures.length}`,
      `Largest successful batch observed: ${valueOrDash(summary.largestSuccessfulBatch)}`,
      `Smallest processing-failure batch observed: ${valueOrDash(summary.smallestProcessingFailureBatch)}`,
      "N-1 probe summary:", ...nMinusOneLines(summary),
    );
    const frequentlyPresent = summary.failureInclusion.filter(({ timesIncludedInProcessingFailure }) => timesIncludedInProcessingFailure > 0);
    if (frequentlyPresent.length > 0) {
      lines.push(
        "Accounts frequently present in failing measured groups (association only):",
        ...frequentlyPresent.map((item) =>
          `  ${item.login}: ${item.timesIncludedInProcessingFailure}/${item.timesIncluded} (${item.failureInclusionRatio.toFixed(2)})`,
        ),
      );
    }
    if (summary.haltedByNodeId !== null) {
      lines.push(`Probe halted after global/non-compositional outcome at ${summary.haltedByNodeId}.`);
    }
    lines.push("Observations:", ...automaticObservations(probe, summary, runMeasurements).map((line) => "  " + line));
  }
  const intermittent = probe.intermittency.filter(({ status }) => status === "INTERMITTENT_OBSERVED");
  lines.push(
    "", "Final summary",
    `Successful nodes: ${successfulMeasurements.length}`,
    `Processing-failure nodes: ${processingFailureMeasurements.length}`,
    `Singleton failures: ${probe.summaries.reduce((sum, item) => sum + item.singletonFailures.length, 0)}`,
    `Largest successful batch observed: ${valueOrDash(successfulMeasurements.length === 0 ? null : Math.max(...successfulMeasurements.map(({ batchSize }) => batchSize)))}`,
    `Smallest processing-failure batch observed: ${valueOrDash(processingFailureMeasurements.length === 0 ? null : Math.min(...processingFailureMeasurements.map(({ batchSize }) => batchSize)))}`,
    `Intermittent groups observed: ${intermittent.length}`,
    "No observed size is a universal GitHub threshold.",
    "", "Saved probe:", savedPath,
  );
  return lines.join("\n");
}
