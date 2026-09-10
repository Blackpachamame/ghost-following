import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  createHistoricalPeriods,
  type ActivityPeriod,
} from "../domain/activity.js";
import {
  GitHubGraphQLAccountError,
  GitHubRateLimitError,
} from "../github/errors.js";
import {
  enrichHistoricalActivity,
  type HistoricalCandidate,
  type HistoricalResult,
} from "./historical.js";

const period: ActivityPeriod = {
  from: "2025-09-04T21:28:34.891Z",
  to: "2026-09-04T21:28:34.891Z",
  days: 365,
};

function rateLimit(remaining: number) {
  return {
    cost: 1,
    limit: 5000,
    remaining,
    resetAt: new Date("2026-09-09T01:00:00.000Z"),
  };
}

interface FixtureCandidate extends HistoricalCandidate {
  account: { login: string; url: string };
  metadata: { original: string };
}

function candidate(
  login: string,
  status: HistoricalCandidate["status"] = "NO_RECENT_VISIBLE_ACTIVITY",
): FixtureCandidate {
  return {
    account: { login, url: "https://github.com/" + login },
    status,
    metadata: { original: login },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("reusable historical activity", () => {
  it("enriches quiet records without recent activity or IDs and preserves every original field", async () => {
    const source = [
      candidate("active", "ACTIVE"),
      candidate("quiet"),
      candidate("unknown", "UNKNOWN"),
      candidate("limited", "INSUFFICIENT_VISIBILITY"),
    ];
    const original = structuredClone(source);
    const requested: { login: string; period: ActivityPeriod }[] = [];
    const completed: HistoricalResult<FixtureCandidate>[] = [];

    const result = await enrichHistoricalActivity(source, {
      async getHistoricalActivity(login, historicalPeriod) {
        requested.push({ login, period: historicalPeriod });
        return {
          lastVisibleActivityAt: requested.length === 2 ? "2024-01-15" : null,
          rateLimit: rateLimit(4999 - requested.length),
        };
      },
    }, period, {
      historyYears: 5,
      onHistoricalAccountCompleted(value, count, total) {
        assert.equal(count, 1);
        assert.equal(total, 1);
        completed.push(value);
      },
    });

    assert.deepEqual(requested, createHistoricalPeriods(period, 5).slice(0, 2)
      .map((value) => ({ login: "quiet", period: value })));
    assert.deepEqual(source, original);
    assert.strictEqual(result.results[0], source[0]);
    assert.strictEqual(result.results[2], source[2]);
    assert.strictEqual(result.results[3], source[3]);
    assert.deepEqual(result.results[1], {
      ...source[1],
      lastVisibleActivityAt: "2024-01-15",
      historicalLookupStatus: "FOUND",
    });
    assert.deepEqual(completed, [result.results[1]]);
    assert.equal(result.rateLimit?.remaining, 4997);
  });

  it("runs all requested annual windows and keeps account failures local", async () => {
    const requested: string[] = [];
    const result = await enrichHistoricalActivity([
      candidate("failed"),
      candidate("not-found"),
    ], {
      async getHistoricalActivity(login) {
        requested.push(login);
        if (login === "failed") {
          throw new GitHubGraphQLAccountError("Account historical unavailable.", rateLimit(4800));
        }
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(4900) };
      },
    }, period, { historyYears: 3 });

    assert.equal(requested.filter((login) => login === "failed").length, 1);
    assert.equal(requested.filter((login) => login === "not-found").length, 3);
    assert.equal(result.results[0]?.status, "NO_RECENT_VISIBLE_ACTIVITY");
    assert.equal(result.results[0]?.historicalLookupStatus, "FAILED");
    assert.equal(result.results[0]?.historicalLookupError, "Account historical unavailable.");
    assert.equal(result.results[0]?.lastVisibleActivityAt, null);
    assert.equal(result.results[1]?.historicalLookupStatus, "NOT_FOUND_IN_LOOKBACK");
    assert.equal(result.results[1]?.lastVisibleActivityAt, null);
    assert.equal(result.rateLimit?.remaining, 4800);
  });

  it("uses four concurrent account jobs by default", async () => {
    const release = deferred();
    const requested: string[] = [];
    let running = 0;
    let peak = 0;
    const source = Array.from({ length: 7 }, (_, index) => candidate("user-" + index));
    const pending = enrichHistoricalActivity(source, {
      async getHistoricalActivity(login) {
        requested.push(login);
        running += 1;
        peak = Math.max(peak, running);
        await release.promise;
        running -= 1;
        return { lastVisibleActivityAt: "2024-12-01", rateLimit: rateLimit(4900) };
      },
    }, period, { historyYears: 5 });

    assert.equal(requested.length, 4);
    release.resolve();
    const result = await pending;
    assert.equal(peak, 4);
    assert.deepEqual(requested, source.map(({ account }) => account.login));
    assert.equal(result.results.length, source.length);
  });

  it("reuses completed records case insensitively and includes them in progress", async () => {
    const source = [candidate("Saved"), candidate("pending")];
    const saved: HistoricalResult<FixtureCandidate> = {
      ...source[0]!,
      account: { login: "saved", url: "https://github.com/old" },
      historicalLookupStatus: "FOUND",
      lastVisibleActivityAt: "2024-01-10",
    };
    const requested: string[] = [];
    const result = await enrichHistoricalActivity(source, {
      async getHistoricalActivity(login) {
        requested.push(login);
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(4900) };
      },
    }, period, {
      historyYears: 1,
      completedHistoricalActivity: [saved],
      onHistoricalAccountCompleted(_value, completed, total) {
        assert.equal(completed, 2);
        assert.equal(total, 2);
      },
    });

    assert.deepEqual(requested, ["pending"]);
    assert.deepEqual(result.results[0], { ...saved, account: source[0]!.account });
    assert.equal(result.results[1]?.historicalLookupStatus, "NOT_FOUND_IN_LOOKBACK");
  });

  it("saves completed zero-quota work before stopping further account requests", async () => {
    const requested: string[] = [];
    const completed: string[] = [];
    await assert.rejects(enrichHistoricalActivity([
      candidate("completed"),
      candidate("pending"),
    ], {
      async getHistoricalActivity(login) {
        requested.push(login);
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(0) };
      },
    }, period, {
      concurrency: 1,
      historyYears: 1,
      onHistoricalAccountCompleted(value) { completed.push(value.account.login); },
    }), GitHubRateLimitError);

    assert.deepEqual(requested, ["completed"]);
    assert.deepEqual(completed, ["completed"]);
  });

  it("stops before the next annual window when an unfinished account exhausts quota", async () => {
    let requested = 0;
    let completed = 0;
    await assert.rejects(enrichHistoricalActivity([candidate("unfinished")], {
      async getHistoricalActivity() {
        requested += 1;
        return { lastVisibleActivityAt: null, rateLimit: rateLimit(0) };
      },
    }, period, {
      historyYears: 2,
      onHistoricalAccountCompleted() { completed += 1; },
    }), GitHubRateLimitError);

    assert.equal(requested, 1);
    assert.equal(completed, 0);
  });

  it("drains in-flight results and their persistence callbacks before propagating a fatal interruption", async () => {
    const responseReady = deferred();
    const persisted = deferred();
    const fatal = new GitHubRateLimitError(
      { remaining: 4000, retryAfterSeconds: 60 },
      403,
      ["Secondary rate limit reached."],
    );
    const requested: string[] = [];
    const completed: string[] = [];
    let settled = false;
    const running = enrichHistoricalActivity([
      candidate("fatal"),
      candidate("in-flight"),
      candidate("never-started"),
    ], {
      async getHistoricalActivity(login) {
        requested.push(login);
        if (login === "fatal") throw fatal;
        await responseReady.promise;
        return { lastVisibleActivityAt: "2024-12-01", rateLimit: rateLimit(4000) };
      },
    }, period, {
      historyYears: 1,
      concurrency: 2,
      async onHistoricalAccountCompleted(value) {
        completed.push(value.account.login);
        await persisted.promise;
      },
    }).finally(() => { settled = true; });
    const rejection = assert.rejects(running, (error) => error === fatal);

    await setImmediate();
    assert.equal(settled, false);
    assert.deepEqual(requested, ["fatal", "in-flight"]);
    responseReady.resolve();
    await setImmediate();
    assert.deepEqual(completed, ["in-flight"]);
    assert.equal(settled, false);
    persisted.resolve();
    await rejection;
    assert.equal(settled, true);
    assert.deepEqual(requested, ["fatal", "in-flight"]);
  });
});
