#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import type { Sleep } from "../github/retry.js";
import { runRecentQueryComparison } from "./recent-query-comparison.js";
import { formatRecentQueryComparison, writeRecentQueryComparison } from "./recent-query-report.js";
import { loadRecentQuerySource } from "./recent-query-source.js";

const GITHUB_USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export const RECENT_QUERY_COMPARISON_USAGE =
  "Usage: npm run diagnose:recent-query -- <audit-username> [--timestamp <ISO>] [--source <path>] [--runs <1-3>]";

export const RECENT_QUERY_COMPARISON_HELP = [
  "GitHub Ghost Following - Recent Query Comparison", "", RECENT_QUERY_COMPARISON_USAGE, "",
  "Experimental diagnostic comparing CURRENT, CLASSIFIER_MINIMAL and NUMERIC_MINIMAL.",
  "It replays the selected saved recent incident sequentially and consumes live GraphQL quota.",
  "It performs no audit, REST, historical lookup, checkpoint, export or adaptive split.",
  "It never modifies the source failure JSONL.", "",
  "Options:",
  "  --timestamp <ISO>  Select that exact incident timestamp (default: latest valid).",
  "  --source <path>    Read an archived or explicit JSONL file.",
  "  --runs <1-3>       Repeat the fixed comparison plan (default: 1).",
  "  --help, -h         Show this help.",
].join("\n");

export class RecentQueryComparisonUsageError extends Error {
  override readonly name = "RecentQueryComparisonUsageError";
}

export type RecentQueryComparisonCliArgs = { help: true } | {
  help: false; auditUsername: string; timestamp?: string; source?: string; runs: number;
};

export function parseRecentQueryComparisonArgs(args: readonly string[]): RecentQueryComparisonCliArgs {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const auditUsername = args[0];
  if (auditUsername === undefined || !GITHUB_USERNAME_PATTERN.test(auditUsername)) {
    throw new RecentQueryComparisonUsageError("Expected a valid GitHub audit username.");
  }
  let timestamp: string | undefined;
  let source: string | undefined;
  let runs = 1;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--timestamp" && option !== "--source" && option !== "--runs") {
      throw new RecentQueryComparisonUsageError(`Unexpected argument: ${JSON.stringify(option)}.`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new RecentQueryComparisonUsageError(`${option} requires a value.`);
    }
    if (option === "--timestamp") {
      if (timestamp !== undefined || Number.isNaN(new Date(value).getTime())) throw new RecentQueryComparisonUsageError("--timestamp requires one valid timestamp.");
      timestamp = value;
    } else if (option === "--source") {
      if (source !== undefined || value.trim().length === 0) throw new RecentQueryComparisonUsageError("--source requires one path.");
      source = value;
    } else {
      if (!/^[1-3]$/.test(value)) throw new RecentQueryComparisonUsageError("--runs must be 1, 2 or 3.");
      runs = Number(value);
    }
    index += 1;
  }
  return {
    help: false, auditUsername, runs,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(source === undefined ? {} : { source }),
  };
}

export interface RecentQueryComparisonIO { log(message: string): void; error(message: string): void }

export async function runRecentQueryComparisonCli(
  args: readonly string[],
  options: {
    token?: string; fetch?: typeof globalThis.fetch; sleep?: Sleep; clock?: () => number;
    now?: Date; sourceRoot?: string; outputRoot?: string; io?: RecentQueryComparisonIO;
  } = {},
): Promise<number> {
  const io = options.io ?? console;
  try {
    const parsed = parseRecentQueryComparisonArgs(args);
    if (parsed.help) { io.log(RECENT_QUERY_COMPARISON_HELP); return 0; }
    if (options.token === undefined || options.token.trim().length === 0) {
      io.error("GITHUB_TOKEN is required for the recent query comparison.");
      return 1;
    }
    const source = await loadRecentQuerySource(parsed.auditUsername, {
      ...(parsed.timestamp === undefined ? {} : { timestamp: parsed.timestamp }),
      ...(parsed.source === undefined ? {} : { source: parsed.source }),
      ...(options.sourceRoot === undefined ? {} : { root: options.sourceRoot }),
    });
    const comparison = await runRecentQueryComparison(source.incident, source.path, parsed.runs, {
      token: options.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const savedPath = await writeRecentQueryComparison(comparison,
      options.outputRoot === undefined ? {} : { root: options.outputRoot });
    io.log(formatRecentQueryComparison(comparison, savedPath));
    return 0;
  } catch (error) {
    if (error instanceof RecentQueryComparisonUsageError) {
      io.error(`${error.message}\n\n${RECENT_QUERY_COMPARISON_USAGE}\nUse --help for details.`);
      return 2;
    }
    io.error(error instanceof Error ? error.message : "Recent query comparison failed.");
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  const token = process.env.GITHUB_TOKEN;
  process.exitCode = await runRecentQueryComparisonCli(
    process.argv.slice(2), token === undefined ? {} : { token },
  );
}
