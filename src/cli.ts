#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { HELP, parseArgs, USAGE, UsageError } from "./args.js";
import { analyzeFollowingActivity } from "./activity/analyzer.js";
import { createAuditResult } from "./domain/audit.js";
import { createActivityPeriod } from "./domain/activity.js";
import { ExportWriteError, writeAuditExports } from "./export/files.js";
import { GitHubClient } from "./github/client.js";
import {
  GitHubAuthenticationError,
  GitHubRateLimitError,
  GitHubUserNotFoundError,
} from "./github/errors.js";
import { getFollowing } from "./github/following.js";
import { GitHubGraphQLClient } from "./github/graphql.js";
import { formatActivityReport, formatExportSummary } from "./report.js";

export interface CliIO {
  log(message: string): void;
  error(message: string): void;
}

export const TOKEN_REQUIRED_MESSAGE = [
  "Activity analysis requires GITHUB_TOKEN.",
  "",
  "Set it in your environment before running the analysis.",
  "The token is never stored by this application.",
].join("\n");

function formatDate(date: Date): string {
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

export async function runCli(
  args: readonly string[],
  options: {
    token?: string;
    fetch?: typeof globalThis.fetch;
    io?: CliIO;
    now?: Date;
    concurrency?: number;
  } = {},
): Promise<number> {
  const io = options.io ?? console;

  try {
    const cliOptions = parseArgs(args);
    if (cliOptions.help) {
      io.log(HELP);
      return 0;
    }

    const { username } = cliOptions;
    if (!options.token) {
      io.error(TOKEN_REQUIRED_MESSAGE);
      return 1;
    }

    const clientOptions: ConstructorParameters<typeof GitHubClient>[0] = {};
    clientOptions.token = options.token;
    if (options.fetch) clientOptions.fetch = options.fetch;

    const following = await getFollowing(new GitHubClient(clientOptions), username);
    const graphQLClientOptions: ConstructorParameters<typeof GitHubGraphQLClient>[0] = {
      token: options.token,
    };
    if (options.fetch) graphQLClientOptions.fetch = options.fetch;
    const generatedAt = options.now ?? new Date();
    const period = createActivityPeriod(generatedAt, cliOptions.days);
    const analysis = await analyzeFollowingActivity(
      following.accounts,
      new GitHubGraphQLClient(graphQLClientOptions),
      period,
      options.concurrency,
    );
    const audit = createAuditResult({
      user: username,
      generatedAt,
      analysis,
      restRateLimit: following.rateLimit,
    });
    io.log(formatActivityReport(audit));

    const exportPaths: { jsonPath?: string; csvPath?: string } = {};
    if (cliOptions.jsonPath !== undefined) {
      exportPaths.jsonPath = cliOptions.jsonPath;
    }
    if (cliOptions.csvPath !== undefined) {
      exportPaths.csvPath = cliOptions.csvPath;
    }
    await writeAuditExports(audit, exportPaths);
    if (exportPaths.jsonPath !== undefined || exportPaths.csvPath !== undefined) {
      io.log(formatExportSummary(exportPaths));
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(`${error.message}\n\n${USAGE}\nUse --help for usage information.`);
      return 2;
    }

    if (error instanceof ExportWriteError) {
      io.error(error.message);
      return 1;
    }

    if (error instanceof GitHubUserNotFoundError) {
      io.error(error.message);
      return 1;
    }

    if (error instanceof GitHubAuthenticationError) {
      io.error(`${error.message}\nCheck GITHUB_TOKEN and its permissions.`);
      return 1;
    }

    if (error instanceof GitHubRateLimitError) {
      const lines = [
        "GitHub API rate limit reached or the request was temporarily restricted.",
        "Using GITHUB_TOKEN significantly increases the available request quota.",
      ];

      if (error.details.resetAt) {
        lines.push(`Rate limit reset: ${formatDate(error.details.resetAt)}.`);
      }
      if (error.details.retryAfterSeconds !== undefined) {
        lines.push(`Retry after: ${error.details.retryAfterSeconds} seconds.`);
      }

      io.error(lines.join("\n"));
      return 1;
    }

    io.error(error instanceof Error ? error.message : "An unexpected error occurred.");
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  const token = process.env.GITHUB_TOKEN;
  process.exitCode = await runCli(
    process.argv.slice(2),
    token === undefined ? {} : { token },
  );
}
