import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  parseRecentBatchInvestigationArgs,
  RECENT_BATCH_INVESTIGATION_HELP,
  runRecentBatchInvestigationCli,
  type RecentBatchInvestigationIO,
} from "./recent-batch-investigation-cli.js";
import { recentBatchFailureDiagnosticPathFor } from "./recent-batch-failures.js";

const AUDIT_USERNAME = "AuditUser";
const TEST_NOW = new Date("2026-08-25T02:00:00.000Z");
const PERIOD = {
  from: "2025-08-24T23:41:55.948Z",
  to: "2026-08-24T23:41:55.948Z",
  days: 365,
};

function sourceIncident() {
  return {
    timestamp: "2026-08-25T01:40:41.234Z",
    auditUsername: AUDIT_USERNAME,
    phase: "recent",
    period: PERIOD,
    httpStatus: 504,
    attempts: 3,
    batchSize: 2,
    logins: ["first-user", "second-user"],
  };
}

function successfulPayload(bodyText: string): unknown {
  const body = JSON.parse(bodyText) as {
    variables: Record<string, string>;
  };
  const data: Record<string, unknown> = {
    rateLimit: {
      cost: 1,
      limit: 5_000,
      remaining: 4_999,
      resetAt: "2026-08-25T03:00:00.000Z",
    },
  };
  for (let index = 0; index < 2; index += 1) {
    const login = body.variables["login" + index]!;
    data["u" + index] = {
      login,
      contributionsCollection: {
        startedAt: PERIOD.from,
        endedAt: PERIOD.to,
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

function captureIO(): {
  io: RecentBatchInvestigationIO;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      log(message) {
        logs.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
    logs,
    errors,
  };
}

describe("recent batch investigation CLI arguments", () => {
  it("parses a username and supports help", () => {
    assert.deepEqual(parseRecentBatchInvestigationArgs([AUDIT_USERNAME]), {
      help: false,
      auditUsername: AUDIT_USERNAME,
    });
    assert.deepEqual(parseRecentBatchInvestigationArgs(["--help"]), {
      help: true,
    });
    assert.deepEqual(parseRecentBatchInvestigationArgs(["-h"]), {
      help: true,
    });
  });

  it("rejects missing, invalid and extra arguments", () => {
    assert.throws(() => parseRecentBatchInvestigationArgs([]));
    assert.throws(() => parseRecentBatchInvestigationArgs(["bad/user"]));
    assert.throws(() =>
      parseRecentBatchInvestigationArgs([AUDIT_USERNAME, "extra"]),
    );
  });

  it("shows help without a token or request", async () => {
    const captured = captureIO();
    let requested = false;
    const exitCode = await runRecentBatchInvestigationCli(["--help"], {
      fetch: (async () => {
        requested = true;
        return new Response();
      }) as typeof fetch,
      io: captured.io,
    });

    assert.equal(exitCode, 0);
    assert.equal(requested, false);
    assert.deepEqual(captured.logs, [RECENT_BATCH_INVESTIGATION_HELP]);
    assert.equal(captured.errors.length, 0);
  });

  it("uses exit code 2 for a missing username and 1 for a missing token", async () => {
    const missingUser = captureIO();
    const missingToken = captureIO();

    assert.equal(
      await runRecentBatchInvestigationCli([], { io: missingUser.io }),
      2,
    );
    assert.match(missingUser.errors[0] ?? "", /Usage:/);
    assert.equal(
      await runRecentBatchInvestigationCli([AUDIT_USERNAME], {
        io: missingToken.io,
      }),
      1,
    );
    assert.match(missingToken.errors[0] ?? "", /GITHUB_TOKEN is required/);
  });
});

describe("recent batch investigation CLI isolation", () => {
  it("reads only the source JSONL, calls only GraphQL and preserves audit files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-cli-investigation-"));
    const sourceRoot = join(root, "diagnostics");
    const investigationsRoot = join(sourceRoot, "investigations");
    const checkpointPath = join(root, "checkpoints", "audituser.json");
    const reportPath = join(root, "reports", "existing.json");
    const sourcePath = recentBatchFailureDiagnosticPathFor(
      AUDIT_USERNAME,
      sourceRoot,
    );
    const sourceContents = JSON.stringify(sourceIncident()) + "\n";
    const checkpointContents =
      JSON.stringify({ checkpoint: "unchanged" }) + "\n";
    const reportContents = JSON.stringify({ report: "unchanged" }) + "\n";
    const captured = captureIO();
    let requests = 0;
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(join(root, "checkpoints"), { recursive: true });
      await mkdir(join(root, "reports"), { recursive: true });
      await writeFile(sourcePath, sourceContents, "utf8");
      await writeFile(checkpointPath, checkpointContents, "utf8");
      await writeFile(reportPath, reportContents, "utf8");

      const exitCode = await runRecentBatchInvestigationCli(
        [AUDIT_USERNAME],
        {
          token: "obvious-test-placeholder",
          sourceRoot,
          investigationsRoot,
          now: TEST_NOW,
          sleep: async () => undefined,
          fetch: (async (
            input: string | URL | Request,
            init?: RequestInit,
          ) => {
            requests += 1;
            assert.equal(String(input), "https://api.github.com/graphql");
            const body = String(init?.body);
            const parsed = JSON.parse(body) as {
              variables: Record<string, string>;
            };
            assert.equal(parsed.variables.login0, "first-user");
            assert.equal(parsed.variables.login1, "second-user");
            assert.equal(parsed.variables.from, PERIOD.from);
            assert.equal(parsed.variables.to, PERIOD.to);
            return new Response(JSON.stringify(successfulPayload(body)), {
              status: 200,
            });
          }) as typeof fetch,
          io: captured.io,
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(requests, 1);
      assert.equal(await readFile(sourcePath, "utf8"), sourceContents);
      assert.equal(await readFile(checkpointPath, "utf8"), checkpointContents);
      assert.equal(await readFile(reportPath, "utf8"), reportContents);
      const files = await readdir(investigationsRoot);
      assert.equal(files.length, 1);
      const saved = await readFile(join(investigationsRoot, files[0]!), "utf8");
      const savedResult = JSON.parse(saved) as { conclusion: string };
      assert.equal(savedResult.conclusion, "NOT_REPRODUCED");
      assert.doesNotMatch(saved, /obvious-test-placeholder/i);
      assert.doesNotMatch(saved, /authorization/i);
      assert.match(captured.logs[0] ?? "", /Recent batch investigation/);
      assert.match(captured.logs[0] ?? "", /NOT_REPRODUCED|not reproduced/i);
      assert.equal(captured.errors.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves an inconclusive result and exits 1 after exhausted HTTP 503", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-cli-503-"));
    const sourceRoot = join(root, "diagnostics");
    const investigationsRoot = join(sourceRoot, "investigations");
    const sourcePath = recentBatchFailureDiagnosticPathFor(
      AUDIT_USERNAME,
      sourceRoot,
    );
    const sourceContents = JSON.stringify(sourceIncident()) + "\n";
    const captured = captureIO();
    let requests = 0;
    try {
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(sourcePath, sourceContents, "utf8");

      const exitCode = await runRecentBatchInvestigationCli(
        [AUDIT_USERNAME],
        {
          token: "obvious-test-placeholder",
          sourceRoot,
          investigationsRoot,
          now: TEST_NOW,
          sleep: async () => undefined,
          fetch: (async () => {
            requests += 1;
            return new Response("", { status: 503 });
          }) as typeof fetch,
          io: captured.io,
        },
      );

      assert.equal(exitCode, 1);
      assert.equal(requests, 3);
      assert.equal(await readFile(sourcePath, "utf8"), sourceContents);
      const files = await readdir(investigationsRoot);
      assert.equal(files.length, 1);
      const saved = await readFile(join(investigationsRoot, files[0]!), "utf8");
      const savedResult = JSON.parse(saved) as {
        conclusion: string;
        tree: Array<{ outcome: string }>;
      };
      assert.equal(savedResult.conclusion, "INCONCLUSIVE");
      assert.equal(savedResult.tree[0]?.outcome, "SERVICE_UNAVAILABLE");
      assert.doesNotMatch(saved, /obvious-test-placeholder/i);
      assert.match(captured.logs[0] ?? "", /SERVICE_UNAVAILABLE/);
      assert.equal(captured.errors.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not request or persist when no valid source incident exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-cli-source-error-"));
    const sourceRoot = join(root, "diagnostics");
    const investigationsRoot = join(sourceRoot, "investigations");
    const sourcePath = recentBatchFailureDiagnosticPathFor(
      AUDIT_USERNAME,
      sourceRoot,
    );
    const captured = captureIO();
    let requested = false;
    try {
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(sourcePath, "{invalid}\n", "utf8");
      const exitCode = await runRecentBatchInvestigationCli(
        [AUDIT_USERNAME],
        {
          token: "obvious-test-placeholder",
          sourceRoot,
          investigationsRoot,
          fetch: (async () => {
            requested = true;
            return new Response();
          }) as typeof fetch,
          io: captured.io,
        },
      );

      assert.equal(exitCode, 1);
      assert.equal(requested, false);
      assert.match(captured.errors[0] ?? "", /No valid recent batch failure/);
      await assert.rejects(access(investigationsRoot));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
