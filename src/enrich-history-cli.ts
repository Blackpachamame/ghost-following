#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { UsageError } from "./args.js";
import {
  HELP, USAGE, parseEnrichHistoryArgs, formatEnrichHistoryResumeCommand,
  type EnrichHistoryOptions,
} from "./enrich-history/args.js";
import { enrichHistoryReport, type EnrichmentDependencies } from "./enrich-history/runner.js";
import { GitHubRateLimitError } from "./github/errors.js";
import { formatActivityReport, formatExportSummary } from "./report.js";
import {
  createProgressReporter, formatRateLimitLines, type CliIO,
} from "./utils/cli-presentation.js";

export async function runEnrichHistoryCli(
  args: readonly string[],
  options: Omit<EnrichmentDependencies, "onProgress" | "onCheckpointSaved"> & { io?: CliIO } = {},
): Promise<number> {
  const rawIO = options.io ?? console;
  let token = options.token;
  const redact = (message: string): string => token ? message.replaceAll(token, "[REDACTED]") : message;
  const io: CliIO = {
    log: (message) => rawIO.log(redact(message)),
    error: (message) => rawIO.error(redact(message)),
  };
  let parsed: EnrichHistoryOptions | undefined;
  let progressSaved = false;
  let progress: ReturnType<typeof createProgressReporter> | undefined;
  try {
    const argsResult = parseEnrichHistoryArgs(args);
    if (argsResult.help) {
      io.log(HELP);
      return 0;
    }
    parsed = argsResult;
    const audit = await enrichHistoryReport(parsed, {
      ...options,
      getToken() {
        token = options.getToken?.();
        return token;
      },
      onCheckpointSaved() { progressSaved = true; },
      onProgress(completed, total) {
        progress ??= createProgressReporter("Enriching historical activity", total, io, 10);
        progress(completed, total);
      },
    });
    io.log(formatActivityReport(audit));
    io.log(formatExportSummary(parsed));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(`${error.message}\n\n${USAGE}\nUse --help for usage information.`);
      return 2;
    }
    const lines = error instanceof GitHubRateLimitError
      ? formatRateLimitLines(error, "GraphQL", progressSaved)
      : [error instanceof Error ? error.message : "An unexpected error occurred.",
          ...(progressSaved ? ["Progress saved."] : [])];
    if (progressSaved && parsed !== undefined) {
      lines.push("", "Run:", `  ${formatEnrichHistoryResumeCommand(parsed)}`);
    }
    io.error(lines.join("\n"));
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await runEnrichHistoryCli(process.argv.slice(2), {
    getToken: () => process.env.GITHUB_TOKEN,
  });
}

