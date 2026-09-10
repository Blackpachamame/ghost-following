import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseUsername } from "../args.js";
import { AUDIT_SCHEMA_VERSION, type AuditResult } from "../domain/audit.js";

export class AuditInputError extends Error {
  override readonly name = "AuditInputError";
}

function invalid(field: string): never {
  throw new AuditInputError(`Invalid input report: ${field}.`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isActivityDate(value: unknown): value is string {
  if (isTimestamp(value)) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isUsername(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  try {
    return parseUsername([value]) === value;
  } catch {
    return false;
  }
}

function validateRateLimit(value: unknown, field: string, graphql = false): void {
  const rateLimit = record(value, field);
  for (const key of ["limit", "remaining"] as const) {
    if (rateLimit[key] !== null && !isCount(rateLimit[key])) {
      invalid(`${field}.${key} must be a nonnegative integer or null`);
    }
  }
  if (rateLimit.resetAt !== null && !isTimestamp(rateLimit.resetAt)) {
    invalid(`${field}.resetAt must be a valid serialized date or null`);
  }
  if (graphql && !isCount(rateLimit.cost)) {
    invalid(`${field}.cost must be a nonnegative integer`);
  }
}

function validateAudit(value: unknown): asserts value is AuditResult {
  const audit = record(value, "root");
  if (audit.schemaVersion !== AUDIT_SCHEMA_VERSION) {
    throw new AuditInputError("Unsupported input report schemaVersion; expected 1.");
  }
  const history = record(audit.history, "history");
  if (!isCount(history.years)) invalid("history.years must be a nonnegative integer");
  if (history.years !== 0) {
    throw new AuditInputError(
      "Input report already contains historical lookup. This command currently accepts reports with history.years = 0 only.",
    );
  }
  if (!isUsername(audit.user)) invalid("user must be a valid GitHub username");
  if (!isTimestamp(audit.generatedAt)) invalid("generatedAt must be a valid serialized date");

  const period = record(audit.period, "period");
  if (!isCount(period.days) || period.days === 0) invalid("period.days must be a positive integer");
  if (!isTimestamp(period.from) || !isTimestamp(period.to)) {
    invalid("period.from and period.to must be valid serialized dates");
  }
  if (new Date(period.from).getTime() >= new Date(period.to).getTime()) {
    invalid("period.from must precede period.to");
  }

  const summary = record(audit.summary, "summary");
  for (const key of [
    "followingTotal", "eligibleUsers", "unsupportedAccounts", "active",
    "noRecentVisibleActivity", "insufficientVisibility", "unknown",
  ] as const) {
    if (!isCount(summary[key])) invalid(`summary.${key} must be a nonnegative integer`);
  }
  if (!Array.isArray(audit.accounts)) invalid("accounts must be an array");
  const counts = { ACTIVE: 0, NO_RECENT_VISIBLE_ACTIVITY: 0, INSUFFICIENT_VISIBILITY: 0, UNKNOWN: 0 };
  const logins = new Set<string>();
  for (const [index, value] of audit.accounts.entries()) {
    const field = `accounts[${index}]`;
    const account = record(value, field);
    if (!isUsername(account.login)) invalid(`${field}.login must be a valid GitHub username`);
    const key = account.login.toLowerCase();
    if (logins.has(key)) invalid("accounts must contain unique logins (case-insensitive)");
    logins.add(key);
    if (typeof account.url !== "string" || account.url.length === 0) {
      invalid(`${field}.url must be a nonempty string`);
    }
    if (account.accountType !== "User") invalid(`${field}.accountType must be User`);
    if (typeof account.status !== "string" || !Object.hasOwn(counts, account.status)) {
      invalid(`${field}.status is not recognized`);
    }
    counts[account.status as keyof typeof counts] += 1;
    if (account.recentPeriodDays !== period.days) invalid(`${field}.recentPeriodDays must equal period.days`);
    for (const contribution of [
      "totalContributions", "commitContributions", "pullRequestContributions",
      "pullRequestReviewContributions", "issueContributions", "restrictedContributionsCount",
    ] as const) {
      if (account[contribution] !== null && !isCount(account[contribution])) {
        invalid(`${field}.${contribution} must be a nonnegative integer or null`);
      }
    }
    if (account.hasActivityInThePast !== null && typeof account.hasActivityInThePast !== "boolean") {
      invalid(`${field}.hasActivityInThePast must be a boolean or null`);
    }
    if (account.lastVisibleActivityAt !== null && !isActivityDate(account.lastVisibleActivityAt)) {
      invalid(`${field}.lastVisibleActivityAt must be a valid date or null`);
    }
    if (
      account.historicalLookupStatus !== null &&
      account.historicalLookupStatus !== "NOT_REQUESTED" &&
      account.historicalLookupStatus !== "FOUND" &&
      account.historicalLookupStatus !== "NOT_FOUND_IN_LOOKBACK" &&
      account.historicalLookupStatus !== "FAILED"
    ) invalid(`${field}.historicalLookupStatus is not recognized`);
    if (
      account.status === "NO_RECENT_VISIBLE_ACTIVITY" &&
      (account.historicalLookupStatus !== "NOT_REQUESTED" || account.lastVisibleActivityAt !== null)
    ) invalid(`${field} must have historicalLookupStatus NOT_REQUESTED and lastVisibleActivityAt null`);
  }

  if (
    summary.eligibleUsers !== audit.accounts.length ||
    summary.followingTotal !== audit.accounts.length + (summary.unsupportedAccounts as number) ||
    summary.active !== counts.ACTIVE ||
    summary.noRecentVisibleActivity !== counts.NO_RECENT_VISIBLE_ACTIVITY ||
    summary.insufficientVisibility !== counts.INSUFFICIENT_VISIBILITY ||
    summary.unknown !== counts.UNKNOWN
  ) invalid("summary counts do not match accounts");
  const coverage = audit.accounts.length === 0
    ? null
    : ((counts.ACTIVE + counts.NO_RECENT_VISIBLE_ACTIVITY) / audit.accounts.length) * 100;
  if (summary.coverage !== coverage) invalid("summary.coverage does not match accounts");

  // Schema 1 always serializes these fields, using null for unavailable values.
  const rateLimits = record(audit.rateLimits, "rateLimits");
  validateRateLimit(rateLimits.rest, "rateLimits.rest");
  if (rateLimits.graphql !== null) validateRateLimit(rateLimits.graphql, "rateLimits.graphql", true);
}

export async function readAuditExport(path: string): Promise<{ audit: AuditResult; sourceHash: string }> {
  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch {
    throw new AuditInputError("Could not read input report JSON file.");
  }
  let audit: unknown;
  try {
    audit = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
  } catch {
    // Native JSON errors can include source contents, so do not retain them.
    throw new AuditInputError("Input report is not valid JSON.");
  }
  validateAudit(audit);
  return { audit, sourceHash: createHash("sha256").update(contents).digest("hex") };
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    // New exports may live beneath an existing symlinked directory.
    return join(await canonicalPath(parent), basename(path));
  }
}

async function pathIdentity(path: string): Promise<{ canonical: string; fileId: string | undefined }> {
  const absolute = resolve(path);
  const canonical = await canonicalPath(absolute);
  let fileId: string | undefined;
  try {
    const info = await stat(absolute, { bigint: true });
    if (info.ino !== 0n) fileId = `${info.dev}:${info.ino}`;
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return {
    canonical: process.platform === "win32" ? canonical.toLowerCase() : canonical,
    fileId,
  };
}

export async function assertDistinctPaths(
  inputPath: string,
  outputs: readonly { path: string; label: string }[],
): Promise<void> {
  const paths = [{ path: inputPath, label: "Input" }, ...outputs];
  let identities: Awaited<ReturnType<typeof pathIdentity>>[];
  try {
    identities = await Promise.all(paths.map(({ path }) => pathIdentity(path)));
  } catch {
    throw new AuditInputError("Could not resolve input and output paths safely.");
  }
  for (let first = 0; first < identities.length; first += 1) {
    for (let second = first + 1; second < identities.length; second += 1) {
      const a = identities[first]!;
      const b = identities[second]!;
      if (a.canonical === b.canonical || (a.fileId !== undefined && a.fileId === b.fileId)) {
        throw new AuditInputError(`${paths[first]!.label} and ${paths[second]!.label} paths must be different.`);
      }
    }
  }
}