import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RecentBatchHttpFailure } from "../activity/analyzer.js";

const GITHUB_USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export const DEFAULT_RECENT_FAILURE_DIAGNOSTICS_ROOT = resolve(
  ".ghost-following",
  "diagnostics",
);

export interface RecentBatchFailureIncident {
  timestamp: string;
  auditUsername: string;
  phase: "recent";
  period: RecentBatchHttpFailure["period"];
  httpStatus: number;
  attempts: number;
  batchSize: number;
  logins: string[];
}

export type RecentBatchDiagnosticWriteOperation = "mkdir" | "appendFile";

export class RecentBatchDiagnosticWriteError extends Error {
  override readonly name = "RecentBatchDiagnosticWriteError";

  constructor(
    readonly operation: RecentBatchDiagnosticWriteOperation,
    readonly code: string | undefined,
    options: ErrorOptions,
  ) {
    super(
      `Could not write recent batch diagnostic during ${operation}${
        code === undefined ? "" : ` (${code})`
      }.`,
      options,
    );
  }
}

export interface RecentBatchDiagnosticFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  appendFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "a" },
  ): Promise<unknown>;
}

export interface RecentBatchFailureWriterOptions {
  root?: string;
  fileSystem?: Partial<RecentBatchDiagnosticFileSystem>;
}

const NODE_DIAGNOSTIC_FILE_SYSTEM: RecentBatchDiagnosticFileSystem = {
  mkdir,
  appendFile,
};

function fileSystemCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function safeTerminalLogin(login: string): string {
  return login.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export function recentBatchFailureDiagnosticPathFor(
  auditUsername: string,
  root = DEFAULT_RECENT_FAILURE_DIAGNOSTICS_ROOT,
): string {
  if (!GITHUB_USERNAME_PATTERN.test(auditUsername)) {
    throw new RangeError("Recent batch diagnostic requires a valid audit username.");
  }
  return join(root, auditUsername + "-failures.jsonl");
}

export function createRecentBatchFailureIncident(
  auditUsername: string,
  failure: RecentBatchHttpFailure,
  timestamp = new Date(),
): RecentBatchFailureIncident {
  if (
    !GITHUB_USERNAME_PATTERN.test(auditUsername) ||
    Number.isNaN(timestamp.getTime())
  ) {
    throw new RangeError(
      "Recent batch diagnostic requires a valid audit username and timestamp.",
    );
  }
  return {
    timestamp: timestamp.toISOString(),
    auditUsername,
    phase: "recent",
    period: { ...failure.period },
    httpStatus: failure.httpStatus,
    attempts: failure.attempts,
    batchSize: failure.logins.length,
    logins: [...failure.logins],
  };
}

export function formatRecentBatchFailure(
  failure: RecentBatchHttpFailure,
): string {
  const lines = [
    "Recent batch exhausted retries after " + failure.attempts + " attempts",
    "HTTP status: " + failure.httpStatus,
    "Batch size: " + failure.logins.length,
    "Users:",
    ...failure.logins.map((login) => "  " + safeTerminalLogin(login)),
  ];
  if (failure.httpStatus === 502 || failure.httpStatus === 504) {
    lines.push("");
    if (failure.logins.length > 1) {
      const leftSize = Math.floor(failure.logins.length / 2);
      lines.push(
        `Retry fallback: splitting batch into ${leftSize} + ${failure.logins.length - leftSize}.`,
      );
    } else {
      lines.push(
        "Account could not be evaluated after retries.",
        "Marking as UNKNOWN and continuing.",
      );
    }
  }
  return lines.join("\n");
}

export function formatRecentBatchDiagnosticWarning(error: unknown): string {
  const detail =
    error instanceof RecentBatchDiagnosticWriteError
      ? " during " +
        error.operation +
        (error.code === undefined ? "" : " (" + error.code + ")")
      : "";
  return (
    "Warning: Could not write recent batch diagnostic" +
    detail +
    ". Diagnostic logging does not change audit handling."
  );
}

export class RecentBatchFailureWriter {
  readonly path: string;
  readonly #fileSystem: RecentBatchDiagnosticFileSystem;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    auditUsername: string,
    options: RecentBatchFailureWriterOptions = {},
  ) {
    this.path = recentBatchFailureDiagnosticPathFor(
      auditUsername,
      options.root,
    );
    this.#fileSystem = {
      ...NODE_DIAGNOSTIC_FILE_SYSTEM,
      ...options.fileSystem,
    };
  }

  append(incident: RecentBatchFailureIncident): Promise<void> {
    const line = JSON.stringify(incident) + "\n";
    const operation = this.#tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.#fileSystem.mkdir(dirname(this.path), { recursive: true });
        } catch (error) {
          throw new RecentBatchDiagnosticWriteError(
            "mkdir",
            fileSystemCode(error),
            { cause: error },
          );
        }
        try {
          await this.#fileSystem.appendFile(this.path, line, {
            encoding: "utf8",
            flag: "a",
          });
        } catch (error) {
          throw new RecentBatchDiagnosticWriteError(
            "appendFile",
            fileSystemCode(error),
            { cause: error },
          );
        }
      });
    this.#tail = operation;
    return operation;
  }

  async flush(): Promise<void> {
    await this.#tail;
  }
}
