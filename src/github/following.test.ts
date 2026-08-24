import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubClient } from "./client.js";
import { GitHubHttpError } from "./errors.js";
import { getFollowing } from "./following.js";

function apiAccount(index: number, type = "User") {
  return {
    login: `account-${index}`,
    id: index + 1,
    type,
    html_url: `https://github.com/account-${index}`,
    ignored: "not normalized",
  };
}

describe("getFollowing", () => {
  it("follows every next-page link and returns normalized accounts", async () => {
    const calls: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => apiAccount(index));
    const secondPage = [apiAccount(100, "Organization")];
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);

      if (calls.length === 1) {
        return new Response(JSON.stringify(firstPage), {
          status: 200,
          headers: {
            link: '<https://api.github.com/next-page>; rel="next"',
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4999",
          },
        });
      }

      return new Response(JSON.stringify(secondPage), {
        status: 200,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4998",
        },
      });
    }) as typeof fetch;

    const result = await getFollowing(
      new GitHubClient({ fetch: fetchMock }),
      "octocat",
    );

    assert.equal(calls.length, 2);
    assert.match(calls[0] ?? "", /following\?per_page=100$/);
    assert.equal(calls[1], "https://api.github.com/next-page");
    assert.equal(result.accounts.length, 101);
    assert.deepEqual(result.accounts[100], {
      login: "account-100",
      id: 101,
      type: "Organization",
      htmlUrl: "https://github.com/account-100",
    });
    assert.equal(result.rateLimit.remaining, 4998);
  });

  it("fails the whole operation when an intermediate page fails", async () => {
    let requestCount = 0;
    const fetchMock = (async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify([apiAccount(0)]), {
          status: 200,
          headers: { link: '<https://api.github.com/page-2>; rel="next"' },
        });
      }

      return new Response('{"message":"Internal Server Error"}', {
        status: 500,
        statusText: "Internal Server Error",
      });
    }) as typeof fetch;

    await assert.rejects(
      getFollowing(new GitHubClient({ fetch: fetchMock }), "octocat"),
      GitHubHttpError,
    );
    assert.equal(requestCount, 2);
  });
});

