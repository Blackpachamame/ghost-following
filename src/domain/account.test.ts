import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupAccountsByType, normalizeAccount } from "./account.js";

describe("normalizeAccount", () => {
  it("keeps only the fields used by the application", () => {
    const account = normalizeAccount({
      login: "octocat",
      id: 1,
      type: "User",
      html_url: "https://github.com/octocat",
      avatar_url: "https://example.com/avatar.png",
      site_admin: false,
    });

    assert.deepEqual(account, {
      login: "octocat",
      id: 1,
      type: "User",
      htmlUrl: "https://github.com/octocat",
    });
  });

  it("rejects malformed API data", () => {
    assert.throws(
      () => normalizeAccount({ login: "octocat", id: "1", type: "User" }),
      /invalid id/,
    );
  });
});

describe("groupAccountsByType", () => {
  it("counts every type returned by GitHub without inventing categories", () => {
    const counts = groupAccountsByType([
      { login: "one", id: 1, type: "User", htmlUrl: "https://github.com/one" },
      { login: "two", id: 2, type: "User", htmlUrl: "https://github.com/two" },
      {
        login: "example-org",
        id: 3,
        type: "Organization",
        htmlUrl: "https://github.com/example-org",
      },
    ]);

    assert.deepEqual(Object.fromEntries(counts), { User: 2, Organization: 1 });
  });
});

