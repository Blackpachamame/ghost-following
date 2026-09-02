import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ActivityPeriod } from "../domain/activity.js";
import { TRANSIENT_MAX_ATTEMPTS } from "../github/retry.js";
import {
  recentBatchFailureDiagnosticPathFor,
  type RecentBatchFailureIncident,
} from "./recent-batch-failures.js";
import { MAX_SUPPORTED_DIAGNOSTIC_BATCH_SIZE } from "./recent-diagnostic-limits.js";

const GITHUB_USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export interface RecentQuerySourceOptions {
  timestamp?: string;
  source?: string;
  root?: string;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export interface LoadedRecentQuerySource {
  path: string;
  incident: RecentBatchFailureIncident;
}

export class RecentQuerySourceError extends Error {
  override readonly name = "RecentQuerySourceError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function period(value: unknown): ActivityPeriod | undefined {
  if (!isRecord(value) || !timestamp(value.from) || !timestamp(value.to) ||
      !Number.isSafeInteger(value.days) || (value.days as number) <= 0 ||
      new Date(value.from).getTime() >= new Date(value.to).getTime()) return undefined;
  return { from: value.from, to: value.to, days: value.days as number };
}

function logins(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SUPPORTED_DIAGNOSTIC_BATCH_SIZE ||
      !value.every((item) => typeof item === "string" && GITHUB_USERNAME_PATTERN.test(item))) return undefined;
  const values = value as string[];
  return new Set(values.map((item) => item.toLowerCase())).size === values.length
    ? [...values]
    : undefined;
}

function incident(value: unknown, auditUsername: string): RecentBatchFailureIncident | undefined {
  if (!isRecord(value) || value.phase !== "recent" || !timestamp(value.timestamp) ||
      typeof value.auditUsername !== "string" ||
      value.auditUsername.toLowerCase() !== auditUsername.toLowerCase()) return undefined;
  const parsedPeriod = period(value.period);
  const parsedLogins = logins(value.logins);
  if (parsedPeriod === undefined || parsedLogins === undefined ||
      !Number.isSafeInteger(value.httpStatus) || (value.httpStatus as number) < 100 ||
      (value.httpStatus as number) > 599 || value.attempts !== TRANSIENT_MAX_ATTEMPTS ||
      value.batchSize !== parsedLogins.length) return undefined;
  return {
    timestamp: value.timestamp,
    auditUsername: value.auditUsername,
    phase: "recent",
    period: parsedPeriod,
    httpStatus: value.httpStatus as number,
    attempts: TRANSIENT_MAX_ATTEMPTS,
    batchSize: parsedLogins.length,
    logins: parsedLogins,
  };
}

export async function loadRecentQuerySource(
  auditUsername: string,
  options: RecentQuerySourceOptions = {},
): Promise<LoadedRecentQuerySource> {
  if (!GITHUB_USERNAME_PATTERN.test(auditUsername)) {
    throw new RecentQuerySourceError("A valid GitHub audit username is required.");
  }
  if (options.timestamp !== undefined && !timestamp(options.timestamp)) {
    throw new RecentQuerySourceError("--timestamp must be a valid timestamp.");
  }
  const path = options.source === undefined
    ? recentBatchFailureDiagnosticPathFor(auditUsername, options.root)
    : resolve(options.source);
  let contents: string;
  try {
    contents = await (options.readFile ?? readFile)(path, "utf8");
  } catch (error) {
    throw new RecentQuerySourceError(`Could not read source JSONL ${JSON.stringify(path)}.`, { cause: error });
  }
  const matches: RecentBatchFailureIncident[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try {
      const parsed = incident(JSON.parse(rawLine) as unknown, auditUsername);
      if (parsed !== undefined &&
          (options.timestamp === undefined || parsed.timestamp === options.timestamp)) matches.push(parsed);
    } catch {
      // Malformed lines are ignored, preserving earlier/later valid incidents.
    }
  }
  const selected = matches.at(-1);
  if (selected === undefined) {
    const qualifier = options.timestamp === undefined ? "" : ` at ${options.timestamp}`;
    throw new RecentQuerySourceError(`No valid recent failure incident${qualifier} was found in ${JSON.stringify(path)}.`);
  }
  return { path, incident: selected };
}
