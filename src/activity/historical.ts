import {
  createHistoricalPeriods,
  MAX_HISTORICAL_LOOKBACK_YEARS,
  type ActivityPeriod,
  type ActivityStatus,
  type HistoricalLookupStatus,
} from "../domain/activity.js";
import {
  GitHubGraphQLAccountError,
  GitHubRateLimitError,
} from "../github/errors.js";
import type {
  GraphQLRateLimit,
  HistoricalActivityQueryResult,
} from "../github/graphql.js";
import { mapWithConcurrency } from "../utils/concurrency.js";

export const DEFAULT_HISTORICAL_CONCURRENCY = 4;

export interface HistoricalCandidate {
  account: { login: string };
  status: ActivityStatus;
}

export type HistoricalResult<T extends HistoricalCandidate> = T & {
  lastVisibleActivityAt?: string | null;
  historicalLookupStatus?: HistoricalLookupStatus;
  historicalLookupError?: string;
};

export interface HistoricalActivityProvider {
  getHistoricalActivity(
    login: string,
    period: ActivityPeriod,
  ): Promise<HistoricalActivityQueryResult>;
}

export interface HistoricalActivityOptions<T extends HistoricalCandidate> {
  historyYears: number;
  concurrency?: number;
  initialRateLimit?: GraphQLRateLimit;
  completedHistoricalActivity?: readonly HistoricalResult<T>[];
  onHistoricalAccountCompleted?(
    result: HistoricalResult<T>,
    completed: number,
    total: number,
    rateLimit: GraphQLRateLimit | undefined,
  ): Promise<void> | void;
}

interface HistoricalWorkResult<T extends HistoricalCandidate> {
  result: HistoricalResult<T>;
  rateLimit?: GraphQLRateLimit;
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

async function completeHistoricalResult<T extends HistoricalCandidate>(
  recent: T,
  client: HistoricalActivityProvider,
  historicalPeriods: readonly ActivityPeriod[],
  observedRateLimit: GraphQLRateLimit | undefined,
): Promise<HistoricalWorkResult<T>> {
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
        const found: HistoricalWorkResult<T> = {
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
    const notFound: HistoricalWorkResult<T> = {
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
      const work: HistoricalWorkResult<T> = {
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

export async function enrichHistoricalActivity<T extends HistoricalCandidate>(
  recentResults: readonly T[],
  client: HistoricalActivityProvider,
  period: ActivityPeriod,
  options: HistoricalActivityOptions<T>,
): Promise<{ results: HistoricalResult<T>[]; rateLimit?: GraphQLRateLimit }> {
  const { historyYears } = options;
  if (
    !Number.isSafeInteger(historyYears) ||
    historyYears < 0 ||
    historyYears > MAX_HISTORICAL_LOOKBACK_YEARS
  ) {
    throw new RangeError(
      "Historical year count must be an integer from 0 to " +
        MAX_HISTORICAL_LOOKBACK_YEARS + ".",
    );
  }

  let latestRateLimit = options.initialRateLimit;
  if (historyYears === 0) {
    const results = recentResults.map((recent) =>
      recent.status === "NO_RECENT_VISIBLE_ACTIVITY"
        ? {
            ...recent,
            lastVisibleActivityAt: null,
            historicalLookupStatus: "NOT_REQUESTED" as const,
          }
        : recent,
    );
    return latestRateLimit === undefined
      ? { results }
      : { results, rateLimit: latestRateLimit };
  }

  const historicalCandidates = recentResults.filter(
    ({ status }) => status === "NO_RECENT_VISIBLE_ACTIVITY",
  );
  const currentByLogin = new Map(
    historicalCandidates.map((result) => [loginKey(result.account.login), result]),
  );
  const historicalByLogin = new Map<string, HistoricalResult<T>>();
  for (const saved of options.completedHistoricalActivity ?? []) {
    const current = currentByLogin.get(loginKey(saved.account.login));
    if (current !== undefined) {
      historicalByLogin.set(loginKey(current.account.login), {
        ...saved,
        account: current.account,
      });
    }
  }
  for (const [key, result] of historicalByLogin) {
    if (
      result.historicalLookupStatus !== "FOUND" &&
      result.historicalLookupStatus !== "NOT_FOUND_IN_LOOKBACK" &&
      result.historicalLookupStatus !== "FAILED"
    ) {
      historicalByLogin.delete(key);
    }
  }
  const pendingHistorical = historicalCandidates.filter(
    ({ account }) => !historicalByLogin.has(loginKey(account.login)),
  );
  const historicalPeriods = createHistoricalPeriods(period, historyYears);
  let historicalCompleted = historicalCandidates.length - pendingHistorical.length;
  const startedWork: Promise<HistoricalWorkResult<T>>[] = [];
  let historicalWorkResults: HistoricalWorkResult<T>[];
  try {
    historicalWorkResults = await mapWithConcurrency(
      pendingHistorical,
      options.concurrency ?? DEFAULT_HISTORICAL_CONCURRENCY,
      (recent) => {
        const job = (async (): Promise<HistoricalWorkResult<T>> => {
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
        })();
        startedWork.push(job);
        return job;
      },
    );
  } catch (error) {
    // Let already started accounts persist their results before the caller
    // flushes its checkpoint and reports an interruption.
    await Promise.allSettled(startedWork);
    throw error;
  }
  latestRateLimit = selectLatestRateLimit([
    latestRateLimit,
    ...historicalWorkResults.map(({ rateLimit }) => rateLimit),
  ]);

  const results = recentResults.map((recent) => {
    if (recent.status !== "NO_RECENT_VISIBLE_ACTIVITY") return recent;
    return historicalByLogin.get(loginKey(recent.account.login)) ?? recent;
  });
  return latestRateLimit === undefined
    ? { results }
    : { results, rateLimit: latestRateLimit };
}
