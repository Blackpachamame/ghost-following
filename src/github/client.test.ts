import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findNextPage, GitHubClient, readRateLimit } from "./client.js";
import {
  GitHubHttpError,
  GitHubRateLimitError,
  GitHubUnexpectedResponseError,
  GitHubUserNotFoundError,
} from "./errors.js";

describe("findNextPage", () => {
  it("extracts the next relation from a GitHub Link header", () => {
    const header =
      '<https://api.github.com/example?page=3>; rel="next", <https://api.github.com/example?page=5>; rel="last"';

    assert.equal(findNextPage(header), "https://api.github.com/example?page=3");
    assert.equal(findNextPage(null), undefined);
  });
});

describe("readRateLimit", () => {
  it("reads available rate limit and retry headers", () => {
    const details = readRateLimit(
      new Headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4998",
        "x-ratelimit-reset": "2",
        "retry-after": "30",
      }),
    );

    assert.equal(details.limit, 5000);
    assert.equal(details.remaining, 4998);
    assert.equal(details.resetAt?.toISOString(), "1970-01-01T00:00:02.000Z");
    assert.equal(details.retryAfterSeconds, 30);
  });

  it("ignores malformed Retry-After and reset headers", () => {
    const details = readRateLimit(
      new Headers({
        "retry-after": "nonsense",
        "x-ratelimit-reset": "9007199254740991",
      }),
    );

    assert.equal(details.retryAfterSeconds, undefined);
    assert.equal(details.resetAt, undefined);
  });
});

describe("GitHubClient", () => {
  for (const status of [502, 503, 504]) {
    it(`retries HTTP ${status} once and then accepts the same REST request`, async () => {
      let requests = 0;
      const delays: number[] = [];
      const fetchMock = (async () => {
        requests += 1;
        return requests === 1
          ? new Response("", { status })
          : new Response("[]", { status: 200 });
      }) as typeof fetch;

      await new GitHubClient({
        fetch: fetchMock,
        sleep: async (delay) => void delays.push(delay),
      }).getPage("https://example.test/page", "octocat");

      assert.equal(requests, 2);
      assert.deepEqual(delays, [1_000]);
    });
  }

  it("uses 1s/2s backoff and succeeds on the third REST attempt", async () => {
    let requests = 0;
    const delays: number[] = [];
    const fetchMock = (async () => {
      requests += 1;
      return requests < 3
        ? new Response("", { status: 502 })
        : new Response("[]", { status: 200 });
    }) as typeof fetch;

    await new GitHubClient({
      fetch: fetchMock,
      sleep: async (delay) => void delays.push(delay),
    }).getPage("https://example.test/page", "octocat");

    assert.equal(requests, 3);
    assert.deepEqual(delays, [1_000, 2_000]);
  });

  it("fails clearly after three transient REST responses", async () => {
    let requests = 0;
    const fetchMock = (async () => {
      requests += 1;
      return new Response('{"message":"Bad Gateway"}', {
        status: 502,
        statusText: "Bad Gateway",
      });
    }) as typeof fetch;

    await assert.rejects(
      new GitHubClient({
        fetch: fetchMock,
        sleep: async () => undefined,
      }).getPage("https://example.test/page", "octocat"),
      (error: unknown) => {
        assert.ok(error instanceof GitHubHttpError);
        assert.equal(error.attempts, 3);
        assert.match(error.message, /HTTP 502 Bad Gateway.*after 3 attempts/);
        return true;
      },
    );
    assert.equal(requests, 3);
  });

  it("does not retry REST 401, 403 or 429 responses", async () => {
    for (const status of [401, 403, 429]) {
      let requests = 0;
      const fetchMock = (async () => {
        requests += 1;
        return new Response("", { status });
      }) as typeof fetch;
      await assert.rejects(
        new GitHubClient({
          fetch: fetchMock,
          sleep: async () => {
            throw new Error("sleep must not be called");
          },
        }).getPage("https://example.test/page", "octocat"),
      );
      assert.equal(requests, 1);
    }
  });

  it("uses optional bearer authentication without exposing the token", async () => {
    let receivedHeaders: Headers | undefined;
    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    await new GitHubClient({ token: "test-token", fetch: fetchMock }).getPage(
      "https://api.github.com/users/octocat/following?per_page=100",
      "octocat",
    );

    assert.equal(receivedHeaders?.get("authorization"), "Bearer test-token");
  });

  it("distinguishes a missing user", async () => {
    const fetchMock = (async () =>
      new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch;

    await assert.rejects(
      new GitHubClient({ fetch: fetchMock }).getPage("https://example.test", "missing"),
      GitHubUserNotFoundError,
    );
  });

  it("reports rate limit metadata", async () => {
    const fetchMock = (async () =>
      new Response('{"message":"API rate limit exceeded"}', {
        status: 429,
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "2",
          "retry-after": "30",
        },
      })) as typeof fetch;

    await assert.rejects(
      new GitHubClient({ fetch: fetchMock }).getPage("https://example.test", "octocat"),
      (error: unknown) => {
        assert.ok(error instanceof GitHubRateLimitError);
        assert.equal(error.kind, "PRIMARY");
        assert.equal(error.limit, 60);
        assert.equal(error.details.remaining, 0);
        assert.equal(error.details.retryAfterSeconds, 30);
        assert.equal(error.resetAt?.toISOString(), "1970-01-01T00:00:02.000Z");
        return true;
      },
    );
  });

  it("classifies only an explicit secondary message as SECONDARY", async () => {
    for (const retryAfter of ["60", undefined] as const) {
      let requests = 0;
      const headers: Record<string, string> = {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4864",
      };
      if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
      const fetchMock = (async () => {
        requests += 1;
        return new Response(
          '{"message":"You have exceeded a SeCoNdArY rate limit. Please wait."}',
          { status: 403, headers },
        );
      }) as typeof fetch;

      await assert.rejects(
        new GitHubClient({
          fetch: fetchMock,
          sleep: async () => {
            throw new Error("sleep must not be called");
          },
        }).getPage("https://example.test", "octocat"),
        (error: unknown) => {
          assert.ok(error instanceof GitHubRateLimitError);
          assert.equal(error.kind, "SECONDARY");
          assert.equal(error.remaining, 4864);
          assert.equal(error.limit, 5000);
          assert.equal(
            error.retryAfterSeconds,
            retryAfter === undefined ? undefined : 60,
          );
          return true;
        },
      );
      assert.equal(requests, 1);
    }
  });

  it("keeps an unclassified rate-limit-like response UNKNOWN", async () => {
    let requests = 0;
    const fetchMock = (async () => {
      requests += 1;
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 429,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4864",
          "retry-after": "nonsense",
        },
      });
    }) as typeof fetch;

    await assert.rejects(
      new GitHubClient({
        fetch: fetchMock,
        sleep: async () => {
          throw new Error("sleep must not be called");
        },
      }).getPage("https://example.test", "octocat"),
      (error: unknown) => {
        assert.ok(error instanceof GitHubRateLimitError);
        assert.equal(error.kind, "UNKNOWN");
        assert.equal(error.retryAfterSeconds, undefined);
        return true;
      },
    );
    assert.equal(requests, 1);
  });

  it("rejects an unexpected successful payload", async () => {
    const fetchMock = (async () =>
      new Response('{"login":"octocat"}', { status: 200 })) as typeof fetch;

    await assert.rejects(
      new GitHubClient({ fetch: fetchMock }).getPage("https://example.test", "octocat"),
      GitHubUnexpectedResponseError,
    );
  });
});
