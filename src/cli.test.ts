import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HELP } from "./args.js";
import { checkpointPathFor } from "./checkpoint.js";
import { runCli, TOKEN_REQUIRED_MESSAGE, type CliIO } from "./cli.js";

function emptyFollowingFetch(): typeof fetch {
  return (async () =>
    new Response("[]", {
      status: 200,
      headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
      },
    })) as typeof fetch;
}

it("requires GITHUB_TOKEN before activity analysis without making a request", async () => {
  const errors: string[] = [];
  let fetchCalled = false;
  const io: CliIO = {
    log() {},
    error(message) {
      errors.push(message);
    },
  };
  const fetchMock = (async () => {
    fetchCalled = true;
    return new Response("[]");
  }) as typeof fetch;

  const exitCode = await runCli(["octocat"], { io, fetch: fetchMock });

  assert.equal(exitCode, 1);
  assert.equal(fetchCalled, false);
  assert.deepEqual(errors, [TOKEN_REQUIRED_MESSAGE]);
});

describe("CLI options", () => {
  it("shows help without a username, token or request", async () => {
    const logs: string[] = [];
    let fetchCalled = false;
    const exitCode = await runCli(["--help"], {
      fetch: (async () => {
        fetchCalled = true;
        return new Response("[]");
      }) as typeof fetch,
      io: {
        log(message) {
          logs.push(message);
        },
        error() {},
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(fetchCalled, false);
    assert.deepEqual(logs, [HELP]);
  });

  it("reports argument errors with exit code 2 and a help hint", async () => {
    for (const args of [
      [] as string[],
      ["octocat", "--foo"],
      ["octocat", "--json"],
      ["octocat", "--csv"],
      ["octocat", "--days", "0"],
    ]) {
      const errors: string[] = [];
      const exitCode = await runCli(args, {
        io: { log() {}, error: (message) => errors.push(message) },
      });
      assert.equal(exitCode, 2);
      assert.match(errors[0] ?? "", /Use --help for usage information/);
    }
  });

  it("writes JSON and CSV together while preserving the terminal report", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-cli-"));
    const jsonPath = join(root, "reports", "audit.json");
    const csvPath = join(root, "reports", "audit.csv");
    const logs: string[] = [];

    try {
      const exitCode = await runCli(
        [
          "octocat",
          "--days",
          "180",
          "--json",
          jsonPath,
          "--csv",
          csvPath,
        ],
        {
          token: "obvious-test-placeholder",
          fetch: emptyFollowingFetch(),
          now: new Date("2026-08-22T00:00:00.000Z"),
          checkpointRoot: join(root, "checkpoints"),
          io: { log: (message) => logs.push(message), error() {} },
        },
      );

      assert.equal(exitCode, 0);
      assert.match(logs[0] ?? "", /Period: last 180 days/);
      assert.match(logs[1] ?? "", /Exports\n-------/);
      assert.match(logs[1] ?? "", /JSON:/);
      assert.match(logs[1] ?? "", /CSV:/);

      const json = JSON.parse(await readFile(jsonPath, "utf8")) as {
        schemaVersion: number;
        period: { days: number };
        accounts: unknown[];
      };
      assert.equal(json.schemaVersion, 1);
      assert.equal(json.period.days, 180);
      assert.deepEqual(json.accounts, []);
      assert.match(await readFile(csvPath, "utf8"), /^login,profile_url/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a clear non-zero error and does not announce a failed export", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-cli-error-"));
    const blockingPath = join(root, "not-a-directory");
    await writeFile(blockingPath, "file", "utf8");
    const logs: string[] = [];
    const errors: string[] = [];

    try {
      const exitCode = await runCli(
        ["octocat", "--json", join(blockingPath, "audit.json")],
        {
          token: "obvious-test-placeholder",
          fetch: emptyFollowingFetch(),
          now: new Date("2026-08-22T00:00:00.000Z"),
          checkpointRoot: join(root, "checkpoints"),
          io: {
            log: (message) => logs.push(message),
            error: (message) => errors.push(message),
          },
        },
      );

      assert.equal(exitCode, 1);
      assert.match(errors[0] ?? "", /Failed to write JSON export/);
      assert.equal(logs.some((message) => message.startsWith("Exports\n")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the checkpoint after a successful complete audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-success-"));
    const path = checkpointPathFor("octocat", root);
    try {
      const exitCode = await runCli(["octocat"], {
        token: "obvious-test-placeholder",
        fetch: emptyFollowingFetch(),
        checkpointRoot: root,
        now: new Date("2026-08-24T00:00:00.000Z"),
        io: { log() {}, error() {} },
      });

      assert.equal(exitCode, 0);
      await assert.rejects(access(path));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves a resolved batch and prints reset/resume instructions at zero quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-rate-limit-"));
    const path = checkpointPathFor("octocat", root);
    const following = Array.from({ length: 26 }, (_, index) => ({
      login: `user-${index}`,
      id: index + 1,
      type: "User",
      html_url: `https://github.com/user-${index}`,
    }));
    let graphQLRequests = 0;
    const resetAt = "2026-08-24T01:00:00.000Z";
    const fetchMock = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).includes("/following")) {
        return new Response(JSON.stringify(following), {
          status: 200,
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4999",
          },
        });
      }
      graphQLRequests += 1;
      const body = JSON.parse(String(init?.body)) as {
        variables: Record<string, string>;
      };
      const data: Record<string, unknown> = {
        rateLimit: {
          cost: 1,
          limit: 5000,
          remaining: 0,
          resetAt,
        },
      };
      for (let index = 0; index < 25; index += 1) {
        const login = body.variables[`login${index}`]!;
        data[`u${index}`] = {
          login,
          contributionsCollection: {
            startedAt: "2025-08-24T00:00:00.000Z",
            endedAt: "2026-08-24T00:00:00.000Z",
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
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    const logs: string[] = [];
    const errors: string[] = [];

    try {
      const exitCode = await runCli(["octocat"], {
        token: "obvious-test-placeholder",
        fetch: fetchMock,
        checkpointRoot: root,
        now: new Date("2026-08-24T00:00:00.000Z"),
        io: {
          log: (message) => logs.push(message),
          error: (message) => errors.push(message),
        },
      });

      assert.equal(exitCode, 1);
      assert.equal(graphQLRequests, 1);
      assert.deepEqual(logs, ["Analyzing recent activity: 25 / 26"]);
      assert.match(errors[0] ?? "", /GitHub GraphQL rate limit exhausted/);
      assert.match(errors[0] ?? "", /Progress saved/);
      assert.match(errors[0] ?? "", new RegExp(resetAt));
      assert.match(errors[0] ?? "", /npm run start -- octocat --resume/);
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        completedRecentActivity: Record<string, unknown>;
      };
      assert.equal(Object.keys(saved.completedRecentActivity).length, 25);
      assert.doesNotMatch(await readFile(path, "utf8"), /obvious-test-placeholder/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
