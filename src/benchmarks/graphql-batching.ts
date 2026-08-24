#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseUsername } from "../args.js";
import { createActivityPeriod, type ActivityPeriod } from "../domain/activity.js";
import { GitHubClient } from "../github/client.js";
import { getFollowing } from "../github/following.js";
import {
  buildBatchActivityQuery,
  chunkValues,
  type BuiltBatchQuery,
} from "./batch-query.js";
import {
  calculateStrategyMetrics,
  summarizeStrategies,
  type BenchmarkRequestObservation,
  type GraphQLErrorDetail,
  type StrategyMetrics,
} from "./metrics.js";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const BENCHMARK_DAYS = 365;
const MAX_SAMPLE_SIZE = 50;
const REQUESTED_BATCH_SIZES = [5, 10, 25, 30, 35, 40, 45, 50] as const;
const MAX_ERROR_MESSAGE_LENGTH = 300;

export interface BenchmarkIO {
  log(message: string): void;
  error(message: string): void;
}

interface InitialRateLimit {
  cost: number;
  limit: number;
  remaining: number;
}

export interface ParsedBatchResponse {
  successfulUsers: number;
  failedUsers: number;
  graphqlErrors: number;
  globalGraphqlErrors: number;
  partialGraphqlErrors: number;
  nullUsers: number;
  graphqlErrorDetails: GraphQLErrorDetail[];
  graphqlCost?: number;
  remaining?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

export function sanitizeGraphqlErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "Unknown GraphQL error";
  const compact = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length === 0) return "Unknown GraphQL error";
  return compact.length <= MAX_ERROR_MESSAGE_LENGTH
    ? compact
    : `${compact.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function formatGraphqlErrorPath(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const segments = value
    .slice(0, 8)
    .filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    )
    .map((segment) => sanitizeGraphqlErrorMessage(String(segment)).slice(0, 80));
  return segments.length === 0 ? null : segments.join(".");
}

function syntheticGraphqlError(message: string): GraphQLErrorDetail {
  return { message, path: null, scope: "global" };
}

function isValidBenchmarkUser(value: unknown, expectedLogin: string): boolean {
  if (!isRecord(value) || value.login !== expectedLogin) return false;
  const collection = value.contributionsCollection;
  if (!isRecord(collection) || !isRecord(collection.contributionCalendar)) {
    return false;
  }
  return (
    typeof collection.hasAnyContributions === "boolean" &&
    typeof collection.hasAnyRestrictedContributions === "boolean" &&
    readNonNegativeInteger(collection.restrictedContributionsCount) !== undefined &&
    readNonNegativeInteger(collection.contributionCalendar.totalContributions) !==
      undefined
  );
}

export function parseBatchResponse(
  body: string,
  builtQuery: BuiltBatchQuery,
): ParsedBatchResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return {
      successfulUsers: 0,
      failedUsers: builtQuery.aliases.length,
      graphqlErrors: 1,
      globalGraphqlErrors: 1,
      partialGraphqlErrors: 0,
      nullUsers: 0,
      graphqlErrorDetails: [
        syntheticGraphqlError("Response body is not valid JSON"),
      ],
    };
  }

  if (!isRecord(payload)) {
    return {
      successfulUsers: 0,
      failedUsers: builtQuery.aliases.length,
      graphqlErrors: 1,
      globalGraphqlErrors: 1,
      partialGraphqlErrors: 0,
      nullUsers: 0,
      graphqlErrorDetails: [
        syntheticGraphqlError("GraphQL response is not an object"),
      ],
    };
  }

  const aliasNames = new Set(builtQuery.aliases.map(({ alias }) => alias));
  let graphqlErrors = 0;
  let globalGraphqlErrors = 0;
  let partialGraphqlErrors = 0;
  const graphqlErrorDetails: GraphQLErrorDetail[] = [];
  if (Array.isArray(payload.errors)) {
    for (const error of payload.errors) {
      graphqlErrors += 1;
      const partial =
        isRecord(error) &&
        Array.isArray(error.path) &&
        typeof error.path[0] === "string" &&
        aliasNames.has(error.path[0]);
      if (partial) {
        partialGraphqlErrors += 1;
      } else {
        globalGraphqlErrors += 1;
      }
      graphqlErrorDetails.push({
        message: sanitizeGraphqlErrorMessage(
          isRecord(error) ? error.message : undefined,
        ),
        path: formatGraphqlErrorPath(isRecord(error) ? error.path : undefined),
        scope: partial ? "partial" : "global",
      });
    }
  } else if (payload.errors !== undefined) {
    graphqlErrors += 1;
    globalGraphqlErrors += 1;
    graphqlErrorDetails.push(
      syntheticGraphqlError("GraphQL errors field is not an array"),
    );
  }

  if (!isRecord(payload.data)) {
    if (graphqlErrors === 0) {
      graphqlErrors = 1;
      globalGraphqlErrors = 1;
      graphqlErrorDetails.push(
        syntheticGraphqlError("GraphQL response is missing data"),
      );
    }
    return {
      successfulUsers: 0,
      failedUsers: builtQuery.aliases.length,
      graphqlErrors,
      globalGraphqlErrors,
      partialGraphqlErrors,
      nullUsers: 0,
      graphqlErrorDetails,
    };
  }

  let successfulUsers = 0;
  let nullUsers = 0;
  for (const { alias, login } of builtQuery.aliases) {
    const value = payload.data[alias];
    if (value === null) nullUsers += 1;
    if (isValidBenchmarkUser(value, login)) successfulUsers += 1;
  }

  const rateLimit = payload.data.rateLimit;
  let graphqlCost: number | undefined;
  let remaining: number | undefined;
  if (isRecord(rateLimit)) {
    graphqlCost = readNonNegativeInteger(rateLimit.cost);
    remaining = readNonNegativeInteger(rateLimit.remaining);
  }
  if (graphqlCost === undefined || remaining === undefined) {
    graphqlErrors += 1;
    globalGraphqlErrors += 1;
    graphqlErrorDetails.push(
      syntheticGraphqlError("GraphQL response is missing valid rate-limit data"),
    );
  }

  const result: ParsedBatchResponse = {
    successfulUsers,
    failedUsers: builtQuery.aliases.length - successfulUsers,
    graphqlErrors,
    globalGraphqlErrors,
    partialGraphqlErrors,
    nullUsers,
    graphqlErrorDetails,
  };
  if (graphqlCost !== undefined) result.graphqlCost = graphqlCost;
  if (remaining !== undefined) result.remaining = remaining;
  return result;
}

async function executeBatchRequest(input: {
  logins: readonly string[];
  period: ActivityPeriod;
  token: string;
  fetch: typeof globalThis.fetch;
  clock: () => number;
}): Promise<BenchmarkRequestObservation> {
  const builtQuery = buildBatchActivityQuery(input.logins, input.period);
  const startedAt = input.clock();
  let response: Response;
  let body: string;
  try {
    response = await input.fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        "User-Agent": "github-ghost-following-benchmark",
      },
      body: JSON.stringify({
        query: builtQuery.query,
        variables: builtQuery.variables,
      }),
    });
    body = await response.text();
  } catch {
    return {
      durationMs: Math.max(0, input.clock() - startedAt),
      responseBytes: 0,
      successfulUsers: 0,
      failedUsers: input.logins.length,
      graphqlErrors: 0,
      globalGraphqlErrors: 0,
      partialGraphqlErrors: 0,
      nullUsers: 0,
      httpErrors: 1,
    };
  }

  const durationMs = Math.max(0, input.clock() - startedAt);
  const responseBytes = Buffer.byteLength(body, "utf8");
  if (!response.ok) {
    return {
      durationMs,
      responseBytes,
      successfulUsers: 0,
      failedUsers: input.logins.length,
      graphqlErrors: 0,
      globalGraphqlErrors: 0,
      partialGraphqlErrors: 0,
      nullUsers: 0,
      httpErrors: 1,
    };
  }

  const parsed = parseBatchResponse(body, builtQuery);
  return {
    durationMs,
    responseBytes,
    successfulUsers: parsed.successfulUsers,
    failedUsers: parsed.failedUsers,
    graphqlErrors: parsed.graphqlErrors,
    globalGraphqlErrors: parsed.globalGraphqlErrors,
    partialGraphqlErrors: parsed.partialGraphqlErrors,
    nullUsers: parsed.nullUsers,
    httpErrors: 0,
    graphqlErrorDetails: parsed.graphqlErrorDetails,
    ...(parsed.graphqlCost === undefined
      ? {}
      : { graphqlCost: parsed.graphqlCost }),
    ...(parsed.remaining === undefined ? {} : { remaining: parsed.remaining }),
  };
}

export async function executeStrategy(input: {
  strategy: string;
  batchSize: number;
  logins: readonly string[];
  period: ActivityPeriod;
  token: string;
  fetch: typeof globalThis.fetch;
  clock?: () => number;
  remainingBefore: number | null;
}): Promise<StrategyMetrics> {
  const observations: BenchmarkRequestObservation[] = [];
  for (const chunk of chunkValues(input.logins, input.batchSize)) {
    observations.push(
      await executeBatchRequest({
        logins: chunk,
        period: input.period,
        token: input.token,
        fetch: input.fetch,
        clock: input.clock ?? (() => performance.now()),
      }),
    );
  }
  return calculateStrategyMetrics({
    strategy: input.strategy,
    batchSize: input.batchSize,
    sampleSize: input.logins.length,
    remainingBefore: input.remainingBefore,
    observations,
  });
}

export function planBatchSizes(sampleSize: number): Array<{
  requested: number;
  effective: number;
}> {
  if (!Number.isSafeInteger(sampleSize) || sampleSize <= 0) return [];
  const seen = new Set<number>();
  const plan: Array<{ requested: number; effective: number }> = [];
  for (const requested of REQUESTED_BATCH_SIZES) {
    const effective = Math.min(requested, sampleSize);
    if (effective === 1 || seen.has(effective)) continue;
    seen.add(effective);
    plan.push({ requested, effective });
  }
  return plan;
}

async function fetchInitialRateLimit(
  token: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<InitialRateLimit> {
  const response = await fetchImplementation(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "github-ghost-following-benchmark",
    },
    body: JSON.stringify({
      query: "query BenchmarkRateLimit { rateLimit { cost limit remaining resetAt } }",
      variables: {},
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Initial GraphQL rate-limit query failed with HTTP ${response.status}.`,
    );
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.rateLimit)) {
    throw new Error("Initial GraphQL rate-limit response is incomplete.");
  }
  const cost = readNonNegativeInteger(payload.data.rateLimit.cost);
  const limit = readNonNegativeInteger(payload.data.rateLimit.limit);
  const remaining = readNonNegativeInteger(payload.data.rateLimit.remaining);
  if (cost === undefined || limit === undefined || remaining === undefined) {
    throw new Error("Initial GraphQL rate-limit response is invalid.");
  }
  return { cost, limit, remaining };
}

function formatTable(rows: readonly string[][]): string {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  if (widths === undefined) return "";
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatBenchmarkResults(
  metrics: readonly StrategyMetrics[],
  finalRemaining: number | null,
): string {
  const rows = [
    [
      "STRATEGY",
      "USERS",
      "REQUESTS",
      "COST",
      "COST/USER",
      "TIME",
      "AVG REQ",
      "RESPONSE",
      "OK/FAIL",
      "GQL/HTTP ERR",
      "REMAINING",
    ],
    ...metrics.map((item) => [
      item.strategy,
      String(item.sampleSize),
      String(item.httpRequests),
      String(item.totalGraphqlCost),
      item.costPerUser.toFixed(2),
      `${item.durationMs.toFixed(0)} ms`,
      `${item.averageRequestMs.toFixed(1)} ms`,
      formatBytes(item.approxResponseBytes),
      `${item.successfulUsers}/${item.failedUsers}`,
      `${item.graphqlErrors}/${item.httpErrors}`,
      `${item.remainingBefore ?? "?"}→${item.remainingAfter ?? "?"}`,
    ]),
  ];

  const summary = summarizeStrategies(metrics);
  const observations = [
    "",
    `Final GraphQL remaining: ${finalRemaining ?? "unknown"}`,
    "",
    "Observed among fully successful strategies:",
  ];
  if (summary.bestRequestReduction !== null) {
    observations.push(
      `  Best HTTP request reduction: ${summary.bestRequestReduction}`,
    );
  }
  if (summary.lowestCostPerUser !== null) {
    observations.push(`  Lowest cost/user: ${summary.lowestCostPerUser}`);
  }
  if (summary.bestLatency !== null) {
    observations.push(`  Best latency: ${summary.bestLatency}`);
  }
  if (summary.largestFullySuccessfulBatch !== null) {
    observations.push(
      `  Largest fully successful batch observed in this run: ${summary.largestFullySuccessfulBatch}`,
    );
  }
  if (summary.firstFailingBatch !== null) {
    observations.push(
      `  First failing batch tested in this run: ${summary.firstFailingBatch}`,
    );
  }
  if (
    summary.bestRequestReduction === null &&
    summary.lowestCostPerUser === null &&
    summary.bestLatency === null
  ) {
    observations.push("  No fully successful strategy was observed.");
  }

  const strategiesWithErrors = metrics.filter(
    ({ graphqlErrors, httpErrors, nullUsers }) =>
      graphqlErrors > 0 || httpErrors > 0 || nullUsers > 0,
  );
  if (strategiesWithErrors.length > 0) {
    observations.push("", "Error detail:");
    for (const item of strategiesWithErrors) {
      observations.push(
        `  ${item.strategy}: global GraphQL ${item.globalGraphqlErrors}, partial GraphQL ${item.partialGraphqlErrors}, null users ${item.nullUsers}, HTTP ${item.httpErrors}`,
      );
      if (item.graphqlErrorMessages.length > 0) {
        observations.push(`  ${item.strategy} GraphQL errors:`);
        for (const error of item.graphqlErrorMessages) {
          const paths =
            error.examplePaths.length === 0
              ? ""
              : ` (example paths: ${error.examplePaths.join(", ")})`;
          observations.push(
            `    ${error.count}× ${JSON.stringify(error.message)} [${error.scopes.join("/")}]${paths}`,
          );
        }
      }
    }
  }

  return `${formatTable(rows)}\n${observations.join("\n")}`;
}

export async function runBatchingBenchmark(
  args: readonly string[],
  options: {
    fetch?: typeof globalThis.fetch;
    io?: BenchmarkIO;
    now?: Date;
    clock?: () => number;
  } = {},
): Promise<number> {
  const io = options.io ?? console;
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token.trim().length === 0) {
    io.error("GITHUB_TOKEN is required for this benchmark.");
    return 1;
  }

  try {
    const username = parseUsername(args);
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const following = await getFollowing(
      new GitHubClient({ token, fetch: fetchImplementation }),
      username,
    );
    const eligible = following.accounts.filter(({ type }) => type === "User");
    const sample = eligible.slice(0, MAX_SAMPLE_SIZE).map(({ login }) => login);
    if (sample.length === 0) {
      io.error("The benchmark requires at least one eligible User account.");
      return 1;
    }

    const period = createActivityPeriod(options.now ?? new Date(), BENCHMARK_DAYS);
    const batchPlan = planBatchSizes(sample.length);
    const strategyNames = [
      "individual",
      ...batchPlan.map(({ effective }) => String(effective)),
    ];
    const reductions = batchPlan
      .filter(({ requested, effective }) => requested !== effective)
      .map(
        ({ requested, effective }) =>
          `Requested batch ${requested} reduced to ${effective}.`,
      );
    io.log(
      [
        "GitHub Ghost Following — GraphQL Batching Benchmark",
        "",
        `User: ${username}`,
        `Eligible users: ${eligible.length}`,
        `Benchmark sample: ${sample.length} users`,
        `Period: ${BENCHMARK_DAYS} days`,
        `Strategies: ${strategyNames.join(", ")}`,
        "Batch size 1 is represented by the individual strategy.",
        "This benchmark will issue multiple real GraphQL requests.",
        ...reductions,
      ].join("\n"),
    );

    const initialRateLimit = await fetchInitialRateLimit(
      token,
      fetchImplementation,
    );
    io.log(
      `Initial GraphQL remaining: ${initialRateLimit.remaining} / ${initialRateLimit.limit} (setup query cost: ${initialRateLimit.cost})`,
    );

    const metrics: StrategyMetrics[] = [];
    let remaining: number | null = initialRateLimit.remaining;
    const benchmarkClock = options.clock ?? (() => performance.now());
    const individual = await executeStrategy({
      strategy: "individual",
      batchSize: 1,
      logins: sample,
      period,
      token,
      fetch: fetchImplementation,
      clock: benchmarkClock,
      remainingBefore: remaining,
    });
    metrics.push(individual);
    remaining = individual.remainingAfter;

    for (const { effective } of batchPlan) {
      const result = await executeStrategy({
        strategy: `batch ${effective}`,
        batchSize: effective,
        logins: sample,
        period,
        token,
        fetch: fetchImplementation,
        clock: benchmarkClock,
        remainingBefore: remaining,
      });
      metrics.push(result);
      remaining = result.remainingAfter;
    }

    io.log(formatBenchmarkResults(metrics, remaining));
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : "Benchmark failed.");
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await runBatchingBenchmark(process.argv.slice(2));
}
