import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CheckpointError } from "../checkpoint.js";
import { isExportedGitHubLogin } from "./login.js";
import {
  createHistoricalPeriods,
  MAX_HISTORICAL_LOOKBACK_YEARS,
  type ActivityPeriod,
  type HistoricalLookupStatus,
} from "../domain/activity.js";
import type {
  AuditResult,
  SerializableGraphQLRateLimit,
} from "../domain/audit.js";

export const HISTORY_ENRICHMENT_CHECKPOINT_SCHEMA_VERSION = 1;

export interface CompletedHistoricalActivity {
  login: string;
  lastVisibleActivityAt: string | null;
  historicalLookupStatus: Exclude<HistoricalLookupStatus, "NOT_REQUESTED">;
}

export interface HistoryEnrichmentCheckpoint {
  schemaVersion: typeof HISTORY_ENRICHMENT_CHECKPOINT_SCHEMA_VERSION;
  sourceHash: string;
  user: string;
  period: ActivityPeriod;
  historyYears: number;
  createdAt: string;
  updatedAt: string;
  completedHistoricalActivity: Record<string, CompletedHistoricalActivity>;
  lastGraphqlRateLimit?: SerializableGraphQLRateLimit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLogin(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value) &&
    !value.includes("--")
  );
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validDay(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    validDateTime(value + "T00:00:00.000Z")
  );
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateHistoryYears(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_HISTORICAL_LOOKBACK_YEARS
  ) {
    throw new CheckpointError(
      "Historical enrichment checkpoint contains invalid historyYears.",
    );
  }
  return value as number;
}

function validatePeriod(value: unknown): ActivityPeriod {
  if (
    !isRecord(value) ||
    !nonnegativeInteger(value.days) ||
    value.days === 0 ||
    !validDateTime(value.from) ||
    !validDateTime(value.to) ||
    new Date(value.from).getTime() >= new Date(value.to).getTime()
  ) {
    throw new CheckpointError(
      "Historical enrichment checkpoint contains an invalid period.",
    );
  }
  return { days: value.days, from: value.from, to: value.to };
}

function validateResults(
  value: unknown,
  period: ActivityPeriod,
  historyYears: number,
): Record<string, CompletedHistoricalActivity> {
  if (!isRecord(value)) {
    throw new CheckpointError(
      "Historical enrichment checkpoint contains invalid completed historical activity.",
    );
  }
  const periods = createHistoricalPeriods(period, historyYears);
  // GitHub returns contribution days, so compare the inclusive calendar dates
  // covered by the same annual windows used by the production lookup.
  const earliestDay = periods[periods.length - 1]!.from.slice(0, 10);
  const latestDay = periods[0]!.to.slice(0, 10);
  const completed: Record<string, CompletedHistoricalActivity> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !isRecord(item) ||
      !isExportedGitHubLogin(item.login) ||
      key !== item.login.toLocaleLowerCase("en-US") ||
      (item.historicalLookupStatus !== "FOUND" &&
        item.historicalLookupStatus !== "NOT_FOUND_IN_LOOKBACK" &&
        item.historicalLookupStatus !== "FAILED")
    ) {
      throw new CheckpointError(
        "Historical enrichment checkpoint contains invalid completed historical activity.",
      );
    }
    if (
      item.historicalLookupStatus === "FOUND"
        ? !validDay(item.lastVisibleActivityAt) ||
          item.lastVisibleActivityAt < earliestDay ||
          item.lastVisibleActivityAt > latestDay
        : item.lastVisibleActivityAt !== null
    ) {
      throw new CheckpointError(
        "Historical enrichment checkpoint contains an invalid historical status/date or a date outside the lookback.",
      );
    }
    completed[key] = {
      login: item.login,
      historicalLookupStatus: item.historicalLookupStatus,
      lastVisibleActivityAt: item.lastVisibleActivityAt as string | null,
    };
  }
  return completed;
}

function validateRateLimit(
  value: unknown,
): SerializableGraphQLRateLimit | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !nonnegativeInteger(value.cost) ||
    (value.limit !== null && !nonnegativeInteger(value.limit)) ||
    (value.remaining !== null && !nonnegativeInteger(value.remaining)) ||
    (value.resetAt !== null && !validDateTime(value.resetAt))
  ) {
    throw new CheckpointError(
      "Historical enrichment checkpoint contains invalid GraphQL rate limit data.",
    );
  }
  return {
    cost: value.cost,
    limit: value.limit,
    remaining: value.remaining,
    resetAt: value.resetAt,
  };
}

function validateCheckpoint(value: unknown): HistoryEnrichmentCheckpoint {
  if (
    !isRecord(value) ||
    value.schemaVersion !== HISTORY_ENRICHMENT_CHECKPOINT_SCHEMA_VERSION ||
    typeof value.sourceHash !== "string" ||
    !/^[a-f\d]{64}$/.test(value.sourceHash) ||
    !validLogin(value.user) ||
    !validDateTime(value.createdAt) ||
    !validDateTime(value.updatedAt)
  ) {
    throw new CheckpointError(
      "Historical enrichment checkpoint schema is invalid or unsupported.",
    );
  }
  const period = validatePeriod(value.period);
  const historyYears = validateHistoryYears(value.historyYears);
  const checkpoint: HistoryEnrichmentCheckpoint = {
    schemaVersion: HISTORY_ENRICHMENT_CHECKPOINT_SCHEMA_VERSION,
    sourceHash: value.sourceHash,
    user: value.user,
    period,
    historyYears,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedHistoricalActivity: validateResults(
      value.completedHistoricalActivity,
      period,
      historyYears,
    ),
  };
  const rateLimit = validateRateLimit(value.lastGraphqlRateLimit);
  if (rateLimit !== undefined) checkpoint.lastGraphqlRateLimit = rateLimit;
  return checkpoint;
}

export function historyEnrichmentCheckpointPathFor(
  user: string,
  checkpointRoot = resolve(".ghost-following", "history-enrichment"),
): string {
  if (!validLogin(user)) {
    throw new CheckpointError("Historical enrichment checkpoint requires a valid user.");
  }
  return join(checkpointRoot, user.toLocaleLowerCase("en-US") + "-history.json");
}

export function createHistoryEnrichmentCheckpoint(
  audit: AuditResult,
  sourceHash: string,
  historyYears: number,
  now = new Date(),
): HistoryEnrichmentCheckpoint {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("Historical enrichment checkpoint requires a valid creation date.");
  }
  return validateCheckpoint({
    schemaVersion: HISTORY_ENRICHMENT_CHECKPOINT_SCHEMA_VERSION,
    sourceHash,
    user: audit.user,
    period: audit.period,
    historyYears,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedHistoricalActivity: {},
  });
}

export async function loadHistoryEnrichmentCheckpoint(
  path: string,
): Promise<HistoryEnrichmentCheckpoint> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new CheckpointError("No historical enrichment checkpoint found at " + path + ".");
    }
    throw new CheckpointError("Could not read historical enrichment checkpoint at " + path + ".");
  }
  return validateCheckpoint(parsed);
}

export function validateHistoryEnrichmentResume(
  checkpoint: HistoryEnrichmentCheckpoint,
  audit: AuditResult,
  sourceHash: string,
  historyYears: number,
): void {
  const validated = validateCheckpoint(checkpoint);
  if (validated.sourceHash !== sourceHash) {
    throw new CheckpointError(
      "Historical enrichment checkpoint sourceHash does not match the input report; the source report has changed or differs from the original input.",
    );
  }
  if (validated.user !== audit.user) {
    throw new CheckpointError(
      "Historical enrichment checkpoint user does not match the input report.",
    );
  }
  if (
    validated.period.days !== audit.period.days ||
    validated.period.from !== audit.period.from ||
    validated.period.to !== audit.period.to
  ) {
    throw new CheckpointError(
      "Historical enrichment checkpoint period does not match the input report.",
    );
  }
  if (validated.historyYears !== historyYears) {
    throw new CheckpointError(
      "Historical enrichment checkpoint historyYears (" +
        validated.historyYears +
        ") does not match requested --history-years " +
        historyYears +
        ".",
    );
  }
  const candidates = new Map(
    audit.accounts
      .filter(({ accountType, status }) =>
        accountType === "User" && status === "NO_RECENT_VISIBLE_ACTIVITY")
      .map((account) => [account.login.toLocaleLowerCase("en-US"), account]),
  );
  for (const [key, result] of Object.entries(validated.completedHistoricalActivity)) {
    if (candidates.get(key)?.login !== result.login) {
      throw new CheckpointError(
        "Historical enrichment checkpoint contains a result that is not a quiet candidate in the input report.",
      );
    }
  }
}