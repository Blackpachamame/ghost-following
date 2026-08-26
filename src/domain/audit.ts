import type { ActivityAnalysis } from "../activity/analyzer.js";
import type { RateLimitSnapshot } from "../github/client.js";
import type {
  ActivityStatus,
  HistoricalLookupStatus,
} from "./activity.js";

export const AUDIT_SCHEMA_VERSION = 1;

export interface AuditSummary {
  followingTotal: number;
  eligibleUsers: number;
  unsupportedAccounts: number;
  active: number;
  noRecentVisibleActivity: number;
  insufficientVisibility: number;
  unknown: number;
  coverage: number | null;
}

export interface AccountAuditResult {
  login: string;
  url: string;
  accountType: string;
  status: ActivityStatus;
  recentPeriodDays: number;
  totalContributions: number | null;
  commitContributions: number | null;
  pullRequestContributions: number | null;
  pullRequestReviewContributions: number | null;
  issueContributions: number | null;
  restrictedContributionsCount: number | null;
  hasActivityInThePast: boolean | null;
  lastVisibleActivityAt: string | null;
  historicalLookupStatus: HistoricalLookupStatus | null;
}

export interface SerializableRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export interface SerializableGraphQLRateLimit extends SerializableRateLimit {
  cost: number;
}

export interface AuditResult {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  generatedAt: string;
  user: string;
  period: {
    days: number;
    from: string;
    to: string;
  };
  history: {
    years: number;
  };
  summary: AuditSummary;
  accounts: AccountAuditResult[];
  rateLimits: {
    rest: SerializableRateLimit;
    graphql: SerializableGraphQLRateLimit | null;
  };
}

function serializeRestRateLimit(
  rateLimit: RateLimitSnapshot,
): SerializableRateLimit {
  return {
    limit: rateLimit.limit ?? null,
    remaining: rateLimit.remaining ?? null,
    resetAt: rateLimit.resetAt?.toISOString() ?? null,
  };
}

export function createAuditResult(input: {
  user: string;
  generatedAt: Date;
  analysis: ActivityAnalysis;
  restRateLimit: RateLimitSnapshot;
}): AuditResult {
  if (Number.isNaN(input.generatedAt.getTime())) {
    throw new RangeError("Audit result requires a valid generation date.");
  }

  const { analysis } = input;
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    user: input.user,
    period: {
      days: analysis.period.days,
      from: analysis.period.from,
      to: analysis.period.to,
    },
    history: {
      years: analysis.historyYears,
    },
    summary: {
      followingTotal: analysis.followingTotal,
      eligibleUsers: analysis.eligibleUsers,
      unsupportedAccounts: analysis.unsupportedAccounts,
      active: analysis.counts.ACTIVE,
      noRecentVisibleActivity: analysis.counts.NO_RECENT_VISIBLE_ACTIVITY,
      insufficientVisibility: analysis.counts.INSUFFICIENT_VISIBILITY,
      unknown: analysis.counts.UNKNOWN,
      coverage: analysis.coverage,
    },
    accounts: analysis.results.map((result) => {
      const activity = result.activity;
      return {
        login: result.account.login,
        url: result.account.htmlUrl,
        accountType: result.account.type,
        status: result.status,
        recentPeriodDays: analysis.period.days,
        totalContributions: activity?.totalContributions ?? null,
        commitContributions: activity?.totalCommitContributions ?? null,
        pullRequestContributions:
          activity?.totalPullRequestContributions ?? null,
        pullRequestReviewContributions:
          activity?.totalPullRequestReviewContributions ?? null,
        issueContributions: activity?.totalIssueContributions ?? null,
        restrictedContributionsCount:
          activity?.restrictedContributionsCount ?? null,
        hasActivityInThePast: activity?.hasActivityInThePast ?? null,
        lastVisibleActivityAt: result.lastVisibleActivityAt ?? null,
        historicalLookupStatus: result.historicalLookupStatus ?? null,
      };
    }),
    rateLimits: {
      rest: serializeRestRateLimit(input.restRateLimit),
      graphql:
        analysis.rateLimit === undefined
          ? null
          : {
              cost: analysis.rateLimit.cost,
              limit: analysis.rateLimit.limit,
              remaining: analysis.rateLimit.remaining,
              resetAt: analysis.rateLimit.resetAt.toISOString(),
            },
    },
  };
}
