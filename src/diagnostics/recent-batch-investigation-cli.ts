#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { GitHubGraphQLClient } from "../github/graphql.js";
import type { Sleep } from "../github/retry.js";
import {
  formatRecentBatchInvestigation,
  investigateRecentBatch,
  loadLatestRecentBatchFailureIncident,
  writeRecentBatchInvestigation,
} from "./recent-batch-investigation.js";

const GITHUB_USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export const RECENT_BATCH_INVESTIGATION_USAGE =
  "Usage: npm run diagnose:recent-batch -- <audit-username>";

export const RECENT_BATCH_INVESTIGATION_HELP = [
  "GitHub Ghost Following — Recent Batch Investigation",
  "",
  "Troubleshoot the latest recorded recent GraphQL batch failure.",
  "",
  RECENT_BATCH_INVESTIGATION_USAGE,
  "",
  "The command replays only the saved batch and period.",
  "It can consume GitHub GraphQL quota.",
  "It does not run REST, an audit, historical lookup, exports or checkpoints.",
  "A singleton timeout is evidence for manual review, not proof of causation",
  "and not a detector for private profiles.",
].join("\n");

export interface RecentBatchInvestigationIO {
  log(message: string): void;
  error(message: string): void;
}

export class RecentBatchInvestigationUsageError extends Error {
  override readonly name = "RecentBatchInvestigationUsageError";
}

export type RecentBatchInvestigationCliArgs =
  | { help: true }
  | { help: false; auditUsername: string };

export function parseRecentBatchInvestigationArgs(
  args: readonly string[],
): RecentBatchInvestigationCliArgs {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const auditUsername = args[0];
  if (
    auditUsername === undefined ||
    !GITHUB_USERNAME_PATTERN.test(auditUsername)
  ) {
    throw new RecentBatchInvestigationUsageError(
      "Expected a valid GitHub audit username.",
    );
  }
  if (args.length > 1) {
    throw new RecentBatchInvestigationUsageError(
      "Unexpected argument: " + JSON.stringify(args[1]) + ".",
    );
  }
  return { help: false, auditUsername };
}

export async function runRecentBatchInvestigationCli(
  args: readonly string[],
  options: {
    token?: string;
    fetch?: typeof globalThis.fetch;
    sleep?: Sleep;
    io?: RecentBatchInvestigationIO;
    now?: Date;
    sourceRoot?: string;
    investigationsRoot?: string;
  } = {},
): Promise<number> {
  const io = options.io ?? console;
  try {
    const parsed = parseRecentBatchInvestigationArgs(args);
    if (parsed.help) {
      io.log(RECENT_BATCH_INVESTIGATION_HELP);
      return 0;
    }
    if (options.token === undefined || options.token.trim().length === 0) {
      io.error("GITHUB_TOKEN is required for recent batch investigation.");
      return 1;
    }

    const incident = await loadLatestRecentBatchFailureIncident(
      parsed.auditUsername,
      options.sourceRoot === undefined ? {} : { root: options.sourceRoot },
    );
    const graphQLOptions: ConstructorParameters<
      typeof GitHubGraphQLClient
    >[0] = { token: options.token };
    if (options.fetch !== undefined) graphQLOptions.fetch = options.fetch;
    if (options.sleep !== undefined) graphQLOptions.sleep = options.sleep;
    const investigation = await investigateRecentBatch(
      new GitHubGraphQLClient(graphQLOptions),
      incident,
      options.now ?? new Date(),
    );
    const savedPath = await writeRecentBatchInvestigation(
      investigation,
      options.investigationsRoot === undefined
        ? {}
        : { root: options.investigationsRoot },
    );
    io.log(formatRecentBatchInvestigation(investigation, savedPath));
    return investigation.conclusion === "INCONCLUSIVE" ? 1 : 0;
  } catch (error) {
    if (error instanceof RecentBatchInvestigationUsageError) {
      io.error(
        error.message +
          "\n\n" +
          RECENT_BATCH_INVESTIGATION_USAGE +
          "\nUse --help for troubleshooting details.",
      );
      return 2;
    }
    io.error(
      error instanceof Error
        ? error.message
        : "Recent batch investigation failed.",
    );
    return 1;
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  const token = process.env.GITHUB_TOKEN;
  process.exitCode = await runRecentBatchInvestigationCli(
    process.argv.slice(2),
    token === undefined ? {} : { token },
  );
}
