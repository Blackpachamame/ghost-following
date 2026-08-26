import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FollowedAccount } from "../domain/account.js";
import {
  createActivityPeriod,
  createHistoricalPeriods,
  type AccountActivity,
  type AccountActivityResult,
  type ActivityPeriod,
} from "../domain/activity.js";
import {
  GitHubAuthenticationError,
  GitHubGraphQLAccountError,
  GitHubGraphQLFatalError,
  GitHubHttpError,
  GitHubNetworkError,
  GitHubRateLimitError,
} from "../github/errors.js";
import type { AccountActivityQueryResult } from "../github/graphql.js";
import {
  analyzeFollowingActivity,
  type ActivityProvider,
} from "./analyzer.js";

const period = createActivityPeriod(new Date("2026-08-22T00:00:00.000Z"));
const rateLimit = (remaining: number) => ({
  cost: 1,
  limit: 5000,
  remaining,
  resetAt: new Date("2026-08-22T01:00:00.000Z"),
});

describe("productive recent batching", () => {
  function batchSuccess(
    logins: readonly string[],
    remaining = 4900,
  ) {
    return {
      items: logins.map((login) => ({
        login,
        status: "SUCCESS" as const,
        activity: queryResult(login, 1).activity,
      })),
      rateLimit: rateLimit(remaining),
    };
  }

  function batchResourceLimit(logins: readonly string[]) {
    return {
      items: logins.map((login) => ({
        login,
        status: "RESOURCE_LIMIT" as const,
        error: "Resource limits for this query exceeded.",
      })),
      rateLimit: rateLimit(4900),
    };
  }

  const historicalNeverCalled = async () => {
    throw new Error("Historical lookup should not run for active fixtures.");
  };

  it("splits 25 as 12 + 13 and a failing 13 as 6 + 7", async () => {
    const calls: number[] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push(logins.length);
        return logins.length === 25 || logins.length === 13
          ? batchResourceLimit(logins)
          : batchSuccess(logins);
      },
      getHistoricalActivity: historicalNeverCalled,
    };
    const accounts = Array.from({ length: 25 }, (_, index) =>
      account(`user-${index}`, "User", index + 1),
    );

    const analysis = await analyzeFollowingActivity(accounts, provider, period);

    assert.deepEqual(calls, [25, 12, 13, 6, 7]);
    assert.equal(analysis.counts.ACTIVE, 25);
    assert.equal(analysis.counts.UNKNOWN, 0);
  });

  it("marks a size-one resource failure UNKNOWN after one request", async () => {
    const calls: number[] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push(logins.length);
        return batchResourceLimit(logins);
      },
      getHistoricalActivity: historicalNeverCalled,
    };

    const analysis = await analyzeFollowingActivity(
      [account("limited")],
      provider,
      period,
    );

    assert.deepEqual(calls, [1]);
    assert.equal(analysis.results[0]?.status, "UNKNOWN");
  });

  it("does not repeat a successful alias while retrying one partial failure", async () => {
    const calls: string[][] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push([...logins]);
        if (logins.length === 2) {
          return {
            items: [
              {
                login: logins[0]!,
                status: "SUCCESS" as const,
                activity: queryResult(logins[0]!, 1).activity,
              },
              {
                login: logins[1]!,
                status: "RESOURCE_LIMIT" as const,
                error: "Resource limits for this query exceeded.",
              },
            ],
            rateLimit: rateLimit(4900),
          };
        }
        return batchSuccess(logins);
      },
      getHistoricalActivity: historicalNeverCalled,
    };

    const analysis = await analyzeFollowingActivity(
      [account("ok", "User", 1), account("retry", "User", 2)],
      provider,
      period,
    );

    assert.deepEqual(calls, [["ok", "retry"], ["retry"]]);
    assert.equal(analysis.counts.ACTIVE, 2);
  });

  for (const status of [502, 504] as const) {
    it(`recovers an exhausted HTTP ${status} batch as sequential 12 + 13`, async () => {
      const calls: string[][] = [];
      const diagnosed: number[] = [];
      const progress: number[] = [];
      const provider: ActivityProvider = {
        async getAccountActivities(logins) {
          calls.push([...logins]);
          if (logins.length === 25) {
            throw new GitHubHttpError(status, "", undefined, 3);
          }
          return batchSuccess(logins);
        },
        getHistoricalActivity: historicalNeverCalled,
      };
      const accounts = Array.from({ length: 25 }, (_, index) =>
        account(`user-${index}`, "User", index + 1),
      );

      const analysis = await analyzeFollowingActivity(accounts, provider, period, {
        onRecentBatchFailed(failure) {
          diagnosed.push(failure.logins.length);
        },
        onRecentBatchCompleted(_results, completed) {
          progress.push(completed);
        },
      });

      assert.deepEqual(calls.map(({ length }) => length), [25, 12, 13]);
      assert.deepEqual(diagnosed, [25]);
      assert.deepEqual(progress, [12, 25]);
      assert.equal(analysis.counts.ACTIVE, 25);
      assert.deepEqual(
        analysis.results.map(({ account: value }) => value.login),
        accounts.map(({ login }) => login),
      );
    });
  }

  it("returns to the production batch size after recovering one HTTP timeout batch", async () => {
    const calls: number[] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push(logins.length);
        if (calls.length === 1) {
          throw new GitHubHttpError(502, "", undefined, 3);
        }
        return batchSuccess(logins);
      },
      getHistoricalActivity: historicalNeverCalled,
    };
    const accounts = Array.from({ length: 50 }, (_, index) =>
      account(`fixed-batch-${index}`, "User", index + 1),
    );

    const analysis = await analyzeFollowingActivity(accounts, provider, period);

    assert.deepEqual(calls, [25, 12, 13, 25]);
    assert.equal(analysis.counts.ACTIVE, 50);
  });

  it("recursively splits only the HTTP timeout branches that exhaust retries", async () => {
    const calls: string[][] = [];
    const diagnosed: number[] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push([...logins]);
        if (logins.length === 25 || logins.length === 13) {
          throw new GitHubHttpError(504, "", undefined, 3);
        }
        return batchSuccess(logins);
      },
      getHistoricalActivity: historicalNeverCalled,
    };
    const accounts = Array.from({ length: 25 }, (_, index) =>
      account(`nested-${index}`, "User", index + 1),
    );

    const analysis = await analyzeFollowingActivity(accounts, provider, period, {
      onRecentBatchFailed(failure) {
        diagnosed.push(failure.logins.length);
      },
    });

    assert.deepEqual(calls.map(({ length }) => length), [25, 12, 13, 6, 7]);
    assert.deepEqual(diagnosed, [25, 13]);
    assert.equal(analysis.counts.ACTIVE, 25);
    assert.equal(new Set(analysis.results.map(({ account: value }) => value.login)).size, 25);
  });

  for (const status of [502, 504] as const) {
    it(`marks an exhausted singleton HTTP ${status} UNKNOWN without historical lookup`, async () => {
      let historicalCalls = 0;
      const completed: AccountActivityResult[] = [];
      const provider: ActivityProvider = {
        async getAccountActivities() {
          throw new GitHubHttpError(status, "", undefined, 3);
        },
        async getHistoricalActivity() {
          historicalCalls += 1;
          throw new Error("Historical lookup must not run for UNKNOWN.");
        },
      };

      const analysis = await analyzeFollowingActivity(
        [account("timeout-singleton")],
        provider,
        period,
        {
          onRecentBatchCompleted(results) {
            completed.push(...results);
          },
        },
      );

      assert.equal(analysis.results[0]?.status, "UNKNOWN");
      assert.match(analysis.results[0]?.error ?? "", new RegExp(`HTTP ${status}`));
      assert.equal(analysis.coverage, 0);
      assert.equal(historicalCalls, 0);
      assert.deepEqual(completed, analysis.results);
    });
  }

  it("continues after two distinct singleton HTTP timeout failures", async () => {
    const calls: string[][] = [];
    const diagnosed: number[] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push([...logins]);
        throw new GitHubHttpError(504, "", undefined, 3);
      },
      getHistoricalActivity: historicalNeverCalled,
    };

    const analysis = await analyzeFollowingActivity(
      [account("left", "User", 1), account("right", "User", 2)],
      provider,
      period,
      {
        onRecentBatchFailed(failure) {
          diagnosed.push(failure.logins.length);
        },
      },
    );

    assert.deepEqual(calls, [["left", "right"], ["left"], ["right"]]);
    assert.deepEqual(diagnosed, [2, 1, 1]);
    assert.equal(analysis.counts.UNKNOWN, 2);
    assert.equal(analysis.coverage, 0);
  });

  it("keeps exhausted HTTP 503 fatal and does not split it", async () => {
    const original = new GitHubHttpError(503, "Service Unavailable", undefined, 3);
    const calls: string[][] = [];
    const diagnosed: number[] = [];
    const accounts = Array.from({ length: 25 }, (_, index) =>
      account(`unavailable-${index}`, "User", index + 1),
    );
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push([...logins]);
        throw original;
      },
      getHistoricalActivity: historicalNeverCalled,
    };

    await assert.rejects(
      analyzeFollowingActivity(accounts, provider, period, {
        onRecentBatchFailed(failure) {
          diagnosed.push(failure.logins.length);
        },
      }),
      (error) => error === original,
    );
    assert.deepEqual(calls.map(({ length }) => length), [25]);
    assert.deepEqual(diagnosed, [25]);
  });

  it("does not split excluded HTTP, auth, rate-limit, parsing or transport errors", async () => {
    const errors = [
      new GitHubAuthenticationError(),
      new GitHubRateLimitError({ remaining: 0 }, 403),
      new GitHubRateLimitError({ remaining: 0 }, 429),
      new GitHubNetworkError("Could not reach GitHub after 3 attempts."),
      new GitHubGraphQLFatalError("Invalid GraphQL response."),
      new GitHubHttpError(500, "Internal Server Error", undefined, 3),
      new GitHubHttpError(504, "Gateway Timeout", undefined, 2),
      new TypeError("Generic fetch failure."),
    ];

    for (const original of errors) {
      let calls = 0;
      let diagnosed = false;
      const provider: ActivityProvider = {
        async getAccountActivities() {
          calls += 1;
          throw original;
        },
        getHistoricalActivity: historicalNeverCalled,
      };
      await assert.rejects(
        analyzeFollowingActivity(
          [account("first", "User", 1), account("second", "User", 2)],
          provider,
          period,
          {
            onRecentBatchFailed() {
              diagnosed = true;
            },
          },
        ),
        (error) => error === original,
      );
      assert.equal(calls, 1);
      assert.equal(diagnosed, false);
    }
  });

  it("composes RESOURCE_LIMIT splitting followed by HTTP timeout splitting", async () => {
    const calls: number[] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push(logins.length);
        if (logins.length === 25) return batchResourceLimit(logins);
        if (logins.length === 13) {
          throw new GitHubHttpError(504, "", undefined, 3);
        }
        return batchSuccess(logins);
      },
      getHistoricalActivity: historicalNeverCalled,
    };
    const accounts = Array.from({ length: 25 }, (_, index) =>
      account(`resource-http-${index}`, "User", index + 1),
    );

    const analysis = await analyzeFollowingActivity(accounts, provider, period);

    assert.deepEqual(calls, [25, 12, 13, 6, 7]);
    assert.equal(analysis.counts.ACTIVE, 25);
  });

  it("composes HTTP timeout splitting followed by RESOURCE_LIMIT splitting", async () => {
    const calls: string[][] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        calls.push([...logins]);
        if (logins.length === 25) {
          throw new GitHubHttpError(502, "", undefined, 3);
        }
        if (logins.length === 12) return batchResourceLimit(logins);
        return batchSuccess(logins);
      },
      getHistoricalActivity: historicalNeverCalled,
    };
    const accounts = Array.from({ length: 25 }, (_, index) =>
      account(`http-resource-${index}`, "User", index + 1),
    );

    const analysis = await analyzeFollowingActivity(accounts, provider, period);

    assert.deepEqual(calls.map(({ length }) => length), [25, 12, 6, 6, 13]);
    assert.equal(analysis.counts.ACTIVE, 25);
    const terminalLogins = calls.slice(2).flat();
    assert.equal(new Set(terminalLogins).size, 25);
  });

  it("publishes a successful left branch before a fatal right branch and resumes without it", async () => {
    const fatal = new GitHubRateLimitError({ remaining: 0 }, 429);
    const persisted: AccountActivityResult[] = [];
    const progress: number[] = [];
    const accounts = Array.from({ length: 25 }, (_, index) =>
      account(`durable-${index}`, "User", index + 1),
    );
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        if (logins.length === 25) {
          throw new GitHubHttpError(504, "", undefined, 3);
        }
        if (logins.length === 12) return batchSuccess(logins);
        throw fatal;
      },
      getHistoricalActivity: historicalNeverCalled,
    };

    await assert.rejects(
      analyzeFollowingActivity(accounts, provider, period, {
        onRecentBatchCompleted(results, completed) {
          persisted.push(...results);
          progress.push(completed);
        },
      }),
      (error) => error === fatal,
    );
    assert.equal(persisted.length, 12);
    assert.deepEqual(progress, [12]);

    const resumedCalls: string[][] = [];
    const resumed = await analyzeFollowingActivity(
      accounts,
      {
        async getAccountActivities(logins) {
          resumedCalls.push([...logins]);
          return batchSuccess(logins);
        },
        getHistoricalActivity: historicalNeverCalled,
      },
      period,
      { completedRecentActivity: persisted },
    );
    assert.deepEqual(resumedCalls, [accounts.slice(12).map(({ login }) => login)]);
    assert.equal(resumed.counts.ACTIVE, 25);
  });

  it("persists singleton timeout UNKNOWN before a later fatal and skips it on resume", async () => {
    const fatal = new GitHubRateLimitError({ remaining: 0 }, 429);
    const persisted: AccountActivityResult[] = [];
    const accounts = [
      account("durable-unknown", "User", 1),
      account("later-fatal", "User", 2),
    ];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        if (logins.length === 2 || logins[0] === "durable-unknown") {
          throw new GitHubHttpError(504, "", undefined, 3);
        }
        throw fatal;
      },
      getHistoricalActivity: historicalNeverCalled,
    };

    await assert.rejects(
      analyzeFollowingActivity(accounts, provider, period, {
        onRecentBatchCompleted(results) {
          persisted.push(...results);
        },
      }),
      (error) => error === fatal,
    );
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.status, "UNKNOWN");

    const resumedCalls: string[][] = [];
    const resumed = await analyzeFollowingActivity(
      accounts,
      {
        async getAccountActivities(logins) {
          resumedCalls.push([...logins]);
          return batchSuccess(logins);
        },
        getHistoricalActivity: historicalNeverCalled,
      },
      period,
      { completedRecentActivity: persisted },
    );
    assert.deepEqual(resumedCalls, [["later-fatal"]]);
    assert.equal(resumed.counts.UNKNOWN, 1);
    assert.equal(resumed.counts.ACTIVE, 1);
    assert.equal(resumed.coverage, 50);
  });

  it("counts mixed successful aliases and singleton timeout UNKNOWN exactly once", async () => {
    const completed: number[] = [];
    const accounts = Array.from({ length: 11 }, (_, index) =>
      account(`coverage-${index}`, "User", index + 1),
    );
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        if (logins.length === 1) {
          throw new GitHubHttpError(502, "", undefined, 3);
        }
        return {
          items: logins.map((login, index) =>
            index === logins.length - 1
              ? {
                  login,
                  status: "RESOURCE_LIMIT" as const,
                  error: "Resource limits for this query exceeded.",
                }
              : {
                  login,
                  status: "SUCCESS" as const,
                  activity: queryResult(login, 1).activity,
                },
          ),
          rateLimit: rateLimit(4900),
        };
      },
      getHistoricalActivity: historicalNeverCalled,
    };

    const analysis = await analyzeFollowingActivity(accounts, provider, period, {
      onRecentBatchCompleted(_results, count) {
        completed.push(count);
      },
    });

    assert.deepEqual(completed, [10, 11]);
    assert.equal(analysis.counts.ACTIVE, 10);
    assert.equal(analysis.counts.UNKNOWN, 1);
    assert.equal(analysis.coverage, (10 / 11) * 100);
  });

  it("resumes completed recent and historical results and only requests pending users", async () => {
    const completedAccount = account("completed", "User", 1);
    const quietAccount = account("quiet", "User", 2);
    const pendingAccount = account("pending", "User", 3);
    const completedRecent: AccountActivityResult = {
      account: completedAccount,
      activity: queryResult("completed", 2).activity,
      status: "ACTIVE",
    };
    const quietRecent: AccountActivityResult = {
      account: quietAccount,
      activity: queryResult("quiet", 0, false).activity,
      status: "NO_RECENT_VISIBLE_ACTIVITY",
    };
    const quietHistorical: AccountActivityResult = {
      ...quietRecent,
      lastVisibleActivityAt: null,
      historicalLookupStatus: "NOT_FOUND_IN_LOOKBACK",
    };
    const requested: string[][] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        requested.push([...logins]);
        return batchSuccess(logins);
      },
      getHistoricalActivity: historicalNeverCalled,
    };

    const analysis = await analyzeFollowingActivity(
      [completedAccount, quietAccount, pendingAccount],
      provider,
      period,
      {
        historyYears: 5,
        completedRecentActivity: [completedRecent, quietRecent],
        completedHistoricalActivity: [quietHistorical],
      },
    );

    assert.deepEqual(requested, [["pending"]]);
    assert.deepEqual(
      analysis.results.map(({ account: value }) => value.login),
      ["completed", "quiet", "pending"],
    );
    assert.equal(
      analysis.results[1]?.historicalLookupStatus,
      "NOT_FOUND_IN_LOOKBACK",
    );
  });

  it("reprocesses a legacy NO_PAST_ACTIVITY checkpoint without repeating recent", async () => {
    const quietAccount = account("legacy-quiet", "User", 1);
    const quietRecent: AccountActivityResult = {
      account: quietAccount,
      activity: queryResult("legacy-quiet", 0, false).activity,
      status: "NO_RECENT_VISIBLE_ACTIVITY",
    };
    const legacyHistorical = {
      ...quietRecent,
      lastVisibleActivityAt: null,
      historicalLookupStatus: "NO_PAST_ACTIVITY",
    } as unknown as AccountActivityResult;
    let recentCalls = 0;
    const requestedPeriods: ActivityPeriod[] = [];
    const persisted: AccountActivityResult[] = [];
    const provider: ActivityProvider = {
      async getAccountActivities() {
        recentCalls += 1;
        throw new Error("Completed recent activity must not be requested.");
      },
      async getHistoricalActivity(_login, historicalPeriod) {
        requestedPeriods.push(historicalPeriod);
        return {
          lastVisibleActivityAt: "2025-08-17",
          rateLimit: rateLimit(4800),
        };
      },
    };

    const analysis = await analyzeFollowingActivity(
      [quietAccount],
      provider,
      period,
      {
        historyYears: 5,
        completedRecentActivity: [quietRecent],
        completedHistoricalActivity: [legacyHistorical],
        onHistoricalAccountCompleted(result) {
          persisted.push(result);
        },
      },
    );

    assert.equal(recentCalls, 0);
    assert.deepEqual(requestedPeriods, createHistoricalPeriods(period, 5).slice(0, 1));
    assert.equal(analysis.results[0]?.historicalLookupStatus, "FOUND");
    assert.equal(analysis.results[0]?.lastVisibleActivityAt, "2025-08-17");
    assert.equal(analysis.results[0]?.activity?.hasActivityInThePast, false);
    assert.deepEqual(persisted, analysis.results);
  });

  it("reuses every modern historical checkpoint status without new queries", async () => {
    const accounts = [
      account("saved-found", "User", 1),
      account("saved-not-found", "User", 2),
      account("saved-failed", "User", 3),
    ];
    const recent = accounts.map((value) => ({
      account: value,
      activity: queryResult(value.login, 0, false).activity,
      status: "NO_RECENT_VISIBLE_ACTIVITY" as const,
    }));
    const historical: AccountActivityResult[] = [
      {
        ...recent[0]!,
        lastVisibleActivityAt: "2024-01-10",
        historicalLookupStatus: "FOUND",
      },
      {
        ...recent[1]!,
        lastVisibleActivityAt: null,
        historicalLookupStatus: "NOT_FOUND_IN_LOOKBACK",
      },
      {
        ...recent[2]!,
        lastVisibleActivityAt: null,
        historicalLookupStatus: "FAILED",
        historicalLookupError: "saved failure",
      },
    ];
    let historicalCalls = 0;

    const analysis = await analyzeFollowingActivity(
      accounts,
      {
        async getAccountActivities() {
          throw new Error("Completed recent activity must not be requested.");
        },
        async getHistoricalActivity() {
          historicalCalls += 1;
          throw new Error("Completed historical activity must not be requested.");
        },
      },
      period,
      {
        historyYears: 5,
        completedRecentActivity: recent,
        completedHistoricalActivity: historical,
      },
    );

    assert.equal(historicalCalls, 0);
    assert.deepEqual(
      analysis.results.map(({ historicalLookupStatus }) =>
        historicalLookupStatus),
      ["FOUND", "NOT_FOUND_IN_LOOKBACK", "FAILED"],
    );
  });

  it("saves the completed batch and stops before another request at zero quota", async () => {
    let requests = 0;
    let saved = 0;
    const provider: ActivityProvider = {
      async getAccountActivities(logins) {
        requests += 1;
        return batchSuccess(logins, 0);
      },
      getHistoricalActivity: historicalNeverCalled,
    };
    const accounts = Array.from({ length: 30 }, (_, index) =>
      account(`user-${index}`, "User", index + 1),
    );

    await assert.rejects(
      analyzeFollowingActivity(accounts, provider, period, {
        onRecentBatchCompleted(results) {
          saved += results.length;
        },
      }),
      GitHubRateLimitError,
    );
    assert.equal(requests, 1);
    assert.equal(saved, 25);
  });

  it("produces equivalent account results with batch and individual transports", async () => {
    const accounts = [
      account("active", "User", 1),
      account("quiet", "User", 2),
    ];
    const individual: ActivityProvider = {
      async getAccountActivity(login) {
        return queryResult(login, login === "active" ? 3 : 0, false);
      },
      async getHistoricalActivity() {
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(4800) };
      },
    };
    const batch: ActivityProvider = {
      async getAccountActivities(logins) {
        return {
          items: logins.map((login) => ({
            login,
            status: "SUCCESS" as const,
            activity: queryResult(login, login === "active" ? 3 : 0, false)
              .activity,
          })),
          rateLimit: rateLimit(4900),
        };
      },
      async getHistoricalActivity() {
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(4800) };
      },
    };

    const [individualAnalysis, batchAnalysis] = await Promise.all([
      analyzeFollowingActivity(accounts, individual, period),
      analyzeFollowingActivity(accounts, batch, period),
    ]);

    assert.deepEqual(batchAnalysis.results, individualAnalysis.results);
    assert.deepEqual(batchAnalysis.counts, individualAnalysis.counts);
    assert.equal(batchAnalysis.coverage, individualAnalysis.coverage);
  });
});

function account(login: string, type = "User", id = 1): FollowedAccount {
  return { login, id, type, htmlUrl: `https://github.com/${login}` };
}

function queryResult(
  login: string,
  total: number,
  hasActivityInThePast = false,
): AccountActivityQueryResult {
  const activity: AccountActivity = {
    login,
    periodStart: period.from,
    periodEnd: period.to,
    totalContributions: total,
    totalCommitContributions: total,
    totalIssueContributions: 0,
    totalPullRequestContributions: 0,
    totalPullRequestReviewContributions: 0,
    restrictedContributionsCount: 0,
    hasAnyContributions: total > 0,
    hasAnyRestrictedContributions: false,
    hasActivityInThePast,
  };
  return { activity, rateLimit: rateLimit(4999 - total) };
}

describe("analyzeFollowingActivity", () => {
  it("marks quiet accounts NOT_REQUESTED and creates zero historical work by default", async () => {
    let historicalCalls = 0;
    const analysis = await analyzeFollowingActivity(
      [account("quiet-default")],
      {
        async getAccountActivity(login) {
          return queryResult(login, 0, false);
        },
        async getHistoricalActivity() {
          historicalCalls += 1;
          throw new Error("Historical must remain disabled by default.");
        },
      },
      period,
    );

    assert.equal(analysis.historyYears, 0);
    assert.equal(historicalCalls, 0);
    assert.equal(analysis.results[0]?.historicalLookupStatus, "NOT_REQUESTED");
    assert.equal(analysis.results[0]?.lastVisibleActivityAt, null);
    assert.equal(analysis.results[0]?.activity?.hasActivityInThePast, false);
  });

  for (const historyYears of [1, 3, 5]) {
    it(`limits historical lookup to ${historyYears} explicit annual windows`, async () => {
      const requestedPeriods: ActivityPeriod[] = [];
      const analysis = await analyzeFollowingActivity(
        [account(`quiet-${historyYears}`)],
        {
          async getAccountActivity(login) {
            return queryResult(login, 0, false);
          },
          async getHistoricalActivity(_login, historicalPeriod) {
            requestedPeriods.push(historicalPeriod);
            return { lastVisibleActivityAt: null, rateLimit: rateLimit(4900) };
          },
        },
        period,
        { historyYears },
      );

      assert.deepEqual(
        requestedPeriods,
        createHistoricalPeriods(period, historyYears),
      );
      assert.equal(
        analysis.results[0]?.historicalLookupStatus,
        "NOT_FOUND_IN_LOOKBACK",
      );
    });
  }

  it("excludes non-users, preserves account errors, and enriches quiet users", async () => {
    const requested: string[] = [];
    const historicalRequested: string[] = [];
    const provider: ActivityProvider = {
      async getAccountActivity(login) {
        requested.push(login);
        if (login === "broken") {
          throw new GitHubGraphQLAccountError("Temporary account-level error.");
        }
        return queryResult(login, login === "active" ? 2 : 0, login === "quiet");
      },
      async getHistoricalActivity(login) {
        historicalRequested.push(login);
        return {
          lastVisibleActivityAt: "2024-09-17",
          rateLimit: rateLimit(4996),
        };
      },
    };

    const analysis = await analyzeFollowingActivity(
      [
        account("active", "User", 1),
        account("quiet", "User", 2),
        account("broken", "User", 3),
        account("example-org", "Organization", 4),
      ],
      provider,
      period,
      { concurrency: 2, historyYears: 5 },
    );

    assert.deepEqual(requested.sort(), ["active", "broken", "quiet"]);
    assert.deepEqual(historicalRequested, ["quiet"]);
    assert.deepEqual(analysis.counts, {
      ACTIVE: 1,
      NO_RECENT_VISIBLE_ACTIVITY: 1,
      INSUFFICIENT_VISIBILITY: 0,
      UNKNOWN: 1,
    });
    assert.equal(analysis.coverage, (2 / 3) * 100);
    assert.equal(analysis.results[2]?.status, "UNKNOWN");
    assert.equal(analysis.results[1]?.lastVisibleActivityAt, "2024-09-17");
    assert.equal(analysis.results[1]?.historicalLookupStatus, "FOUND");
    assert.equal(analysis.rateLimit?.remaining, 4996);
  });

  it("finds the real regression date despite hasActivityInThePast being false", async () => {
    const regressionPeriod: ActivityPeriod = {
      from: "2025-08-24T23:41:55.948Z",
      to: "2026-08-24T23:41:55.948Z",
      days: 365,
    };
    const requestedPeriods: ActivityPeriod[] = [];
    const provider: ActivityProvider = {
      async getAccountActivities(logins, requestedPeriod) {
        return {
          items: logins.map((login) => ({
            login,
            status: "SUCCESS" as const,
            activity: {
              ...queryResult(login, 0, false).activity,
              periodStart: requestedPeriod.from,
              periodEnd: requestedPeriod.to,
            },
          })),
          rateLimit: rateLimit(4900),
        };
      },
      async getHistoricalActivity(login, historicalPeriod) {
        assert.equal(login, "robbertjanhermeler-cmd");
        requestedPeriods.push(historicalPeriod);
        return {
          lastVisibleActivityAt: "2025-08-17",
          rateLimit: rateLimit(4899),
        };
      },
    };

    const analysis = await analyzeFollowingActivity(
      [account("robbertjanhermeler-cmd")],
      provider,
      regressionPeriod,
      { historyYears: 5 },
    );

    assert.deepEqual(requestedPeriods, [
      {
        from: "2024-08-24T23:41:55.948Z",
        to: "2025-08-24T23:41:55.947Z",
        days: 365,
      },
    ]);
    assert.equal(analysis.results[0]?.status, "NO_RECENT_VISIBLE_ACTIVITY");
    assert.equal(analysis.results[0]?.historicalLookupStatus, "FOUND");
    assert.equal(analysis.results[0]?.lastVisibleActivityAt, "2025-08-17");
    assert.equal(analysis.results[0]?.activity?.hasActivityInThePast, false);
    assert.equal(analysis.coverage, 100);
  });

  it("checks all five windows when hasActivityInThePast is false and finds nothing", async () => {
    const requestedPeriods: ActivityPeriod[] = [];
    const provider: ActivityProvider = {
      async getAccountActivity(login) {
        return queryResult(login, 0, false);
      },
      async getHistoricalActivity(_login, historicalPeriod) {
        requestedPeriods.push(historicalPeriod);
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(4990) };
      },
    };

    const analysis = await analyzeFollowingActivity(
      [account("not-found-with-false-signal")],
      provider,
      period,
      { historyYears: 5 },
    );

    assert.deepEqual(requestedPeriods, createHistoricalPeriods(period, 5));
    assert.equal(
      analysis.results[0]?.historicalLookupStatus,
      "NOT_FOUND_IN_LOOKBACK",
    );
    assert.equal(analysis.results[0]?.activity?.hasActivityInThePast, false);
  });

  it("checks annual windows sequentially and stops at the first match", async () => {
    const requestedPeriods: ActivityPeriod[] = [];
    const expectedPeriods = createHistoricalPeriods(period, 5);
    const provider: ActivityProvider = {
      async getAccountActivity(login) {
        return queryResult(login, 0, true);
      },
      async getHistoricalActivity(_login, historicalPeriod) {
        requestedPeriods.push(historicalPeriod);
        return {
          lastVisibleActivityAt:
            requestedPeriods.length === 2 ? "2024-01-15" : null,
          rateLimit: rateLimit(4999 - requestedPeriods.length),
        };
      },
    };

    const analysis = await analyzeFollowingActivity(
      [account("older")],
      provider,
      period,
      { historyYears: 5 },
    );

    assert.deepEqual(requestedPeriods, expectedPeriods.slice(0, 2));
    assert.equal(analysis.results[0]?.historicalLookupStatus, "FOUND");
    assert.equal(analysis.results[0]?.lastVisibleActivityAt, "2024-01-15");
  });

  it("makes exactly five calls before reporting no match in the lookback", async () => {
    const requestedPeriods: ActivityPeriod[] = [];
    const provider: ActivityProvider = {
      async getAccountActivity(login) {
        return queryResult(login, 0, true);
      },
      async getHistoricalActivity(_login, historicalPeriod) {
        requestedPeriods.push(historicalPeriod);
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(4990) };
      },
    };

    const analysis = await analyzeFollowingActivity(
      [account("beyond-lookback")],
      provider,
      period,
      { historyYears: 5 },
    );

    assert.deepEqual(requestedPeriods, createHistoricalPeriods(period, 5));
    assert.equal(requestedPeriods.length, 5);
    assert.equal(
      analysis.results[0]?.historicalLookupStatus,
      "NOT_FOUND_IN_LOOKBACK",
    );
  });

  it("does not run historical for ACTIVE or UNKNOWN results", async () => {
    let historicalCalls = 0;
    const provider: ActivityProvider = {
      async getAccountActivity(login) {
        if (login === "unknown") {
          throw new GitHubGraphQLAccountError("Account result unavailable.");
        }
        return queryResult(login, 1, false);
      },
      async getHistoricalActivity() {
        historicalCalls += 1;
        throw new Error("Historical must not run for ACTIVE or UNKNOWN.");
      },
    };

    const analysis = await analyzeFollowingActivity(
      [account("active", "User", 1), account("unknown", "User", 2)],
      provider,
      period,
      { historyYears: 5 },
    );

    assert.equal(historicalCalls, 0);
    assert.deepEqual(
      analysis.results.map(({ status }) => status),
      ["ACTIVE", "UNKNOWN"],
    );
  });

  for (const hasActivityInThePast of [false, true] as const) {
    it(`preserves NO_RECENT_VISIBLE_ACTIVITY when historical fails with signal ${hasActivityInThePast}`, async () => {
      let historicalCalls = 0;
      const provider: ActivityProvider = {
        async getAccountActivity(login) {
          return queryResult(login, 0, hasActivityInThePast);
        },
        async getHistoricalActivity(login) {
          historicalCalls += 1;
          throw new GitHubGraphQLAccountError(
            `Historical data unavailable for ${login}.`,
          );
        },
      };

      const analysis = await analyzeFollowingActivity(
        [account("quiet")],
        provider,
        period,
        { historyYears: 5 },
      );

      assert.equal(historicalCalls, 1);
      assert.equal(analysis.results[0]?.status, "NO_RECENT_VISIBLE_ACTIVITY");
      assert.equal(analysis.results[0]?.lastVisibleActivityAt, null);
      assert.equal(analysis.results[0]?.historicalLookupStatus, "FAILED");
      assert.match(
        analysis.results[0]?.historicalLookupError ?? "",
        /unavailable/,
      );
    });
  }
});
