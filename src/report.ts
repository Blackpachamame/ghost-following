import { groupAccountsByType, type FollowedAccount } from "./domain/account.js";
import {
  HISTORICAL_LOOKBACK_YEARS,
  type ActivityStatus,
} from "./domain/activity.js";
import type { AccountAuditResult, AuditResult } from "./domain/audit.js";
import type { RateLimitSnapshot } from "./github/client.js";

export interface SummaryInput {
  username: string;
  accounts: readonly FollowedAccount[];
  rateLimit: RateLimitSnapshot;
}

export function formatSummary(input: SummaryInput): string {
  const lines = [
    "GitHub Ghost Following",
    "",
    `User: ${input.username}`,
    `Following found: ${input.accounts.length}`,
    "",
    "Account types:",
  ];

  const typeCounts = [...groupAccountsByType(input.accounts)].sort(([left], [right]) => {
    if (left === "User") return -1;
    if (right === "User") return 1;
    return left.localeCompare(right);
  });

  if (typeCounts.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [type, count] of typeCounts) {
      lines.push(`  ${type}: ${count}`);
    }
  }

  if (
    input.rateLimit.remaining !== undefined &&
    input.rateLimit.limit !== undefined
  ) {
    lines.push(
      "",
      "GitHub API:",
      `  Remaining requests: ${input.rateLimit.remaining} / ${input.rateLimit.limit}`,
    );
  }

  return lines.join("\n");
}

const STATUS_ORDER: Readonly<Record<ActivityStatus, number>> = {
  NO_RECENT_VISIBLE_ACTIVITY: 0,
  INSUFFICIENT_VISIBILITY: 1,
  UNKNOWN: 2,
  ACTIVE: 3,
};

function displayNumber(value: number | null): string {
  return value === null ? "-" : String(value);
}

function detailCells(result: AccountAuditResult): string[] {
  return [
    result.login,
    displayNumber(result.totalContributions),
    displayNumber(result.commitContributions),
    displayNumber(result.pullRequestContributions),
    displayNumber(result.pullRequestReviewContributions),
    displayNumber(result.issueContributions),
    displayNumber(result.restrictedContributionsCount),
    result.status,
  ];
}

function formatTable(rows: readonly string[][]): string[] {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  if (widths === undefined) return [];

  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join("  ")
      .trimEnd(),
  );
}

function candidateDate(result: AccountAuditResult): string {
  if (result.lastVisibleActivityAt !== null) {
    return result.lastVisibleActivityAt;
  }
  if (result.historicalLookupStatus === "FAILED") return "lookup failed";
  return `not found in ${HISTORICAL_LOOKBACK_YEARS}y`;
}

function candidateRank(result: AccountAuditResult): number {
  switch (result.historicalLookupStatus) {
    case "NOT_FOUND_IN_LOOKBACK":
      return 0;
    case "FAILED":
      return 1;
    case "FOUND":
      return 2;
    default:
      return 3;
  }
}

function compareCandidates(
  left: AccountAuditResult,
  right: AccountAuditResult,
): number {
  const rankDifference = candidateRank(left) - candidateRank(right);
  if (rankDifference !== 0) return rankDifference;

  const leftDate = left.lastVisibleActivityAt;
  const rightDate = right.lastVisibleActivityAt;
  if (leftDate === null || leftDate === undefined) {
    if (rightDate !== null && rightDate !== undefined) return -1;
    return left.login.localeCompare(right.login);
  }
  if (rightDate === null || rightDate === undefined) return 1;
  return leftDate.localeCompare(rightDate) || left.login.localeCompare(right.login);
}

export function formatActivityReport(audit: AuditResult): string {
  const candidates = audit.accounts
    .filter(({ status }) => status === "NO_RECENT_VISIBLE_ACTIVITY")
    .sort(compareCandidates);
  const otherResults = audit.accounts
    .filter(({ status }) => status !== "NO_RECENT_VISIBLE_ACTIVITY")
    .sort((left, right) => {
    const statusDifference = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    if (statusDifference !== 0) return statusDifference;

    const leftTotal = left.totalContributions ?? Number.POSITIVE_INFINITY;
    const rightTotal = right.totalContributions ?? Number.POSITIVE_INFINITY;
    return leftTotal - rightTotal || left.login.localeCompare(right.login);
    });
  const candidateTable = formatTable([
    ["USERNAME", "LAST VISIBLE ACTIVITY", "PAST ACTIVITY", "STATUS"],
    ...candidates.map((result) => [
      result.login,
      candidateDate(result),
      result.hasActivityInThePast === true ? "yes" : "no",
      result.status,
    ]),
  ]);
  const activityTable = formatTable([
    ["USERNAME", "TOTAL", "COMMITS", "PRS", "REVIEWS", "ISSUES", "RESTRICTED", "STATUS"],
    ...otherResults.map(detailCells),
  ]);
  const coverage =
    audit.summary.coverage === null
      ? "N/A"
      : `${audit.summary.coverage.toFixed(1)}%`;
  const lines = [
    "GitHub Ghost Following",
    "",
    `User: ${audit.user}`,
    `Period: last ${audit.period.days} days`,
    "",
    "Following",
    "---------",
    `Total: ${audit.summary.followingTotal}`,
    `Eligible users: ${audit.summary.eligibleUsers}`,
    `Unsupported/non-user accounts: ${audit.summary.unsupportedAccounts}`,
    "",
    "Activity",
    "--------",
    `Active: ${audit.summary.active}`,
    `No recent visible activity: ${audit.summary.noRecentVisibleActivity}`,
    `Insufficient visibility: ${audit.summary.insufficientVisibility}`,
    `Unknown: ${audit.summary.unknown}`,
    "",
    `Coverage: ${coverage}`,
    "",
    "Candidates",
    "",
    ...candidateTable,
    "",
    "Other activity details",
    "",
    ...activityTable,
  ];

  if (
    audit.rateLimits.rest.remaining !== null &&
    audit.rateLimits.rest.limit !== null
  ) {
    lines.push(
      "",
      "GitHub REST:",
      `  Remaining: ${audit.rateLimits.rest.remaining} / ${audit.rateLimits.rest.limit}`,
    );
  }

  if (audit.rateLimits.graphql !== null) {
    lines.push(
      "",
      "GitHub GraphQL:",
      `  Remaining: ${audit.rateLimits.graphql.remaining} / ${audit.rateLimits.graphql.limit}`,
      `  Last observed query cost: ${audit.rateLimits.graphql.cost}`,
      `  Resets at: ${audit.rateLimits.graphql.resetAt ?? "unknown"}`,
    );
  }

  return lines.join("\n");
}

export function formatExportSummary(paths: {
  jsonPath?: string;
  csvPath?: string;
}): string {
  const lines = ["Exports", "-------"];
  if (paths.jsonPath !== undefined) lines.push(`JSON: ${paths.jsonPath}`);
  if (paths.csvPath !== undefined) lines.push(`CSV: ${paths.csvPath}`);
  return lines.join("\n");
}
