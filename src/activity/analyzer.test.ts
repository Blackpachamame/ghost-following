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
import { GitHubGraphQLAccountError } from "../github/errors.js";
import { GitHubRateLimitError } from "../github/errors.js";
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
      historicalLookupStatus: "NO_PAST_ACTIVITY",
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
        completedRecentActivity: [completedRecent, quietRecent],
        completedHistoricalActivity: [quietHistorical],
      },
    );

    assert.deepEqual(requested, [["pending"]]);
    assert.deepEqual(
      analysis.results.map(({ account: value }) => value.login),
      ["completed", "quiet", "pending"],
    );
    assert.equal(analysis.results[1]?.historicalLookupStatus, "NO_PAST_ACTIVITY");
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
      2,
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

  it("performs no historical query when hasActivityInThePast is false", async () => {
    let historicalCalls = 0;
    const provider: ActivityProvider = {
      async getAccountActivity(login) {
        return queryResult(login, 0, false);
      },
      async getHistoricalActivity() {
        historicalCalls += 1;
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(4990) };
      },
    };

    const analysis = await analyzeFollowingActivity(
      [account("never-active")],
      provider,
      period,
    );

    assert.equal(historicalCalls, 0);
    assert.equal(analysis.results[0]?.status, "NO_RECENT_VISIBLE_ACTIVITY");
    assert.equal(
      analysis.results[0]?.historicalLookupStatus,
      "NO_PAST_ACTIVITY",
    );
    assert.equal(analysis.coverage, 100);
  });

  it("checks annual windows sequentially and stops at the first match", async () => {
    const requestedPeriods: ActivityPeriod[] = [];
    const expectedPeriods = createHistoricalPeriods(period);
    const provider: ActivityProvider = {
      async getAccountActivity(login) {
        return queryResult(login, 0, true);
      },
      async getHistoricalActivity(_login, historicalPeriod) {
        requestedPeriods.push(historicalPeriod);
        return {
          lastVisibleActivityAt:
            requestedPeriods.length === 3 ? "2023-01-15" : null,
          rateLimit: rateLimit(4999 - requestedPeriods.length),
        };
      },
    };

    const analysis = await analyzeFollowingActivity(
      [account("older")],
      provider,
      period,
    );

    assert.deepEqual(requestedPeriods, expectedPeriods.slice(0, 3));
    assert.equal(analysis.results[0]?.historicalLookupStatus, "FOUND");
    assert.equal(analysis.results[0]?.lastVisibleActivityAt, "2023-01-15");
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
    );

    assert.deepEqual(requestedPeriods, createHistoricalPeriods(period));
    assert.equal(requestedPeriods.length, 5);
    assert.equal(
      analysis.results[0]?.historicalLookupStatus,
      "NOT_FOUND_IN_LOOKBACK",
    );
  });

  it("preserves NO_RECENT_VISIBLE_ACTIVITY when historical lookup fails", async () => {
    let historicalCalls = 0;
    const provider: ActivityProvider = {
      async getAccountActivity(login) {
        return queryResult(login, 0, true);
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
    );

    assert.equal(historicalCalls, 1);
    assert.equal(analysis.results[0]?.status, "NO_RECENT_VISIBLE_ACTIVITY");
    assert.equal(analysis.results[0]?.lastVisibleActivityAt, null);
    assert.equal(analysis.results[0]?.historicalLookupStatus, "FAILED");
    assert.match(analysis.results[0]?.historicalLookupError ?? "", /unavailable/);
  });
});
