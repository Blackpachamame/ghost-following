import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FollowedAccount } from "../domain/account.js";
import {
  createActivityPeriod,
  createHistoricalPeriods,
  type AccountActivity,
  type ActivityPeriod,
} from "../domain/activity.js";
import { GitHubGraphQLAccountError } from "../github/errors.js";
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
