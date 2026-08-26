import {
  ACTIVITY_PERIOD_DAYS,
  MAX_HISTORICAL_LOOKBACK_YEARS,
} from "./domain/activity.js";

const USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export const HELP = [
  "GitHub Ghost Following",
  "",
  "Audit visible GitHub activity for the accounts followed by a user.",
  "",
  "Usage:",
  "  github-ghost-following <username> [options]",
  "",
  "Options:",
  "  --days <number>       Activity period in days (default: 365)",
  "  --history-years <1-5> Look back up to N years for quiet accounts (default: disabled)",
  "  --json <path>       Export full audit as JSON",
  "  --csv <path>        Export account audit as CSV",
  "  --resume            Resume a compatible saved audit",
  "  -h, --help          Show help",
].join("\n");

export const USAGE = "Usage: github-ghost-following <username> [options]";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface AuditCliOptions {
  help: false;
  username: string;
  days: number;
  historyYears?: number;
  resume: boolean;
  jsonPath?: string;
  csvPath?: string;
}

export interface HelpCliOptions {
  help: true;
}

export type CliOptions = AuditCliOptions | HelpCliOptions;

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (
    value === undefined ||
    value.length === 0 ||
    value.startsWith("--") ||
    value === "-h"
  ) {
    throw new UsageError(`Missing value for ${option}.`);
  }
  return value;
}

function parseDays(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(
      "Invalid value for --days: expected a positive integer.",
    );
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new UsageError(
      "Invalid value for --days: expected a positive integer.",
    );
  }
  return days;
}

function parseHistoryYears(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(
      `Invalid value for --history-years: expected an integer from 1 to ${MAX_HISTORICAL_LOOKBACK_YEARS}.`,
    );
  }
  const years = Number(value);
  if (
    !Number.isSafeInteger(years) ||
    years < 1 ||
    years > MAX_HISTORICAL_LOOKBACK_YEARS
  ) {
    throw new UsageError(
      `Invalid value for --history-years: expected an integer from 1 to ${MAX_HISTORICAL_LOOKBACK_YEARS}.`,
    );
  }
  return years;
}

function validateUsername(username: string | undefined): string {
  if (
    username === undefined ||
    !USERNAME_PATTERN.test(username) ||
    username.includes("--")
  ) {
    throw new UsageError(`Invalid GitHub username: ${JSON.stringify(username)}.`);
  }
  return username;
}

export function parseArgs(args: readonly string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  const username = args[0];
  if (username === undefined || username.startsWith("-")) {
    throw new UsageError("Expected a GitHub username.");
  }

  const parsed: AuditCliOptions = {
    help: false,
    username: validateUsername(username),
    days: ACTIVITY_PERIOD_DAYS,
    resume: false,
  };

  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    switch (option) {
      case "--days":
        parsed.days = parseDays(requireValue(args, index, option));
        index += 1;
        break;
      case "--history-years":
        parsed.historyYears = parseHistoryYears(
          requireValue(args, index, option),
        );
        index += 1;
        break;
      case "--json":
        parsed.jsonPath = requireValue(args, index, option);
        index += 1;
        break;
      case "--csv":
        parsed.csvPath = requireValue(args, index, option);
        index += 1;
        break;
      case "--resume":
        parsed.resume = true;
        break;
      default:
        if (option?.startsWith("-")) {
          throw new UsageError(`Unknown option: ${option}`);
        }
        throw new UsageError(`Unexpected argument: ${JSON.stringify(option)}.`);
    }
  }

  return parsed;
}

export function parseUsername(args: readonly string[]): string {
  const parsed = parseArgs(args);
  if (parsed.help) {
    throw new UsageError("Expected a GitHub username.");
  }
  return parsed.username;
}
