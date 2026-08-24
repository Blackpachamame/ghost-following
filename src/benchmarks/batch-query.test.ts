import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBatchActivityQuery, chunkValues } from "./batch-query.js";

const period = {
  from: "2025-08-24T00:00:00.000Z",
  to: "2026-08-24T00:00:00.000Z",
  days: 365,
};

describe("buildBatchActivityQuery", () => {
  it("builds a safe single-user aliased query", () => {
    const login = 'unsafe"login';
    const result = buildBatchActivityQuery([login], period);

    assert.deepEqual(result.aliases, [{ alias: "u0", login }]);
    assert.match(result.query, /\$login0: String!/);
    assert.match(result.query, /u0: user\(login: \$login0\)/);
    assert.match(result.query, /rateLimit\s*\{/);
    assert.doesNotMatch(result.query, /unsafe"login/);
    assert.deepEqual(result.variables, {
      from: period.from,
      to: period.to,
      login0: login,
    });
  });

  it("builds five unique aliases and login variables with shared dates", () => {
    const logins = ["one", "two", "three", "four", "five"];
    const result = buildBatchActivityQuery(logins, period);

    assert.deepEqual(
      result.aliases.map(({ alias }) => alias),
      ["u0", "u1", "u2", "u3", "u4"],
    );
    for (const [index, login] of logins.entries()) {
      assert.equal(result.variables[`login${index}`], login);
      assert.match(result.query, new RegExp(`u${index}: user\\(login: \\$login${index}\\)`));
      assert.doesNotMatch(result.query, new RegExp(`user\\(login: "${login}"`));
    }
    assert.equal(result.variables.from, period.from);
    assert.equal(result.variables.to, period.to);
    assert.equal((result.query.match(/\$from: DateTime!/g) ?? []).length, 1);
    assert.equal((result.query.match(/\$to: DateTime!/g) ?? []).length, 1);
  });
});

describe("chunkValues", () => {
  const users = Array.from({ length: 50 }, (_, index) => `user-${index}`);

  it("chunks divisible samples", () => {
    assert.deepEqual(chunkValues(users, 10).map(({ length }) => length), [10, 10, 10, 10, 10]);
    assert.deepEqual(chunkValues(users, 25).map(({ length }) => length), [25, 25]);
    assert.deepEqual(chunkValues(users, 50).map(({ length }) => length), [50]);
  });

  it("keeps a final non-divisible chunk", () => {
    assert.deepEqual(
      chunkValues(users.slice(0, 48), 10).map(({ length }) => length),
      [10, 10, 10, 10, 8],
    );
  });

  it("chunks 78 production-sized users as 25 + 25 + 25 + 3", () => {
    assert.deepEqual(
      chunkValues(Array.from({ length: 78 }), 25).map(({ length }) => length),
      [25, 25, 25, 3],
    );
  });
});
