import { performance } from "node:perf_hooks";
import type { ActivityPeriod } from "../domain/activity.js";
import { readRateLimit } from "../github/client.js";
import {
  isRetryableTransportError,
  requestWithTransientRetry,
  TransientTransportRetryExhaustedError,
  type Sleep,
} from "../github/retry.js";
import type { RecentBatchFailureIncident } from "./recent-batch-failures.js";
import {
  buildRecentQueryVariant,
  parseRecentQueryVariant,
  recentQueryFields,
  RECENT_QUERY_VARIANTS,
  RecentQueryVariantError,
  type RecentQueryAccountObservation,
  type RecentQueryDetails,
  type RecentQueryVariant,
} from "./recent-query-variants.js";

export const RECENT_QUERY_SHAPES = ["FULL", "LEFT", "RIGHT"] as const;
export type RecentQueryShape = (typeof RECENT_QUERY_SHAPES)[number];
export type RecentQueryOutcome =
  | "SUCCESS" | "HTTP_502_EXHAUSTED" | "HTTP_503_EXHAUSTED"
  | "HTTP_504_EXHAUSTED" | "RESOURCE_LIMIT" | "INVALID_RESPONSE_BODY"
  | "RATE_LIMIT" | "AUTH_ERROR" | "TRANSPORT_ERROR" | "SCHEMA_ERROR"
  | "OTHER_FATAL";

export interface RecentQueryBatchShape {
  shape: RecentQueryShape;
  logins: string[];
}

export interface RecentQueryMeasurement {
  variant: RecentQueryVariant;
  run: number;
  shape: RecentQueryShape;
  batchSize: number;
  logins: string[];
  outcome: RecentQueryOutcome;
  errorClass: string | null;
  elapsedMs: number;
  requestBodyBytes: number;
  responseBodyBytes: number | null;
  httpAttempts: number;
  graphqlCost: number | null;
  rateLimitRemaining: number | null;
  accounts?: RecentQueryAccountObservation[];
}

export interface RecentQueryParity {
  run: number;
  shape: RecentQueryShape;
  variant: Exclude<RecentQueryVariant, "CURRENT">;
  classificationParity: "MATCH" | "MISMATCH" | "NOT_COMPARABLE";
  classificationMismatches: string[];
  detailParity: "MATCH" | "MISMATCH" | "NOT_APPLICABLE";
  detailMismatches: string[];
}

export interface RecentQueryComparison {
  schemaVersion: 1;
  comparisonTimestamp: string;
  auditUsername: string;
  sourcePath: string;
  sourceIncident: Omit<RecentBatchFailureIncident, "auditUsername" | "phase" | "logins"> & { logins: string[] };
  runs: number;
  variants: { name: RecentQueryVariant; fields: readonly string[] }[];
  measurements: RecentQueryMeasurement[];
  parity: RecentQueryParity[];
}

export interface RecentQueryExecutionOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: Sleep;
  clock?: () => number;
}

class ResponseBodyFailure extends Error {
  override readonly name = "ResponseBodyFailure";
  constructor(readonly category: "INVALID_JSON" | "BODY_READ_FAILED", readonly bytes: number | null, options?: ErrorOptions) {
    super(category === "INVALID_JSON" ? "Response body is not valid JSON." : "Response body could not be read.", options);
  }
}

class ResponseBodyRetryExhausted extends Error {
  override readonly name = "ResponseBodyRetryExhausted";
  constructor(readonly attempts: number, readonly bytes: number | null, options: ErrorOptions) {
    super(`Response body remained invalid after ${attempts} attempts.`, options);
  }
}

interface ProcessedBody { payload: unknown; bytes: number | null }

export function createRecentQueryShapes(logins: readonly string[]): RecentQueryBatchShape[] {
  if (logins.length === 0) throw new RangeError("At least one login is required.");
  const shapes: RecentQueryBatchShape[] = [{ shape: "FULL", logins: [...logins] }];
  if (logins.length > 1) {
    const midpoint = Math.floor(logins.length / 2);
    shapes.push(
      { shape: "LEFT", logins: logins.slice(0, midpoint) },
      { shape: "RIGHT", logins: logins.slice(midpoint) },
    );
  }
  return shapes;
}

function outcomeForResponse(response: Response): RecentQueryOutcome {
  const status = response.status;
  if (status === 502) return "HTTP_502_EXHAUSTED";
  if (status === 503) return "HTTP_503_EXHAUSTED";
  if (status === 504) return "HTTP_504_EXHAUSTED";
  if (status === 401) return "AUTH_ERROR";
  if (status === 429) return "RATE_LIMIT";
  if (status === 403) {
    const rate = readRateLimit(response.headers);
    return rate.remaining === 0 || rate.retryAfterSeconds !== undefined
      ? "RATE_LIMIT"
      : "AUTH_ERROR";
  }
  return "OTHER_FATAL";
}

function elapsed(clock: () => number, started: number): number {
  return Math.max(0, Math.round((clock() - started) * 100) / 100);
}

export async function executeRecentQueryMeasurement(
  variant: RecentQueryVariant,
  run: number,
  shape: RecentQueryBatchShape,
  period: ActivityPeriod,
  options: RecentQueryExecutionOptions,
): Promise<RecentQueryMeasurement> {
  const built = buildRecentQueryVariant(shape.logins, period, variant);
  const serializedBody = JSON.stringify({ query: built.query, variables: built.variables });
  const requestBodyBytes = Buffer.byteLength(serializedBody, "utf8");
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  const base = {
    variant, run, shape: shape.shape, batchSize: shape.logins.length,
    logins: [...shape.logins], requestBodyBytes,
  };
  let attempts = 1;
  let responseBytes: number | null = null;
  try {
    const retried = await requestWithTransientRetry(
      () => (options.fetch ?? globalThis.fetch)("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          "user-agent": "github-ghost-following",
          "x-github-api-version": "2022-11-28",
        },
        body: serializedBody,
      }),
      {
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        processResponse: async (response: Response): Promise<ProcessedBody> => {
          if (!response.ok) return { payload: undefined, bytes: null };
          let text: string;
          try { text = await response.text(); }
          catch (error) { throw new ResponseBodyFailure("BODY_READ_FAILED", null, { cause: error }); }
          const bytes = Buffer.byteLength(text, "utf8");
          try { return { payload: JSON.parse(text) as unknown, bytes }; }
          catch (error) { throw new ResponseBodyFailure("INVALID_JSON", bytes, { cause: error }); }
        },
        isRetryableProcessError: (error: unknown) => error instanceof ResponseBodyFailure &&
          (error.category === "INVALID_JSON" || isRetryableTransportError(error)),
        createProcessRetryExhaustedError: (error: unknown, count: number) => new ResponseBodyRetryExhausted(
          count, error instanceof ResponseBodyFailure ? error.bytes : null, { cause: error },
        ),
      },
    );
    attempts = retried.attempts;
    responseBytes = retried.result.bytes;
    if (!retried.response.ok) {
      const headerRate = readRateLimit(retried.response.headers);
      return {
        ...base, outcome: outcomeForResponse(retried.response),
        errorClass: `HTTP_${retried.response.status}`, elapsedMs: elapsed(clock, started),
        responseBodyBytes: responseBytes, httpAttempts: attempts, graphqlCost: null,
        rateLimitRemaining: headerRate.remaining ?? null,
      };
    }
    const parsed = parseRecentQueryVariant(retried.result.payload, built, period);
    return {
      ...base, outcome: "SUCCESS", errorClass: null, elapsedMs: elapsed(clock, started),
      responseBodyBytes: responseBytes, httpAttempts: attempts,
      graphqlCost: parsed.rateLimit.cost, rateLimitRemaining: parsed.rateLimit.remaining,
      accounts: parsed.accounts,
    };
  } catch (error) {
    let outcome: RecentQueryOutcome = "OTHER_FATAL";
    let cost: number | null = null;
    let remaining: number | null = null;
    if (error instanceof ResponseBodyRetryExhausted) {
      outcome = "INVALID_RESPONSE_BODY"; attempts = error.attempts; responseBytes = error.bytes;
    } else if (error instanceof ResponseBodyFailure) {
      outcome = "INVALID_RESPONSE_BODY"; responseBytes = error.bytes;
    } else if (error instanceof TransientTransportRetryExhaustedError) {
      outcome = "TRANSPORT_ERROR"; attempts = error.attempts;
    } else if (error instanceof RecentQueryVariantError) {
      outcome = error.outcome;
      cost = error.rateLimit?.cost ?? null;
      remaining = error.rateLimit?.remaining ?? null;
    } else if (isRetryableTransportError(error)) {
      outcome = "TRANSPORT_ERROR";
    } else if (error instanceof TypeError) {
      outcome = "TRANSPORT_ERROR";
    }
    return {
      ...base, outcome, errorClass: error instanceof Error ? error.name : "UnknownError",
      elapsedMs: elapsed(clock, started), responseBodyBytes: responseBytes,
      httpAttempts: attempts, graphqlCost: cost, rateLimitRemaining: remaining,
    };
  }
}

function accountMap(measurement: RecentQueryMeasurement): Map<string, RecentQueryAccountObservation> | undefined {
  return measurement.outcome === "SUCCESS" && measurement.accounts !== undefined
    ? new Map(measurement.accounts.map((item) => [item.login.toLowerCase(), item]))
    : undefined;
}

function detailsEqual(left: RecentQueryDetails, right: RecentQueryDetails): boolean {
  return (Object.keys(left) as (keyof RecentQueryDetails)[]).every((key) => left[key] === right[key]);
}

export function compareRecentQueryParity(measurements: readonly RecentQueryMeasurement[]): RecentQueryParity[] {
  const results: RecentQueryParity[] = [];
  for (const candidate of measurements.filter(({ variant }) => variant !== "CURRENT")) {
    const current = measurements.find(({ run, shape, variant }) =>
      run === candidate.run && shape === candidate.shape && variant === "CURRENT");
    const baseline = current === undefined ? undefined : accountMap(current);
    const observed = accountMap(candidate);
    const classificationMismatches: string[] = [];
    const detailMismatches: string[] = [];
    if (baseline !== undefined && observed !== undefined) {
      for (const login of candidate.logins) {
        const left = baseline.get(login.toLowerCase());
        const right = observed.get(login.toLowerCase());
        if (left === undefined || right === undefined || left.classification !== right.classification) classificationMismatches.push(login);
        if (candidate.variant === "NUMERIC_MINIMAL" &&
            (left?.details === undefined || right?.details === undefined || !detailsEqual(left.details, right.details))) detailMismatches.push(login);
      }
    }
    results.push({
      run: candidate.run, shape: candidate.shape,
      variant: candidate.variant as Exclude<RecentQueryVariant, "CURRENT">,
      classificationParity: baseline === undefined || observed === undefined ? "NOT_COMPARABLE"
        : classificationMismatches.length === 0 ? "MATCH" : "MISMATCH",
      classificationMismatches,
      detailParity: candidate.variant === "CLASSIFIER_MINIMAL" ? "NOT_APPLICABLE"
        : baseline === undefined || observed === undefined ? "NOT_APPLICABLE"
        : detailMismatches.length === 0 ? "MATCH" : "MISMATCH",
      detailMismatches,
    });
  }
  return results;
}

export async function runRecentQueryComparison(
  incident: RecentBatchFailureIncident,
  sourcePath: string,
  runs: number,
  options: RecentQueryExecutionOptions & { now?: Date },
): Promise<RecentQueryComparison> {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 3) throw new RangeError("Runs must be an integer from 1 to 3.");
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError("A valid comparison timestamp is required.");
  const measurements: RecentQueryMeasurement[] = [];
  const shapes = createRecentQueryShapes(incident.logins);
  for (let run = 1; run <= runs; run += 1) {
    for (const variant of RECENT_QUERY_VARIANTS) {
      for (const shape of shapes) {
        measurements.push(await executeRecentQueryMeasurement(variant, run, shape, incident.period, options));
      }
    }
  }
  return {
    schemaVersion: 1, comparisonTimestamp: now.toISOString(), auditUsername: incident.auditUsername,
    sourcePath, sourceIncident: {
      timestamp: incident.timestamp, period: { ...incident.period }, httpStatus: incident.httpStatus,
      attempts: incident.attempts, batchSize: incident.batchSize, logins: [...incident.logins],
    },
    runs, variants: RECENT_QUERY_VARIANTS.map((name) => ({ name, fields: recentQueryFields(name) })),
    measurements, parity: compareRecentQueryParity(measurements),
  };
}
