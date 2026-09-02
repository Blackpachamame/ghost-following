import type {
  AccountActivity,
  ActivityPeriod,
} from "../domain/activity.js";
import {
  GitHubAuthenticationError,
  GitHubGraphQLFatalError,
  GitHubRateLimitError,
  isRateLimitLikeMessage,
} from "./errors.js";
import type { GraphQLRateLimit } from "./graphql.js";

export interface BatchAlias {
  alias: string;
  login: string;
}

export interface BuiltAccountActivityBatchQuery {
  query: string;
  variables: Record<string, string>;
  aliases: BatchAlias[];
}

export type BatchAccountActivityItem =
  | {
      login: string;
      status: "SUCCESS";
      activity: AccountActivity;
    }
  | {
      login: string;
      status: "ACCOUNT_ERROR" | "RESOURCE_LIMIT";
      error: string;
    };

export interface BatchAccountActivityQueryResult {
  items: BatchAccountActivityItem[];
  rateLimit?: GraphQLRateLimit;
}

interface ParsedGraphQLError {
  message: string;
  path?: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number {
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

function parseRateLimit(value: unknown): GraphQLRateLimit | undefined {
  if (!isRecord(value) || typeof value.resetAt !== "string") return undefined;
  const resetAt = new Date(value.resetAt);
  if (Number.isNaN(resetAt.getTime())) return undefined;
  try {
    return {
      cost: readNonNegativeInteger(value, "cost"),
      limit: readNonNegativeInteger(value, "limit"),
      remaining: readNonNegativeInteger(value, "remaining"),
      resetAt,
    };
  } catch {
    return undefined;
  }
}

function parseErrors(value: unknown): ParsedGraphQLError[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new GitHubGraphQLFatalError(
      "GitHub GraphQL returned an invalid errors array.",
    );
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

export function isResourceLimitMessage(message: string): boolean {
  return (
    /resource limits? for this query exceeded/i.test(message) ||
    /query (?:complexity|cost).*(?:exceed|limit)/i.test(message)
  );
}

function isRateLimitMessage(message: string): boolean {
  return isRateLimitLikeMessage(message) && !isResourceLimitMessage(message);
}

function isAuthenticationMessage(message: string): boolean {
  return /(bad credentials|requires authentication|not authenticated|resource not accessible|insufficient.*(?:scope|permission))/i.test(
    message,
  );
}

function parseActivity(
  value: unknown,
  requestedLogin: string,
  period: ActivityPeriod,
): AccountActivity {
  if (!isRecord(value) || typeof value.login !== "string") {
    throw new TypeError("User data is incomplete.");
  }
  const collection = value.contributionsCollection;
  if (!isRecord(collection) || !isRecord(collection.contributionCalendar)) {
    throw new TypeError("Contribution data is incomplete.");
  }
  return {
    login: value.login,
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
}

export function buildAccountActivityBatchQuery(
  logins: readonly string[],
  period: ActivityPeriod,
): BuiltAccountActivityBatchQuery {
  if (logins.length === 0) {
    throw new RangeError("A batch query requires at least one login.");
  }

  const aliases = logins.map((login, index) => ({ alias: `u${index}`, login }));
  const definitions = aliases.map(
    (_item, index) => `$login${index}: String!`,
  );
  const selections = aliases.map(
    ({ alias }, index) => `
      ${alias}: user(login: $login${index}) {
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
      }`,
  );
  const variables: Record<string, string> = {
    from: period.from,
    to: period.to,
  };
  for (const [index, login] of logins.entries()) {
    variables[`login${index}`] = login;
  }

  return {
    query: `
      query BatchAccountActivity(
        $from: DateTime!
        $to: DateTime!
        ${definitions.join("\n        ")}
      ) {
        ${selections.join("\n")}
        rateLimit {
          cost
          limit
          remaining
          resetAt
        }
      }
    `,
    variables,
    aliases,
  };
}

export function parseAccountActivityBatchResponse(
  payload: unknown,
  built: BuiltAccountActivityBatchQuery,
  period: ActivityPeriod,
): BatchAccountActivityQueryResult {
  if (!isRecord(payload)) {
    throw new GitHubGraphQLFatalError(
      "GitHub GraphQL returned a non-object batch response.",
    );
  }

  const data = isRecord(payload.data) ? payload.data : undefined;
  const rateLimit = parseRateLimit(data?.rateLimit);
  const errors = parseErrors(payload.errors);
  const messages = errors.map(({ message }) => message);

  if (
    errors.length > 0 &&
    (rateLimit?.remaining === 0 || messages.some(isRateLimitMessage))
  ) {
    throw new GitHubRateLimitError(rateLimit ?? {}, 200, messages);
  }
  if (messages.some(isAuthenticationMessage)) {
    throw new GitHubAuthenticationError(
      `GitHub GraphQL authentication failed: ${messages.join("; ")}`,
    );
  }

  const knownAliases = new Set(built.aliases.map(({ alias }) => alias));
  const errorsByAlias = new Map<string, ParsedGraphQLError[]>();
  const globalErrors: ParsedGraphQLError[] = [];
  for (const error of errors) {
    const alias = typeof error.path?.[0] === "string" ? error.path[0] : undefined;
    if (alias !== undefined && knownAliases.has(alias)) {
      const existing = errorsByAlias.get(alias) ?? [];
      existing.push(error);
      errorsByAlias.set(alias, existing);
    } else {
      globalErrors.push(error);
    }
  }

  const nonResourceGlobalErrors = globalErrors.filter(
    ({ message }) => !isResourceLimitMessage(message),
  );
  if (nonResourceGlobalErrors.length > 0) {
    throw new GitHubGraphQLFatalError(
      `GitHub GraphQL batch query failed: ${nonResourceGlobalErrors
        .map(({ message }) => message)
        .join("; ")}`,
    );
  }

  const items = built.aliases.map(({ alias, login }): BatchAccountActivityItem => {
    const aliasErrors = errorsByAlias.get(alias) ?? [];
    if (aliasErrors.length > 0) {
      const message = aliasErrors.map((error) => error.message).join("; ");
      return {
        login,
        status: aliasErrors.every(({ message: item }) =>
          isResourceLimitMessage(item),
        )
          ? "RESOURCE_LIMIT"
          : "ACCOUNT_ERROR",
        error: message,
      };
    }

    const user = data?.[alias];
    try {
      if (user === null || user === undefined) {
        const resourceError = globalErrors.find(({ message }) =>
          isResourceLimitMessage(message),
        );
        if (resourceError !== undefined) {
          return {
            login,
            status: "RESOURCE_LIMIT",
            error: resourceError.message,
          };
        }
        return {
          login,
          status: "ACCOUNT_ERROR",
          error: `GitHub GraphQL could not resolve user ${JSON.stringify(login)}.`,
        };
      }
      return {
        login,
        status: "SUCCESS",
        activity: parseActivity(user, login, period),
      };
    } catch {
      return {
        login,
        status: "ACCOUNT_ERROR",
        error: `GitHub GraphQL returned uninterpretable contribution data for ${JSON.stringify(login)}.`,
      };
    }
  });

  if (
    rateLimit === undefined &&
    items.some(({ status }) => status === "SUCCESS")
  ) {
    throw new GitHubGraphQLFatalError(
      "GitHub GraphQL batch response is missing valid rate limit data.",
    );
  }

  return rateLimit === undefined ? { items } : { items, rateLimit };
}
