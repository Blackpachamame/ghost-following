import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateCoverage,
  classifyActivity,
  createActivityPeriod,
  createHistoricalLookbackStart,
  createHistoricalPeriods,
  type AccountActivity,
  type AccountActivityResult,
} from "./activity.js";

function activity(overrides: Partial<AccountActivity> = {}): AccountActivity {
  return {
    login: "octocat",
    periodStart: "2025-01-01T00:00:00.000Z",
    periodEnd: "2026-01-01T00:00:00.000Z",
    totalContributions: 0,
    totalCommitContributions: 0,
    totalIssueContributions: 0,
    totalPullRequestContributions: 0,
    totalPullRequestReviewContributions: 0,
    restrictedContributionsCount: 0,
    hasAnyContributions: false,
    hasAnyRestrictedContributions: false,
    hasActivityInThePast: false,
    ...overrides,
  };
}

describe("classifyActivity", () => {
  it("does not let userViewType change a zero-activity classification", () => {
    const activityWithViewType = {
      ...activity(),
      userViewType: "PRIVATE",
    };

    assert.equal(
      classifyActivity(activityWithViewType),
      "NO_RECENT_VISIBLE_ACTIVITY",
    );
  });

  it("classifies public non-commit contributions as ACTIVE", () => {
    assert.equal(
      classifyActivity(
        activity({
          totalContributions: 4,
          totalPullRequestContributions: 4,
          hasAnyContributions: true,
        }),
      ),
      "ACTIVE",
    );
  });

  it("classifies restricted activity alone as ACTIVE", () => {
    assert.equal(
      classifyActivity(
        activity({
          restrictedContributionsCount: 3,
          hasAnyRestrictedContributions: true,
        }),
      ),
      "ACTIVE",
    );
  });

  it("classifies a complete zero response as NO_RECENT_VISIBLE_ACTIVITY", () => {
    assert.equal(classifyActivity(activity()), "NO_RECENT_VISIBLE_ACTIVITY");
  });

});

describe("calculateCoverage", () => {
  it("counts only evaluable statuses", () => {
    const account = {
      login: "one",
      id: 1,
      type: "User",
      htmlUrl: "https://github.com/one",
    };
    const results: AccountActivityResult[] = [
      { account, status: "ACTIVE", activity: activity() },
      { account, status: "NO_RECENT_VISIBLE_ACTIVITY", activity: activity() },
      { account, status: "UNKNOWN" },
      { account, status: "INSUFFICIENT_VISIBILITY" },
    ];

    assert.equal(calculateCoverage(results, 4), 50);
    assert.equal(calculateCoverage([], 0), null);
  });

  it("reports full coverage for 48 active and 30 quiet users", () => {
    const account = {
      login: "one",
      id: 1,
      type: "User",
      htmlUrl: "https://github.com/one",
    };
    const results: AccountActivityResult[] = [
      ...Array.from({ length: 48 }, () => ({
        account,
        status: "ACTIVE" as const,
      })),
      ...Array.from({ length: 30 }, () => ({
        account,
        status: "NO_RECENT_VISIBLE_ACTIVITY" as const,
      })),
    ];

    assert.equal(calculateCoverage(results, 78)?.toFixed(1), "100.0");
  });
});

it("creates an explicit 365-day UTC period", () => {
  const period = createActivityPeriod(new Date("2026-08-22T12:00:00-03:00"));

  assert.deepEqual(period, {
    from: "2025-08-22T15:00:00.000Z",
    to: "2026-08-22T15:00:00.000Z",
    days: 365,
  });
});

it("creates a configurable 180-day UTC period", () => {
  assert.deepEqual(
    createActivityPeriod(new Date("2026-08-22T00:00:00.000Z"), 180),
    {
      from: "2026-02-23T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
      days: 180,
    },
  );
});

it("starts historical lookup immediately before a custom recent period", () => {
  const recent = createActivityPeriod(
    new Date("2026-08-22T00:00:00.000Z"),
    180,
  );
  const historical = createHistoricalPeriods(recent);

  assert.equal(historical[0]?.to, "2026-02-22T23:59:59.999Z");
  assert.ok(new Date(historical[0]?.to ?? 0) < new Date(recent.from));
  assert.ok(new Date(historical[0]?.from ?? 0) < new Date(recent.from));
  assert.ok(historical.every(({ to }) => new Date(to) < new Date(recent.from)));
  for (let index = 1; index < historical.length; index += 1) {
    assert.ok(
      new Date(historical[index]?.to ?? 0) <
        new Date(historical[index - 1]?.from ?? 0),
    );
  }
});

it("creates five adjacent historical windows before the recent period", () => {
  const recent = {
    from: "2024-02-29T12:00:00.000Z",
    to: "2025-02-28T12:00:00.000Z",
    days: 365,
  };

  assert.equal(
    createHistoricalLookbackStart(recent),
    "2019-02-28T12:00:00.000Z",
  );
  assert.deepEqual(createHistoricalPeriods(recent), [
    {
      from: "2023-02-28T12:00:00.000Z",
      to: "2024-02-29T11:59:59.999Z",
      days: 366,
    },
    {
      from: "2022-02-28T12:00:00.000Z",
      to: "2023-02-28T11:59:59.999Z",
      days: 365,
    },
    {
      from: "2021-02-28T12:00:00.000Z",
      to: "2022-02-28T11:59:59.999Z",
      days: 365,
    },
    {
      from: "2020-02-28T12:00:00.000Z",
      to: "2021-02-28T11:59:59.999Z",
      days: 366,
    },
    {
      from: "2019-02-28T12:00:00.000Z",
      to: "2020-02-28T11:59:59.999Z",
      days: 365,
    },
  ]);
});
