import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  analyzeFollowingActivity,
  type ActivityProvider,
} from "../activity/analyzer.js";
import { checkpointPathFor } from "../checkpoint.js";
import { runCli, type CliIO } from "../cli.js";
import type { ActivityPeriod } from "../domain/activity.js";
import { GitHubHttpError } from "../github/errors.js";
import {
  createRecentBatchFailureIncident,
  RecentBatchFailureWriter,
  recentBatchFailureDiagnosticPathFor,
} from "./recent-batch-failures.js";

const AUDIT_USERNAME = "AuditUser";
const TEST_TOKEN = "obvious-test-placeholder";
const TEST_NOW = new Date("2026-08-25T00:00:00.000Z");

type GraphQLResponder = (request: number, body: string) => Response;

interface AuditHarnessResult {
  root: string;
  diagnosticsRoot: string;
  diagnosticPath: string;
  exitCode: number;
  graphqlRequests: number;
  logs: string[];
  errors: string[];
}

function followedUsers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    login: "user-" + index,
    id: index + 1,
    type: "User",
    html_url: "https://github.com/user-" + index,
  }));
}

function rateLimit(remaining = 4_999) {
  return {
    cost: 1,
    limit: 5_000,
    remaining,
    resetAt: "2026-08-25T01:00:00.000Z",
  };
}

function successfulBatchPayload(bodyText: string): unknown {
  const body = JSON.parse(bodyText) as {
    variables: Record<string, string>;
  };
  const loginKeys = Object.keys(body.variables)
    .filter((key) => /^login\d+$/.test(key))
    .sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)));
  const data: Record<string, unknown> = { rateLimit: rateLimit() };
  for (const [index, key] of loginKeys.entries()) {
    const login = body.variables[key]!;
    data["u" + index] = {
      login,
      contributionsCollection: {
        startedAt: body.variables.from,
        endedAt: body.variables.to,
        hasAnyContributions: true,
        hasAnyRestrictedContributions: false,
        hasActivityInThePast: false,
        restrictedContributionsCount: 0,
        totalCommitContributions: 1,
        totalIssueContributions: 0,
        totalPullRequestContributions: 0,
        totalPullRequestReviewContributions: 0,
        contributionCalendar: { totalContributions: 1 },
      },
    };
  }
  return { data };
}

function requestedLogins(bodyText: string): string[] {
  const body = JSON.parse(bodyText) as {
    variables: Record<string, string>;
  };
  return Object.keys(body.variables)
    .filter((key) => /^login\d+$/.test(key))
    .sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)))
    .map((key) => body.variables[key]!);
}

function resourceLimitPayload(bodyText: string): unknown {
  const body = JSON.parse(bodyText) as {
    variables: Record<string, string>;
  };
  const aliases = Object.keys(body.variables)
    .filter((key) => /^login\d+$/.test(key))
    .map((_key, index) => "u" + index);
  const data: Record<string, unknown> = { rateLimit: rateLimit() };
  for (const alias of aliases) data[alias] = null;
  return {
    data,
    errors: [{ message: "Resource limits for this query exceeded." }],
  };
}

async function runAuditHarness(
  responder: GraphQLResponder,
  options: {
    userCount?: number;
    blockDiagnosticsRoot?: boolean;
    root?: string;
    args?: readonly string[];
  } = {},
): Promise<AuditHarnessResult> {
  const root =
    options.root ??
    (await mkdtemp(join(tmpdir(), "ghost-following-recent-failure-")));
  const diagnosticsRoot = join(root, "diagnostics");
  if (options.blockDiagnosticsRoot) {
    await writeFile(diagnosticsRoot, "not-a-directory", "utf8");
  }
  const logs: string[] = [];
  const errors: string[] = [];
  const users = followedUsers(options.userCount ?? 25);
  let graphqlRequests = 0;
  const fetchMock = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(input).includes("/following")) {
      return new Response(JSON.stringify(users), {
        status: 200,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4999",
        },
      });
    }
    graphqlRequests += 1;
    return responder(graphqlRequests, String(init?.body));
  }) as typeof fetch;
  const io: CliIO = {
    log(message) {
      logs.push(message);
    },
    error(message) {
      errors.push(message);
    },
  };
  const exitCode = await runCli([AUDIT_USERNAME, ...(options.args ?? [])], {
    token: TEST_TOKEN,
    fetch: fetchMock,
    sleep: async () => undefined,
    now: TEST_NOW,
    checkpointRoot: join(root, "checkpoints"),
    diagnosticsRoot,
    io,
  });
  return {
    root,
    diagnosticsRoot,
    diagnosticPath: recentBatchFailureDiagnosticPathFor(
      AUDIT_USERNAME,
      diagnosticsRoot,
    ),
    exitCode,
    graphqlRequests,
    logs,
    errors,
  };
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

describe("recent batch failure JSONL writer", () => {
  it("appends multiple incidents as independent JSON lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-jsonl-"));
    const writer = new RecentBatchFailureWriter(AUDIT_USERNAME, { root });
    const period: ActivityPeriod = {
      from: "2025-08-25T00:00:00.000Z",
      to: TEST_NOW.toISOString(),
      days: 365,
    };

    try {
      const first = createRecentBatchFailureIncident(
        AUDIT_USERNAME,
        {
          logins: ["first", "second"],
          period,
          httpStatus: 502,
          attempts: 3,
        },
        TEST_NOW,
      );
      const second = createRecentBatchFailureIncident(
        AUDIT_USERNAME,
        {
          logins: ["third"],
          period,
          httpStatus: 504,
          attempts: 3,
        },
        new Date("2026-08-25T00:01:00.000Z"),
      );

      await Promise.all([writer.append(first), writer.append(second)]);

      const lines = (await readFile(writer.path, "utf8")).trim().split("\n");
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]!), first);
      assert.deepEqual(JSON.parse(lines[1]!), second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never replaces the original HTTP error when reporting throws", async () => {
    const original = new GitHubHttpError(
      503,
      "Service Unavailable",
      undefined,
      3,
    );
    const reportingFailure = new Error("simulated diagnostic write failure");
    let observedReportingFailure: unknown;
    const provider: ActivityProvider = {
      async getAccountActivities() {
        throw original;
      },
      async getHistoricalActivity() {
        throw new Error("Historical lookup must not run.");
      },
    };

    await assert.rejects(
      analyzeFollowingActivity(
        [
          {
            login: "failed-user",
            id: 1,
            type: "User",
            htmlUrl: "https://github.com/failed-user",
          },
        ],
        provider,
        {
          from: "2025-08-25T00:00:00.000Z",
          to: TEST_NOW.toISOString(),
          days: 365,
        },
        {
          onRecentBatchFailed() {
            throw reportingFailure;
          },
          onRecentBatchFailureReportingError(error) {
            observedReportingFailure = error;
          },
        },
      ),
      (error) => error === original,
    );
    assert.equal(observedReportingFailure, reportingFailure);
  });
});

describe("recent batch failure CLI diagnostics", () => {
  it("does not create a diagnostic for a successful recent batch", async () => {
    const result = await runAuditHarness(
      (_request, body) =>
        new Response(JSON.stringify(successfulBatchPayload(body)), {
          status: 200,
        }),
      { userCount: 1 },
    );

    try {
      assert.equal(result.exitCode, 0);
      assert.equal(result.graphqlRequests, 1);
      await assertMissing(result.diagnosticPath);
      assert.equal(
          result.errors.some((message) =>
            message.includes("Recent batch exhausted retries"),
          ),
        false,
      );
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  it("does not create a diagnostic when one transient failure recovers", async () => {
    const result = await runAuditHarness(
      (request, body) =>
        request === 1
          ? new Response("", { status: 504 })
          : new Response(JSON.stringify(successfulBatchPayload(body)), {
              status: 200,
            }),
      { userCount: 1 },
    );

    try {
      assert.equal(result.exitCode, 0);
      assert.equal(result.graphqlRequests, 2);
      await assertMissing(result.diagnosticPath);
      assert.equal(result.errors.length, 0);
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  for (const status of [502, 504]) {
    it(`records and recovers the exact 25-user batch after exhausted HTTP ${status}`, async () => {
      const result = await runAuditHarness(
        (request, body) =>
          request <= 3
            ? new Response("", { status })
            : new Response(JSON.stringify(successfulBatchPayload(body)), {
                status: 200,
              }),
      );

      try {
        assert.equal(result.exitCode, 0);
        assert.equal(result.graphqlRequests, 5);
        const file = await readFile(result.diagnosticPath, "utf8");
        const lines = file.trim().split("\n");
        assert.equal(lines.length, 1);
        const incident = JSON.parse(lines[0]!) as {
          timestamp: string;
          auditUsername: string;
          phase: string;
          period: ActivityPeriod;
          httpStatus: number;
          attempts: number;
          batchSize: number;
          logins: string[];
        };
        assert.deepEqual(incident, {
          timestamp: TEST_NOW.toISOString(),
          auditUsername: AUDIT_USERNAME,
          phase: "recent",
          period: {
            from: "2025-08-25T00:00:00.000Z",
            to: TEST_NOW.toISOString(),
            days: 365,
          },
          httpStatus: status,
          attempts: 3,
          batchSize: 25,
          logins: Array.from(
            { length: 25 },
            (_value, index) => "user-" + index,
          ),
        });
        assert.equal(
          result.errors[0],
          [
            "Recent batch exhausted retries after 3 attempts",
            "HTTP status: " + status,
            "Batch size: 25",
            "Users:",
            ...incident.logins.map((login) => "  " + login),
            "",
            "Retry fallback: splitting batch into 12 + 13.",
          ].join("\n"),
        );
        assert.deepEqual(
          result.logs.filter((message) =>
            message.startsWith("Analyzing recent activity:"),
          ),
          ["Analyzing recent activity: 25 / 25"],
        );
        assert.doesNotMatch(file, /obvious-test-placeholder/i);
        assert.doesNotMatch(file, /authorization/i);
        assert.doesNotMatch(file, /contributionsCollection/i);
        assert.doesNotMatch(file, /query BatchAccountActivity/i);
      } finally {
        await rm(result.root, { recursive: true, force: true });
      }
    });
  }

  it("records exhausted HTTP 503 once and keeps it fatal without splitting", async () => {
    const result = await runAuditHarness(
      () => new Response("", { status: 503 }),
    );

    try {
      assert.equal(result.exitCode, 1);
      assert.equal(result.graphqlRequests, 3);
      const lines = (await readFile(result.diagnosticPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const incident = JSON.parse(lines[0]!) as {
        httpStatus: number;
        batchSize: number;
        logins: string[];
      };
      assert.equal(incident.httpStatus, 503);
      assert.equal(incident.batchSize, 25);
      assert.equal(incident.logins.length, 25);
      assert.match(
        result.errors[0] ?? "",
        /^Recent batch exhausted retries after 3 attempts/,
      );
      assert.doesNotMatch(result.errors[0] ?? "", /splitting batch/);
      assert.match(result.errors[1] ?? "", /HTTP 503.*after 3 attempts/);
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  it("does not diagnose HTTP 401 authentication failures", async () => {
    const result = await runAuditHarness(
      () => new Response("", { status: 401 }),
      { userCount: 1 },
    );

    try {
      assert.equal(result.exitCode, 1);
      assert.equal(result.graphqlRequests, 1);
      await assertMissing(result.diagnosticPath);
      assert.equal(
        result.errors.some((message) =>
          message.includes("Recent batch exhausted retries"),
        ),
        false,
      );
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  for (const status of [403, 429]) {
    it(`does not diagnose HTTP ${status} rate limits`, async () => {
      const result = await runAuditHarness(
        () =>
          new Response("", {
            status,
            headers: { "x-ratelimit-remaining": "0" },
          }),
        { userCount: 1 },
      );

      try {
        assert.equal(result.exitCode, 1);
        assert.equal(result.graphqlRequests, 1);
        await assertMissing(result.diagnosticPath);
        assert.equal(
          result.errors.some((message) =>
            message.includes("Recent batch exhausted retries"),
          ),
          false,
        );
      } finally {
        await rm(result.root, { recursive: true, force: true });
      }
    });
  }

  it("keeps RESOURCE_LIMIT fallback separate from HTTP diagnostics", async () => {
    const result = await runAuditHarness(
      (request, body) =>
        new Response(
          JSON.stringify(
            request === 1
              ? resourceLimitPayload(body)
              : successfulBatchPayload(body),
          ),
          { status: 200 },
        ),
      { userCount: 2 },
    );

    try {
      assert.equal(result.exitCode, 0);
      assert.equal(result.graphqlRequests, 3);
      await assertMissing(result.diagnosticPath);
      assert.equal(
        result.errors.some((message) =>
          message.includes("Recent batch exhausted retries"),
        ),
        false,
      );
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  it("records each exact nested HTTP timeout batch as a separate incident", async () => {
    const result = await runAuditHarness((_, body) => {
      const logins = requestedLogins(body);
      return logins.length === 25 || logins.length === 13
        ? new Response("", { status: 504 })
        : new Response(JSON.stringify(successfulBatchPayload(body)), {
            status: 200,
          });
    });

    try {
      assert.equal(result.exitCode, 0);
      assert.equal(result.graphqlRequests, 9);
      const incidents = (await readFile(result.diagnosticPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          httpStatus: number;
          batchSize: number;
          logins: string[];
        });
      assert.deepEqual(
        incidents.map(({ httpStatus, batchSize }) => ({ httpStatus, batchSize })),
        [
          { httpStatus: 504, batchSize: 25 },
          { httpStatus: 504, batchSize: 13 },
        ],
      );
      assert.deepEqual(
        incidents[1]?.logins,
        Array.from({ length: 13 }, (_value, index) => "user-" + (index + 12)),
      );
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  it("records an exhausted singleton and reports UNKNOWN continuation", async () => {
    const result = await runAuditHarness(
      (_, body) => {
        const logins = requestedLogins(body);
        return logins.length === 2 || logins[0] === "user-0"
          ? new Response("", { status: 502 })
          : new Response(JSON.stringify(successfulBatchPayload(body)), {
              status: 200,
            });
      },
      { userCount: 2 },
    );

    try {
      assert.equal(result.exitCode, 0);
      assert.equal(result.graphqlRequests, 7);
      const incidents = (await readFile(result.diagnosticPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          batchSize: number;
          logins: string[];
        });
      assert.deepEqual(
        incidents.map(({ batchSize, logins }) => ({ batchSize, logins })),
        [
          { batchSize: 2, logins: ["user-0", "user-1"] },
          { batchSize: 1, logins: ["user-0"] },
        ],
      );
      assert.match(
        result.errors[1] ?? "",
        /Account could not be evaluated after retries\.\nMarking as UNKNOWN and continuing\./,
      );
      assert.doesNotMatch(
        await readFile(result.diagnosticPath, "utf8"),
        /obvious-test-placeholder|authorization|contributionsCollection/i,
      );
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  it("persists a successful split branch and --resume requests only the other branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-partial-resume-"));
    const checkpointPath = checkpointPathFor(
      AUDIT_USERNAME,
      join(root, "checkpoints"),
    );
    try {
      const first = await runAuditHarness(
        (request, body) => {
          if (request <= 3) return new Response("", { status: 504 });
          if (request === 4) {
            return new Response(JSON.stringify(successfulBatchPayload(body)), {
              status: 200,
            });
          }
          return new Response("", { status: 401 });
        },
        { root },
      );
      assert.equal(first.exitCode, 1);
      assert.equal(first.graphqlRequests, 5);
      const saved = JSON.parse(await readFile(checkpointPath, "utf8")) as {
        schemaVersion: number;
        completedRecentActivity: Record<
          string,
          { account: { login: string }; status: string }
        >;
      };
      assert.equal(saved.schemaVersion, 1);
      assert.equal(Object.keys(saved.completedRecentActivity).length, 12);

      const resumedRequests: string[][] = [];
      const resumed = await runAuditHarness(
        (_, body) => {
          resumedRequests.push(requestedLogins(body));
          return new Response(JSON.stringify(successfulBatchPayload(body)), {
            status: 200,
          });
        },
        { root, args: ["--resume"] },
      );
      assert.equal(resumed.exitCode, 0);
      assert.deepEqual(resumedRequests, [
        Array.from({ length: 13 }, (_value, index) => "user-" + (index + 12)),
      ]);
      await assertMissing(checkpointPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists singleton UNKNOWN and --resume does not request it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-unknown-resume-"));
    const checkpointPath = checkpointPathFor(
      AUDIT_USERNAME,
      join(root, "checkpoints"),
    );
    try {
      const first = await runAuditHarness(
        (_, body) => {
          const logins = requestedLogins(body);
          return logins.length === 2 || logins[0] === "user-0"
            ? new Response("", { status: 504 })
            : new Response("", { status: 401 });
        },
        { root, userCount: 2 },
      );
      assert.equal(first.exitCode, 1);
      assert.equal(first.graphqlRequests, 7);
      const saved = JSON.parse(await readFile(checkpointPath, "utf8")) as {
        schemaVersion: number;
        completedRecentActivity: Record<string, { status: string }>;
      };
      assert.equal(saved.schemaVersion, 1);
      assert.deepEqual(Object.keys(saved.completedRecentActivity), ["user-0"]);
      assert.equal(saved.completedRecentActivity["user-0"]?.status, "UNKNOWN");

      const resumedRequests: string[][] = [];
      const resumed = await runAuditHarness(
        (_, body) => {
          resumedRequests.push(requestedLogins(body));
          return new Response(JSON.stringify(successfulBatchPayload(body)), {
            status: 200,
          });
        },
        { root, userCount: 2, args: ["--resume"] },
      );
      assert.equal(resumed.exitCode, 0);
      assert.deepEqual(resumedRequests, [["user-1"]]);
      await assertMissing(checkpointPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves prior checkpoint progress when invalid JSON exhausts and resumes the failed batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-json-resume-"));
    const checkpointPath = checkpointPathFor(
      AUDIT_USERNAME,
      join(root, "checkpoints"),
    );
    try {
      const privateBodyMarker = "private-invalid-body-marker";
      const first = await runAuditHarness(
        (request, body) =>
          request === 1
            ? new Response(JSON.stringify(successfulBatchPayload(body)), {
                status: 200,
              })
            : new Response(privateBodyMarker, { status: 200 }),
        { root, userCount: 26 },
      );
      assert.equal(first.exitCode, 1);
      assert.equal(first.graphqlRequests, 4);
      assert.match(
        first.errors.at(-1) ?? "",
        /not valid JSON after 3 attempts/,
      );
      assert.doesNotMatch(first.errors.join("\n"), new RegExp(privateBodyMarker));
      const saved = JSON.parse(await readFile(checkpointPath, "utf8")) as {
        schemaVersion: number;
        completedRecentActivity: Record<string, { status: string }>;
      };
      assert.equal(saved.schemaVersion, 1);
      assert.equal(Object.keys(saved.completedRecentActivity).length, 25);
      assert.equal(saved.completedRecentActivity["user-25"], undefined);
      await assertMissing(first.diagnosticPath);

      const resumedRequests: string[][] = [];
      const resumed = await runAuditHarness(
        (_, body) => {
          resumedRequests.push(requestedLogins(body));
          return new Response(JSON.stringify(successfulBatchPayload(body)), {
            status: 200,
          });
        },
        { root, userCount: 26, args: ["--resume"] },
      );
      assert.equal(resumed.exitCode, 0);
      assert.deepEqual(resumedRequests, [["user-25"]]);
      await assertMissing(checkpointPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports singleton timeout UNKNOWN through existing JSON and CSV schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-unknown-export-"));
    const jsonPath = join(root, "audit.json");
    const csvPath = join(root, "audit.csv");
    try {
      const result = await runAuditHarness(
        () => new Response("", { status: 504 }),
        {
          root,
          userCount: 1,
          args: ["--json", jsonPath, "--csv", csvPath],
        },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.graphqlRequests, 3);
      const audit = JSON.parse(await readFile(jsonPath, "utf8")) as {
        schemaVersion: number;
        accounts: Array<{ login: string; status: string }>;
      };
      assert.equal(audit.schemaVersion, 1);
      assert.equal(audit.accounts.length, 1);
      assert.equal(audit.accounts[0]?.login, "user-0");
      assert.equal(audit.accounts[0]?.status, "UNKNOWN");
      assert.match(await readFile(csvPath, "utf8"), /^user-0,[^\n]*,UNKNOWN,/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns safely and still recovers with adaptive splitting when writing fails", async () => {
    const result = await runAuditHarness(
      (request, body) =>
        request <= 3
          ? new Response("", { status: 504 })
          : new Response(JSON.stringify(successfulBatchPayload(body)), {
              status: 200,
            }),
      { userCount: 2, blockDiagnosticsRoot: true },
    );

    try {
      assert.equal(result.exitCode, 0);
      assert.equal(result.graphqlRequests, 5);
      assert.match(
        result.errors[0] ?? "",
        /^Recent batch exhausted retries after 3 attempts/,
      );
      assert.match(result.errors[0] ?? "", /splitting batch into 1 \+ 1/);
      assert.match(
        result.errors[1] ?? "",
        /^Warning: Could not write recent batch diagnostic during mkdir \(EEXIST\)\./,
      );
      assert.match(
        result.errors[1] ?? "",
        /Diagnostic logging does not change audit handling\./,
      );
      assert.equal(result.errors.length, 2);
      assert.doesNotMatch(result.errors.join("\n"), /obvious-test-placeholder/i);
      assert.doesNotMatch(result.errors.join("\n"), /authorization/i);
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });
});
