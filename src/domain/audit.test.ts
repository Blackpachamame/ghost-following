import assert from "node:assert/strict";
import { it } from "node:test";
import type { ActivityAnalysis } from "../activity/analyzer.js";
import { createAuditResult } from "./audit.js";

it("creates a reusable audit result with stable summary and coherent nulls", () => {
  const period = {
    from: "2026-02-23T00:00:00.000Z",
    to: "2026-08-22T00:00:00.000Z",
    days: 180,
  };
  const analysis: ActivityAnalysis = {
    period,
    followingTotal: 3,
    eligibleUsers: 2,
    unsupportedAccounts: 1,
    results: [
      {
        account: {
          login: "active",
          id: 1,
          type: "User",
          htmlUrl: "https://github.com/active",
        },
        status: "ACTIVE",
        activity: {
          login: "active",
          periodStart: period.from,
          periodEnd: period.to,
          totalContributions: 4,
          totalCommitContributions: 2,
          totalIssueContributions: 1,
          totalPullRequestContributions: 1,
          totalPullRequestReviewContributions: 0,
          restrictedContributionsCount: 0,
          hasAnyContributions: true,
          hasAnyRestrictedContributions: false,
          hasActivityInThePast: true,
        },
      },
      {
        account: {
          login: "unknown",
          id: 2,
          type: "User",
          htmlUrl: "https://github.com/unknown",
        },
        status: "UNKNOWN",
      },
    ],
    counts: {
      ACTIVE: 1,
      NO_RECENT_VISIBLE_ACTIVITY: 0,
      INSUFFICIENT_VISIBILITY: 0,
      UNKNOWN: 1,
    },
    coverage: 50,
    rateLimit: {
      cost: 1,
      limit: 5000,
      remaining: 4997,
      resetAt: new Date("2026-08-22T01:00:00.000Z"),
    },
  };

  const audit = createAuditResult({
    user: "owner",
    generatedAt: new Date("2026-08-22T00:00:00.000Z"),
    analysis,
    restRateLimit: { limit: 5000, remaining: 4998 },
  });

  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.generatedAt, "2026-08-22T00:00:00.000Z");
  assert.equal(audit.period.days, 180);
  assert.deepEqual(audit.summary, {
    followingTotal: 3,
    eligibleUsers: 2,
    unsupportedAccounts: 1,
    active: 1,
    noRecentVisibleActivity: 0,
    insufficientVisibility: 0,
    unknown: 1,
    coverage: 50,
  });
  assert.equal(audit.accounts.length, 2);
  assert.equal(audit.accounts[0]?.commitContributions, 2);
  assert.equal(audit.accounts[1]?.totalContributions, null);
  assert.equal(audit.accounts[1]?.hasActivityInThePast, null);
  assert.equal(audit.accounts[1]?.historicalLookupStatus, null);
  assert.equal(audit.rateLimits.graphql?.resetAt, "2026-08-22T01:00:00.000Z");
});
