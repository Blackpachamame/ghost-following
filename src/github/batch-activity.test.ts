import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAccountActivityBatchQuery,
  parseAccountActivityBatchResponse,
} from "./batch-activity.js";

const period = {
  from: "2025-08-24T00:00:00.000Z",
  to: "2026-08-24T00:00:00.000Z",
  days: 365,
};

function user(login: string, total = 1) {
  return {
    login,
    contributionsCollection: {
      startedAt: period.from,
      endedAt: period.to,
      hasAnyContributions: total > 0,
      hasAnyRestrictedContributions: false,
      hasActivityInThePast: false,
      restrictedContributionsCount: 0,
      totalCommitContributions: total,
      totalIssueContributions: 0,
      totalPullRequestContributions: 0,
      totalPullRequestReviewContributions: 0,
      contributionCalendar: { totalContributions: total },
    },
  };
}

const rateLimit = {
  cost: 1,
  limit: 5000,
  remaining: 4999,
  resetAt: "2026-08-24T01:00:00.000Z",
};

describe("production activity batch query", () => {
  it("builds 25 safe variables and aliases with every production signal", () => {
    const logins = Array.from({ length: 25 }, (_, index) =>
      index === 0 ? 'unsafe"login' : `user-${index}`,
    );
    const built = buildAccountActivityBatchQuery(logins, period);

    assert.equal(built.aliases.length, 25);
    assert.equal(built.variables.login0, logins[0]);
    assert.equal(built.variables.login24, logins[24]);
    assert.doesNotMatch(built.query, /unsafe"login/);
    assert.match(built.query, /u24: user\(login: \$login24\)/);
    for (const field of [
      "hasActivityInThePast",
      "totalCommitContributions",
      "totalIssueContributions",
      "totalPullRequestContributions",
      "totalPullRequestReviewContributions",
      "restrictedContributionsCount",
      "totalContributions",
    ]) {
      assert.match(built.query, new RegExp(field));
    }
  });

  it("parses successful aliases independently from partial GraphQL errors", () => {
    const built = buildAccountActivityBatchQuery(["ok", "limited", "missing"], period);
    const parsed = parseAccountActivityBatchResponse(
      {
        data: {
          u0: user("ok", 7),
          u1: null,
          u2: null,
          rateLimit,
        },
        errors: [
          {
            message: "Resource limits for this query exceeded.",
            path: ["u1"],
          },
          { message: "User unavailable.", path: ["u2"] },
        ],
      },
      built,
      period,
    );

    assert.equal(parsed.items[0]?.status, "SUCCESS");
    assert.equal(
      parsed.items[0]?.status === "SUCCESS"
        ? parsed.items[0].activity.totalContributions
        : null,
      7,
    );
    assert.equal(parsed.items[1]?.status, "RESOURCE_LIMIT");
    assert.equal(parsed.items[2]?.status, "ACCOUNT_ERROR");
  });

  it("distinguishes user null from a global schema failure", () => {
    const built = buildAccountActivityBatchQuery(["missing"], period);
    const missing = parseAccountActivityBatchResponse(
      { data: { u0: null, rateLimit } },
      built,
      period,
    );
    assert.equal(missing.items[0]?.status, "ACCOUNT_ERROR");

    assert.throws(
      () =>
        parseAccountActivityBatchResponse(
          {
            data: null,
            errors: [{ message: "Cannot query field invalidField." }],
          },
          built,
          period,
        ),
      /batch query failed/,
    );
  });
});
