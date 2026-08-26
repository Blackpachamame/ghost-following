#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { HELP, parseArgs, USAGE, UsageError } from "./args.js";
import {
  ACTIVITY_BATCH_SIZE,
  analyzeFollowingActivity,
} from "./activity/analyzer.js";
import {
  CheckpointError,
  CheckpointWriter,
  checkpointHistoricalResults,
  checkpointPathFor,
  checkpointRateLimit,
  checkpointRecentResults,
  compareFollowing,
  createCheckpoint,
  loadCheckpoint,
  recordHistoricalResult,
  recordRateLimit,
  recordRecentResults,
  removeCheckpoint,
  validateResumeCheckpoint,
  type AuditCheckpoint,
} from "./checkpoint.js";
import { createAuditResult } from "./domain/audit.js";
import { createActivityPeriod } from "./domain/activity.js";
import {
  createRecentBatchFailureIncident,
  formatRecentBatchDiagnosticWarning,
  formatRecentBatchFailure,
  RecentBatchFailureWriter,
} from "./diagnostics/recent-batch-failures.js";
import { ExportWriteError, writeAuditExports } from "./export/files.js";
import { GitHubClient } from "./github/client.js";
import {
  GitHubAuthenticationError,
  GitHubRateLimitError,
  GitHubUserNotFoundError,
} from "./github/errors.js";
import { getFollowing } from "./github/following.js";
import { GitHubGraphQLClient } from "./github/graphql.js";
import type { Sleep } from "./github/retry.js";
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

export function formatSuggestedResumeCommand(
  username: string,
  days: number,
  historyYears: number,
): string {
  return `npm run start -- ${username} --days ${days}${historyYears === 0 ? "" : ` --history-years ${historyYears}`} --resume`;
}

export async function runCli(
  args: readonly string[],
  options: {
    token?: string;
    fetch?: typeof globalThis.fetch;
    io?: CliIO;
    now?: Date;
    concurrency?: number;
    checkpointRoot?: string;
    diagnosticsRoot?: string;
    sleep?: Sleep;
  } = {},
): Promise<number> {
  const io = options.io ?? console;
  let progressSavedFor: string | undefined;
  let progressSavedDays = 0;
  let progressSavedHistoryYears = 0;

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
    if (options.sleep) clientOptions.sleep = options.sleep;

    const following = await getFollowing(new GitHubClient(clientOptions), username);
    const graphQLClientOptions: ConstructorParameters<typeof GitHubGraphQLClient>[0] = {
      token: options.token,
    };
    if (options.fetch) graphQLClientOptions.fetch = options.fetch;
    if (options.sleep) graphQLClientOptions.sleep = options.sleep;
    const startedAt = options.now ?? new Date();
    const checkpointPath = checkpointPathFor(
      username,
      options.checkpointRoot,
    );
    let checkpoint: AuditCheckpoint;
    let period;
    let historyYears: number;
    if (cliOptions.resume) {
      checkpoint = await loadCheckpoint(checkpointPath);
      historyYears = validateResumeCheckpoint(
        checkpoint,
        username,
        cliOptions.days,
        cliOptions.historyYears,
      );
      period = checkpoint.period;
      const changes = compareFollowing(
        checkpoint.followingSnapshot,
        following.accounts,
      );
      if (changes.added.length > 0 || changes.removed.length > 0) {
        io.log(
          [
            "Following changed since checkpoint:",
            `  +${changes.added.length} new accounts`,
            `  -${changes.removed.length} removed accounts`,
          ].join("\n"),
        );
      }
      checkpoint.followingSnapshot = [...following.accounts];
    } else {
      historyYears = cliOptions.historyYears ?? 0;
      period = createActivityPeriod(startedAt, cliOptions.days);
      checkpoint = createCheckpoint(
        username,
        period,
        following.accounts,
        startedAt,
        historyYears,
      );
    }
    const checkpointWriter = new CheckpointWriter(checkpointPath);
    const recentBatchFailureWriter = new RecentBatchFailureWriter(username, {
      ...(options.diagnosticsRoot === undefined
        ? {}
        : { root: options.diagnosticsRoot }),
    });
    await checkpointWriter.save(checkpoint, startedAt);
    progressSavedFor = username;
    progressSavedDays = period.days;
    progressSavedHistoryYears = historyYears;

    const saveCheckpoint = (): Promise<void> =>
      checkpointWriter.save(checkpoint);
    const recentProgress = createProgressReporter(
      "Analyzing recent activity",
      following.accounts.filter(({ type }) => type === "User").length,
      io,
      ACTIVITY_BATCH_SIZE,
    );
    let historicalProgress:
      | ((completed: number, actualTotal: number) => void)
      | undefined;
    const savedRateLimit = checkpointRateLimit(checkpoint);
    const reusableRateLimit =
      savedRateLimit?.remaining === 0 &&
      savedRateLimit.resetAt.getTime() <= startedAt.getTime()
        ? undefined
        : savedRateLimit;
    const analysis = await analyzeFollowingActivity(
      following.accounts,
      new GitHubGraphQLClient(graphQLClientOptions),
      period,
      {
        ...(options.concurrency === undefined
          ? {}
          : { concurrency: options.concurrency }),
        historyYears,
        completedRecentActivity: checkpointRecentResults(checkpoint),
        completedHistoricalActivity: checkpointHistoricalResults(checkpoint),
        ...(reusableRateLimit === undefined
          ? {}
          : { initialRateLimit: reusableRateLimit }),
        async onRecentBatchCompleted(results, completed, total, rateLimit) {
          recordRecentResults(checkpoint, results);
          recordRateLimit(checkpoint, rateLimit);
          await saveCheckpoint();
          recentProgress(completed, total);
        },
        async onRecentBatchFailed(failure) {
          io.error(formatRecentBatchFailure(failure));
          await recentBatchFailureWriter.append(
            createRecentBatchFailureIncident(
              username,
              failure,
              options.now ?? new Date(),
            ),
          );
        },
        onRecentBatchFailureReportingError(error) {
          io.error(formatRecentBatchDiagnosticWarning(error));
        },
        async onHistoricalAccountCompleted(result, completed, total, rateLimit) {
          recordHistoricalResult(checkpoint, result);
          recordRateLimit(checkpoint, rateLimit);
          await saveCheckpoint();
          historicalProgress ??= createProgressReporter(
            "Analyzing historical activity",
            total,
            io,
            10,
          );
          historicalProgress(completed, total);
        },
      },
    );
    await checkpointWriter.flush();
    const generatedAt = options.now ?? new Date();
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
    await removeCheckpoint(checkpointPath);
    progressSavedFor = undefined;
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

    if (error instanceof CheckpointError) {
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
      if (progressSavedFor !== undefined) {
        const lines = [
          "GitHub GraphQL rate limit exhausted.",
          "Progress saved.",
        ];
        if (error.details.resetAt) {
          lines.push(`Resume after: ${formatDate(error.details.resetAt)}`);
        }
        lines.push(
          "",
          "Run:",
          `  ${formatSuggestedResumeCommand(
            progressSavedFor,
            progressSavedDays,
            progressSavedHistoryYears,
          )}`,
        );
        io.error(lines.join("\n"));
        return 1;
      }
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

function createProgressReporter(
  label: string,
  total: number,
  io: CliIO,
  minimumStep: number,
): (completed: number, actualTotal: number) => void {
  if (total === 0) return () => undefined;
  const step = Math.max(
    minimumStep,
    Math.ceil(total / (10 * minimumStep)) * minimumStep,
  );
  let next = step;
  let last = -1;
  return (completed, actualTotal) => {
    if (completed < next && completed !== actualTotal) return;
    if (completed === last) return;
    io.log(`${label}: ${completed} / ${actualTotal}`);
    last = completed;
    while (next <= completed) next += step;
  };
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  const token = process.env.GITHUB_TOKEN;
  process.exitCode = await runCli(
    process.argv.slice(2),
    token === undefined ? {} : { token },
  );
}
