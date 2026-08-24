#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createActivityPeriod, type ActivityPeriod } from "../domain/activity.js";
import { readApiMessage, readRateLimit } from "../github/client.js";
import {
  GitHubAuthenticationError,
  GitHubGraphQLFatalError,
  GitHubHttpError,
  GitHubNetworkError,
  GitHubRateLimitError,
} from "../github/errors.js";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const MAX_TEXT_LENGTH = 200;

export const GRAPHQL_DIAGNOSTIC_QUERY = `
  query GraphQLDiagnostic($from: DateTime!, $to: DateTime!) {
    aylxxn: user(login: "aylxxn") {
      login
      userViewType
      name
      bio
      url
      contributionsCollection(from: $from, to: $to) {
        startedAt
        endedAt
        hasAnyContributions
        hasAnyRestrictedContributions
        restrictedContributionsCount
        hasActivityInThePast
        contributionYears
        contributionCalendar {
          totalContributions
        }
      }
    }

    undrbug: user(login: "undrbug") {
      login
      userViewType
      contributionsCollection(from: $from, to: $to) {
        startedAt
        endedAt
        hasAnyContributions
        hasAnyRestrictedContributions
        restrictedContributionsCount
        hasActivityInThePast
        contributionYears
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
        mostRecentCollectionWithActivity {
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
                date
                contributionCount
              }
            }
          }
        }
      }
    }

    rateLimit {
      cost
      remaining
      limit
      resetAt
    }
  }
`;

export interface DiagnosticIO {
  log(message: string): void;
  error(message: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GitHubGraphQLFatalError(
      `GitHub GraphQL diagnostic response is missing ${label}.`,
    );
  }
  return value;
}

export function sanitizeDiagnosticText(value: string): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return compact.length <= MAX_TEXT_LENGTH
    ? compact
    : `${compact.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return JSON.stringify(sanitizeDiagnosticText(value));
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item)).join(", ")}]`;
  }
  return "unavailable";
}

export function findLatestContributionDay(calendar: unknown): string | null {
  const calendarRecord = requireRecord(calendar, "contributionCalendar");
  const weeks = calendarRecord.weeks;
  if (!Array.isArray(weeks)) {
    throw new GitHubGraphQLFatalError(
      "GitHub GraphQL diagnostic response has invalid contribution weeks.",
    );
  }

  let latest: string | null = null;
  for (const week of weeks) {
    const weekRecord = requireRecord(week, "a contribution week");
    const days = weekRecord.contributionDays;
    if (!Array.isArray(days)) {
      throw new GitHubGraphQLFatalError(
        "GitHub GraphQL diagnostic response has invalid contribution days.",
      );
    }

    for (const day of days) {
      const dayRecord = requireRecord(day, "a contribution day");
      const date = dayRecord.date;
      const count = dayRecord.contributionCount;
      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isSafeInteger(count) ||
        (count as number) < 0
      ) {
        throw new GitHubGraphQLFatalError(
          "GitHub GraphQL diagnostic response has an invalid contribution day.",
        );
      }
      if ((count as number) > 0 && (latest === null || date > latest)) {
        latest = date;
      }
    }
  }

  return latest;
}

function collectionLines(
  collection: Record<string, unknown>,
  options: { includeLatestDay?: boolean; includeYears?: boolean } = {},
): string[] {
  const calendar = requireRecord(
    collection.contributionCalendar,
    "contributionCalendar",
  );
  const lines = [
    `  startedAt: ${formatValue(collection.startedAt)}`,
    `  endedAt: ${formatValue(collection.endedAt)}`,
    `  totalContributions: ${formatValue(calendar.totalContributions)}`,
    `  hasAnyContributions: ${formatValue(collection.hasAnyContributions)}`,
    `  hasAnyRestrictedContributions: ${formatValue(collection.hasAnyRestrictedContributions)}`,
    `  restrictedContributionsCount: ${formatValue(collection.restrictedContributionsCount)}`,
  ];

  if (options.includeYears === true) {
    lines.push(
      `  hasActivityInThePast: ${formatValue(collection.hasActivityInThePast)}`,
      `  contributionYears: ${formatValue(collection.contributionYears)}`,
    );
  }
  if (options.includeLatestDay === true) {
    lines.push(
      `  latestRestrictedContributionDate: ${formatValue(collection.latestRestrictedContributionDate)}`,
      `  latestContributionDay: ${formatValue(findLatestContributionDay(calendar))}`,
    );
  }

  return lines;
}

export function formatDiagnosticReport(payload: unknown): string {
  const payloadRecord = requireRecord(payload, "the response body");
  const data = requireRecord(payloadRecord.data, "data");
  const aylxxn = requireRecord(data.aylxxn, "user aylxxn");
  const aylxxnCollection = requireRecord(
    aylxxn.contributionsCollection,
    "aylxxn contributionsCollection",
  );
  const undrbug = requireRecord(data.undrbug, "user undrbug");
  const undrbugCollection = requireRecord(
    undrbug.contributionsCollection,
    "undrbug contributionsCollection",
  );
  const mostRecent = undrbugCollection.mostRecentCollectionWithActivity;
  const rateLimit = requireRecord(data.rateLimit, "rateLimit");

  const lines = [
    "=== aylxxn ===",
    "",
    `login: ${formatValue(aylxxn.login)}`,
    `userViewType: ${formatValue(aylxxn.userViewType)}`,
    `name: ${formatValue(aylxxn.name)}`,
    `bio: ${formatValue(aylxxn.bio)}`,
    `url: ${formatValue(aylxxn.url)}`,
    "current collection:",
    ...collectionLines(aylxxnCollection, { includeYears: true }),
    "",
    "=== undrbug ===",
    "",
    `login: ${formatValue(undrbug.login)}`,
    `userViewType: ${formatValue(undrbug.userViewType)}`,
    "Current collection:",
    ...collectionLines(undrbugCollection, { includeYears: true }),
    "",
    "Most recent collection with activity:",
    `  exists: ${mostRecent === null ? "no" : "yes"}`,
  ];

  if (mostRecent !== null) {
    lines.push(
      ...collectionLines(requireRecord(mostRecent, "mostRecentCollectionWithActivity"), {
        includeLatestDay: true,
      }),
    );
  }

  lines.push(
    "",
    "Rate limit:",
    `  cost: ${formatValue(rateLimit.cost)}`,
    `  remaining: ${formatValue(rateLimit.remaining)}`,
    `  limit: ${formatValue(rateLimit.limit)}`,
    `  resetAt: ${formatValue(rateLimit.resetAt)}`,
  );

  return lines.join("\n");
}

function graphQLErrorMessage(payload: Record<string, unknown>): string | undefined {
  if (!Array.isArray(payload.errors) || payload.errors.length === 0) {
    return undefined;
  }
  const messages = payload.errors.map((error) => {
    if (!isRecord(error) || typeof error.message !== "string") {
      return "Unknown GraphQL error";
    }
    return sanitizeDiagnosticText(error.message);
  });
  return messages.join("; ");
}

async function requestDiagnostic(
  token: string,
  period: ActivityPeriod,
  fetchImplementation: typeof globalThis.fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "github-ghost-following-diagnostic",
      },
      body: JSON.stringify({
        query: GRAPHQL_DIAGNOSTIC_QUERY,
        variables: { from: period.from, to: period.to },
      }),
    });
  } catch (error) {
    throw new GitHubNetworkError(
      "Could not reach the GitHub GraphQL endpoint for diagnostics.",
      { cause: error },
    );
  }

  const headerRateLimit = readRateLimit(response.headers);
  if (response.status === 401) throw new GitHubAuthenticationError();
  if (response.status === 403 || response.status === 429) {
    throw new GitHubRateLimitError(headerRateLimit, response.status);
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
      "GitHub GraphQL diagnostic returned invalid JSON.",
      { cause: error },
    );
  }
  if (!isRecord(payload)) {
    throw new GitHubGraphQLFatalError(
      "GitHub GraphQL diagnostic returned a non-object response.",
    );
  }
  const graphQLError = graphQLErrorMessage(payload);
  if (graphQLError !== undefined) {
    throw new GitHubGraphQLFatalError(
      `GitHub GraphQL diagnostic failed: ${graphQLError}`,
    );
  }
  return payload;
}

export async function runDiagnostic(
  options: {
    fetch?: typeof globalThis.fetch;
    io?: DiagnosticIO;
    now?: Date;
  } = {},
): Promise<number> {
  const io = options.io ?? console;
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token.trim().length === 0) {
    io.error("GITHUB_TOKEN is required for this diagnostic command.");
    return 1;
  }

  try {
    const period = createActivityPeriod(options.now ?? new Date());
    const payload = await requestDiagnostic(
      token,
      period,
      options.fetch ?? globalThis.fetch,
    );
    io.log(formatDiagnosticReport(payload));
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : "Diagnostic command failed.");
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await runDiagnostic();
}
