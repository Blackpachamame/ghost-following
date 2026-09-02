#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { GitHubClient } from "../github/client.js";
import { getFollowing, type FollowingResult } from "../github/following.js";
import type { Sleep } from "../github/retry.js";
import {
  DEFAULT_BENCHMARK_DAYS,
  DEFAULT_BENCHMARK_SAMPLE_SIZE,
  DEFAULT_BENCHMARK_SIZES,
  MAX_BENCHMARK_SAMPLE_SIZE,
  MAX_BENCHMARK_BATCH_SIZE,
  MIN_BENCHMARK_SAMPLE_SIZE,
  createCurrentBatchSizeExecutor,
  prepareBatchSizeBenchmark,
  runBatchSizeBenchmark,
  validateBenchmarkSizes,
} from "./recent-batch-size-benchmark.js";
import {
  formatBatchSizeBenchmarkPlan,
  formatRecentBatchSizeBenchmark,
  writeRecentBatchSizeBenchmark,
} from "./recent-batch-size-report.js";

const GITHUB_USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export const RECENT_BATCH_SIZE_USAGE =
  `Usage: npm run diagnose:recent-batch-sizes -- <audit-username> [--days <positive integer>] [--sample-size <50-500>] [--sizes <1..${MAX_BENCHMARK_BATCH_SIZE},...>]`;

export const RECENT_BATCH_SIZE_HELP = [
  "GitHub Ghost Following - Recent Batch Size Benchmark",
  "",
  RECENT_BATCH_SIZE_USAGE,
  "",
  "Diagnostic benchmark only; it does not change the production batch size or other production behavior.",
  "It retrieves the complete following list through REST once, filters Users, and ranks a deterministic SHA-256 sample.",
  "Every requested size processes the same users in the same order and the same recent period.",
  "It then makes sequential live GraphQL CURRENT-query requests and can consume API quota.",
  "Adaptive fallback is disabled: an exhausted processing failure remains a failed batch.",
  "It performs no historical lookup, checkpoint, productive audit export, resume, or production change.",
  "Global failures persist a partial benchmark and stop without sleeping until reset.",
  "",
  "Options:",
  `  --days <integer>       Recent period in positive whole days (default: ${DEFAULT_BENCHMARK_DAYS}).`,
  `  --sample-size <number> Deterministic sample size ${MIN_BENCHMARK_SAMPLE_SIZE}-${MAX_BENCHMARK_SAMPLE_SIZE} (default: ${DEFAULT_BENCHMARK_SAMPLE_SIZE}).`,
  `  --sizes <list>         Unique ordered integers 1-${MAX_BENCHMARK_BATCH_SIZE} (default: ${DEFAULT_BENCHMARK_SIZES.join(",")}).`,
  "  --help, -h             Show this help without making requests.",
].join("\n");

export class RecentBatchSizeUsageError extends Error {
  override readonly name = "RecentBatchSizeUsageError";
}

export type RecentBatchSizeCliArgs = { help: true } | {
  help: false;
  auditUsername: string;
  days: number;
  sampleSize: number;
  sizes: number[];
};

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) throw new RecentBatchSizeUsageError(`${option} requires a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RecentBatchSizeUsageError(`${option} requires a positive integer.`);
  return parsed;
}

export function parseBenchmarkSizes(value: string): number[] {
  const tokens = value.split(",");
  if (tokens.length === 0 || tokens.some((token) => token.length === 0 || !/^\d+$/.test(token))) {
    throw new RecentBatchSizeUsageError(`--sizes requires comma-separated unique integers from 1 to ${MAX_BENCHMARK_BATCH_SIZE}.`);
  }
  const sizes = tokens.map(Number);
  try {
    return validateBenchmarkSizes(sizes);
  } catch (error) {
    throw new RecentBatchSizeUsageError(error instanceof Error ? error.message : "Invalid --sizes value.", { cause: error });
  }
}

export function parseRecentBatchSizeArgs(args: readonly string[]): RecentBatchSizeCliArgs {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const auditUsername = args[0];
  if (auditUsername === undefined || !GITHUB_USERNAME_PATTERN.test(auditUsername)) {
    throw new RecentBatchSizeUsageError("Expected a valid GitHub audit username.");
  }
  let days = DEFAULT_BENCHMARK_DAYS;
  let sampleSize = DEFAULT_BENCHMARK_SAMPLE_SIZE;
  let sizes: number[] = [...DEFAULT_BENCHMARK_SIZES];
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--days", "--sample-size", "--sizes"].includes(option ?? "")) {
      throw new RecentBatchSizeUsageError(`Unexpected argument: ${JSON.stringify(option)}.`);
    }
    if (seen.has(option!)) throw new RecentBatchSizeUsageError(`${option} may be provided only once.`);
    seen.add(option!);
    if (value === undefined || value.startsWith("--")) throw new RecentBatchSizeUsageError(`${option} requires a value.`);
    if (option === "--days") {
      days = parsePositiveInteger(value, option);
    } else if (option === "--sample-size") {
      sampleSize = parsePositiveInteger(value, option);
      if (sampleSize < MIN_BENCHMARK_SAMPLE_SIZE || sampleSize > MAX_BENCHMARK_SAMPLE_SIZE) {
        throw new RecentBatchSizeUsageError(`--sample-size must be from ${MIN_BENCHMARK_SAMPLE_SIZE} to ${MAX_BENCHMARK_SAMPLE_SIZE}.`);
      }
    } else {
      sizes = parseBenchmarkSizes(value);
    }
    index += 1;
  }
  return { help: false, auditUsername, days, sampleSize, sizes };
}

export interface RecentBatchSizeIO { log(message: string): void; error(message: string): void }

export async function runRecentBatchSizeCli(
  args: readonly string[],
  options: {
    token?: string;
    fetch?: typeof globalThis.fetch;
    sleep?: Sleep;
    clock?: () => number;
    now?: Date;
    outputRoot?: string;
    io?: RecentBatchSizeIO;
    getFollowing?: (client: GitHubClient, username: string) => Promise<FollowingResult>;
  } = {},
): Promise<number> {
  const io = options.io ?? console;
  try {
    const parsed = parseRecentBatchSizeArgs(args);
    if (parsed.help) {
      io.log(RECENT_BATCH_SIZE_HELP);
      return 0;
    }
    if (options.token === undefined || options.token.trim().length === 0) {
      io.error("GITHUB_TOKEN is required for the recent batch-size benchmark.");
      return 1;
    }
    const client = new GitHubClient({
      token: options.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    const following = await (options.getFollowing ?? getFollowing)(client, parsed.auditUsername);
    const prepared = prepareBatchSizeBenchmark(parsed.auditUsername, following.accounts, {
      days: parsed.days, sampleSize: parsed.sampleSize, sizes: parsed.sizes, now: options.now ?? new Date(),
    });
    io.log(formatBatchSizeBenchmarkPlan(prepared));
    const benchmark = await runBatchSizeBenchmark(prepared, createCurrentBatchSizeExecutor({
      token: options.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }));
    const savedPath = await writeRecentBatchSizeBenchmark(
      benchmark,
      options.outputRoot === undefined ? {} : { root: options.outputRoot },
    );
    io.log(formatRecentBatchSizeBenchmark(benchmark, savedPath));
    return benchmark.halt === null ? 0 : 1;
  } catch (error) {
    if (error instanceof RecentBatchSizeUsageError) {
      io.error(`${error.message}\n\n${RECENT_BATCH_SIZE_USAGE}\nUse --help for details.`);
      return 2;
    }
    io.error(error instanceof Error ? error.message : "Recent batch-size benchmark failed.");
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  const token = process.env.GITHUB_TOKEN;
  process.exitCode = await runRecentBatchSizeCli(process.argv.slice(2), token === undefined ? {} : { token });
}
