import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createActivityPeriod, type ActivityPeriod } from "../domain/activity.js";
import {
  GitHubAuthenticationError,
  GitHubGraphQLAccountError,
  GitHubGraphQLFatalError,
  GitHubGraphQLResponseBodyError,
  GitHubHttpError,
  GitHubRateLimitError,
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

  it("classifies a GraphQL HTTP 200 rate-limit error as PRIMARY at zero quota", () => {
    assert.throws(
      () =>
        parseAccountActivityResponse(
          {
            data: {
              rateLimit: {
                cost: 1,
                limit: 5000,
                remaining: 0,
                resetAt: "2026-08-22T01:00:00.000Z",
              },
            },
            errors: [{ message: "API rate limit exceeded" }],
          },
          "octocat",
          period,
        ),
      (error: unknown) => {
        assert.ok(error instanceof GitHubRateLimitError);
        assert.equal(error.kind, "PRIMARY");
        assert.equal(error.remaining, 0);
        return true;
      },
    );
  });

  it("classifies an explicit GraphQL HTTP 200 secondary message as SECONDARY", () => {
    assert.throws(
      () =>
        parseAccountActivityResponse(
          {
            data: {
              rateLimit: {
                cost: 1,
                limit: 5000,
                remaining: 4864,
                resetAt: "2026-08-22T01:00:00.000Z",
              },
            },
            errors: [{ message: "Abuse detection mechanism triggered." }],
          },
          "octocat",
          period,
        ),
      (error: unknown) => {
        assert.ok(error instanceof GitHubRateLimitError);
        assert.equal(error.kind, "SECONDARY");
        assert.equal(error.remaining, 4864);
        return true;
      },
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

function batchPayload(requestBody: string) {
  const body = JSON.parse(requestBody) as {
    variables: Record<string, string>;
  };
  const data: Record<string, unknown> = {
    rateLimit: payload().data.rateLimit,
  };
  const loginKeys = Object.keys(body.variables)
    .filter((key) => /^login\d+$/.test(key))
    .sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)));
  for (const [index, key] of loginKeys.entries()) {
    const login = body.variables[key]!;
    data[`u${index}`] = {
      login,
      contributionsCollection: {
        startedAt: period.from,
        endedAt: period.to,
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
  return { data };
}

function transportError(code: string): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket failure"), { code }),
  });
}

function responseWithBodyReadFailure(error: unknown): Response {
  const response = new Response("", { status: 200 });
  Object.defineProperty(response, "text", {
    value: async () => Promise.reject(error),
  });
  return response;
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
  it("preserves headers and never retries HTTP 200 primary or secondary rate limits", async () => {
    const cases = [
      {
        message: "API rate limit exceeded",
        remaining: 0,
        expectedKind: "PRIMARY",
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1787360400",
        },
      },
      {
        message: "You have exceeded a secondary rate limit.",
        remaining: 4864,
        expectedKind: "SECONDARY",
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4864",
          "retry-after": "60",
        },
      },
    ] as const;

    for (const testCase of cases) {
      let requests = 0;
      await assert.rejects(
        new GitHubGraphQLClient({
          token: "secret-test-placeholder",
          fetch: (async () => {
            requests += 1;
            return new Response(
              JSON.stringify({
                data: {
                  rateLimit: {
                    cost: 1,
                    limit: 5000,
                    remaining: testCase.remaining,
                    resetAt: "2026-08-22T01:00:00.000Z",
                  },
                },
                errors: [{ message: testCase.message }],
              }),
              { status: 200, headers: testCase.headers },
            );
          }) as typeof fetch,
          sleep: async () => {
            throw new Error("sleep must not be called");
          },
        }).getAccountActivity("octocat", period),
        (error: unknown) => {
          assert.ok(error instanceof GitHubRateLimitError);
          assert.equal(error.kind, testCase.expectedKind);
          assert.equal(error.remaining, testCase.remaining);
          assert.equal(error.limit, 5000);
          assert.equal(
            error.retryAfterSeconds,
            testCase.expectedKind === "SECONDARY" ? 60 : undefined,
          );
          assert.doesNotMatch(
            error.message,
            /secret-test-placeholder|authorization|query|variables/i,
          );
          return true;
        },
      );
      assert.equal(requests, 1);
    }
  });

  it("classifies HTTP 403 secondary and HTTP 429 without evidence conservatively", async () => {
    const cases = [
      {
        status: 403,
        body: { message: "Secondary rate limit reached." },
        expectedKind: "SECONDARY",
      },
      {
        status: 429,
        body: { message: "Request temporarily restricted." },
        expectedKind: "UNKNOWN",
      },
    ] as const;

    for (const testCase of cases) {
      let requests = 0;
      await assert.rejects(
        new GitHubGraphQLClient({
          token: "test",
          fetch: (async () => {
            requests += 1;
            return new Response(JSON.stringify(testCase.body), {
              status: testCase.status,
              headers: {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4864",
              },
            });
          }) as typeof fetch,
          sleep: async () => {
            throw new Error("sleep must not be called");
          },
        }).getAccountActivity("octocat", period),
        (error: unknown) => {
          assert.ok(error instanceof GitHubRateLimitError);
          assert.equal(error.kind, testCase.expectedKind);
          return true;
        },
      );
      assert.equal(requests, 1);
    }
  });
  it("retries invalid JSON with the exact same recent request and then succeeds", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      body: string;
    }> = [];
    const delays: number[] = [];
    const logins = ["first", "second"];
    const fetchMock = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = {
        url: String(input),
        method: init?.method,
        body: String(init?.body),
      };
      requests.push(request);
      return requests.length === 1
        ? new Response("{invalid", { status: 200 })
        : new Response(JSON.stringify(batchPayload(request.body)), {
            status: 200,
          });
    }) as typeof fetch;

    const result = await new GitHubGraphQLClient({
      token: "test",
      fetch: fetchMock,
      sleep: async (delay) => void delays.push(delay),
    }).getAccountActivities(logins, period);

    assert.equal(result.items.length, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(delays, [1_000]);
    const sent = JSON.parse(requests[0]!.body) as {
      query: string;
      variables: Record<string, string>;
    };
    assert.match(sent.query, /u1: user\(login: \$login1\)/);
    assert.deepEqual(sent.variables, {
      login0: "first",
      login1: "second",
      from: period.from,
      to: period.to,
    });
  });

  it("uses exactly three total attempts for two invalid JSON responses then success", async () => {
    const bodies: string[] = [];
    const delays: number[] = [];
    const fetchMock = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = String(init?.body);
      bodies.push(body);
      return bodies.length < 3
        ? new Response("not-json", { status: 200 })
        : new Response(JSON.stringify(batchPayload(body)), { status: 200 });
    }) as typeof fetch;

    await new GitHubGraphQLClient({
      token: "test",
      fetch: fetchMock,
      sleep: async (delay) => void delays.push(delay),
    }).getAccountActivities(["first"], period);

    assert.equal(bodies.length, 3);
    assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(delays, [1_000, 2_000]);
  });

  it("returns a structured body error after three invalid JSON attempts", async () => {
    let requests = 0;
    const invalidBody = "definitely-not-json";
    const fetchMock = (async () => {
      requests += 1;
      return new Response(invalidBody, { status: 200 });
    }) as typeof fetch;

    await assert.rejects(
      new GitHubGraphQLClient({
        token: "obvious-test-placeholder",
        fetch: fetchMock,
        sleep: async () => undefined,
      }).getAccountActivity("octocat", period),
      (error: unknown) => {
        assert.ok(error instanceof GitHubGraphQLResponseBodyError);
        assert.equal(error.category, "INVALID_JSON");
        assert.equal(error.status, 200);
        assert.equal(error.attempts, 3);
        assert.match(error.message, /not valid JSON after 3 attempts/);
        assert.ok(error.cause instanceof GitHubGraphQLResponseBodyError);
        assert.equal(error.cause.cause, undefined);
        assert.doesNotMatch(
          error.message,
          /definitely-not-json|obvious-test-placeholder|authorization|query|variables/i,
        );
        return true;
      },
    );
    assert.equal(requests, 3);
  });

  it("shares one three-attempt budget across HTTP 504, invalid JSON and success", async () => {
    const bodies: string[] = [];
    const delays: number[] = [];
    const fetchMock = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = String(init?.body);
      bodies.push(body);
      if (bodies.length === 1) return new Response("", { status: 504 });
      if (bodies.length === 2) return new Response("{invalid", { status: 200 });
      return new Response(JSON.stringify(batchPayload(body)), { status: 200 });
    }) as typeof fetch;

    await new GitHubGraphQLClient({
      token: "test",
      fetch: fetchMock,
      sleep: async (delay) => void delays.push(delay),
    }).getAccountActivities(["first"], period);

    assert.equal(bodies.length, 3);
    assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(delays, [1_000, 2_000]);
  });

  it("shares one three-attempt budget across transport failure, invalid JSON and success", async () => {
    const bodies: string[] = [];
    const delays: number[] = [];
    const fetchMock = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = String(init?.body);
      bodies.push(body);
      if (bodies.length === 1) throw transportError("ECONNRESET");
      if (bodies.length === 2) return new Response("{invalid", { status: 200 });
      return new Response(JSON.stringify(batchPayload(body)), { status: 200 });
    }) as typeof fetch;

    await new GitHubGraphQLClient({
      token: "test",
      fetch: fetchMock,
      sleep: async (delay) => void delays.push(delay),
    }).getAccountActivities(["first"], period);

    assert.equal(bodies.length, 3);
    assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(delays, [1_000, 2_000]);
  });

  it("uses the final invalid JSON failure when a mixed budget is exhausted", async () => {
    let requests = 0;
    await assert.rejects(
      new GitHubGraphQLClient({
        token: "test",
        fetch: (async () => {
          requests += 1;
          return requests === 2
            ? new Response("", { status: 502 })
            : new Response("{invalid", { status: 200 });
        }) as typeof fetch,
        sleep: async () => undefined,
      }).getAccountActivity("octocat", period),
      (error: unknown) => {
        assert.ok(error instanceof GitHubGraphQLResponseBodyError);
        assert.equal(error.category, "INVALID_JSON");
        assert.equal(error.attempts, 3);
        return true;
      },
    );
    assert.equal(requests, 3);
  });

  it("preserves the final HTTP error after an earlier invalid JSON response", async () => {
    let requests = 0;
    await assert.rejects(
      new GitHubGraphQLClient({
        token: "test",
        fetch: (async () => {
          requests += 1;
          return requests === 1
            ? new Response("{invalid", { status: 200 })
            : new Response("not-json", { status: 504 });
        }) as typeof fetch,
        sleep: async () => undefined,
      }).getAccountActivity("octocat", period),
      (error: unknown) => {
        assert.ok(error instanceof GitHubHttpError);
        assert.equal(error.status, 504);
        assert.equal(error.attempts, 3);
        return true;
      },
    );
    assert.equal(requests, 3);
  });

  it("recovers a classified transient body read failure", async () => {
    let requests = 0;
    const delays: number[] = [];
    const result = await new GitHubGraphQLClient({
      token: "test",
      fetch: (async () => {
        requests += 1;
        return requests === 1
          ? responseWithBodyReadFailure(
              transportError("UND_ERR_BODY_TIMEOUT"),
            )
          : new Response(JSON.stringify(payload()), { status: 200 });
      }) as typeof fetch,
      sleep: async (delay) => void delays.push(delay),
    }).getAccountActivity("octocat", period);

    assert.equal(result.activity.login, "octocat");
    assert.equal(requests, 2);
    assert.deepEqual(delays, [1_000]);
  });

  it("does not retry an unclassified body read failure", async () => {
    let requests = 0;
    await assert.rejects(
      new GitHubGraphQLClient({
        token: "test",
        fetch: (async () => {
          requests += 1;
          return responseWithBodyReadFailure(
            new TypeError("generic body failure"),
          );
        }) as typeof fetch,
        sleep: async () => {
          throw new Error("sleep must not be called");
        },
      }).getAccountActivity("octocat", period),
      (error: unknown) => {
        assert.ok(error instanceof GitHubGraphQLResponseBodyError);
        assert.equal(error.category, "BODY_READ_FAILED");
        assert.equal(error.attempts, 1);
        return true;
      },
    );
    assert.equal(requests, 1);
  });

  it("returns a structured error after three classified body read failures", async () => {
    let requests = 0;
    await assert.rejects(
      new GitHubGraphQLClient({
        token: "test",
        fetch: (async () => {
          requests += 1;
          return responseWithBodyReadFailure(
            transportError("UND_ERR_SOCKET"),
          );
        }) as typeof fetch,
        sleep: async () => undefined,
      }).getAccountActivity("octocat", period),
      (error: unknown) => {
        assert.ok(error instanceof GitHubGraphQLResponseBodyError);
        assert.equal(error.category, "BODY_READ_FAILED");
        assert.equal(error.attempts, 3);
        assert.match(error.message, /could not be read after 3 attempts/);
        return true;
      },
    );
    assert.equal(requests, 3);
  });

  it("retries invalid JSON for the exact same historical user and window", async () => {
    const bodies: string[] = [];
    const historicalPeriod: ActivityPeriod = {
      from: "2024-08-22T00:00:00.000Z",
      to: "2025-08-22T00:00:00.000Z",
      days: 365,
    };
    const result = await new GitHubGraphQLClient({
      token: "test",
      fetch: (async (_input, init) => {
        bodies.push(String(init?.body));
        return bodies.length === 1
          ? new Response("{invalid", { status: 200 })
          : new Response(JSON.stringify(historicalPayload([])), {
              status: 200,
            });
      }) as typeof fetch,
      sleep: async () => undefined,
    }).getHistoricalActivity("octocat", historicalPeriod);

    assert.equal(result.lastVisibleActivityAt, null);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    const sent = JSON.parse(bodies[0]!) as {
      variables: Record<string, string>;
    };
    assert.deepEqual(sent.variables, {
      login: "octocat",
      from: historicalPeriod.from,
      to: historicalPeriod.to,
    });
  });

  it("does not retry a valid RESOURCE_LIMIT GraphQL payload", async () => {
    let requests = 0;
    const result = await new GitHubGraphQLClient({
      token: "test",
      fetch: (async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            data: {
              rateLimit: payload().data.rateLimit,
              u0: null,
              u1: null,
            },
            errors: [{ message: "Resource limits for this query exceeded." }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
      sleep: async () => {
        throw new Error("sleep must not be called");
      },
    }).getAccountActivities(["first", "second"], period);

    assert.equal(requests, 1);
    assert.deepEqual(
      result.items.map(({ status }) => status),
      ["RESOURCE_LIMIT", "RESOURCE_LIMIT"],
    );
  });

  for (const status of [502, 503, 504]) {
    it(`preserves exhausted HTTP ${status} as GitHubHttpError after three attempts`, async () => {
      let requests = 0;
      await assert.rejects(
        new GitHubGraphQLClient({
          token: "test",
          fetch: (async () => {
            requests += 1;
            return new Response("not-json", { status });
          }) as typeof fetch,
          sleep: async () => undefined,
        }).getAccountActivity("octocat", period),
        (error: unknown) => {
          assert.ok(error instanceof GitHubHttpError);
          assert.equal(error.status, status);
          assert.equal(error.attempts, 3);
          return true;
        },
      );
      assert.equal(requests, 3);
    });
  }

  for (const status of [502, 503, 504]) {
    it(`retries HTTP ${status} with the identical 25-user recent batch`, async () => {
      const bodies: string[] = [];
      const delays: number[] = [];
      const logins = Array.from({ length: 25 }, (_, index) => `user-${index}`);
      const fetchMock = (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = String(init?.body);
        bodies.push(body);
        return bodies.length === 1
          ? new Response("", {
              status,
              headers: { "x-ratelimit-remaining": "1" },
            })
          : new Response(JSON.stringify(batchPayload(body)), { status: 200 });
      }) as typeof fetch;

      const result = await new GitHubGraphQLClient({
        token: "test",
        fetch: fetchMock,
        sleep: async (delay) => void delays.push(delay),
      }).getAccountActivities(logins, period);

      assert.equal(result.items.length, 25);
      assert.equal(result.rateLimit?.remaining, 4999);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], bodies[1]);
      assert.deepEqual(delays, [1_000]);
      const sent = JSON.parse(bodies[0]!) as {
        query: string;
        variables: Record<string, string>;
      };
      assert.match(sent.query, /u24: user\(login: \$login24\)/);
      assert.equal(sent.variables.login0, "user-0");
      assert.equal(sent.variables.login24, "user-24");
      assert.equal(sent.variables.from, period.from);
      assert.equal(sent.variables.to, period.to);
    });
  }

  it("retries the same historical login and window after HTTP 503", async () => {
    const bodies: string[] = [];
    const delays: number[] = [];
    const historicalPeriod: ActivityPeriod = {
      from: "2024-08-22T00:00:00.000Z",
      to: "2025-08-22T00:00:00.000Z",
      days: 365,
    };
    const fetchMock = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify(historicalPayload([])), { status: 200 });
    }) as typeof fetch;

    await new GitHubGraphQLClient({
      token: "test",
      fetch: fetchMock,
      sleep: async (delay) => void delays.push(delay),
    }).getHistoricalActivity("octocat", historicalPeriod);

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(delays, [1_000]);
    const sent = JSON.parse(bodies[0]!) as {
      variables: Record<string, string>;
    };
    assert.deepEqual(sent.variables, {
      login: "octocat",
      from: historicalPeriod.from,
      to: historicalPeriod.to,
    });
  });

  it("does not retry GraphQL HTTP 401, 403 or 429", async () => {
    for (const status of [401, 403, 429]) {
      let requests = 0;
      const fetchMock = (async () => {
        requests += 1;
        return new Response("", { status });
      }) as typeof fetch;
      await assert.rejects(
        new GitHubGraphQLClient({
          token: "test",
          fetch: fetchMock,
          sleep: async () => {
            throw new Error("sleep must not be called");
          },
        }).getAccountActivity("octocat", period),
      );
      assert.equal(requests, 1);
    }
  });

  it("does not retry GraphQL authentication or global schema errors in HTTP 200", async () => {
    const cases: Array<{
      body: unknown;
      error: typeof GitHubAuthenticationError | typeof GitHubGraphQLFatalError;
    }> = [
      {
        body: {
          data: null,
          errors: [{ message: "Requires authentication" }],
        },
        error: GitHubAuthenticationError,
      },
      {
        body: {
          data: null,
          errors: [{ message: "Cannot query field invalidField." }],
        },
        error: GitHubGraphQLFatalError,
      },
    ];

    for (const testCase of cases) {
      let requests = 0;
      const fetchMock = (async () => {
        requests += 1;
        return new Response(JSON.stringify(testCase.body), { status: 200 });
      }) as typeof fetch;
      await assert.rejects(
        new GitHubGraphQLClient({
          token: "test",
          fetch: fetchMock,
          sleep: async () => {
            throw new Error("sleep must not be called");
          },
        }).getAccountActivity("octocat", period),
        testCase.error,
      );
      assert.equal(requests, 1);
    }
  });

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
