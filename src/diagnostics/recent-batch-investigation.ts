import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ActivityPeriod } from "../domain/activity.js";
import type { BatchAccountActivityQueryResult } from "../github/batch-activity.js";
import {
  GitHubHttpError,
  GitHubRateLimitError,
} from "../github/errors.js";
import { TRANSIENT_MAX_ATTEMPTS } from "../github/retry.js";
import {
  recentBatchFailureDiagnosticPathFor,
  type RecentBatchFailureIncident,
} from "./recent-batch-failures.js";
import { MAX_SUPPORTED_DIAGNOSTIC_BATCH_SIZE } from "./recent-diagnostic-limits.js";

const GITHUB_USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const INVESTIGATION_SCHEMA_VERSION = 1;
const MAX_ERROR_MESSAGE_LENGTH = 240;

export const DEFAULT_INVESTIGATIONS_ROOT = resolve(
  ".ghost-following",
  "diagnostics",
  "investigations",
);

export type RecentBatchInvestigationOutcome =
  | "SUCCESS"
  | "HTTP_TIMEOUT"
  | "RESOURCE_LIMIT"
  | "SINGLETON_TIMEOUT"
  | "SERVICE_UNAVAILABLE"
  | "FATAL";

export type RecentBatchSplitReason = "HTTP_TIMEOUT" | "RESOURCE_LIMIT";

export type RecentBatchInvestigationConclusion =
  | "NOT_REPRODUCED"
  | "SPLIT_RESOLVED"
  | "SINGLETON_TIMEOUTS"
  | "INCONCLUSIVE";

export interface RecentBatchInvestigationError {
  name: string;
  message: string;
}

export interface RecentBatchInvestigationNode {
  logins: string[];
  batchSize: number;
  outcome: RecentBatchInvestigationOutcome;
  httpStatus?: number;
  attempts?: number;
  splitReason?: RecentBatchSplitReason;
  successfulLogins?: string[];
  resourceLimitedLogins?: string[];
  accountErrorLogins?: string[];
  error?: RecentBatchInvestigationError;
  children?: RecentBatchInvestigationNode[];
}

export interface RecentBatchInvestigation {
  schemaVersion: typeof INVESTIGATION_SCHEMA_VERSION;
  investigationTimestamp: string;
  auditUsername: string;
  sourceIncidentTimestamp: string;
  sourceHttpStatus: number;
  sourceAttempts: number;
  period: ActivityPeriod;
  originalBatchSize: number;
  originalLogins: string[];
  conclusion: RecentBatchInvestigationConclusion;
  singletonTimeouts: string[];
  tree: RecentBatchInvestigationNode[];
}

export interface RecentBatchInvestigationClient {
  getAccountActivities(
    logins: readonly string[],
    period: ActivityPeriod,
  ): Promise<BatchAccountActivityQueryResult>;
}

export interface RecentBatchInvestigationFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx" },
  ): Promise<unknown>;
}

export interface InvestigationFileOptions {
  root?: string;
  fileSystem?: Partial<RecentBatchInvestigationFileSystem>;
}

export class RecentBatchInvestigationSourceError extends Error {
  override readonly name = "RecentBatchInvestigationSourceError";
}

export class RecentBatchInvestigationWriteError extends Error {
  override readonly name = "RecentBatchInvestigationWriteError";

  constructor(message: string, options: ErrorOptions) {
    super(message, options);
  }
}

const NODE_INVESTIGATION_FILE_SYSTEM: RecentBatchInvestigationFileSystem = {
  readFile: (path, encoding) => readFile(path, encoding),
  mkdir,
  writeFile,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileSystemCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function parsePeriod(value: unknown): ActivityPeriod | undefined {
  if (
    !isRecord(value) ||
    !isValidTimestamp(value.from) ||
    !isValidTimestamp(value.to) ||
    !isPositiveSafeInteger(value.days) ||
    new Date(value.from).getTime() >= new Date(value.to).getTime()
  ) {
    return undefined;
  }
  return { from: value.from, to: value.to, days: value.days };
}

function parseLogins(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SUPPORTED_DIAGNOSTIC_BATCH_SIZE ||
    !value.every(
      (login) =>
        typeof login === "string" && GITHUB_USERNAME_PATTERN.test(login),
    )
  ) {
    return undefined;
  }
  const unique = new Set(
    value.map((login) => (login as string).toLocaleLowerCase("en-US")),
  );
  return unique.size === value.length ? [...value] as string[] : undefined;
}

function parseSourceIncident(
  value: unknown,
  requestedAuditUsername: string,
): RecentBatchFailureIncident | undefined {
  if (
    !isRecord(value) ||
    value.phase !== "recent" ||
    !isValidTimestamp(value.timestamp) ||
    typeof value.auditUsername !== "string" ||
    value.auditUsername.toLocaleLowerCase("en-US") !==
      requestedAuditUsername.toLocaleLowerCase("en-US")
  ) {
    return undefined;
  }
  const period = parsePeriod(value.period);
  const logins = parseLogins(value.logins);
  if (
    period === undefined ||
    logins === undefined ||
    !Number.isSafeInteger(value.httpStatus) ||
    (value.httpStatus as number) < 100 ||
    (value.httpStatus as number) > 599 ||
    value.attempts !== TRANSIENT_MAX_ATTEMPTS ||
    value.batchSize !== logins.length
  ) {
    return undefined;
  }
  return {
    timestamp: value.timestamp,
    auditUsername: value.auditUsername,
    phase: "recent",
    period,
    httpStatus: value.httpStatus as number,
    attempts: value.attempts,
    batchSize: logins.length,
    logins,
  };
}

export async function loadLatestRecentBatchFailureIncident(
  auditUsername: string,
  options: InvestigationFileOptions = {},
): Promise<RecentBatchFailureIncident> {
  if (!GITHUB_USERNAME_PATTERN.test(auditUsername)) {
    throw new RecentBatchInvestigationSourceError(
      "Recent batch investigation requires a valid GitHub username.",
    );
  }
  const fileSystem = {
    ...NODE_INVESTIGATION_FILE_SYSTEM,
    ...options.fileSystem,
  };
  const path = recentBatchFailureDiagnosticPathFor(
    auditUsername,
    options.root,
  );
  let contents: string;
  try {
    contents = await fileSystem.readFile(path, "utf8");
  } catch (error) {
    throw new RecentBatchInvestigationSourceError(
      "Could not read the recent batch failure log for " +
        JSON.stringify(auditUsername) +
        ".",
      { cause: error },
    );
  }
  const lines = contents.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const incident = parseSourceIncident(
        JSON.parse(line) as unknown,
        auditUsername,
      );
      if (incident !== undefined) return incident;
    } catch {
      // A malformed line does not hide the latest earlier valid incident.
    }
  }
  throw new RecentBatchInvestigationSourceError(
    "No valid recent batch failure incident was found for " +
      JSON.stringify(auditUsername) +
      ".",
  );
}

interface NodeResolution {
  node: RecentBatchInvestigationNode;
  halt: boolean;
}

function sanitizeErrorMessage(message: string): string {
  const compact = message
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length <= MAX_ERROR_MESSAGE_LENGTH
    ? compact
    : compact.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1) + "…";
}

function errorDetails(error: unknown): RecentBatchInvestigationError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeErrorMessage(error.message),
    };
  }
  return {
    name: "UnknownError",
    message: "The diagnostic request failed with a non-Error value.",
  };
}

function splitInHalf(values: readonly string[]): [string[], string[]] {
  const midpoint = Math.floor(values.length / 2);
  return [values.slice(0, midpoint), values.slice(midpoint)];
}

async function resolveInvestigationNode(
  client: RecentBatchInvestigationClient,
  logins: readonly string[],
  period: ActivityPeriod,
): Promise<NodeResolution> {
  const nodeBase = {
    logins: [...logins],
    batchSize: logins.length,
  };
  let response: BatchAccountActivityQueryResult;
  try {
    response = await client.getAccountActivities(logins, period);
  } catch (error) {
    if (
      error instanceof GitHubHttpError &&
      (error.status === 502 || error.status === 504) &&
      error.attempts === TRANSIENT_MAX_ATTEMPTS
    ) {
      if (logins.length === 1) {
        return {
          node: {
            ...nodeBase,
            outcome: "SINGLETON_TIMEOUT",
            httpStatus: error.status,
            attempts: error.attempts,
          },
          halt: false,
        };
      }
      const node: RecentBatchInvestigationNode = {
        ...nodeBase,
        outcome: "HTTP_TIMEOUT",
        httpStatus: error.status,
        attempts: error.attempts,
        splitReason: "HTTP_TIMEOUT",
        children: [],
      };
      for (const half of splitInHalf(logins)) {
        const child = await resolveInvestigationNode(client, half, period);
        node.children!.push(child.node);
        if (child.halt) return { node, halt: true };
      }
      return { node, halt: false };
    }
    if (error instanceof GitHubHttpError && error.status === 503) {
      return {
        node: {
          ...nodeBase,
          outcome: "SERVICE_UNAVAILABLE",
          httpStatus: error.status,
          attempts: error.attempts,
          error: errorDetails(error),
        },
        halt: true,
      };
    }
    const node: RecentBatchInvestigationNode = {
      ...nodeBase,
      outcome: "FATAL",
      error: errorDetails(error),
    };
    if (error instanceof GitHubHttpError) {
      node.httpStatus = error.status;
      node.attempts = error.attempts;
    } else if (error instanceof GitHubRateLimitError) {
      node.httpStatus = error.status;
    }
    return { node, halt: true };
  }

  const accountErrorLogins = response.items
    .filter(({ status }) => status === "ACCOUNT_ERROR")
    .map(({ login }) => login);
  if (accountErrorLogins.length > 0) {
    return {
      node: {
        ...nodeBase,
        outcome: "FATAL",
        accountErrorLogins,
        error: {
          name: "GraphQLAccountErrors",
          message:
            "The batch returned one or more account-scoped GraphQL errors.",
        },
      },
      halt: true,
    };
  }

  const resourceLimitedLogins = response.items
    .filter(({ status }) => status === "RESOURCE_LIMIT")
    .map(({ login }) => login);
  if (resourceLimitedLogins.length === 0) {
    return { node: { ...nodeBase, outcome: "SUCCESS" }, halt: false };
  }

  const successfulLogins = response.items
    .filter(({ status }) => status === "SUCCESS")
    .map(({ login }) => login);
  const node: RecentBatchInvestigationNode = {
    ...nodeBase,
    outcome: "RESOURCE_LIMIT",
    resourceLimitedLogins,
    ...(successfulLogins.length === 0 ? {} : { successfulLogins }),
  };
  if (logins.length === 1 && resourceLimitedLogins.length === 1) {
    return { node, halt: false };
  }

  const groups =
    resourceLimitedLogins.length === 1
      ? [[...resourceLimitedLogins]]
      : splitInHalf(resourceLimitedLogins);
  node.splitReason = "RESOURCE_LIMIT";
  node.children = [];
  for (const group of groups) {
    const child = await resolveInvestigationNode(client, group, period);
    node.children.push(child.node);
    if (child.halt) return { node, halt: true };
  }
  return { node, halt: false };
}

function collectNodes(
  node: RecentBatchInvestigationNode,
): RecentBatchInvestigationNode[] {
  return [
    node,
    ...(node.children ?? []).flatMap((child) => collectNodes(child)),
  ];
}

function selectConclusion(
  root: RecentBatchInvestigationNode,
): {
  conclusion: RecentBatchInvestigationConclusion;
  singletonTimeouts: string[];
} {
  const nodes = collectNodes(root);
  const singletonTimeouts = nodes
    .filter(({ outcome }) => outcome === "SINGLETON_TIMEOUT")
    .flatMap(({ logins }) => logins);
  const isInconclusive = nodes.some(
    ({ outcome, children }) =>
      outcome === "FATAL" ||
      outcome === "SERVICE_UNAVAILABLE" ||
      (outcome === "RESOURCE_LIMIT" && (children?.length ?? 0) === 0),
  );
  if (isInconclusive) {
    return { conclusion: "INCONCLUSIVE", singletonTimeouts };
  }
  if (singletonTimeouts.length > 0) {
    return { conclusion: "SINGLETON_TIMEOUTS", singletonTimeouts };
  }
  if (root.outcome === "SUCCESS") {
    return { conclusion: "NOT_REPRODUCED", singletonTimeouts };
  }
  if (nodes.some(({ outcome }) => outcome === "HTTP_TIMEOUT")) {
    return { conclusion: "SPLIT_RESOLVED", singletonTimeouts };
  }
  return { conclusion: "INCONCLUSIVE", singletonTimeouts };
}

export async function investigateRecentBatch(
  client: RecentBatchInvestigationClient,
  incident: RecentBatchFailureIncident,
  now = new Date(),
): Promise<RecentBatchInvestigation> {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("Recent batch investigation requires a valid timestamp.");
  }
  const resolved = await resolveInvestigationNode(
    client,
    incident.logins,
    incident.period,
  );
  const summary = selectConclusion(resolved.node);
  return {
    schemaVersion: INVESTIGATION_SCHEMA_VERSION,
    investigationTimestamp: now.toISOString(),
    auditUsername: incident.auditUsername,
    sourceIncidentTimestamp: incident.timestamp,
    sourceHttpStatus: incident.httpStatus,
    sourceAttempts: incident.attempts,
    period: { ...incident.period },
    originalBatchSize: incident.logins.length,
    originalLogins: [...incident.logins],
    conclusion: summary.conclusion,
    singletonTimeouts: summary.singletonTimeouts,
    tree: [resolved.node],
  };
}

function windowsSafeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

export function recentBatchInvestigationPathFor(
  auditUsername: string,
  investigationTimestamp: string,
  root = DEFAULT_INVESTIGATIONS_ROOT,
  suffix = 0,
): string {
  if (
    !GITHUB_USERNAME_PATTERN.test(auditUsername) ||
    !isValidTimestamp(investigationTimestamp) ||
    !Number.isSafeInteger(suffix) ||
    suffix < 0
  ) {
    throw new RangeError("Invalid recent batch investigation path data.");
  }
  const suffixText = suffix === 0 ? "" : "-" + suffix;
  return join(
    root,
    auditUsername +
      "-" +
      windowsSafeTimestamp(investigationTimestamp) +
      suffixText +
      ".json",
  );
}

export async function writeRecentBatchInvestigation(
  investigation: RecentBatchInvestigation,
  options: InvestigationFileOptions = {},
): Promise<string> {
  const root = options.root ?? DEFAULT_INVESTIGATIONS_ROOT;
  const fileSystem = {
    ...NODE_INVESTIGATION_FILE_SYSTEM,
    ...options.fileSystem,
  };
  try {
    await fileSystem.mkdir(root, { recursive: true });
  } catch (error) {
    throw new RecentBatchInvestigationWriteError(
      "Could not create the investigation directory" +
        (fileSystemCode(error) === undefined
          ? ""
          : " (" + fileSystemCode(error) + ")") +
        ".",
      { cause: error },
    );
  }
  const contents = JSON.stringify(investigation, null, 2) + "\n";
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const path = recentBatchInvestigationPathFor(
      investigation.auditUsername,
      investigation.investigationTimestamp,
      root,
      suffix,
    );
    try {
      await fileSystem.writeFile(path, contents, {
        encoding: "utf8",
        flag: "wx",
      });
      return path;
    } catch (error) {
      if (fileSystemCode(error) === "EEXIST") continue;
      throw new RecentBatchInvestigationWriteError(
        "Could not write the investigation result" +
          (fileSystemCode(error) === undefined
            ? ""
            : " (" + fileSystemCode(error) + ")") +
          ".",
        { cause: error },
      );
    }
  }
  throw new RecentBatchInvestigationWriteError(
    "Could not allocate a unique investigation filename.",
    { cause: new Error("Investigation filename suffix limit reached.") },
  );
}

function nodeOutcomeText(node: RecentBatchInvestigationNode): string {
  switch (node.outcome) {
    case "SUCCESS":
      return "SUCCESS";
    case "HTTP_TIMEOUT":
      return (
        "HTTP " + node.httpStatus + " after " + node.attempts + " attempts"
      );
    case "SINGLETON_TIMEOUT":
      return (
        "HTTP " +
        node.httpStatus +
        " after " +
        node.attempts +
        " attempts (singleton)"
      );
    case "SERVICE_UNAVAILABLE":
      return (
        "SERVICE_UNAVAILABLE (HTTP " +
        node.httpStatus +
        " after " +
        node.attempts +
        " attempts)"
      );
    case "RESOURCE_LIMIT":
      return "RESOURCE_LIMIT";
    case "FATAL":
      return "FATAL (" + (node.error?.name ?? "UnknownError") + ")";
  }
}

function formatTreeNode(
  node: RecentBatchInvestigationNode,
  depth: number,
): string[] {
  const indent = "  ".repeat(depth);
  const lines = [
    indent + node.batchSize + " → " + nodeOutcomeText(node),
  ];
  if (node.splitReason !== undefined && node.children !== undefined) {
    lines.push(
      indent +
        "Splitting (" +
        node.splitReason +
        "): " +
        node.children.map(({ batchSize }) => batchSize).join(" + "),
    );
  }
  for (const child of node.children ?? []) {
    lines.push("", ...formatTreeNode(child, depth + 1));
  }
  return lines;
}

function conclusionText(
  conclusion: RecentBatchInvestigationConclusion,
): string {
  switch (conclusion) {
    case "NOT_REPRODUCED":
      return "The previous timeout was not reproduced by the full batch.";
    case "SPLIT_RESOLVED":
      return "Original timeout reproduced, but all smaller subsets resolved.";
    case "SINGLETON_TIMEOUTS":
      return "One or more repeated singleton timeouts were observed.";
    case "INCONCLUSIVE":
      return "Investigation stopped without a conclusive timeout isolation.";
  }
}

export function formatRecentBatchInvestigation(
  investigation: RecentBatchInvestigation,
  savedPath: string,
): string {
  const lines = [
    "Recent batch investigation",
    "",
    "Audit: " + investigation.auditUsername,
    "Source incident: " + investigation.sourceIncidentTimestamp,
    "Source failure: HTTP " +
      investigation.sourceHttpStatus +
      " after " +
      investigation.sourceAttempts +
      " attempts",
    "Period: " +
      investigation.period.from +
      " → " +
      investigation.period.to,
    "Original batch size: " + investigation.originalBatchSize,
    "",
    ...formatTreeNode(investigation.tree[0]!, 0),
    "",
    "Conclusion:",
    investigation.conclusion,
    conclusionText(investigation.conclusion),
  ];
  if (investigation.singletonTimeouts.length > 0) {
    lines.push(
      "",
      investigation.singletonTimeouts.length === 1
        ? "Repeated singleton timeout observed:"
        : "Repeated singleton timeouts observed:",
      ...investigation.singletonTimeouts.map((login) => "  " + login),
      "",
      "This does not prove that an account caused the original timeout.",
      "Manual review recommended.",
    );
  } else {
    lines.push("", "No singleton timeout was isolated.");
  }
  lines.push("", "Saved investigation:", savedPath);
  return lines.join("\n");
}
