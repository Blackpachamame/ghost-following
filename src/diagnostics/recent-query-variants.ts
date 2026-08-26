import {
  classifyActivity,
  type AccountActivity,
  type ActivityPeriod,
  type ActivityStatus,
} from "../domain/activity.js";
import {
  buildAccountActivityBatchQuery,
  isResourceLimitMessage,
  parseAccountActivityBatchResponse,
  type BuiltAccountActivityBatchQuery,
} from "../github/batch-activity.js";
import {
  GitHubAuthenticationError,
  GitHubGraphQLFatalError,
  GitHubRateLimitError,
} from "../github/errors.js";

export const RECENT_QUERY_VARIANTS = [
  "CURRENT",
  "CLASSIFIER_MINIMAL",
  "NUMERIC_MINIMAL",
] as const;
export type RecentQueryVariant = (typeof RECENT_QUERY_VARIANTS)[number];

export const CURRENT_FIELDS = [
  "login",
  "contributionsCollection.startedAt",
  "contributionsCollection.endedAt",
  "contributionsCollection.hasAnyContributions",
  "contributionsCollection.hasAnyRestrictedContributions",
  "contributionsCollection.hasActivityInThePast",
  "contributionsCollection.restrictedContributionsCount",
  "contributionsCollection.totalCommitContributions",
  "contributionsCollection.totalIssueContributions",
  "contributionsCollection.totalPullRequestContributions",
  "contributionsCollection.totalPullRequestReviewContributions",
  "contributionsCollection.contributionCalendar.totalContributions",
  "rateLimit.cost",
  "rateLimit.limit",
  "rateLimit.remaining",
  "rateLimit.resetAt",
] as const;

export const CLASSIFIER_MINIMAL_FIELDS = [
  "login",
  "contributionsCollection.hasAnyContributions",
  "contributionsCollection.hasAnyRestrictedContributions",
  "rateLimit.cost",
  "rateLimit.limit",
  "rateLimit.remaining",
  "rateLimit.resetAt",
] as const;

export const NUMERIC_MINIMAL_FIELDS = [
  "login",
  "contributionsCollection.hasAnyContributions",
  "contributionsCollection.hasAnyRestrictedContributions",
  "contributionsCollection.restrictedContributionsCount",
  "contributionsCollection.totalCommitContributions",
  "contributionsCollection.totalIssueContributions",
  "contributionsCollection.totalPullRequestContributions",
  "contributionsCollection.totalPullRequestReviewContributions",
  "contributionsCollection.contributionCalendar.totalContributions",
  "rateLimit.cost",
  "rateLimit.limit",
  "rateLimit.remaining",
  "rateLimit.resetAt",
] as const;

export interface BuiltRecentQueryVariant extends BuiltAccountActivityBatchQuery {
  variant: RecentQueryVariant;
  fields: readonly string[];
}

export interface RecentQueryDetails {
  totalContributions: number;
  commitContributions: number;
  issueContributions: number;
  pullRequestContributions: number;
  pullRequestReviewContributions: number;
  restrictedContributionsCount: number;
}

export interface RecentQueryAccountObservation {
  login: string;
  classification: Extract<ActivityStatus, "ACTIVE" | "NO_RECENT_VISIBLE_ACTIVITY">;
  details?: RecentQueryDetails;
}

export interface ParsedRecentQueryVariant {
  accounts: RecentQueryAccountObservation[];
  rateLimit: { cost: number; remaining: number };
}

export class RecentQueryVariantError extends Error {
  override readonly name = "RecentQueryVariantError";
  constructor(
    readonly outcome: "RESOURCE_LIMIT" | "RATE_LIMIT" | "AUTH_ERROR" | "SCHEMA_ERROR",
    message: string,
    readonly rateLimit?: { cost: number; remaining: number },
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${key} is not a non-negative integer.`);
  }
  return value as number;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== "boolean") throw new TypeError(`${key} is not boolean.`);
  return record[key] as boolean;
}

function fieldsFor(variant: RecentQueryVariant): readonly string[] {
  if (variant === "CURRENT") return CURRENT_FIELDS;
  return variant === "CLASSIFIER_MINIMAL"
    ? CLASSIFIER_MINIMAL_FIELDS
    : NUMERIC_MINIMAL_FIELDS;
}

export function recentQueryFields(variant: RecentQueryVariant): readonly string[] {
  return fieldsFor(variant);
}

export function buildRecentQueryVariant(
  logins: readonly string[],
  period: ActivityPeriod,
  variant: RecentQueryVariant,
): BuiltRecentQueryVariant {
  if (variant === "CURRENT") {
    return { ...buildAccountActivityBatchQuery(logins, period), variant, fields: CURRENT_FIELDS };
  }
  if (logins.length === 0) throw new RangeError("A comparison query requires logins.");
  const aliases = logins.map((login, index) => ({ alias: `u${index}`, login }));
  const definitions = aliases.map((_item, index) => `$login${index}: String!`);
  const projection = variant === "CLASSIFIER_MINIMAL"
    ? ["hasAnyContributions", "hasAnyRestrictedContributions"]
    : [
        "hasAnyContributions",
        "hasAnyRestrictedContributions",
        "restrictedContributionsCount",
        "totalCommitContributions",
        "totalIssueContributions",
        "totalPullRequestContributions",
        "totalPullRequestReviewContributions",
        "contributionCalendar { totalContributions }",
      ];
  const selections = aliases.map(({ alias }, index) => `
      ${alias}: user(login: $login${index}) {
        login
        contributionsCollection(from: $from, to: $to) {
          ${projection.join("\n          ")}
        }
      }`);
  const variables: Record<string, string> = { from: period.from, to: period.to };
  for (const [index, login] of logins.entries()) variables[`login${index}`] = login;
  return {
    variant,
    fields: fieldsFor(variant),
    aliases,
    variables,
    query: `
      query RecentQueryComparison${variant}(
        $from: DateTime!
        $to: DateTime!
        ${definitions.join("\n        ")}
      ) {
        ${selections.join("\n")}
        rateLimit { cost limit remaining resetAt }
      }
    `,
  };
}

function parseRateLimit(value: unknown): { cost: number; remaining: number } {
  if (!isRecord(value) || typeof value.resetAt !== "string" || Number.isNaN(new Date(value.resetAt).getTime())) {
    throw new TypeError("rateLimit is incomplete.");
  }
  readInteger(value, "limit");
  return { cost: readInteger(value, "cost"), remaining: readInteger(value, "remaining") };
}

function assertIdentity(requested: string, returned: string): void {
  if (requested.toLowerCase() !== returned.toLowerCase()) {
    throw new RecentQueryVariantError(
      "SCHEMA_ERROR",
      `Returned login ${JSON.stringify(returned)} does not match requested login ${JSON.stringify(requested)}.`,
    );
  }
}

function details(activity: AccountActivity): RecentQueryDetails {
  return {
    totalContributions: activity.totalContributions,
    commitContributions: activity.totalCommitContributions,
    issueContributions: activity.totalIssueContributions,
    pullRequestContributions: activity.totalPullRequestContributions,
    pullRequestReviewContributions: activity.totalPullRequestReviewContributions,
    restrictedContributionsCount: activity.restrictedContributionsCount,
  };
}

function parseCurrent(
  payload: unknown,
  built: BuiltRecentQueryVariant,
  period: ActivityPeriod,
): ParsedRecentQueryVariant {
  try {
    const parsed = parseAccountActivityBatchResponse(payload, built, period);
    const limited = parsed.items.filter(({ status }) => status === "RESOURCE_LIMIT");
    if (limited.length > 0) {
      throw new RecentQueryVariantError("RESOURCE_LIMIT", "GraphQL resource limit.", parsed.rateLimit);
    }
    if (parsed.rateLimit === undefined || parsed.items.some(({ status }) => status !== "SUCCESS")) {
      throw new RecentQueryVariantError("SCHEMA_ERROR", "CURRENT returned incomplete aliases.", parsed.rateLimit);
    }
    return {
      rateLimit: parsed.rateLimit,
      accounts: parsed.items.map((item) => {
        if (item.status !== "SUCCESS") throw new Error("Unexpected item state.");
        assertIdentity(item.login, item.activity.login);
        return {
          login: item.login,
          classification: classifyActivity(item.activity) as RecentQueryAccountObservation["classification"],
          details: details(item.activity),
        };
      }),
    };
  } catch (error) {
    if (error instanceof RecentQueryVariantError) throw error;
    if (error instanceof GitHubAuthenticationError) throw new RecentQueryVariantError("AUTH_ERROR", error.message);
    if (error instanceof GitHubRateLimitError) throw new RecentQueryVariantError("RATE_LIMIT", error.message);
    if (error instanceof GitHubGraphQLFatalError) throw new RecentQueryVariantError("SCHEMA_ERROR", error.message);
    throw error;
  }
}

function graphqlMessages(payload: Record<string, unknown>): string[] {
  if (payload.errors === undefined) return [];
  if (!Array.isArray(payload.errors)) throw new TypeError("Invalid GraphQL errors.");
  return payload.errors.map((item) => {
    if (!isRecord(item) || typeof item.message !== "string") throw new TypeError("Invalid GraphQL error item.");
    return item.message;
  });
}

function parseMinimal(
  payload: unknown,
  built: BuiltRecentQueryVariant,
  period: ActivityPeriod,
): ParsedRecentQueryVariant {
  if (!isRecord(payload)) throw new RecentQueryVariantError("SCHEMA_ERROR", "Response is not an object.");
  const messages = graphqlMessages(payload);
  const data = isRecord(payload.data) ? payload.data : undefined;
  let rateLimit: { cost: number; remaining: number } | undefined;
  if (data !== undefined) {
    try { rateLimit = parseRateLimit(data.rateLimit); } catch { /* Error payloads may omit quota metadata. */ }
  }
  if (messages.some((message) => /rate.?limit/i.test(message) && !isResourceLimitMessage(message))) throw new RecentQueryVariantError("RATE_LIMIT", messages.join("; "), rateLimit);
  if (messages.some((message) => /(bad credentials|requires authentication|not authenticated|resource not accessible|insufficient.*(?:scope|permission))/i.test(message))) {
    throw new RecentQueryVariantError("AUTH_ERROR", messages.join("; "), rateLimit);
  }
  if (messages.some(isResourceLimitMessage)) throw new RecentQueryVariantError("RESOURCE_LIMIT", messages.join("; "), rateLimit);
  if (messages.length > 0) throw new RecentQueryVariantError("SCHEMA_ERROR", messages.join("; "), rateLimit);
  if (data === undefined || rateLimit === undefined) throw new RecentQueryVariantError("SCHEMA_ERROR", "Response is missing data or rate limit metadata.");
  const accounts = built.aliases.map(({ alias, login }) => {
    const user = data[alias];
    if (!isRecord(user) || typeof user.login !== "string" || !isRecord(user.contributionsCollection)) {
      throw new RecentQueryVariantError("SCHEMA_ERROR", `Alias ${alias} is incomplete.`, rateLimit);
    }
    assertIdentity(login, user.login);
    const collection = user.contributionsCollection;
    const hasAnyContributions = readBoolean(collection, "hasAnyContributions");
    const hasAnyRestrictedContributions = readBoolean(collection, "hasAnyRestrictedContributions");
    if (built.variant === "CLASSIFIER_MINIMAL") {
      return {
        login,
        classification: hasAnyContributions || hasAnyRestrictedContributions
          ? "ACTIVE" as const
          : "NO_RECENT_VISIBLE_ACTIVITY" as const,
      };
    }
    if (!isRecord(collection.contributionCalendar)) throw new RecentQueryVariantError("SCHEMA_ERROR", `Alias ${alias} totals are incomplete.`, rateLimit);
    const activity: AccountActivity = {
      login,
      periodStart: period.from,
      periodEnd: period.to,
      totalContributions: readInteger(collection.contributionCalendar, "totalContributions"),
      totalCommitContributions: readInteger(collection, "totalCommitContributions"),
      totalIssueContributions: readInteger(collection, "totalIssueContributions"),
      totalPullRequestContributions: readInteger(collection, "totalPullRequestContributions"),
      totalPullRequestReviewContributions: readInteger(collection, "totalPullRequestReviewContributions"),
      restrictedContributionsCount: readInteger(collection, "restrictedContributionsCount"),
      hasAnyContributions,
      hasAnyRestrictedContributions,
      hasActivityInThePast: false,
    };
    return {
      login,
      classification: classifyActivity(activity) as RecentQueryAccountObservation["classification"],
      details: details(activity),
    };
  });
  return { accounts, rateLimit };
}

export function parseRecentQueryVariant(
  payload: unknown,
  built: BuiltRecentQueryVariant,
  period: ActivityPeriod,
): ParsedRecentQueryVariant {
  try {
    return built.variant === "CURRENT"
      ? parseCurrent(payload, built, period)
      : parseMinimal(payload, built, period);
  } catch (error) {
    if (error instanceof RecentQueryVariantError) throw error;
    throw new RecentQueryVariantError(
      "SCHEMA_ERROR",
      error instanceof Error ? error.message : "Invalid response.",
    );
  }
}
