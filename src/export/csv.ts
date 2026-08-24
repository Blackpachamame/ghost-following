import type { AuditResult } from "../domain/audit.js";

export const CSV_HEADERS = [
  "login",
  "profile_url",
  "status",
  "period_days",
  "total_contributions",
  "commits",
  "pull_requests",
  "reviews",
  "issues",
  "restricted_contributions",
  "has_activity_in_past",
  "last_visible_activity",
  "historical_lookup_status",
] as const;

export function escapeCsvValue(
  value: string | number | boolean | null,
): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeAuditCsv(audit: AuditResult): string {
  const rows: Array<readonly (string | number | boolean | null)[]> = [
    CSV_HEADERS,
    ...audit.accounts.map((account) => [
      account.login,
      account.url,
      account.status,
      account.recentPeriodDays,
      account.totalContributions,
      account.commitContributions,
      account.pullRequestContributions,
      account.pullRequestReviewContributions,
      account.issueContributions,
      account.restrictedContributionsCount,
      account.hasActivityInThePast,
      account.lastVisibleActivityAt,
      account.historicalLookupStatus,
    ]),
  ];

  return `${rows
    .map((row) => row.map((value) => escapeCsvValue(value)).join(","))
    .join("\n")}\n`;
}
