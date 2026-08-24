import type { AccountActivity, ActivityPeriod } from "../domain/activity.js";
import {
  buildAccountActivityBatchQuery,
  parseAccountActivityBatchResponse,
  type BatchAccountActivityQueryResult,
} from "./batch-activity.js";
import { readApiMessage, readRateLimit } from "./client.js";
import {
  GitHubAuthenticationError,
  GitHubGraphQLAccountError,
  GitHubGraphQLFatalError,
  GitHubHttpError,
  GitHubNetworkError,
  GitHubRateLimitError,
  type RateLimitDetails,
} from "./errors.js";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

export const ACCOUNT_ACTIVITY_QUERY = `
  query AccountActivity($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      login
      contributionsCollection(from: $from, to: $to) {
        startedAt
        endedAt
        hasAnyContributions
        hasAnyRestrictedContributions
        hasActivityInThePast
        restrictedContributionsCount
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        contributionCalendar {
          totalContributions
        }
      }
    }
    rateLimit {
      cost
      limit
      remaining
      resetAt
    }
  }
`;

export const HISTORICAL_ACTIVITY_QUERY = `
  query HistoricalActivity($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      login
      contributionsCollection(from: $from, to: $to) {
        startedAt
        endedAt
        hasAnyContributions
        hasAnyRestrictedContributions
        restrictedContributionsCount
        latestRestrictedContributionDate
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
        }
      }
    }
    rateLimit {
      cost
      limit
      remaining
      resetAt
    }
  }
`;

export interface GraphQLRateLimit {
  cost: number;
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface AccountActivityQueryResult {
  activity: AccountActivity;
  rateLimit: GraphQLRateLimit;
}

export interface HistoricalActivityQueryResult {
  lastVisibleActivityAt: string | null;
  rateLimit: GraphQLRateLimit;
}

export interface GitHubGraphQLClientOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${key} is not a non-negative integer.`);
  }
  return value as number;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new TypeError(`${key} is not a boolean.`);
  }
  return value;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} is not a non-empty string.`);
  }
  return value;
}

function readDate(value: unknown, key: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${key} is not a date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${key} is not a valid date.`);
  }
  return value;
}

function parseRateLimit(value: unknown): GraphQLRateLimit {
  if (!isRecord(value) || typeof value.resetAt !== "string") {
    throw new TypeError("rateLimit is incomplete.");
  }

  const resetAt = new Date(value.resetAt);
  if (Number.isNaN(resetAt.getTime())) {
    throw new TypeError("rateLimit.resetAt is invalid.");
  }

  return {
    cost: readNonNegativeInteger(value, "cost"),
    limit: readNonNegativeInteger(value, "limit"),
    remaining: readNonNegativeInteger(value, "remaining"),
    resetAt,
  };
}

function tryParseRateLimit(value: unknown): GraphQLRateLimit | undefined {
  try {
    return parseRateLimit(value);
  } catch {
    return undefined;
  }
}

interface ParsedGraphQLError {
  message: string;
  path?: readonly unknown[];
}

function parseErrors(value: unknown): ParsedGraphQLError[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  return value.map((item) => {
    if (!isRecord(item) || typeof item.message !== "string") {
      throw new GitHubGraphQLFatalError(
        "GitHub GraphQL returned an invalid errors array.",
      );
    }
    return Array.isArray(item.path)
      ? { message: item.message, path: item.path }
      : { message: item.message };
  });
}

function toRateLimitDetails(
  rateLimit: GraphQLRateLimit | undefined,
): (RateLimitDetails & { cost?: number }) | undefined {
  if (rateLimit === undefined) return undefined;
  return rateLimit;
}

export function parseAccountActivityResponse(
  payload: unknown,
  requestedLogin: string,
  period: ActivityPeriod,
): AccountActivityQueryResult {
  if (!isRecord(payload)) {
    throw new GitHubGraphQLFatalError(
      "GitHub GraphQL returned a non-object response.",
    );
  }

  const data = isRecord(payload.data) ? payload.data : undefined;
  const rateLimit = tryParseRateLimit(data?.rateLimit);
  const errors = parseErrors(payload.errors);
  const combinedErrorMessage = errors.map(({ message }) => message).join("; ");

  if (errors.some(({ message }) => /rate.?limit/i.test(message))) {
    throw new GitHubRateLimitError(rateLimit ?? {}, 200);
  }

  if (
    errors.some(({ message }) =>
      /(bad credentials|requires authentication|not authenticated|resource not accessible|insufficient.*(?:scope|permission))/i.test(
        message,
      ),
    )
  ) {
    throw new GitHubAuthenticationError(
      `GitHub GraphQL authentication failed: ${combinedErrorMessage}`,
    );
  }

  if (errors.length > 0) {
    const accountSpecific = errors.every(
      ({ path }) => path?.[0] === "user",
    );
    const message = combinedErrorMessage;

    if (accountSpecific || data?.user === null) {
      throw new GitHubGraphQLAccountError(
        `Could not evaluate ${JSON.stringify(requestedLogin)}: ${message}`,
        toRateLimitDetails(rateLimit),
      );
    }

    throw new GitHubGraphQLFatalError(`GitHub GraphQL query failed: ${message}`);
  }

  if (data === undefined) {
    throw new GitHubGraphQLFatalError("GitHub GraphQL response is missing data.");
  }

  if (data.user === null) {
    throw new GitHubGraphQLAccountError(
      `GitHub GraphQL could not resolve user ${JSON.stringify(requestedLogin)}.`,
      toRateLimitDetails(rateLimit),
    );
  }

  if (!isRecord(data.user)) {
    throw new GitHubGraphQLAccountError(
      `GitHub GraphQL returned incomplete user data for ${JSON.stringify(requestedLogin)}.`,
      toRateLimitDetails(rateLimit),
    );
  }

  if (rateLimit === undefined) {
    throw new GitHubGraphQLFatalError(
      "GitHub GraphQL response is missing valid rate limit data.",
    );
  }

  const user = data.user;
  const collection = user.contributionsCollection;
  if (
    typeof user.login !== "string" ||
    !isRecord(collection) ||
    !isRecord(collection.contributionCalendar)
  ) {
    throw new GitHubGraphQLAccountError(
      `GitHub GraphQL returned incomplete contribution data for ${JSON.stringify(requestedLogin)}.`,
      rateLimit,
    );
  }

  try {
    const activity: AccountActivity = {
      login: user.login,
      periodStart: period.from,
      periodEnd: period.to,
      totalContributions: readNonNegativeInteger(
        collection.contributionCalendar,
        "totalContributions",
      ),
      totalCommitContributions: readNonNegativeInteger(
        collection,
        "totalCommitContributions",
      ),
      totalIssueContributions: readNonNegativeInteger(
        collection,
        "totalIssueContributions",
      ),
      totalPullRequestContributions: readNonNegativeInteger(
        collection,
        "totalPullRequestContributions",
      ),
      totalPullRequestReviewContributions: readNonNegativeInteger(
        collection,
        "totalPullRequestReviewContributions",
      ),
      restrictedContributionsCount: readNonNegativeInteger(
        collection,
        "restrictedContributionsCount",
      ),
      hasAnyContributions: readBoolean(collection, "hasAnyContributions"),
      hasAnyRestrictedContributions: readBoolean(
        collection,
        "hasAnyRestrictedContributions",
      ),
      hasActivityInThePast: readBoolean(collection, "hasActivityInThePast"),
    };

    return { activity, rateLimit };
  } catch (error) {
    throw new GitHubGraphQLAccountError(
      `GitHub GraphQL returned uninterpretable contribution data for ${JSON.stringify(requestedLogin)}.`,
      rateLimit,
      { cause: error },
    );
  }
}

function latestVisibleDateFromCollection(
  value: unknown,
): string | null {
  if (!isRecord(value) || !isRecord(value.contributionCalendar)) {
    throw new TypeError("Historical contributionsCollection is incomplete.");
  }

  readNonEmptyString(value, "startedAt");
  readNonEmptyString(value, "endedAt");
  const hasAnyContributions = readBoolean(value, "hasAnyContributions");
  const hasAnyRestrictedContributions = readBoolean(
    value,
    "hasAnyRestrictedContributions",
  );
  const restrictedContributionsCount = readNonNegativeInteger(
    value,
    "restrictedContributionsCount",
  );
  const totalContributions = readNonNegativeInteger(
    value.contributionCalendar,
    "totalContributions",
  );

  const weeks = value.contributionCalendar.weeks;
  if (!Array.isArray(weeks)) {
    throw new TypeError("contributionCalendar.weeks is not an array.");
  }

  const dates: string[] = [];
  for (const week of weeks) {
    if (!isRecord(week) || !Array.isArray(week.contributionDays)) {
      throw new TypeError("A contribution calendar week is incomplete.");
    }
    for (const day of week.contributionDays) {
      if (!isRecord(day)) {
        throw new TypeError("A contribution calendar day is incomplete.");
      }
      const count = readNonNegativeInteger(day, "contributionCount");
      const date = readDate(day.date, "contributionCalendar.day.date");
      if (count > 0) dates.push(date);
    }
  }

  if (value.latestRestrictedContributionDate !== null) {
    dates.push(
      readDate(
        value.latestRestrictedContributionDate,
        "latestRestrictedContributionDate",
      ),
    );
  }

  const latest = dates.sort((left, right) => right.localeCompare(left))[0] ?? null;
  const hasVisibleActivity =
    hasAnyContributions ||
    hasAnyRestrictedContributions ||
    restrictedContributionsCount > 0 ||
    totalContributions > 0;
  if (hasVisibleActivity && latest === null) {
    throw new TypeError(
      "Historical collection reports activity without an attributable date.",
    );
  }
  return latest;
}

export function parseHistoricalActivityResponse(
  payload: unknown,
  requestedLogin: string,
): HistoricalActivityQueryResult {
  if (!isRecord(payload)) {
    throw new GitHubGraphQLFatalError(
      "GitHub GraphQL returned a non-object response.",
    );
  }

  const data = isRecord(payload.data) ? payload.data : undefined;
  const rateLimit = tryParseRateLimit(data?.rateLimit);
  const errors = parseErrors(payload.errors);
  const combinedErrorMessage = errors.map(({ message }) => message).join("; ");

  if (errors.some(({ message }) => /rate.?limit/i.test(message))) {
    throw new GitHubRateLimitError(rateLimit ?? {}, 200);
  }
  if (
    errors.some(({ message }) =>
      /(bad credentials|requires authentication|not authenticated|resource not accessible|insufficient.*(?:scope|permission))/i.test(
        message,
      ),
    )
  ) {
    throw new GitHubAuthenticationError(
      `GitHub GraphQL authentication failed: ${combinedErrorMessage}`,
    );
  }
  if (errors.length > 0) {
    const accountSpecific = errors.every(({ path }) => path?.[0] === "user");
    if (accountSpecific || data?.user === null) {
      throw new GitHubGraphQLAccountError(
        `Could not retrieve historical activity for ${JSON.stringify(requestedLogin)}: ${combinedErrorMessage}`,
        toRateLimitDetails(rateLimit),
      );
    }
    throw new GitHubGraphQLFatalError(
      `GitHub GraphQL historical query failed: ${combinedErrorMessage}`,
    );
  }
  if (data === undefined) {
    throw new GitHubGraphQLFatalError("GitHub GraphQL response is missing data.");
  }
  if (!isRecord(data.user) || rateLimit === undefined) {
    throw new GitHubGraphQLAccountError(
      `GitHub GraphQL returned incomplete historical data for ${JSON.stringify(requestedLogin)}.`,
      toRateLimitDetails(rateLimit),
    );
  }

  const collection = data.user.contributionsCollection;
  if (
    typeof data.user.login !== "string" ||
    !isRecord(collection)
  ) {
    throw new GitHubGraphQLAccountError(
      `GitHub GraphQL returned incomplete historical data for ${JSON.stringify(requestedLogin)}.`,
      rateLimit,
    );
  }

  try {
    return {
      lastVisibleActivityAt: latestVisibleDateFromCollection(collection),
      rateLimit,
    };
  } catch (error) {
    throw new GitHubGraphQLAccountError(
      `GitHub GraphQL returned uninterpretable historical data for ${JSON.stringify(requestedLogin)}.`,
      rateLimit,
      { cause: error },
    );
  }
}

export class GitHubGraphQLClient {
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GitHubGraphQLClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getAccountActivity(
    login: string,
    period: ActivityPeriod,
  ): Promise<AccountActivityQueryResult> {
    return parseAccountActivityResponse(
      await this.#request(ACCOUNT_ACTIVITY_QUERY, {
        login,
        from: period.from,
        to: period.to,
      }),
      login,
      period,
    );
  }

  async getAccountActivities(
    logins: readonly string[],
    period: ActivityPeriod,
  ): Promise<BatchAccountActivityQueryResult> {
    const built = buildAccountActivityBatchQuery(logins, period);
    return parseAccountActivityBatchResponse(
      await this.#request(built.query, built.variables),
      built,
      period,
    );
  }

  async getHistoricalActivity(
    login: string,
    period: ActivityPeriod,
  ): Promise<HistoricalActivityQueryResult> {
    return parseHistoricalActivityResponse(
      await this.#request(HISTORICAL_ACTIVITY_QUERY, {
        login,
        from: period.from,
        to: period.to,
      }),
      login,
    );
  }

  async #request(
    query: string,
    variables: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          "User-Agent": "github-ghost-following",
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });
    } catch (error) {
      throw new GitHubNetworkError("Could not reach the GitHub GraphQL endpoint.", {
        cause: error,
      });
    }

    const headerRateLimit = readRateLimit(response.headers);

    if (response.status === 401) {
      throw new GitHubAuthenticationError();
    }

    if (
      response.status === 429 ||
      (response.status === 403 &&
        (headerRateLimit.remaining === 0 ||
          headerRateLimit.retryAfterSeconds !== undefined))
    ) {
      throw new GitHubRateLimitError(headerRateLimit, response.status);
    }

    if (response.status === 403) {
      throw new GitHubAuthenticationError(
        "GITHUB_TOKEN is not authorized to access the requested GraphQL data.",
      );
    }

    if (!response.ok) {
      throw new GitHubHttpError(
        response.status,
        response.statusText,
        await readApiMessage(response),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new GitHubGraphQLFatalError(
        "GitHub GraphQL returned a body that is not valid JSON.",
        { cause: error },
      );
    }

    return payload;
  }
}
