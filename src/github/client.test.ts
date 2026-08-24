import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findNextPage, GitHubClient, readRateLimit } from "./client.js";
import {
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
});

describe("GitHubClient", () => {
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
        assert.equal(error.details.remaining, 0);
        assert.equal(error.details.retryAfterSeconds, 30);
        return true;
      },
    );
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

