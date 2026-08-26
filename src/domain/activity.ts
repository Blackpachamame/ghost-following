import type { FollowedAccount } from "./account.js";

export const ACTIVITY_PERIOD_DAYS = 365;
export const MAX_HISTORICAL_LOOKBACK_YEARS = 5;

export type ActivityStatus =
  | "ACTIVE"
  | "NO_RECENT_VISIBLE_ACTIVITY"
  | "INSUFFICIENT_VISIBILITY"
  | "UNKNOWN";

export interface ActivityPeriod {
  from: string;
  to: string;
  days: number;
}

export interface AccountActivity {
  login: string;
  periodStart: string;
  periodEnd: string;
  totalContributions: number;
  totalCommitContributions: number;
  totalIssueContributions: number;
  totalPullRequestContributions: number;
  totalPullRequestReviewContributions: number;
  restrictedContributionsCount: number;
  hasAnyContributions: boolean;
  hasAnyRestrictedContributions: boolean;
  hasActivityInThePast: boolean;
}

export type HistoricalLookupStatus =
  | "FOUND"
  | "NOT_FOUND_IN_LOOKBACK"
  | "FAILED"
  | "NOT_REQUESTED";

export interface AccountActivityResult {
  account: FollowedAccount;
  status: ActivityStatus;
  activity?: AccountActivity;
  lastVisibleActivityAt?: string | null;
  historicalLookupStatus?: HistoricalLookupStatus;
  historicalLookupError?: string;
  error?: string;
}

export function createActivityPeriod(
  now: Date,
  days = ACTIVITY_PERIOD_DAYS,
): ActivityPeriod {
  if (!Number.isSafeInteger(days) || days <= 0 || Number.isNaN(now.getTime())) {
    throw new RangeError("Activity period requires a valid date and positive day count.");
  }

  return {
    from: new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString(),
    to: now.toISOString(),
    days,
  };
}

export function classifyActivity(activity: AccountActivity): ActivityStatus {
  const hasVisibleActivity =
    activity.hasAnyContributions ||
    activity.hasAnyRestrictedContributions ||
    activity.totalContributions > 0 ||
    activity.totalCommitContributions > 0 ||
    activity.totalIssueContributions > 0 ||
    activity.totalPullRequestContributions > 0 ||
    activity.totalPullRequestReviewContributions > 0 ||
    activity.restrictedContributionsCount > 0;

  return hasVisibleActivity ? "ACTIVE" : "NO_RECENT_VISIBLE_ACTIVITY";
}

function subtractCalendarYears(date: Date, years: number): Date {
  const result = new Date(date);
  const targetYear = result.getUTCFullYear() - years;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCFullYear(
    targetYear,
    result.getUTCMonth(),
    Math.min(result.getUTCDate(), lastDayOfTargetMonth),
  );
  return result;
}

export function createHistoricalLookbackStart(
  period: ActivityPeriod,
  years: number,
): string {
  const recentStart = new Date(period.from);
  if (
    Number.isNaN(recentStart.getTime()) ||
    !Number.isSafeInteger(years) ||
    years <= 0 ||
    years > MAX_HISTORICAL_LOOKBACK_YEARS
  ) {
    throw new RangeError("Historical lookback requires a valid period and year count.");
  }
  return subtractCalendarYears(recentStart, years).toISOString();
}

export function createHistoricalPeriods(
  period: ActivityPeriod,
  years: number,
): ActivityPeriod[] {
  createHistoricalLookbackStart(period, years);

  const periods: ActivityPeriod[] = [];
  let upperExclusive = new Date(period.from);
  for (let index = 0; index < years; index += 1) {
    const from = subtractCalendarYears(upperExclusive, 1);
    periods.push({
      from: from.toISOString(),
      to: new Date(upperExclusive.getTime() - 1).toISOString(),
      days: Math.round(
        (upperExclusive.getTime() - from.getTime()) / (24 * 60 * 60 * 1_000),
      ),
    });
    upperExclusive = from;
  }
  return periods;
}

export function calculateCoverage(
  results: readonly AccountActivityResult[],
  eligibleUsers: number,
): number | null {
  if (eligibleUsers === 0) {
    return null;
  }

  const evaluable = results.filter(
    ({ status }) =>
      status === "ACTIVE" || status === "NO_RECENT_VISIBLE_ACTIVITY",
  ).length;

  return (evaluable / eligibleUsers) * 100;
}
