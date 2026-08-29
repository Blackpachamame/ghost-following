#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import type { Sleep } from "../github/retry.js";
import {
  COMPOSITION_TARGETS,
  runRecentCompositionProbe,
  type CompositionTarget,
} from "./recent-composition-probe.js";
import {
  formatRecentCompositionProbe,
  writeRecentCompositionProbe,
} from "./recent-composition-report.js";
import { loadRecentQuerySource } from "./recent-query-source.js";

const GITHUB_USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export const RECENT_COMPOSITION_USAGE =
  "Usage: npm run diagnose:recent-composition -- <audit-username> [--timestamp <ISO>] [--source <path>] [--target <FULL|LEFT|RIGHT>] [--runs <1-3>]";

export const RECENT_COMPOSITION_HELP = [
  "GitHub Ghost Following - Recent Batch Composition Probe",
  "",
  RECENT_COMPOSITION_USAGE,
  "",
  "Experimental size/composition probe using only the productive CURRENT recent query.",
  "FULL selects the complete source batch; LEFT and RIGHT select its floor/remainder halves.",
  "The probe measures TARGET, both halves and three N-1 samples, then follows only failed half branches.",
  "Splits are observable measurements, not productive recovery, and do not identify individual causality.",
  "It can consume multiple live GraphQL requests and backend intermittency can change the tree between runs.",
  "It performs no audit, REST, historical lookup, checkpoint, export or production change.",
  "It never modifies the source failure JSONL or other diagnostic result directories.",
  "",
  "Options:",
  "  --timestamp <ISO>         Select that exact incident (default: latest valid).",
  "  --source <path>           Read an explicit or archived failure JSONL.",
  "  --target <FULL|LEFT|RIGHT> Select a source-batch group (case-insensitive; default: FULL).",
  "  --runs <1-3>              Repeat from the original target (default: 1).",
  "  --help, -h                Show this help.",
].join("\n");

export class RecentCompositionUsageError extends Error {
  override readonly name = "RecentCompositionUsageError";
}

export type RecentCompositionCliArgs = { help: true } | {
  help: false;
  auditUsername: string;
  timestamp?: string;
  source?: string;
  target: CompositionTarget;
  runs: number;
};

export function parseRecentCompositionArgs(args: readonly string[]): RecentCompositionCliArgs {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const auditUsername = args[0];
  if (auditUsername === undefined || !GITHUB_USERNAME_PATTERN.test(auditUsername)) {
    throw new RecentCompositionUsageError("Expected a valid GitHub audit username.");
  }
  let timestamp: string | undefined;
  let source: string | undefined;
  let target: CompositionTarget = "FULL";
  let runs = 1;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--timestamp", "--source", "--target", "--runs"].includes(option ?? "")) {
      throw new RecentCompositionUsageError(`Unexpected argument: ${JSON.stringify(option)}.`);
    }
    if (seen.has(option!)) throw new RecentCompositionUsageError(`${option} may be provided only once.`);
    seen.add(option!);
    if (value === undefined || value.startsWith("--")) {
      throw new RecentCompositionUsageError(`${option} requires a value.`);
    }
    if (option === "--timestamp") {
      if (Number.isNaN(new Date(value).getTime())) throw new RecentCompositionUsageError("--timestamp requires a valid timestamp.");
      timestamp = value;
    } else if (option === "--source") {
      if (value.trim().length === 0) throw new RecentCompositionUsageError("--source requires a path.");
      source = value;
    } else if (option === "--target") {
      const normalized = value.toUpperCase();
      if (!COMPOSITION_TARGETS.includes(normalized as CompositionTarget)) {
        throw new RecentCompositionUsageError("--target must be FULL, LEFT or RIGHT.");
      }
      target = normalized as CompositionTarget;
    } else {
      if (!/^[1-3]$/.test(value)) throw new RecentCompositionUsageError("--runs must be 1, 2 or 3.");
      runs = Number(value);
    }
    index += 1;
  }
  return {
    help: false,
    auditUsername,
    target,
    runs,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(source === undefined ? {} : { source }),
  };
}

export interface RecentCompositionIO {
  log(message: string): void;
  error(message: string): void;
}

export async function runRecentCompositionCli(
  args: readonly string[],
  options: {
    token?: string;
    fetch?: typeof globalThis.fetch;
    sleep?: Sleep;
    clock?: () => number;
    now?: Date;
    sourceRoot?: string;
    outputRoot?: string;
    io?: RecentCompositionIO;
  } = {},
): Promise<number> {
  const io = options.io ?? console;
  try {
    const parsed = parseRecentCompositionArgs(args);
    if (parsed.help) {
      io.log(RECENT_COMPOSITION_HELP);
      return 0;
    }
    if (options.token === undefined || options.token.trim().length === 0) {
      io.error("GITHUB_TOKEN is required for the recent composition probe.");
      return 1;
    }
    const source = await loadRecentQuerySource(parsed.auditUsername, {
      ...(parsed.timestamp === undefined ? {} : { timestamp: parsed.timestamp }),
      ...(parsed.source === undefined ? {} : { source: parsed.source }),
      ...(options.sourceRoot === undefined ? {} : { root: options.sourceRoot }),
    });
    const probe = await runRecentCompositionProbe(
      source.incident,
      source.path,
      parsed.target,
      parsed.runs,
      {
        token: options.token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
    const savedPath = await writeRecentCompositionProbe(
      probe,
      options.outputRoot === undefined ? {} : { root: options.outputRoot },
    );
    io.log(formatRecentCompositionProbe(probe, savedPath));
    return 0;
  } catch (error) {
    if (error instanceof RecentCompositionUsageError) {
      io.error(`${error.message}\n\n${RECENT_COMPOSITION_USAGE}\nUse --help for details.`);
      return 2;
    }
    io.error(error instanceof Error ? error.message : "Recent composition probe failed.");
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  const token = process.env.GITHUB_TOKEN;
  process.exitCode = await runRecentCompositionCli(
    process.argv.slice(2),
    token === undefined ? {} : { token },
  );
}
