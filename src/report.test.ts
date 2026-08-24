import assert from "node:assert/strict";
import { it } from "node:test";
import type { ActivityAnalysis } from "./activity/analyzer.js";
import { createAuditResult } from "./domain/audit.js";
import { formatActivityReport, formatSummary } from "./report.js";

it("formats the terminal summary with account types and rate limit", () => {
  const output = formatSummary({
    username: "octocat",
    accounts: [
      { login: "one", id: 1, type: "User", htmlUrl: "https://github.com/one" },
      { login: "org", id: 2, type: "Organization", htmlUrl: "https://github.com/org" },
    ],
    rateLimit: { limit: 5000, remaining: 4998 },
  });

  assert.equal(
    output,
    [
      "GitHub Ghost Following",
      "",
      "User: octocat",
      "Following found: 2",
      "",
      "Account types:",
      "  User: 1",
      "  Organization: 1",
      "",
      "GitHub API:",
      "  Remaining requests: 4998 / 5000",
    ].join("\n"),
  );
});

it("formats and orders activity details by semantic status", () => {
  const period = {
    from: "2025-08-22T00:00:00.000Z",
    to: "2026-08-22T00:00:00.000Z",
    days: 365,
  };
  const quietAccount = {
    login: "quiet",
    id: 1,
    type: "User",
    htmlUrl: "https://github.com/quiet",
  };
  const activeAccount = {
    login: "active",
    id: 2,
    type: "User",
    htmlUrl: "https://github.com/active",
  };
  const unknownAccount = {
    login: "unknown",
    id: 3,
    type: "User",
    htmlUrl: "https://github.com/unknown",
  };
  const notFoundAccount = {
    login: "not-found",
    id: 4,
    type: "User",
    htmlUrl: "https://github.com/not-found",
  };
  const noPastAccount = {
    login: "no-past",
    id: 5,
    type: "User",
    htmlUrl: "https://github.com/no-past",
  };
  const analysis: ActivityAnalysis = {
    period,
    followingTotal: 6,
    eligibleUsers: 5,
    unsupportedAccounts: 1,
    results: [
      {
        account: activeAccount,
        status: "ACTIVE",
        activity: {
          login: "active",
          periodStart: period.from,
          periodEnd: period.to,
          totalContributions: 12,
          totalCommitContributions: 8,
          totalIssueContributions: 1,
          totalPullRequestContributions: 2,
          totalPullRequestReviewContributions: 1,
          restrictedContributionsCount: 0,
          hasAnyContributions: true,
          hasAnyRestrictedContributions: false,
          hasActivityInThePast: true,
        },
      },
      {
        account: quietAccount,
        status: "NO_RECENT_VISIBLE_ACTIVITY",
        lastVisibleActivityAt: "2024-09-17",
        historicalLookupStatus: "FOUND",
        activity: {
          login: "quiet",
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
          hasActivityInThePast: true,
        },
      },
      {
        account: notFoundAccount,
        status: "NO_RECENT_VISIBLE_ACTIVITY",
        lastVisibleActivityAt: null,
        historicalLookupStatus: "NOT_FOUND_IN_LOOKBACK",
        activity: {
          login: "not-found",
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
          hasActivityInThePast: true,
        },
      },
      {
        account: noPastAccount,
        status: "NO_RECENT_VISIBLE_ACTIVITY",
        lastVisibleActivityAt: null,
        historicalLookupStatus: "NO_PAST_ACTIVITY",
        activity: {
          login: "no-past",
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
      },
      { account: unknownAccount, status: "UNKNOWN" },
    ],
    counts: {
      ACTIVE: 1,
      NO_RECENT_VISIBLE_ACTIVITY: 3,
      INSUFFICIENT_VISIBILITY: 0,
      UNKNOWN: 1,
    },
    coverage: (4 / 5) * 100,
    rateLimit: {
      cost: 1,
      limit: 5000,
      remaining: 4997,
      resetAt: new Date("2026-08-22T01:00:00.000Z"),
    },
  };

  const output = formatActivityReport(createAuditResult({
    user: "owner",
    generatedAt: new Date("2026-08-22T00:00:00.000Z"),
    analysis,
    restRateLimit: { limit: 5000, remaining: 4998 },
  }));

  assert.match(output, /Eligible users: 5/);
  assert.match(output, /Coverage: 80\.0%/);
  assert.match(output, /USERNAME\s+LAST VISIBLE ACTIVITY\s+PAST ACTIVITY\s+STATUS/);
  assert.match(output, /no-past\s+no past activity\s+no\s+NO_RECENT_VISIBLE_ACTIVITY/);
  assert.match(output, /quiet\s+2024-09-17\s+yes\s+NO_RECENT_VISIBLE_ACTIVITY/);
  assert.match(output, /not-found\s+not found in 5y\s+yes\s+NO_RECENT_VISIBLE_ACTIVITY/);
  assert.ok(output.indexOf("no-past") < output.indexOf("not-found"));
  assert.ok(output.indexOf("not-found") < output.indexOf("quiet"));
  assert.ok(output.indexOf("quiet") < output.indexOf("unknown"));
  assert.ok(output.indexOf("unknown") < output.indexOf("active"));
  assert.match(output, /Remaining: 4997 \/ 5000/);
});
