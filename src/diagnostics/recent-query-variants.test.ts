import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAccountActivityBatchQuery } from "../github/batch-activity.js";
import {
  buildRecentQueryVariant,
  CLASSIFIER_MINIMAL_FIELDS,
  CURRENT_FIELDS,
  NUMERIC_MINIMAL_FIELDS,
  parseRecentQueryVariant,
  RecentQueryVariantError,
} from "./recent-query-variants.js";

const PERIOD = { from: "2025-08-25T00:00:00.000Z", to: "2026-08-25T00:00:00.000Z", days: 365 };
const RATE = { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-08-25T01:00:00.000Z" };

function payload(login = "Alice", active = true, total = active ? 2 : 0) {
  return { data: { u0: { login, contributionsCollection: {
    startedAt: PERIOD.from, endedAt: PERIOD.to,
    hasAnyContributions: active, hasAnyRestrictedContributions: false,
    hasActivityInThePast: false, restrictedContributionsCount: 0,
    totalCommitContributions: total, totalIssueContributions: 0,
    totalPullRequestContributions: 0, totalPullRequestReviewContributions: 0,
    contributionCalendar: { totalContributions: total },
  } }, rateLimit: RATE } };
}

describe("recent query variants", () => {
  it("CURRENT wraps the exact productive builder output and declares its exact fields", () => {
    const productive = buildAccountActivityBatchQuery(["Alice", "Bob"], PERIOD);
    const current = buildRecentQueryVariant(["Alice", "Bob"], PERIOD, "CURRENT");
    assert.equal(current.query, productive.query);
    assert.deepEqual(current.variables, productive.variables);
    assert.deepEqual(current.aliases, productive.aliases);
    assert.deepEqual(current.fields, CURRENT_FIELDS);
  });

  it("CLASSIFIER_MINIMAL requests only login, two booleans and rate-limit metadata", () => {
    const built = buildRecentQueryVariant(["Alice"], PERIOD, "CLASSIFIER_MINIMAL");
    assert.deepEqual(built.fields, CLASSIFIER_MINIMAL_FIELDS);
    assert.match(built.query, /hasAnyContributions/);
    assert.match(built.query, /hasAnyRestrictedContributions/);
    assert.doesNotMatch(built.query, /hasActivityInThePast|totalCommit|contributionCalendar|restrictedContributionsCount/);
  });

  it("NUMERIC_MINIMAL has the exact preserved numeric set without historical metadata", () => {
    const built = buildRecentQueryVariant(["Alice"], PERIOD, "NUMERIC_MINIMAL");
    assert.deepEqual(built.fields, NUMERIC_MINIMAL_FIELDS);
    for (const field of ["totalCommitContributions", "totalIssueContributions", "totalPullRequestContributions", "totalPullRequestReviewContributions", "restrictedContributionsCount", "totalContributions"]) {
      assert.match(built.query, new RegExp(field));
    }
    assert.doesNotMatch(built.query, /hasActivityInThePast|startedAt|endedAt/);
  });

  it("all variants preserve aliases, logins and period variables", () => {
    for (const variant of ["CURRENT", "CLASSIFIER_MINIMAL", "NUMERIC_MINIMAL"] as const) {
      const built = buildRecentQueryVariant(["Alice", "Bob"], PERIOD, variant);
      assert.deepEqual(built.aliases, [{ alias: "u0", login: "Alice" }, { alias: "u1", login: "Bob" }]);
      assert.deepEqual(built.variables, { from: PERIOD.from, to: PERIOD.to, login0: "Alice", login1: "Bob" });
    }
  });

  it("parses equivalent classifications and numeric details", () => {
    for (const variant of ["CURRENT", "CLASSIFIER_MINIMAL", "NUMERIC_MINIMAL"] as const) {
      const parsed = parseRecentQueryVariant(payload(), buildRecentQueryVariant(["Alice"], PERIOD, variant), PERIOD);
      assert.equal(parsed.accounts[0]?.classification, "ACTIVE");
      assert.equal(parsed.rateLimit.cost, 1);
      assert.equal(parsed.rateLimit.remaining, 4999);
      assert.equal(parsed.accounts[0]?.details?.totalContributions, variant === "CLASSIFIER_MINIMAL" ? undefined : 2);
    }
  });

  it("keeps the classifier hypothesis observable instead of inventing numeric equivalence", () => {
    const body = payload("Alice", false, 2);
    const current = parseRecentQueryVariant(body, buildRecentQueryVariant(["Alice"], PERIOD, "CURRENT"), PERIOD);
    const minimal = parseRecentQueryVariant(body, buildRecentQueryVariant(["Alice"], PERIOD, "CLASSIFIER_MINIMAL"), PERIOD);
    assert.equal(current.accounts[0]?.classification, "ACTIVE");
    assert.equal(minimal.accounts[0]?.classification, "NO_RECENT_VISIBLE_ACTIVITY");
  });

  it("enforces returned-login identity case-insensitively", () => {
    assert.doesNotThrow(() => parseRecentQueryVariant(payload("alice"), buildRecentQueryVariant(["Alice"], PERIOD, "NUMERIC_MINIMAL"), PERIOD));
    assert.throws(
      () => parseRecentQueryVariant(payload("Bob"), buildRecentQueryVariant(["Alice"], PERIOD, "CURRENT"), PERIOD),
      (error) => error instanceof RecentQueryVariantError && error.outcome === "SCHEMA_ERROR",
    );
  });

  it("normalizes semantic resource, auth and rate-limit failures", () => {
    const cases = [
      ["Resource limits for this query exceeded.", "RESOURCE_LIMIT"],
      ["Bad credentials", "AUTH_ERROR"],
      ["API rate limit exceeded", "RATE_LIMIT"],
    ] as const;
    for (const [message, outcome] of cases) {
      const body = { data: { rateLimit: RATE, u0: null }, errors: [{ message, path: ["u0"] }] };
      assert.throws(
        () => parseRecentQueryVariant(body, buildRecentQueryVariant(["Alice"], PERIOD, "NUMERIC_MINIMAL"), PERIOD),
        (error) => error instanceof RecentQueryVariantError && error.outcome === outcome,
      );
    }
  });
});
