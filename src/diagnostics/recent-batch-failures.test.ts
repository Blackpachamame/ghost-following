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
  options: { userCount?: number; blockDiagnosticsRoot?: boolean } = {},
): Promise<AuditHarnessResult> {
  const root = await mkdtemp(join(tmpdir(), "ghost-following-recent-failure-"));
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
  const exitCode = await runCli([AUDIT_USERNAME], {
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
    const original = new GitHubHttpError(504, "Gateway Timeout", undefined, 3);
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
        result.errors.some((message) => message.includes("Recent batch failed")),
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

  for (const status of [502, 503, 504]) {
    it(`records the exact 25-user batch after exhausted HTTP ${status}`, async () => {
      const result = await runAuditHarness(
        () => new Response("", { status }),
      );

      try {
        assert.equal(result.exitCode, 1);
        assert.equal(result.graphqlRequests, 3);
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
            "Recent batch failed after 3 attempts",
            "HTTP status: " + status,
            "Batch size: 25",
            "Users:",
            ...incident.logins.map((login) => "  " + login),
          ].join("\n"),
        );
        assert.match(
          result.errors.at(-1) ?? "",
          new RegExp("HTTP " + status + ".*after 3 attempts"),
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
        result.errors.some((message) => message.includes("Recent batch failed")),
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
            message.includes("Recent batch failed"),
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
        result.errors.some((message) => message.includes("Recent batch failed")),
        false,
      );
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  it("warns safely and preserves the exhausted HTTP error when writing fails", async () => {
    const result = await runAuditHarness(
      () => new Response("", { status: 504 }),
      { userCount: 2, blockDiagnosticsRoot: true },
    );

    try {
      assert.equal(result.exitCode, 1);
      assert.equal(result.graphqlRequests, 3);
      assert.match(
        result.errors[0] ?? "",
        /^Recent batch failed after 3 attempts/,
      );
      assert.match(
        result.errors[1] ?? "",
        /^Warning: Could not write recent batch diagnostic during mkdir \(EEXIST\)\./,
      );
      assert.match(
        result.errors[1] ?? "",
        /The original audit error is unchanged\./,
      );
      assert.match(
        result.errors[2] ?? "",
        /HTTP 504.*after 3 attempts/,
      );
      assert.doesNotMatch(result.errors.join("\n"), /obvious-test-placeholder/i);
      assert.doesNotMatch(result.errors.join("\n"), /authorization/i);
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });
});
