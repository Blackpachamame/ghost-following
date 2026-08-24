import {
  calculateCoverage,
  classifyActivity,
  createHistoricalPeriods,
  type AccountActivityResult,
  type ActivityPeriod,
  type ActivityStatus,
} from "../domain/activity.js";
import type { FollowedAccount } from "../domain/account.js";
import { GitHubGraphQLAccountError } from "../github/errors.js";
import type {
  AccountActivityQueryResult,
  GraphQLRateLimit,
  HistoricalActivityQueryResult,
} from "../github/graphql.js";
import { mapWithConcurrency } from "../utils/concurrency.js";

export const DEFAULT_GRAPHQL_CONCURRENCY = 4;

export interface ActivityCounts {
  ACTIVE: number;
  NO_RECENT_VISIBLE_ACTIVITY: number;
  INSUFFICIENT_VISIBILITY: number;
  UNKNOWN: number;
}

export interface ActivityAnalysis {
  period: ActivityPeriod;
  followingTotal: number;
  eligibleUsers: number;
  unsupportedAccounts: number;
  results: AccountActivityResult[];
  counts: ActivityCounts;
  coverage: number | null;
  rateLimit?: GraphQLRateLimit;
}

interface WorkResult {
  result: AccountActivityResult;
  rateLimit?: GraphQLRateLimit;
}

export interface ActivityProvider {
  getAccountActivity(
    login: string,
    period: ActivityPeriod,
  ): Promise<AccountActivityQueryResult>;
  getHistoricalActivity(
    login: string,
    period: ActivityPeriod,
  ): Promise<HistoricalActivityQueryResult>;
}

function isGraphQLRateLimit(value: unknown): value is GraphQLRateLimit {
  return (
    typeof value === "object" &&
    value !== null &&
    "cost" in value &&
    Number.isSafeInteger(value.cost) &&
    "limit" in value &&
    Number.isSafeInteger(value.limit) &&
    "remaining" in value &&
    Number.isSafeInteger(value.remaining) &&
    "resetAt" in value &&
    value.resetAt instanceof Date
  );
}

function countStatuses(results: readonly AccountActivityResult[]): ActivityCounts {
  const counts: ActivityCounts = {
    ACTIVE: 0,
    NO_RECENT_VISIBLE_ACTIVITY: 0,
    INSUFFICIENT_VISIBILITY: 0,
    UNKNOWN: 0,
  };

  for (const result of results) {
    counts[result.status] += 1;
  }

  return counts;
}

function selectLatestRateLimit(
  snapshots: readonly (GraphQLRateLimit | undefined)[],
): GraphQLRateLimit | undefined {
  return snapshots
    .filter((value): value is GraphQLRateLimit => value !== undefined)
    .reduce<GraphQLRateLimit | undefined>((selected, current) => {
      if (selected === undefined || current.remaining < selected.remaining) {
        return current;
      }
      return selected;
    }, undefined);
}

export async function analyzeFollowingActivity(
  accounts: readonly FollowedAccount[],
  client: ActivityProvider,
  period: ActivityPeriod,
  concurrency = DEFAULT_GRAPHQL_CONCURRENCY,
): Promise<ActivityAnalysis> {
  const eligibleAccounts = accounts.filter(({ type }) => type === "User");

  const workResults = await mapWithConcurrency(
    eligibleAccounts,
    concurrency,
    async (account): Promise<WorkResult> => {
      try {
        const queryResult = await client.getAccountActivity(account.login, period);
        return {
          result: {
            account,
            activity: queryResult.activity,
            status: classifyActivity(queryResult.activity),
          },
          rateLimit: queryResult.rateLimit,
        };
      } catch (error) {
        if (error instanceof GitHubGraphQLAccountError) {
          const result: AccountActivityResult = {
            account,
            status: "UNKNOWN",
            error: error.message,
          };
          return isGraphQLRateLimit(error.rateLimit)
            ? { result, rateLimit: error.rateLimit }
            : { result };
        }
        throw error;
      }
    },
  );

  const historicalCandidates = workResults.filter(
    ({ result }) => result.status === "NO_RECENT_VISIBLE_ACTIVITY",
  );
  const historicalPeriods = createHistoricalPeriods(period);
  const historicalWorkResults = await mapWithConcurrency(
    historicalCandidates,
    concurrency,
    async ({ result }): Promise<WorkResult> => {
      if (result.activity === undefined) {
        throw new Error("Historical candidate is missing recent activity data.");
      }

      if (!result.activity.hasActivityInThePast) {
        return {
          result: {
            ...result,
            lastVisibleActivityAt: null,
            historicalLookupStatus: "NO_PAST_ACTIVITY",
          },
        };
      }

      let historicalRateLimit: GraphQLRateLimit | undefined;
      try {
        for (const historicalPeriod of historicalPeriods) {
          const queryResult = await client.getHistoricalActivity(
            result.account.login,
            historicalPeriod,
          );
          historicalRateLimit = selectLatestRateLimit([
            historicalRateLimit,
            queryResult.rateLimit,
          ]);
          if (queryResult.lastVisibleActivityAt !== null) {
            const found: WorkResult = {
              result: {
                ...result,
                lastVisibleActivityAt: queryResult.lastVisibleActivityAt,
                historicalLookupStatus: "FOUND",
              },
            };
            if (historicalRateLimit !== undefined) {
              found.rateLimit = historicalRateLimit;
            }
            return found;
          }
        }

        const notFound: WorkResult = {
          result: {
            ...result,
            lastVisibleActivityAt: null,
            historicalLookupStatus: "NOT_FOUND_IN_LOOKBACK",
          },
        };
        if (historicalRateLimit !== undefined) {
          notFound.rateLimit = historicalRateLimit;
        }
        return notFound;
      } catch (error) {
        if (error instanceof GitHubGraphQLAccountError) {
          const historicalResult: WorkResult = {
            result: {
              ...result,
              lastVisibleActivityAt: null,
              historicalLookupStatus: "FAILED",
              historicalLookupError: error.message,
            },
          };
          historicalRateLimit = selectLatestRateLimit([
            historicalRateLimit,
            isGraphQLRateLimit(error.rateLimit) ? error.rateLimit : undefined,
          ]);
          if (historicalRateLimit !== undefined) {
            historicalResult.rateLimit = historicalRateLimit;
          }
          return historicalResult;
        }
        throw error;
      }
    },
  );

  const historicalByAccountId = new Map(
    historicalWorkResults.map((item) => [item.result.account.id, item]),
  );
  const completedWorkResults = workResults.map(
    (item) => historicalByAccountId.get(item.result.account.id) ?? item,
  );

  const results = completedWorkResults.map(({ result }) => result);
  const analysis: ActivityAnalysis = {
    period,
    followingTotal: accounts.length,
    eligibleUsers: eligibleAccounts.length,
    unsupportedAccounts: accounts.length - eligibleAccounts.length,
    results,
    counts: countStatuses(results),
    coverage: calculateCoverage(results, eligibleAccounts.length),
  };
  const rateLimit = selectLatestRateLimit(
    [...workResults, ...historicalWorkResults].map((result) => result.rateLimit),
  );
  if (rateLimit !== undefined) analysis.rateLimit = rateLimit;

  return analysis;
}

export function isEvaluableStatus(status: ActivityStatus): boolean {
  return status === "ACTIVE" || status === "NO_RECENT_VISIBLE_ACTIVITY";
}
