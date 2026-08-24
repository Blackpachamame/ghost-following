import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FollowedAccount } from "./domain/account.js";
import type {
  AccountActivityResult,
  ActivityPeriod,
} from "./domain/activity.js";
import type { GraphQLRateLimit } from "./github/graphql.js";

export const CHECKPOINT_SCHEMA_VERSION = 1;

export interface CheckpointRateLimit {
  cost: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface AuditCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  username: string;
  period: ActivityPeriod;
  createdAt: string;
  updatedAt: string;
  followingSnapshot: FollowedAccount[];
  completedRecentActivity: Record<string, AccountActivityResult>;
  completedHistoricalActivity: Record<string, AccountActivityResult>;
  rateLimit?: CheckpointRateLimit;
}

export interface FollowingChanges {
  added: FollowedAccount[];
  removed: FollowedAccount[];
}

export class CheckpointError extends Error {
  override readonly name = "CheckpointError";
}

export type CheckpointWriteOperation = "mkdir" | "writeFile" | "rename";

export interface CheckpointFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx" },
  ): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<unknown>;
  rm(path: string, options: { force: true }): Promise<unknown>;
}

export interface CheckpointWriterOptions {
  fileSystem?: Partial<CheckpointFileSystem>;
}

const NODE_CHECKPOINT_FILE_SYSTEM: CheckpointFileSystem = {
  mkdir,
  writeFile,
  rename,
  rm,
};

interface CheckpointWriteQueue {
  tail: Promise<void>;
}

const checkpointWriteQueues = new Map<string, CheckpointWriteQueue>();
let temporarySequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loginKey(login: string): string {
  return login.toLocaleLowerCase("en-US");
}

function validDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function validatePeriod(value: unknown): ActivityPeriod {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.days) ||
    (value.days as number) <= 0 ||
    !validDateTime(value.from) ||
    !validDateTime(value.to)
  ) {
    throw new CheckpointError("Checkpoint contains an invalid audit period.");
  }
  return {
    days: value.days as number,
    from: value.from,
    to: value.to,
  };
}

function validateAccount(value: unknown): FollowedAccount {
  if (
    !isRecord(value) ||
    typeof value.login !== "string" ||
    value.login.length === 0 ||
    !Number.isSafeInteger(value.id) ||
    typeof value.type !== "string" ||
    typeof value.htmlUrl !== "string"
  ) {
    throw new CheckpointError("Checkpoint contains an invalid following snapshot.");
  }
  return {
    login: value.login,
    id: value.id as number,
    type: value.type,
    htmlUrl: value.htmlUrl,
  };
}

function validateResults(
  value: unknown,
  field: string,
): Record<string, AccountActivityResult> {
  if (!isRecord(value)) {
    throw new CheckpointError(`Checkpoint contains invalid ${field}.`);
  }
  const results: Record<string, AccountActivityResult> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !isRecord(item) ||
      !isRecord(item.account) ||
      typeof item.account.login !== "string" ||
      typeof item.status !== "string"
    ) {
      throw new CheckpointError(`Checkpoint contains invalid ${field}.`);
    }
    results[key] = item as unknown as AccountActivityResult;
  }
  return results;
}

function validateRateLimit(value: unknown): CheckpointRateLimit | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.cost) ||
    !Number.isSafeInteger(value.limit) ||
    !Number.isSafeInteger(value.remaining) ||
    !validDateTime(value.resetAt)
  ) {
    throw new CheckpointError("Checkpoint contains invalid rate limit data.");
  }
  return {
    cost: value.cost as number,
    limit: value.limit as number,
    remaining: value.remaining as number,
    resetAt: value.resetAt,
  };
}

export function checkpointPathFor(
  username: string,
  checkpointRoot = resolve(".ghost-following", "checkpoints"),
): string {
  return join(checkpointRoot, `${loginKey(username)}.json`);
}

export function createCheckpoint(
  username: string,
  period: ActivityPeriod,
  following: readonly FollowedAccount[],
  now = new Date(),
): AuditCheckpoint {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("Checkpoint requires a valid creation date.");
  }
  const timestamp = now.toISOString();
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    username,
    period,
    createdAt: timestamp,
    updatedAt: timestamp,
    followingSnapshot: [...following],
    completedRecentActivity: {},
    completedHistoricalActivity: {},
  };
}

function checkpointQueueKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32"
    ? absolute.toLocaleLowerCase("en-US")
    : absolute;
}

function serializeCheckpointSnapshot(
  checkpoint: AuditCheckpoint,
  now = new Date(),
): string {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("Checkpoint requires a valid update date.");
  }
  checkpoint.updatedAt = now.toISOString();
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

function filesystemContext(error: unknown): string {
  const code =
    isRecord(error) && typeof error.code === "string"
      ? `${error.code} `
      : "";
  const message =
    error instanceof Error ? error.message : "Unknown filesystem error.";
  return `${code}${message}`;
}

function checkpointWriteError(
  path: string,
  operation: CheckpointWriteOperation,
  error: unknown,
): CheckpointError {
  return new CheckpointError(
    `Failed to write checkpoint at ${path}: during ${operation}: ${filesystemContext(error)}`,
    { cause: error },
  );
}

function nextTemporaryPath(path: string): string {
  temporarySequence += 1;
  return `${path}.${process.pid}.${Date.now()}.${temporarySequence}.tmp`;
}

async function commitCheckpointSnapshot(
  path: string,
  snapshot: string,
  fileSystem: CheckpointFileSystem,
): Promise<void> {
  const temporaryPath = nextTemporaryPath(path);
  try {
    await fileSystem.mkdir(dirname(path), { recursive: true });
  } catch (error) {
    throw checkpointWriteError(path, "mkdir", error);
  }

  try {
    await fileSystem.writeFile(
      temporaryPath,
      snapshot,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw checkpointWriteError(path, "writeFile", error);
  }

  try {
    await fileSystem.rename(temporaryPath, path);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw checkpointWriteError(path, "rename", error);
  }
}

export class CheckpointWriter {
  readonly #path: string;
  readonly #fileSystem: CheckpointFileSystem;
  readonly #queue: CheckpointWriteQueue;

  constructor(path: string, options: CheckpointWriterOptions = {}) {
    this.#path = path;
    this.#fileSystem = {
      ...NODE_CHECKPOINT_FILE_SYSTEM,
      ...options.fileSystem,
    };
    const key = checkpointQueueKey(path);
    const existing = checkpointWriteQueues.get(key);
    if (existing !== undefined) {
      this.#queue = existing;
    } else {
      this.#queue = { tail: Promise.resolve() };
      checkpointWriteQueues.set(key, this.#queue);
    }
  }

  save(checkpoint: AuditCheckpoint, now = new Date()): Promise<void> {
    const snapshot = serializeCheckpointSnapshot(checkpoint, now);
    const operation = this.#queue.tail
      .catch(() => undefined)
      .then(() =>
        commitCheckpointSnapshot(this.#path, snapshot, this.#fileSystem),
      );
    this.#queue.tail = operation;
    return operation;
  }

  flush(): Promise<void> {
    return this.#queue.tail;
  }
}

export function writeCheckpointAtomic(
  path: string,
  checkpoint: AuditCheckpoint,
  now = new Date(),
): Promise<void> {
  return new CheckpointWriter(path).save(checkpoint, now);
}

export async function loadCheckpoint(path: string): Promise<AuditCheckpoint> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") {
      throw new CheckpointError(`No checkpoint found at ${path}.`);
    }
    throw new CheckpointError(`Could not read checkpoint at ${path}.`, {
      cause: error,
    });
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
    typeof parsed.username !== "string" ||
    !validDateTime(parsed.createdAt) ||
    !validDateTime(parsed.updatedAt) ||
    !Array.isArray(parsed.followingSnapshot)
  ) {
    throw new CheckpointError("Checkpoint schema is invalid or unsupported.");
  }

  const checkpoint: AuditCheckpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    username: parsed.username,
    period: validatePeriod(parsed.period),
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    followingSnapshot: parsed.followingSnapshot.map(validateAccount),
    completedRecentActivity: validateResults(
      parsed.completedRecentActivity,
      "completed recent activity",
    ),
    completedHistoricalActivity: validateResults(
      parsed.completedHistoricalActivity,
      "completed historical activity",
    ),
  };
  const rateLimit = validateRateLimit(parsed.rateLimit);
  if (rateLimit !== undefined) checkpoint.rateLimit = rateLimit;
  return checkpoint;
}

export function validateResumeCheckpoint(
  checkpoint: AuditCheckpoint,
  username: string,
  requestedDays: number,
): void {
  if (loginKey(checkpoint.username) !== loginKey(username)) {
    throw new CheckpointError("Checkpoint username does not match requested user.");
  }
  if (checkpoint.period.days !== requestedDays) {
    throw new CheckpointError(
      "Checkpoint period does not match requested audit period.",
    );
  }
}

export function compareFollowing(
  previous: readonly FollowedAccount[],
  current: readonly FollowedAccount[],
): FollowingChanges {
  const previousKeys = new Set(previous.map(({ login }) => loginKey(login)));
  const currentKeys = new Set(current.map(({ login }) => loginKey(login)));
  return {
    added: current.filter(({ login }) => !previousKeys.has(loginKey(login))),
    removed: previous.filter(({ login }) => !currentKeys.has(loginKey(login))),
  };
}

export function recordRecentResults(
  checkpoint: AuditCheckpoint,
  results: readonly AccountActivityResult[],
): void {
  for (const result of results) {
    checkpoint.completedRecentActivity[loginKey(result.account.login)] = result;
  }
}

export function recordHistoricalResult(
  checkpoint: AuditCheckpoint,
  result: AccountActivityResult,
): void {
  checkpoint.completedHistoricalActivity[loginKey(result.account.login)] = result;
}

export function recordRateLimit(
  checkpoint: AuditCheckpoint,
  rateLimit: GraphQLRateLimit | undefined,
): void {
  if (rateLimit === undefined) return;
  checkpoint.rateLimit = {
    cost: rateLimit.cost,
    limit: rateLimit.limit,
    remaining: rateLimit.remaining,
    resetAt: rateLimit.resetAt.toISOString(),
  };
}

export function checkpointRecentResults(
  checkpoint: AuditCheckpoint,
): AccountActivityResult[] {
  return Object.values(checkpoint.completedRecentActivity);
}

export function checkpointHistoricalResults(
  checkpoint: AuditCheckpoint,
): AccountActivityResult[] {
  return Object.values(checkpoint.completedHistoricalActivity);
}

export function checkpointRateLimit(
  checkpoint: AuditCheckpoint,
): GraphQLRateLimit | undefined {
  if (checkpoint.rateLimit === undefined) return undefined;
  return {
    ...checkpoint.rateLimit,
    resetAt: new Date(checkpoint.rateLimit.resetAt),
  };
}

export async function removeCheckpoint(path: string): Promise<void> {
  await rm(path, { force: true });
}
