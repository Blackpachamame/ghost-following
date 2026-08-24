import {
  calculateCoverage,
  classifyActivity,
  createHistoricalPeriods,
  type AccountActivityResult,
  type ActivityPeriod,
  type ActivityStatus,
} from "../domain/activity.js";
import type { FollowedAccount } from "../domain/account.js";
import type {
  BatchAccountActivityItem,
  BatchAccountActivityQueryResult,
} from "../github/batch-activity.js";
import {
  GitHubGraphQLAccountError,
  GitHubRateLimitError,
} from "../github/errors.js";
import type {
  AccountActivityQueryResult,
  GraphQLRateLimit,
  HistoricalActivityQueryResult,
} from "../github/graphql.js";
import { chunkValues } from "../utils/chunks.js";
import { mapWithConcurrency } from "../utils/concurrency.js";

export const DEFAULT_GRAPHQL_CONCURRENCY = 4;
export const ACTIVITY_BATCH_SIZE = 25;

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
  getAccountActivity?(
    login: string,
    period: ActivityPeriod,
  ): Promise<AccountActivityQueryResult>;
  getAccountActivities?(
    logins: readonly string[],
    period: ActivityPeriod,
  ): Promise<BatchAccountActivityQueryResult>;
  getHistoricalActivity(
    login: string,
    period: ActivityPeriod,
  ): Promise<HistoricalActivityQueryResult>;
}

export interface ActivityAnalysisOptions {
  concurrency?: number;
  initialRateLimit?: GraphQLRateLimit;
  completedRecentActivity?: readonly AccountActivityResult[];
  completedHistoricalActivity?: readonly AccountActivityResult[];
  onRecentBatchCompleted?(
    results: readonly AccountActivityResult[],
    completed: number,
    total: number,
    rateLimit: GraphQLRateLimit | undefined,
  ): Promise<void> | void;
  onHistoricalAccountCompleted?(
    result: AccountActivityResult,
    completed: number,
    total: number,
    rateLimit: GraphQLRateLimit | undefined,
  ): Promise<void> | void;
}

function loginKey(login: string): string {
  return login.toLocaleLowerCase("en-US");
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
  for (const result of results) counts[result.status] += 1;
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

function ensureQuota(rateLimit: GraphQLRateLimit | undefined): void {
  if (rateLimit?.remaining === 0) {
    throw new GitHubRateLimitError(rateLimit, 200);
  }
}

function rebindResult(
  saved: AccountActivityResult,
  account: FollowedAccount,
): AccountActivityResult {
  return { ...saved, account };
}

function mapSavedResults(
  saved: readonly AccountActivityResult[] | undefined,
  accounts: readonly FollowedAccount[],
): Map<string, AccountActivityResult> {
  const currentByLogin = new Map(
    accounts.map((account) => [loginKey(account.login), account]),
  );
  const result = new Map<string, AccountActivityResult>();
  for (const item of saved ?? []) {
    const account = currentByLogin.get(loginKey(item.account.login));
    if (account !== undefined) {
      result.set(loginKey(account.login), rebindResult(item, account));
    }
  }
  return result;
}

function successfulWorkResult(
  account: FollowedAccount,
  item: Extract<BatchAccountActivityItem, { status: "SUCCESS" }>,
  rateLimit: GraphQLRateLimit | undefined,
): WorkResult {
  const work: WorkResult = {
    result: {
      account,
      activity: item.activity,
      status: classifyActivity(item.activity),
    },
  };
  if (rateLimit !== undefined) work.rateLimit = rateLimit;
  return work;
}

function unknownWorkResult(
  account: FollowedAccount,
  error: string,
  rateLimit: GraphQLRateLimit | undefined,
): WorkResult {
  const work: WorkResult = {
    result: { account, status: "UNKNOWN", error },
  };
  if (rateLimit !== undefined) work.rateLimit = rateLimit;
  return work;
}

async function resolveBatchWithFallback(
  accounts: readonly FollowedAccount[],
  client: ActivityProvider,
  period: ActivityPeriod,
  observedRateLimit: GraphQLRateLimit | undefined,
): Promise<{ work: WorkResult[]; rateLimit?: GraphQLRateLimit }> {
  ensureQuota(observedRateLimit);

  if (client.getAccountActivities === undefined) {
    if (client.getAccountActivity === undefined) {
      throw new Error("Activity provider does not support recent activity queries.");
    }
    const work = await mapWithConcurrency(
      accounts,
      DEFAULT_GRAPHQL_CONCURRENCY,
      async (account): Promise<WorkResult> => {
        try {
          const queryResult = await client.getAccountActivity!(
            account.login,
            period,
          );
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
            return unknownWorkResult(
              account,
              error.message,
              isGraphQLRateLimit(error.rateLimit)
                ? error.rateLimit
                : undefined,
            );
          }
          throw error;
        }
      },
    );
    const rateLimit = selectLatestRateLimit([
      observedRateLimit,
      ...work.map((item) => item.rateLimit),
    ]);
    return rateLimit === undefined ? { work } : { work, rateLimit };
  }

  const response = await client.getAccountActivities(
    accounts.map(({ login }) => login),
    period,
  );
  const rateLimit = selectLatestRateLimit([
    observedRateLimit,
    response.rateLimit,
  ]);
  const accountByLogin = new Map(
    accounts.map((account) => [loginKey(account.login), account]),
  );
  const work: WorkResult[] = [];
  const resourceFailures: FollowedAccount[] = [];

  for (const item of response.items) {
    const account = accountByLogin.get(loginKey(item.login));
    if (account === undefined) {
      throw new Error("Batch response contained an unexpected account.");
    }
    if (item.status === "SUCCESS") {
      work.push(successfulWorkResult(account, item, rateLimit));
    } else if (item.status === "RESOURCE_LIMIT") {
      resourceFailures.push(account);
    } else {
      work.push(unknownWorkResult(account, item.error, rateLimit));
    }
  }

  if (resourceFailures.length === 0) {
    return rateLimit === undefined ? { work } : { work, rateLimit };
  }
  if (accounts.length === 1 && resourceFailures.length === 1) {
    work.push(
      unknownWorkResult(
        resourceFailures[0]!,
        "Resource limits for this query exceeded.",
        rateLimit,
      ),
    );
    return rateLimit === undefined ? { work } : { work, rateLimit };
  }

  if (resourceFailures.length === 1) {
    const resolved = await resolveBatchWithFallback(
      resourceFailures,
      client,
      period,
      rateLimit,
    );
    work.push(...resolved.work);
    const fallbackRateLimit = selectLatestRateLimit([
      rateLimit,
      resolved.rateLimit,
    ]);
    return fallbackRateLimit === undefined
      ? { work }
      : { work, rateLimit: fallbackRateLimit };
  }

  const midpoint = Math.floor(resourceFailures.length / 2);
  const groups = [
    resourceFailures.slice(0, midpoint),
    resourceFailures.slice(midpoint),
  ];
  let fallbackRateLimit = rateLimit;
  for (const group of groups) {
    const resolved = await resolveBatchWithFallback(
      group,
      client,
      period,
      fallbackRateLimit,
    );
    work.push(...resolved.work);
    fallbackRateLimit = selectLatestRateLimit([
      fallbackRateLimit,
      resolved.rateLimit,
    ]);
  }
  return fallbackRateLimit === undefined
    ? { work }
    : { work, rateLimit: fallbackRateLimit };
}

async function completeHistoricalResult(
  recent: AccountActivityResult,
  client: ActivityProvider,
  historicalPeriods: readonly ActivityPeriod[],
  observedRateLimit: GraphQLRateLimit | undefined,
): Promise<WorkResult> {
  if (recent.activity === undefined) {
    throw new Error("Historical candidate is missing recent activity data.");
  }
  if (!recent.activity.hasActivityInThePast) {
    return {
      result: {
        ...recent,
        lastVisibleActivityAt: null,
        historicalLookupStatus: "NO_PAST_ACTIVITY",
      },
    };
  }

  let historicalRateLimit = observedRateLimit;
  try {
    for (const historicalPeriod of historicalPeriods) {
      ensureQuota(historicalRateLimit);
      const queryResult = await client.getHistoricalActivity(
        recent.account.login,
        historicalPeriod,
      );
      historicalRateLimit = selectLatestRateLimit([
        historicalRateLimit,
        queryResult.rateLimit,
      ]);
      if (queryResult.lastVisibleActivityAt !== null) {
        const found: WorkResult = {
          result: {
            ...recent,
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
        ...recent,
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
      const rateLimit = selectLatestRateLimit([
        historicalRateLimit,
        isGraphQLRateLimit(error.rateLimit) ? error.rateLimit : undefined,
      ]);
      const work: WorkResult = {
        result: {
          ...recent,
          lastVisibleActivityAt: null,
          historicalLookupStatus: "FAILED",
          historicalLookupError: error.message,
        },
      };
      if (rateLimit !== undefined) work.rateLimit = rateLimit;
      return work;
    }
    throw error;
  }
}

export async function analyzeFollowingActivity(
  accounts: readonly FollowedAccount[],
  client: ActivityProvider,
  period: ActivityPeriod,
  optionsOrConcurrency: ActivityAnalysisOptions | number = {},
): Promise<ActivityAnalysis> {
  const options: ActivityAnalysisOptions =
    typeof optionsOrConcurrency === "number"
      ? { concurrency: optionsOrConcurrency }
      : optionsOrConcurrency;
  const concurrency = options.concurrency ?? DEFAULT_GRAPHQL_CONCURRENCY;
  const eligibleAccounts = accounts.filter(({ type }) => type === "User");
  const recentByLogin = mapSavedResults(
    options.completedRecentActivity,
    eligibleAccounts,
  );
  let latestRateLimit = options.initialRateLimit;
  let recentCompleted = recentByLogin.size;
  const pendingRecent = eligibleAccounts.filter(
    ({ login }) => !recentByLogin.has(loginKey(login)),
  );

  for (const batch of chunkValues(pendingRecent, ACTIVITY_BATCH_SIZE)) {
    const resolved = await resolveBatchWithFallback(
      batch,
      client,
      period,
      latestRateLimit,
    );
    latestRateLimit = selectLatestRateLimit([
      latestRateLimit,
      resolved.rateLimit,
    ]);
    for (const item of resolved.work) {
      recentByLogin.set(loginKey(item.result.account.login), item.result);
    }
    recentCompleted += batch.length;
    await options.onRecentBatchCompleted?.(
      resolved.work.map(({ result }) => result),
      recentCompleted,
      eligibleAccounts.length,
      latestRateLimit,
    );
  }

  const recentResults = eligibleAccounts.map((account) => {
    const result = recentByLogin.get(loginKey(account.login));
    if (result === undefined) {
      throw new Error("Recent activity analysis is incomplete.");
    }
    return rebindResult(result, account);
  });
  const historicalCandidates = recentResults.filter(
    ({ status }) => status === "NO_RECENT_VISIBLE_ACTIVITY",
  );
  const historicalByLogin = mapSavedResults(
    options.completedHistoricalActivity,
    eligibleAccounts,
  );
  const pendingHistorical = historicalCandidates.filter(
    ({ account }) => !historicalByLogin.has(loginKey(account.login)),
  );
  const historicalPeriods = createHistoricalPeriods(period);
  let historicalCompleted = historicalCandidates.length - pendingHistorical.length;

  const historicalWorkResults = await mapWithConcurrency(
    pendingHistorical,
    concurrency,
    async (recent): Promise<WorkResult> => {
      const work = await completeHistoricalResult(
        recent,
        client,
        historicalPeriods,
        latestRateLimit,
      );
      latestRateLimit = selectLatestRateLimit([
        latestRateLimit,
        work.rateLimit,
      ]);
      historicalByLogin.set(loginKey(recent.account.login), work.result);
      historicalCompleted += 1;
      await options.onHistoricalAccountCompleted?.(
        work.result,
        historicalCompleted,
        historicalCandidates.length,
        latestRateLimit,
      );
      return work;
    },
  );
  latestRateLimit = selectLatestRateLimit([
    latestRateLimit,
    ...historicalWorkResults.map(({ rateLimit }) => rateLimit),
  ]);

  const results = recentResults.map((recent) => {
    if (recent.status !== "NO_RECENT_VISIBLE_ACTIVITY") return recent;
    return (
      historicalByLogin.get(loginKey(recent.account.login)) ??
      recent
    );
  });
  const analysis: ActivityAnalysis = {
    period,
    followingTotal: accounts.length,
    eligibleUsers: eligibleAccounts.length,
    unsupportedAccounts: accounts.length - eligibleAccounts.length,
    results,
    counts: countStatuses(results),
    coverage: calculateCoverage(results, eligibleAccounts.length),
  };
  if (latestRateLimit !== undefined) analysis.rateLimit = latestRateLimit;
  return analysis;
}

export function isEvaluableStatus(status: ActivityStatus): boolean {
  return status === "ACTIVE" || status === "NO_RECENT_VISIBLE_ACTIVITY";
}
