import type { GitHubRateLimitError } from "../github/errors.js";

export interface CliIO {
  log(message: string): void;
  error(message: string): void;
}

function formatDate(date: Date): string {
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function formatPrimaryQuota(
  error: GitHubRateLimitError,
  scope: "API" | "GraphQL",
): string | undefined {
  if (error.remaining === undefined) {
    return error.limit === undefined
      ? undefined
      : `Primary ${scope} quota limit: ${error.limit}`;
  }
  return `Primary ${scope} quota remaining: ${error.remaining}${
    error.limit === undefined ? "" : ` / ${error.limit}`
  }`;
}

export function formatRateLimitLines(
  error: GitHubRateLimitError,
  scope: "API" | "GraphQL",
  progressSaved: boolean,
): string[] {
  const lines: string[] = [];
  if (error.kind === "PRIMARY") {
    lines.push(`GitHub ${scope} primary rate limit exhausted.`);
  } else if (error.kind === "SECONDARY") {
    lines.push(`GitHub ${scope} secondary rate limit reached.`);
  } else {
    lines.push(
      `GitHub ${scope} rate limit encountered.`,
      "The response did not provide enough information to classify it as primary or secondary.",
    );
  }

  if (progressSaved) lines.push("Progress saved.");

  const quota = formatPrimaryQuota(error, scope);
  if (quota !== undefined) lines.push(quota);

  if (error.kind === "PRIMARY" && error.resetAt !== undefined) {
    lines.push(`Primary limit resets at: ${formatDate(error.resetAt)}`);
  } else if (error.resetAt !== undefined) {
    lines.push(`Reported rate limit reset: ${formatDate(error.resetAt)}`);
  }

  if (error.retryAfterSeconds !== undefined) {
    lines.push(
      `GitHub requested a cooldown of ${error.retryAfterSeconds} seconds before retrying.`,
    );
  } else if (error.kind === "SECONDARY") {
    lines.push(
      "GitHub did not provide Retry-After.",
      "Wait before resuming; GitHub recommends at least one minute for secondary rate limits when primary quota remains available.",
    );
  }

  if (error.kind === "UNKNOWN") {
    lines.push(`HTTP status: ${error.status}`);
  }
  return lines;
}

export function formatCliArgument(value: string): string {
  if (/^[a-z\d_./:-]+$/i.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return JSON.stringify(value);
}

export function createProgressReporter(
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

