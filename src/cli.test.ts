import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HELP, parseArgs } from "./args.js";
import {
  checkpointHistoricalResults,
  checkpointPathFor,
  checkpointRecentResults,
  createCheckpoint,
  loadCheckpoint,
  recordHistoricalResult,
  recordRecentResults,
  writeCheckpointAtomic,
} from "./checkpoint.js";
import {
  formatSuggestedResumeCommand,
  runCli,
  TOKEN_REQUIRED_MESSAGE,
  type CliIO,
} from "./cli.js";
import type { FollowedAccount } from "./domain/account.js";
import {
  createActivityPeriod,
  type AccountActivityResult,
} from "./domain/activity.js";

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

const activeFollowedAccount: FollowedAccount = {
  login: "active-user",
  id: 1,
  type: "User",
  htmlUrl: "https://github.com/active-user",
};

function activeResult(period: ReturnType<typeof createActivityPeriod>): AccountActivityResult {
  return {
    account: activeFollowedAccount,
    status: "ACTIVE",
    activity: {
      login: activeFollowedAccount.login,
      periodStart: period.from,
      periodEnd: period.to,
      totalContributions: 1,
      totalCommitContributions: 1,
      totalIssueContributions: 0,
      totalPullRequestContributions: 0,
      totalPullRequestReviewContributions: 0,
      restrictedContributionsCount: 0,
      hasAnyContributions: true,
      hasAnyRestrictedContributions: false,
      hasActivityInThePast: false,
    },
  };
}

function activeFollowingFetch(counter: { graphql: number }): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (String(input).includes("/following")) {
      return new Response(
        JSON.stringify([
          {
            login: activeFollowedAccount.login,
            id: activeFollowedAccount.id,
            type: activeFollowedAccount.type,
            html_url: activeFollowedAccount.htmlUrl,
          },
        ]),
        {
          status: 200,
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4999",
          },
        },
      );
    }
    counter.graphql += 1;
    return new Response(
      JSON.stringify({
        data: {
          u0: {
            login: activeFollowedAccount.login,
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
          },
          rateLimit: {
            cost: 1,
            limit: 5000,
            remaining: 4998,
            resetAt: "2026-08-24T01:00:00.000Z",
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

function quietAccounts(count: number): FollowedAccount[] {
  return Array.from({ length: count }, (_, index) => ({
    login: `quiet-${index}`,
    id: index + 1,
    type: "User",
    htmlUrl: `https://github.com/quiet-${index}`,
  }));
}

function quietResult(
  account: FollowedAccount,
  period: ReturnType<typeof createActivityPeriod>,
): AccountActivityResult {
  return {
    account,
    status: "NO_RECENT_VISIBLE_ACTIVITY",
    activity: {
      login: account.login,
      periodStart: period.from,
      periodEnd: period.to,
      totalContributions: 0,
      totalCommitContributions: 0,
      totalIssueContributions: 0,
      totalPullRequestContributions: 0,
      totalPullRequestReviewContributions: 0,
      restrictedContributionsCount: 0,
      hasAnyContributions: false,
      hasAnyRestrictedContributions: false,
      hasActivityInThePast: false,
    },
  };
}

function quietFollowingFetch(
  accounts: readonly FollowedAccount[],
  calls: { recent: number; historical: number },
): typeof fetch {
  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(input).includes("/following")) {
      return new Response(
        JSON.stringify(
          accounts.map(({ login, id, type, htmlUrl }) => ({
            login,
            id,
            type,
            html_url: htmlUrl,
          })),
        ),
        {
          status: 200,
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4999",
          },
        },
      );
    }

    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    if (body.query.includes("HistoricalActivity")) {
      calls.historical += 1;
      return new Response(
        JSON.stringify({
          data: {
            user: {
              login: body.variables.login,
              contributionsCollection: {
                startedAt: body.variables.from,
                endedAt: body.variables.to,
                hasAnyContributions: false,
                hasAnyRestrictedContributions: false,
                restrictedContributionsCount: 0,
                latestRestrictedContributionDate: null,
                contributionCalendar: { totalContributions: 0, weeks: [] },
              },
            },
            rateLimit: {
              cost: 1,
              limit: 5000,
              remaining: 4900,
              resetAt: "2026-08-24T01:00:00.000Z",
            },
          },
        }),
        { status: 200 },
      );
    }

    calls.recent += 1;
    const data: Record<string, unknown> = {
      rateLimit: {
        cost: 1,
        limit: 5000,
        remaining: 4998,
        resetAt: "2026-08-24T01:00:00.000Z",
      },
    };
    const logins = Object.entries(body.variables)
      .filter(([key]) => key.startsWith("login"))
      .map(([, login]) => login);
    for (const [index, login] of logins.entries()) {
      data[`u${index}`] = {
        login,
        contributionsCollection: {
          startedAt: body.variables.from,
          endedAt: body.variables.to,
          hasAnyContributions: false,
          hasAnyRestrictedContributions: false,
          hasActivityInThePast: false,
          restrictedContributionsCount: 0,
          totalCommitContributions: 0,
          totalIssueContributions: 0,
          totalPullRequestContributions: 0,
          totalPullRequestReviewContributions: 0,
          contributionCalendar: { totalContributions: 0 },
        },
      };
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
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
  it("builds deterministic and parseable resume commands", () => {
    const cases = [
      {
        options: { username: "user", days: 365, historyYears: 0 },
        expected: "npm run start -- user --days 365 --resume",
      },
      {
        options: { username: "user", days: 180, historyYears: 0 },
        expected: "npm run start -- user --days 180 --resume",
      },
      {
        options: {
          username: "user",
          days: 365,
          historyYears: 0,
          jsonPath: "reports/user.json",
        },
        expected:
          "npm run start -- user --days 365 --resume --json reports/user.json",
      },
      {
        options: {
          username: "user",
          days: 365,
          historyYears: 0,
          csvPath: "reports/user.csv",
        },
        expected:
          "npm run start -- user --days 365 --resume --csv reports/user.csv",
      },
      {
        options: {
          username: "user",
          days: 365,
          historyYears: 0,
          jsonPath: "reports/user.json",
          csvPath: "reports/user.csv",
        },
        expected:
          "npm run start -- user --days 365 --resume --json reports/user.json --csv reports/user.csv",
      },
      {
        options: { username: "user", days: 365, historyYears: 3 },
        expected:
          "npm run start -- user --days 365 --history-years 3 --resume",
      },
      {
        options: {
          username: "user",
          days: 365,
          historyYears: 3,
          jsonPath: "reports/user.json",
          csvPath: "reports/user.csv",
        },
        expected:
          "npm run start -- user --days 365 --history-years 3 --resume --json reports/user.json --csv reports/user.csv",
      },
    ];

    for (const { options, expected } of cases) {
      const command = formatSuggestedResumeCommand(options);
      assert.equal(command, expected);
      const parsed = parseArgs(command.split(" ").slice(4));
      assert.equal(parsed.help, false);
      if (parsed.help) continue;
      assert.equal(parsed.days, options.days);
      assert.equal(parsed.historyYears ?? 0, options.historyYears);
      assert.equal(parsed.jsonPath, options.jsonPath);
      assert.equal(parsed.csvPath, options.csvPath);
      assert.equal(parsed.resume, true);
    }
  });

  it("quotes a path with spaces without exposing unrelated secrets", () => {
    const command = formatSuggestedResumeCommand({
      username: "user",
      days: 365,
      historyYears: 0,
      jsonPath: "reports/my report.json",
    });

    assert.equal(
      command,
      "npm run start -- user --days 365 --resume --json 'reports/my report.json'",
    );
    assert.doesNotMatch(command, /GITHUB_TOKEN|Authorization|secret-value/);
  });

  it("quotes a Windows export path containing backslashes", () => {
    const command = formatSuggestedResumeCommand({
      username: "user",
      days: 365,
      historyYears: 0,
      jsonPath: String.raw`C:\reports\audit.json`,
    });

    assert.equal(
      command,
      "npm run start -- user --days 365 --resume --json 'C:\\reports\\audit.json'",
    );
  });

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
      ["octocat", "--history-years", "0"],
      ["octocat", "--history-years", "6"],
      ["octocat", "--history-years", "1.5"],
      ["octocat", "--history-years", "foo"],
      ["octocat", "--history-years"],
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
      assert.match(logs[0] ?? "", /Historical lookup: disabled/);
      assert.match(logs[1] ?? "", /Exports\n-------/);
      assert.match(logs[1] ?? "", /JSON:/);
      assert.match(logs[1] ?? "", /CSV:/);

      const json = JSON.parse(await readFile(jsonPath, "utf8")) as {
        schemaVersion: number;
        period: { days: number };
        history: { years: number };
        accounts: unknown[];
      };
      assert.equal(json.schemaVersion, 1);
      assert.equal(json.period.days, 180);
      assert.equal(json.history.years, 0);
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

  it("reports fresh historical progress from the callback actual total", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-fresh-progress-"));
    const accounts = quietAccounts(11);
    const calls = { recent: 0, historical: 0 };
    const logs: string[] = [];

    try {
      assert.equal(
        await runCli(["owner", "--history-years", "1"], {
          token: "test-placeholder",
          fetch: quietFollowingFetch(accounts, calls),
          checkpointRoot: join(root, "checkpoints"),
          now: new Date("2026-08-24T00:00:00.000Z"),
          io: { log: (message) => logs.push(message), error() {} },
        }),
        0,
      );
      assert.equal(calls.recent, 1);
      assert.equal(calls.historical, 11);
      assert.deepEqual(
        logs.filter((message) =>
          message.startsWith("Analyzing historical activity:"),
        ),
        [
          "Analyzing historical activity: 10 / 11",
          "Analyzing historical activity: 11 / 11",
        ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not report or request historical work when history is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-no-history-progress-"));
    const calls = { recent: 0, historical: 0 };
    const logs: string[] = [];

    try {
      assert.equal(
        await runCli(["owner"], {
          token: "test-placeholder",
          fetch: quietFollowingFetch(quietAccounts(11), calls),
          checkpointRoot: join(root, "checkpoints"),
          now: new Date("2026-08-24T00:00:00.000Z"),
          io: { log: (message) => logs.push(message), error() {} },
        }),
        0,
      );
      assert.equal(calls.recent, 1);
      assert.equal(calls.historical, 0);
      assert.equal(
        logs.some((message) =>
          message.startsWith("Analyzing historical activity:"),
        ),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports resume historical progress once with reused completion included", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-resume-progress-"));
    const checkpointRoot = join(root, "checkpoints");
    const path = checkpointPathFor("owner", checkpointRoot);
    const now = new Date("2026-08-24T00:00:00.000Z");
    const period = createActivityPeriod(now);
    const accounts = quietAccounts(3);
    const recent = accounts.map((account) => quietResult(account, period));
    const checkpoint = createCheckpoint("owner", period, accounts, now, 1);
    recordRecentResults(checkpoint, recent);
    recordHistoricalResult(checkpoint, {
      ...recent[0]!,
      lastVisibleActivityAt: null,
      historicalLookupStatus: "NOT_FOUND_IN_LOOKBACK",
    });
    await writeCheckpointAtomic(path, checkpoint, now);
    const calls = { recent: 0, historical: 0 };
    const logs: string[] = [];

    try {
      assert.equal(
        await runCli(["owner", "--resume"], {
          token: "test-placeholder",
          fetch: quietFollowingFetch(accounts, calls),
          checkpointRoot,
          now,
          io: { log: (message) => logs.push(message), error() {} },
        }),
        0,
      );
      assert.equal(calls.recent, 0);
      assert.equal(calls.historical, 2);
      assert.deepEqual(
        logs.filter((message) =>
          message.startsWith("Analyzing historical activity:"),
        ),
        ["Analyzing historical activity: 3 / 3"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fresh audits ignore existing checkpoint history and completed results", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-fresh-history-"));
    const checkpointRoot = join(root, "checkpoints");
    const path = checkpointPathFor("octocat", checkpointRoot);
    const now = new Date("2026-08-24T00:00:00.000Z");
    const period = createActivityPeriod(now);
    const counter = { graphql: 0 };

    try {
      const oldFiveYearAudit = createCheckpoint(
        "octocat",
        period,
        [activeFollowedAccount],
        now,
        5,
      );
      recordRecentResults(oldFiveYearAudit, [activeResult(period)]);
      await writeCheckpointAtomic(path, oldFiveYearAudit, now);
      const defaultJson = join(root, "default.json");
      assert.equal(
        await runCli(["octocat", "--json", defaultJson], {
          token: "test-placeholder",
          fetch: activeFollowingFetch(counter),
          checkpointRoot,
          now,
          io: { log() {}, error() {} },
        }),
        0,
      );
      assert.equal(counter.graphql, 1);
      assert.equal(
        (JSON.parse(await readFile(defaultJson, "utf8")) as {
          history: { years: number };
        }).history.years,
        0,
      );

      const oldDisabledAudit = createCheckpoint(
        "octocat",
        period,
        [activeFollowedAccount],
        now,
        0,
      );
      recordRecentResults(oldDisabledAudit, [activeResult(period)]);
      await writeCheckpointAtomic(path, oldDisabledAudit, now);
      counter.graphql = 0;
      const threeYearJson = join(root, "three-years.json");
      assert.equal(
        await runCli(
          ["octocat", "--history-years", "3", "--json", threeYearJson],
          {
            token: "test-placeholder",
            fetch: activeFollowingFetch(counter),
            checkpointRoot,
            now,
            io: { log() {}, error() {} },
          },
        ),
        0,
      );
      assert.equal(counter.graphql, 1);
      assert.equal(
        (JSON.parse(await readFile(threeYearJson, "utf8")) as {
          history: { years: number };
        }).history.years,
        3,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resume inherits saved history, accepts a match and rejects a mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-resume-history-"));
    const checkpointRoot = join(root, "checkpoints");
    const path = checkpointPathFor("octocat", checkpointRoot);
    const now = new Date("2026-08-24T00:00:00.000Z");
    const period = createActivityPeriod(now);

    try {
      await writeCheckpointAtomic(
        path,
        createCheckpoint("octocat", period, [], now, 3),
        now,
      );
      const inheritedJson = join(root, "inherited.json");
      assert.equal(
        await runCli(["octocat", "--resume", "--json", inheritedJson], {
          token: "test-placeholder",
          fetch: emptyFollowingFetch(),
          checkpointRoot,
          now,
          io: { log() {}, error() {} },
        }),
        0,
      );
      assert.equal(
        (JSON.parse(await readFile(inheritedJson, "utf8")) as {
          history: { years: number };
        }).history.years,
        3,
      );

      await writeCheckpointAtomic(
        path,
        createCheckpoint("octocat", period, [], now, 0),
        now,
      );
      const disabledJson = join(root, "disabled.json");
      assert.equal(
        await runCli(["octocat", "--resume", "--json", disabledJson], {
          token: "test-placeholder",
          fetch: emptyFollowingFetch(),
          checkpointRoot,
          now,
          io: { log() {}, error() {} },
        }),
        0,
      );
      assert.equal(
        (JSON.parse(await readFile(disabledJson, "utf8")) as {
          history: { years: number };
        }).history.years,
        0,
      );

      await writeCheckpointAtomic(
        path,
        createCheckpoint("octocat", period, [], now, 3),
        now,
      );
      assert.equal(
        await runCli(["octocat", "--resume", "--history-years", "3"], {
          token: "test-placeholder",
          fetch: emptyFollowingFetch(),
          checkpointRoot,
          now,
          io: { log() {}, error() {} },
        }),
        0,
      );

      await writeCheckpointAtomic(
        path,
        createCheckpoint("octocat", period, [], now, 3),
        now,
      );
      const errors: string[] = [];
      assert.equal(
        await runCli(["octocat", "--resume", "--history-years", "1"], {
          token: "test-placeholder",
          fetch: emptyFollowingFetch(),
          checkpointRoot,
          now,
          io: { log() {}, error: (message) => errors.push(message) },
        }),
        1,
      );
      assert.match(errors[0] ?? "", /does not match requested --history-years 1/);
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
      for (let index = 0; index < 12; index += 1) {
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
      const exitCode = await runCli(
        [
          "octocat",
          "--days",
          "180",
          "--history-years",
          "3",
          "--json",
          "reports/user.json",
          "--csv",
          "reports/user.csv",
        ],
        {
          token: "obvious-test-placeholder",
          fetch: fetchMock,
          checkpointRoot: root,
          now: new Date("2026-08-24T00:00:00.000Z"),
          sleep: async () => undefined,
          io: {
            log: (message) => logs.push(message),
            error: (message) => errors.push(message),
          },
        },
      );

      assert.equal(exitCode, 1);
      assert.equal(graphQLRequests, 1);
      assert.deepEqual(logs, ["Analyzing recent activity: 12 / 26"]);
      assert.match(errors[0] ?? "", /GitHub GraphQL primary rate limit exhausted/);
      assert.doesNotMatch(errors[0] ?? "", /secondary rate limit/);
      assert.match(errors[0] ?? "", /Progress saved/);
      assert.match(errors[0] ?? "", new RegExp(resetAt));
      assert.match(
        errors[0] ?? "",
        /npm run start -- octocat --days 180 --history-years 3 --resume --json reports\/user\.json --csv reports\/user\.csv/,
      );
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        completedRecentActivity: Record<string, unknown>;
      };
      assert.equal(Object.keys(saved.completedRecentActivity).length, 12);
      assert.doesNotMatch(await readFile(path, "utf8"), /obvious-test-placeholder/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps retry backoff and top-level pacing independent before a secondary limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-secondary-limit-"));
    const path = checkpointPathFor("octocat", root);
    const following = Array.from({ length: 13 }, (_, index) => ({
      login: `secondary-${index}`,
      id: index + 1,
      type: "User",
      html_url: `https://github.com/secondary-${index}`,
    }));
    let graphQLRequests = 0;
    const delays: number[] = [];
    const sleepAfterRequests: number[] = [];
    const fetchMock = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).includes("/following")) {
        return new Response(JSON.stringify(following), { status: 200 });
      }
      graphQLRequests += 1;
      if (graphQLRequests === 1) {
        return new Response("", { status: 504 });
      }
      if (graphQLRequests === 3) {
        return new Response(
          JSON.stringify({
            message:
              "You have exceeded a secondary rate limit. Authorization: secret-body",
          }),
          {
            status: 403,
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4864",
              "retry-after": "60",
            },
          },
        );
      }
      const body = JSON.parse(String(init?.body)) as {
        variables: Record<string, string>;
      };
      const data: Record<string, unknown> = {
        rateLimit: {
          cost: 1,
          limit: 5000,
          remaining: 4864,
          resetAt: "2026-08-24T01:00:00.000Z",
        },
      };
      for (let index = 0; index < 12; index += 1) {
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
    const errors: string[] = [];

    try {
      const exitCode = await runCli([
        "octocat",
        "--days",
        "365",
        "--json",
        "reports/user.json",
        "--csv",
        "reports/user.csv",
      ], {
        token: "top-secret-token",
        fetch: fetchMock,
        checkpointRoot: root,
        now: new Date("2026-08-24T00:00:00.000Z"),
        sleep: async (delay) => {
          delays.push(delay);
          sleepAfterRequests.push(graphQLRequests);
        },
        io: { log() {}, error: (message) => errors.push(message) },
      });

      assert.equal(exitCode, 1);
      assert.equal(graphQLRequests, 3);
      assert.deepEqual(delays, [1_000, 1_000]);
      assert.deepEqual(sleepAfterRequests, [1, 2]);
      assert.match(errors[0] ?? "", /GitHub GraphQL secondary rate limit reached/);
      assert.match(errors[0] ?? "", /cooldown of 60 seconds/);
      assert.match(errors[0] ?? "", /Primary GraphQL quota remaining: 4864 \/ 5000/);
      assert.match(errors[0] ?? "", /Progress saved/);
      assert.match(
        errors[0] ?? "",
        /npm run start -- octocat --days 365 --resume --json reports\/user\.json --csv reports\/user\.csv/,
      );
      assert.doesNotMatch(
        errors[0] ?? "",
        /primary rate limit exhausted|top-secret-token|secret-body|Authorization/i,
      );
      const serialized = await readFile(path, "utf8");
      const saved = JSON.parse(serialized) as {
        completedRecentActivity: Record<string, unknown>;
      };
      assert.equal(Object.keys(saved.completedRecentActivity).length, 12);
      assert.doesNotMatch(serialized, /top-secret-token|secret-body|Authorization/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unclassified REST rate limit without inventing primary or secondary", async () => {
    const errors: string[] = [];
    let requests = 0;
    const exitCode = await runCli(["octocat"], {
      token: "unknown-secret-token",
      fetch: (async () => {
        requests += 1;
        return new Response('{"message":"Request temporarily restricted."}', {
          status: 429,
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4864",
          },
        });
      }) as typeof fetch,
      sleep: async () => {
        throw new Error("sleep must not be called");
      },
      io: { log() {}, error: (message) => errors.push(message) },
    });

    assert.equal(exitCode, 1);
    assert.equal(requests, 1);
    assert.match(errors[0] ?? "", /GitHub API rate limit encountered/);
    assert.match(errors[0] ?? "", /did not provide enough information/);
    assert.match(errors[0] ?? "", /Primary API quota remaining: 4864 \/ 5000/);
    assert.doesNotMatch(
      errors[0] ?? "",
      /primary rate limit exhausted|secondary rate limit reached|unknown-secret-token/i,
    );
  });

  it("preserves exports when a resumed audit hits an UNKNOWN GraphQL rate limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-resume-exports-"));
    const checkpointRoot = join(root, "checkpoints");
    const now = new Date("2026-08-24T00:00:00.000Z");
    const period = createActivityPeriod(now);
    const checkpoint = createCheckpoint(
      "octocat",
      period,
      [activeFollowedAccount],
      now,
    );
    await writeCheckpointAtomic(
      checkpointPathFor("octocat", checkpointRoot),
      checkpoint,
      now,
    );
    const errors: string[] = [];
    let graphQLRequests = 0;

    try {
      const exitCode = await runCli(
        [
          "octocat",
          "--days",
          "365",
          "--resume",
          "--json",
          "reports/user.json",
          "--csv",
          "reports/user.csv",
        ],
        {
          token: "test-placeholder",
          checkpointRoot,
          now,
          fetch: (async (input: string | URL | Request) => {
            if (String(input).includes("/following")) {
              return new Response(
                JSON.stringify([
                  {
                    login: activeFollowedAccount.login,
                    id: activeFollowedAccount.id,
                    type: activeFollowedAccount.type,
                    html_url: activeFollowedAccount.htmlUrl,
                  },
                ]),
                { status: 200 },
              );
            }
            graphQLRequests += 1;
            return new Response(
              '{"message":"Request temporarily restricted."}',
              {
                status: 429,
                headers: {
                  "x-ratelimit-limit": "5000",
                  "x-ratelimit-remaining": "4864",
                },
              },
            );
          }) as typeof fetch,
          sleep: async () => {
            throw new Error("sleep must not be called");
          },
          io: { log() {}, error: (message) => errors.push(message) },
        },
      );

      assert.equal(exitCode, 1);
      assert.equal(graphQLRequests, 1);
      assert.match(errors[0] ?? "", /GitHub GraphQL rate limit encountered/);
      assert.match(errors[0] ?? "", /Progress saved/);
      assert.match(
        errors[0] ?? "",
        /npm run start -- octocat --days 365 --resume --json reports\/user\.json --csv reports\/user\.csv/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the manual secondary wait guidance when Retry-After is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-secondary-wait-"));
    const errors: string[] = [];
    let requests = 0;

    try {
      const exitCode = await runCli(["octocat", "--days", "365"], {
        token: "test-placeholder",
        checkpointRoot: root,
        fetch: (async (input: string | URL | Request) => {
          requests += 1;
          if (String(input).includes("/following")) {
            return new Response(
              JSON.stringify([
                {
                  login: "secondary-wait",
                  id: 1,
                  type: "User",
                  html_url: "https://github.com/secondary-wait",
                },
              ]),
              { status: 200 },
            );
          }
          return new Response(
            '{"message":"Secondary rate limit reached."}',
            {
              status: 403,
              headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4800",
              },
            },
          );
        }) as typeof fetch,
        sleep: async () => {
          throw new Error("sleep must not be called");
        },
        io: { log() {}, error: (message) => errors.push(message) },
      });

      assert.equal(exitCode, 1);
      assert.equal(requests, 2);
      assert.match(errors[0] ?? "", /GitHub did not provide Retry-After/);
      assert.match(errors[0] ?? "", /at least one minute/);
      assert.match(errors[0] ?? "", /Progress saved/);
      await access(checkpointPathFor("octocat", root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resume corrects legacy NO_PAST_ACTIVITY without repeating recent and persists the new historical result", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-legacy-resume-"));
    const checkpointRoot = join(root, "checkpoints");
    const path = checkpointPathFor("octocat", checkpointRoot);
    const now = new Date("2026-08-24T23:41:55.948Z");
    const period = createActivityPeriod(now);
    const accounts: FollowedAccount[] = [
      {
        login: "legacy-first",
        id: 1,
        type: "User",
        htmlUrl: "https://github.com/legacy-first",
      },
      {
        login: "legacy-second",
        id: 2,
        type: "User",
        htmlUrl: "https://github.com/legacy-second",
      },
    ];
    const recent: AccountActivityResult[] = accounts.map((value) => ({
      account: value,
      status: "NO_RECENT_VISIBLE_ACTIVITY",
      activity: {
        login: value.login,
        periodStart: period.from,
        periodEnd: period.to,
        totalContributions: 0,
        totalCommitContributions: 0,
        totalIssueContributions: 0,
        totalPullRequestContributions: 0,
        totalPullRequestReviewContributions: 0,
        restrictedContributionsCount: 0,
        hasAnyContributions: false,
        hasAnyRestrictedContributions: false,
        hasActivityInThePast: false,
      },
    }));
    const checkpoint = createCheckpoint("octocat", period, accounts, now);
    delete (checkpoint as Partial<typeof checkpoint>).historyYears;
    recordRecentResults(checkpoint, recent);
    for (const item of recent) {
      (checkpoint.completedHistoricalActivity as Record<string, unknown>)[
        item.account.login
      ] = {
        ...item,
        lastVisibleActivityAt: null,
        historicalLookupStatus: "NO_PAST_ACTIVITY",
      };
    }
    await writeCheckpointAtomic(path, checkpoint, now);
    const graphQLBodies: Array<{
      query: string;
      variables: Record<string, string>;
    }> = [];
    const fetchMock = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).includes("/following")) {
        return new Response(
          JSON.stringify(
            accounts.map(({ login, id, type, htmlUrl }) => ({
              login,
              id,
              type,
              html_url: htmlUrl,
            })),
          ),
          {
            status: 200,
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4999",
            },
          },
        );
      }
      graphQLBodies.push(JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, string>;
      });
      if (graphQLBodies.length === 2) {
        return new Response("", { status: 401 });
      }
      return new Response(
        JSON.stringify({
          data: {
            user: {
              login: "legacy-first",
              contributionsCollection: {
                startedAt: "2024-08-24T23:41:55.948Z",
                endedAt: "2025-08-24T23:41:55.947Z",
                hasAnyContributions: true,
                hasAnyRestrictedContributions: false,
                restrictedContributionsCount: 0,
                latestRestrictedContributionDate: null,
                contributionCalendar: {
                  totalContributions: 1,
                  weeks: [
                    {
                      contributionDays: [
                        { contributionCount: 1, date: "2025-08-17" },
                      ],
                    },
                  ],
                },
              },
            },
            rateLimit: {
              cost: 1,
              limit: 5000,
              remaining: 4998,
              resetAt: "2026-08-25T01:00:00.000Z",
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const exitCode = await runCli(["octocat", "--resume"], {
        token: "obvious-test-placeholder",
        fetch: fetchMock,
        checkpointRoot,
        concurrency: 1,
        now,
        io: { log() {}, error() {} },
      });

      assert.equal(exitCode, 1);
      assert.equal(graphQLBodies.length, 2);
      assert.match(graphQLBodies[0]?.query ?? "", /HistoricalActivity/);
      assert.deepEqual(
        graphQLBodies.map(({ variables }) => variables.login),
        ["legacy-first", "legacy-second"],
      );
      const saved = await loadCheckpoint(path);
      assert.equal(checkpointRecentResults(saved).length, 2);
      const historical = checkpointHistoricalResults(saved);
      const first = historical.find(
        ({ account: value }) => value.login === "legacy-first",
      );
      const second = historical.find(
        ({ account: value }) => value.login === "legacy-second",
      ) as unknown as { historicalLookupStatus?: string };
      assert.equal(first?.historicalLookupStatus, "FOUND");
      assert.equal(first?.lastVisibleActivityAt, "2025-08-17");
      assert.equal(first?.activity?.hasActivityInThePast, false);
      assert.equal(second.historicalLookupStatus, "NO_PAST_ACTIVITY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
