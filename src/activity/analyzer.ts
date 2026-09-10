import {
  calculateCoverage,
  classifyActivity,
  MAX_HISTORICAL_LOOKBACK_YEARS,
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
  GitHubHttpError,
  GitHubRateLimitError,
} from "../github/errors.js";
import {
  defaultSleep,
  TRANSIENT_HTTP_STATUSES,
  TRANSIENT_MAX_ATTEMPTS,
  type Sleep,
} from "../github/retry.js";
import type {
  AccountActivityQueryResult,
  GraphQLRateLimit,
  HistoricalActivityQueryResult,
} from "../github/graphql.js";
import { chunkValues } from "../utils/chunks.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { enrichHistoricalActivity } from "./historical.js";

export const DEFAULT_GRAPHQL_CONCURRENCY = 4;
export const ACTIVITY_BATCH_SIZE = 12;
export const RECENT_BATCH_PACING_MS = 1_000;

export interface RecentBatchHttpFailure {
  logins: readonly string[];
  period: ActivityPeriod;
  httpStatus: number;
  attempts: number;
}

export interface ActivityCounts {
  ACTIVE: number;
  NO_RECENT_VISIBLE_ACTIVITY: number;
  INSUFFICIENT_VISIBILITY: number;
  UNKNOWN: number;
}

export interface ActivityAnalysis {
  period: ActivityPeriod;
  historyYears: number;
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
  historyYears?: number;
  sleep?: Sleep;
  initialRateLimit?: GraphQLRateLimit;
  completedRecentActivity?: readonly AccountActivityResult[];
  completedHistoricalActivity?: readonly AccountActivityResult[];
  onRecentBatchCompleted?(
    results: readonly AccountActivityResult[],
    completed: number,
    total: number,
    rateLimit: GraphQLRateLimit | undefined,
  ): Promise<void> | void;
  onRecentBatchFailed?(
    failure: RecentBatchHttpFailure,
  ): Promise<void> | void;
  onRecentBatchFailureReportingError?(error: unknown): void;
  onHistoricalAccountCompleted?(
    result: AccountActivityResult,
    completed: number,
    total: number,
    rateLimit: GraphQLRateLimit | undefined,
  ): Promise<void> | void;
}

type RecentBatchFailureHooks = Pick<
  ActivityAnalysisOptions,
  "onRecentBatchFailed" | "onRecentBatchFailureReportingError"
>;

type RecentWorkResolved = (
  work: readonly WorkResult[],
  rateLimit: GraphQLRateLimit | undefined,
) => Promise<void>;

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
  failureHooks: RecentBatchFailureHooks,
  onWorkResolved: RecentWorkResolved,
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
    await onWorkResolved(work, rateLimit);
    return rateLimit === undefined ? { work } : { work, rateLimit };
  }

  let response: BatchAccountActivityQueryResult;
  try {
    response = await client.getAccountActivities(
      accounts.map(({ login }) => login),
      period,
    );
  } catch (error) {
    if (
      error instanceof GitHubHttpError &&
      TRANSIENT_HTTP_STATUSES.has(error.status) &&
      error.attempts === TRANSIENT_MAX_ATTEMPTS
    ) {
      const failure: RecentBatchHttpFailure = {
        logins: accounts.map(({ login }) => login),
        period: { ...period },
        httpStatus: error.status,
        attempts: error.attempts,
      };
      try {
        await failureHooks.onRecentBatchFailed?.(failure);
      } catch (reportingError) {
        try {
          failureHooks.onRecentBatchFailureReportingError?.(reportingError);
        } catch {
          // Reporting must never change handling of the exhausted HTTP request.
        }
      }
      if (error.status === 502 || error.status === 504) {
        if (accounts.length === 1) {
          const work = [
            unknownWorkResult(
              accounts[0]!,
              `Recent activity could not be evaluated after HTTP ${error.status} exhausted ${error.attempts} attempts.`,
              observedRateLimit,
            ),
          ];
          await onWorkResolved(work, observedRateLimit);
          return observedRateLimit === undefined
            ? { work }
            : { work, rateLimit: observedRateLimit };
        }

        const midpoint = Math.floor(accounts.length / 2);
        const groups = [
          accounts.slice(0, midpoint),
          accounts.slice(midpoint),
        ];
        const work: WorkResult[] = [];
        let fallbackRateLimit = observedRateLimit;
        for (const group of groups) {
          const resolved = await resolveBatchWithFallback(
            group,
            client,
            period,
            fallbackRateLimit,
            failureHooks,
            onWorkResolved,
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
    }
    throw error;
  }
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

  if (work.length > 0) {
    await onWorkResolved(work, rateLimit);
  }

  if (resourceFailures.length === 0) {
    return rateLimit === undefined ? { work } : { work, rateLimit };
  }
  if (accounts.length === 1 && resourceFailures.length === 1) {
    const singletonWork = unknownWorkResult(
      resourceFailures[0]!,
      "Resource limits for this query exceeded.",
      rateLimit,
    );
    work.push(singletonWork);
    await onWorkResolved([singletonWork], rateLimit);
    return rateLimit === undefined ? { work } : { work, rateLimit };
  }

  if (resourceFailures.length === 1) {
    const resolved = await resolveBatchWithFallback(
      resourceFailures,
      client,
      period,
      rateLimit,
      failureHooks,
      onWorkResolved,
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
      failureHooks,
      onWorkResolved,
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
  const historyYears = options.historyYears ?? 0;
  const sleep = options.sleep ?? defaultSleep;
  if (
    !Number.isSafeInteger(historyYears) ||
    historyYears < 0 ||
    historyYears > MAX_HISTORICAL_LOOKBACK_YEARS
  ) {
    throw new RangeError(
      `Historical year count must be an integer from 0 to ${MAX_HISTORICAL_LOOKBACK_YEARS}.`,
    );
  }
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

  const completeRecentWork: RecentWorkResolved = async (work, rateLimit) => {
    if (work.length === 0) return;
    latestRateLimit = selectLatestRateLimit([latestRateLimit, rateLimit]);
    const results = work.map(({ result }) => result);
    for (const result of results) {
      const key = loginKey(result.account.login);
      if (recentByLogin.has(key)) {
        throw new Error("Recent activity result was resolved more than once.");
      }
      recentByLogin.set(key, result);
    }
    recentCompleted += results.length;
    await options.onRecentBatchCompleted?.(
      results,
      recentCompleted,
      eligibleAccounts.length,
      latestRateLimit,
    );
  };

  const recentBatches = chunkValues(pendingRecent, ACTIVITY_BATCH_SIZE);
  for (const [index, batch] of recentBatches.entries()) {
    const resolved = await resolveBatchWithFallback(
      batch,
      client,
      period,
      latestRateLimit,
      options,
      completeRecentWork,
    );
    latestRateLimit = selectLatestRateLimit([
      latestRateLimit,
      resolved.rateLimit,
    ]);
    if (index < recentBatches.length - 1) {
      ensureQuota(latestRateLimit);
      await sleep(RECENT_BATCH_PACING_MS);
    }
  }

  const recentResults = eligibleAccounts.map((account) => {
    const result = recentByLogin.get(loginKey(account.login));
    if (result === undefined) {
      throw new Error("Recent activity analysis is incomplete.");
    }
    return rebindResult(result, account);
  });
  const historical = await enrichHistoricalActivity(recentResults, client, period, {
    historyYears,
    concurrency,
    ...(latestRateLimit === undefined ? {} : { initialRateLimit: latestRateLimit }),
    ...(options.completedHistoricalActivity === undefined
      ? {}
      : { completedHistoricalActivity: options.completedHistoricalActivity }),
    ...(options.onHistoricalAccountCompleted === undefined
      ? {}
      : { onHistoricalAccountCompleted: options.onHistoricalAccountCompleted }),
  });
  const { results } = historical;
  latestRateLimit = historical.rateLimit;
  const analysis: ActivityAnalysis = {
    period,
    historyYears,
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
