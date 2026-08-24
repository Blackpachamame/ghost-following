import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createActivityPeriod, type ActivityPeriod } from "../domain/activity.js";
import {
  GitHubAuthenticationError,
  GitHubGraphQLAccountError,
} from "./errors.js";
import {
  ACCOUNT_ACTIVITY_QUERY,
  GitHubGraphQLClient,
  HISTORICAL_ACTIVITY_QUERY,
  parseAccountActivityResponse,
  parseHistoricalActivityResponse,
} from "./graphql.js";

const period = createActivityPeriod(new Date("2026-08-22T00:00:00.000Z"));

function payload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      user: {
        login: "octocat",
        contributionsCollection: {
          startedAt: period.from,
          endedAt: period.to,
          hasAnyContributions: true,
          hasAnyRestrictedContributions: false,
          hasActivityInThePast: true,
          restrictedContributionsCount: 0,
          totalCommitContributions: 7,
          totalIssueContributions: 1,
          totalPullRequestContributions: 2,
          totalPullRequestReviewContributions: 3,
          contributionCalendar: { totalContributions: 15 },
        },
      },
      rateLimit: {
        cost: 1,
        limit: 5000,
        remaining: 4999,
        resetAt: "2026-08-22T01:00:00.000Z",
      },
    },
    ...overrides,
  };
}

describe("parseAccountActivityResponse", () => {
  it("normalizes the official current-period fields without summing them", () => {
    const result = parseAccountActivityResponse(payload(), "octocat", period);

    assert.equal(result.activity.totalContributions, 15);
    assert.equal(result.activity.totalCommitContributions, 7);
    assert.equal(result.activity.totalIssueContributions, 1);
    assert.equal(result.activity.totalPullRequestContributions, 2);
    assert.equal(result.activity.totalPullRequestReviewContributions, 3);
    assert.equal(result.activity.hasActivityInThePast, true);
    assert.equal(result.rateLimit.cost, 1);
    assert.doesNotMatch(ACCOUNT_ACTIVITY_QUERY, /userViewType/);
  });

  it("requires hasActivityInThePast instead of guessing it", () => {
    const response = payload();
    delete (response.data.user.contributionsCollection as Record<string, unknown>)
      .hasActivityInThePast;

    assert.throws(
      () => parseAccountActivityResponse(response, "octocat", period),
      GitHubGraphQLAccountError,
    );
  });

  it("turns a user-scoped GraphQL error into an account error", () => {
    assert.throws(
      () =>
        parseAccountActivityResponse(
          payload({
            errors: [{ message: "User data unavailable", path: ["user"] }],
          }),
          "octocat",
          period,
        ),
      GitHubGraphQLAccountError,
    );
  });

  it("turns an incomplete account response into an account error", () => {
    assert.throws(
      () =>
        parseAccountActivityResponse(
          {
            data: {
              user: { login: "octocat" },
              rateLimit: payload().data.rateLimit,
            },
          },
          "octocat",
          period,
        ),
      GitHubGraphQLAccountError,
    );
  });

  it("treats a GraphQL permission error as fatal authentication failure", () => {
    assert.throws(
      () =>
        parseAccountActivityResponse(
          payload({
            data: null,
            errors: [{ message: "Resource not accessible by personal access token" }],
          }),
          "octocat",
          period,
        ),
      GitHubAuthenticationError,
    );
  });
});

function historicalPayload(
  contributionDays: Array<{ contributionCount: number; date: string }>,
  latestRestrictedContributionDate: string | null = null,
  collectionOverrides: Record<string, unknown> = {},
) {
  const totalContributions = contributionDays.reduce(
    (total, day) => total + day.contributionCount,
    0,
  );
  return {
    data: {
      user: {
        login: "octocat",
        contributionsCollection: {
          startedAt: "2024-08-22T00:00:00.000Z",
          endedAt: "2025-08-22T00:00:00.000Z",
          hasAnyContributions: totalContributions > 0,
          hasAnyRestrictedContributions:
            latestRestrictedContributionDate !== null,
          restrictedContributionsCount:
            latestRestrictedContributionDate === null ? 0 : 1,
          latestRestrictedContributionDate,
          contributionCalendar: {
            totalContributions,
            weeks: [{ contributionDays }],
          },
          ...collectionOverrides,
        },
      },
      rateLimit: payload().data.rateLimit,
    },
  };
}

describe("parseHistoricalActivityResponse", () => {
  it("takes the most recent positive public calendar day", () => {
    const result = parseHistoricalActivityResponse(
      historicalPayload([
        { contributionCount: 2, date: "2023-04-10" },
        { contributionCount: 0, date: "2025-01-01" },
        { contributionCount: 1, date: "2024-09-17" },
      ]),
      "octocat",
    );

    assert.equal(result.lastVisibleActivityAt, "2024-09-17");
  });

  it("returns the maximum of public and restricted activity dates", () => {
    assert.equal(
      parseHistoricalActivityResponse(
        historicalPayload(
          [{ contributionCount: 1, date: "2022-01-03" }],
          "2022-06-28",
        ),
        "octocat",
      ).lastVisibleActivityAt,
      "2022-06-28",
    );
    assert.equal(
      parseHistoricalActivityResponse(
        historicalPayload(
          [{ contributionCount: 1, date: "2022-09-03" }],
          "2022-06-28",
        ),
        "octocat",
      ).lastVisibleActivityAt,
      "2022-09-03",
    );
  });

  it("returns null for a valid empty annual window", () => {
    assert.equal(
      parseHistoricalActivityResponse(historicalPayload([]), "octocat")
        .lastVisibleActivityAt,
      null,
    );
  });

  it("fails precisely when official signals report activity without a date", () => {
    assert.throws(
      () =>
        parseHistoricalActivityResponse(
          historicalPayload([], null, { hasAnyContributions: true }),
          "octocat",
        ),
      GitHubGraphQLAccountError,
    );
  });

  it("never invents a date from malformed historical data", () => {
    assert.throws(
      () =>
        parseHistoricalActivityResponse(
          historicalPayload([{ contributionCount: 1, date: "not-a-date" }]),
          "octocat",
        ),
      GitHubGraphQLAccountError,
    );
  });
});

describe("GitHubGraphQLClient", () => {
  it("posts the current query, variables and bearer token", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify(payload()), { status: 200 });
    }) as typeof fetch;

    await new GitHubGraphQLClient({
      token: "obvious-test-placeholder",
      fetch: fetchMock,
    }).getAccountActivity("octocat", period);

    assert.equal(requestUrl, "https://api.github.com/graphql");
    assert.equal(requestInit?.method, "POST");
    assert.equal(
      new Headers(requestInit?.headers).get("authorization"),
      "Bearer obvious-test-placeholder",
    );
    const body = JSON.parse(String(requestInit?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    assert.equal(body.query, ACCOUNT_ACTIVITY_QUERY);
    assert.deepEqual(body.variables, {
      login: "octocat",
      from: period.from,
      to: period.to,
    });
  });

  it("queries each explicit historical period with from and to", async () => {
    let requestBody = "";
    const historicalPeriod: ActivityPeriod = {
      from: "2024-08-22T00:00:00.000Z",
      to: "2025-08-22T00:00:00.000Z",
      days: 365,
    };
    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify(historicalPayload([])), { status: 200 });
    }) as typeof fetch;

    await new GitHubGraphQLClient({ token: "test", fetch: fetchMock })
      .getHistoricalActivity("octocat", historicalPeriod);

    const body = JSON.parse(requestBody) as {
      query: string;
      variables: Record<string, string>;
    };
    assert.equal(body.query, HISTORICAL_ACTIVITY_QUERY);
    assert.deepEqual(body.variables, {
      login: "octocat",
      from: historicalPeriod.from,
      to: historicalPeriod.to,
    });
    assert.doesNotMatch(body.query, /mostRecentCollectionWithActivity/);
  });

  it("treats HTTP 401 as a fatal authentication error", async () => {
    const fetchMock = (async () =>
      new Response('{"message":"Bad credentials"}', { status: 401 })) as typeof fetch;

    await assert.rejects(
      new GitHubGraphQLClient({ token: "invalid", fetch: fetchMock })
        .getAccountActivity("octocat", period),
      GitHubAuthenticationError,
    );
  });
});
