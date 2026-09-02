import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { FollowedAccount } from "../domain/account.js";
import {
  parseBenchmarkSizes,
  parseRecentBatchSizeArgs,
  RECENT_BATCH_SIZE_HELP,
  runRecentBatchSizeCli,
} from "./recent-batch-size-cli.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "batch-size-cli-")); roots.push(root); return root;
}
function accounts(count: number): FollowedAccount[] {
  return Array.from({ length: count }, (_, index) => ({
    login: `user-${index}`, id: index + 1, type: "User", htmlUrl: `https://github.com/user-${index}`,
  }));
}
function successfulFetch(seen: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const serialized = String(init?.body); seen.push(serialized);
    const body = JSON.parse(serialized) as { variables: Record<string, string> };
    const data: Record<string, unknown> = {
      rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-09-02T00:00:00.000Z" },
    };
    for (const key of Object.keys(body.variables).filter((key) => key.startsWith("login"))) {
      const index = Number(key.slice(5));
      data[`u${index}`] = { login: body.variables[key], contributionsCollection: {
        startedAt: body.variables.from, endedAt: body.variables.to,
        hasAnyContributions: true, hasAnyRestrictedContributions: false, hasActivityInThePast: false,
        restrictedContributionsCount: 0, totalCommitContributions: 1, totalIssueContributions: 0,
        totalPullRequestContributions: 0, totalPullRequestReviewContributions: 0,
        contributionCalendar: { totalContributions: 1 },
      } };
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

describe("recent batch-size CLI arguments", () => {
  it("parses defaults and preserves explicit size order", () => {
    assert.deepEqual(parseRecentBatchSizeArgs(["AuditUser"]), {
      help: false, auditUsername: "AuditUser", days: 365, sampleSize: 200, sizes: [6, 8, 10, 12, 15, 25],
    });
    assert.deepEqual(parseRecentBatchSizeArgs(["AuditUser", "--sizes", "25,1,12", "--sample-size", "50", "--days", "30"]), {
      help: false, auditUsername: "AuditUser", days: 30, sampleSize: 50, sizes: [25, 1, 12],
    });
    assert.deepEqual(parseBenchmarkSizes("1"), [1]);
    assert.deepEqual(parseBenchmarkSizes("1,25"), [1, 25]);
  });

  it("rejects empty, duplicate, decimal, nonnumeric and out-of-range sizes", () => {
    for (const value of ["0", "26", "-1", "1.5", "foo", "10,10", "10,", ",10"]) {
      assert.throws(() => parseBenchmarkSizes(value), /sizes|Batch sizes/);
    }
  });

  it("enforces sample range and positive whole days", () => {
    for (const value of ["50", "200", "500"]) {
      const parsed = parseRecentBatchSizeArgs(["AuditUser", "--sample-size", value]);
      assert.equal(parsed.help, false);
    }
    for (const value of ["49", "501", "1.5", "foo", "0", "-1"]) {
      assert.throws(() => parseRecentBatchSizeArgs(["AuditUser", "--sample-size", value]));
    }
    for (const value of ["0", "-1", "1.5", "foo"]) {
      assert.throws(() => parseRecentBatchSizeArgs(["AuditUser", "--days", value]), /positive integer/);
    }
  });

  it("documents REST, GraphQL quota, deterministic sameness, and every isolation boundary", () => {
    const lower = RECENT_BATCH_SIZE_HELP.toLowerCase();
    for (const phrase of ["rest once", "live graphql", "quota", "same users", "same recent period", "adaptive fallback", "historical", "checkpoint", "production change"]) {
      assert.equal(lower.includes(phrase), true, `missing help phrase ${phrase}`);
    }
  });
});

describe("recent batch-size CLI offline integration", () => {
  it("retrieves following once, prints plan before GraphQL, and writes only its secure artifact", async () => {
    const root = await tempRoot();
    const output = join(root, "diagnostics", "batch-size-benchmarks");
    for (const directory of ["reports", "checkpoints", "query-comparisons", "composition-probes", "investigations"]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "sentinel"), directory);
    }
    let followingCalls = 0;
    const requests: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const exit = await runRecentBatchSizeCli(["AuditUser", "--days", "30", "--sample-size", "50", "--sizes", "25,10"], {
      token: "top-secret-token", fetch: successfulFetch(requests), sleep: async () => undefined,
      now: new Date("2026-09-01T12:00:00.000Z"), outputRoot: output,
      getFollowing: async () => { followingCalls += 1; return { accounts: accounts(50), rateLimit: {} }; },
      io: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    });
    assert.equal(exit, 0);
    assert.equal(followingCalls, 1);
    assert.equal(errors.length, 0);
    assert.match(logs[0]!, /pre-GraphQL plan/);
    assert.match(logs[0]!, /25 -> 2/);
    assert.match(logs[0]!, /10 -> 5/);
    assert.equal(requests.length, 7);
    const periods = requests.map((body) => {
      const value = JSON.parse(body) as { variables: Record<string, string> };
      return [value.variables.from, value.variables.to];
    });
    assert.equal(periods.every((period) => JSON.stringify(period) === JSON.stringify(periods[0])), true);
    const files = await readdir(output);
    assert.equal(files.length, 1);
    const artifact = (await readFile(join(output, files[0]!), "utf8")).toLowerCase();
    for (const secret of ["top-secret-token", "authorization", "bearer", "contributioncalendar", "query recentactivitybatch"]) {
      assert.equal(artifact.includes(secret), false, `artifact leaked ${secret}`);
    }
    for (const directory of ["reports", "checkpoints", "query-comparisons", "composition-probes", "investigations"]) {
      assert.equal(await readFile(join(root, directory, "sentinel"), "utf8"), directory);
    }
  });

  it("persists partial measurements and exits nonzero on a global halt", async () => {
    const root = await tempRoot();
    const output = join(root, "batch-size-benchmarks");
    let calls = 0;
    const exit = await runRecentBatchSizeCli(["AuditUser", "--sample-size", "50", "--sizes", "25,10"], {
      token: "test-token", sleep: async () => undefined, outputRoot: output,
      getFollowing: async () => ({ accounts: accounts(50), rateLimit: {} }),
      fetch: (async () => {
        calls += 1;
        return new Response("unavailable", { status: 503, headers: { "x-ratelimit-reset": "1788267600" } });
      }) as typeof fetch,
      io: { log: () => undefined, error: () => undefined },
    });
    assert.equal(exit, 1);
    assert.equal(calls, 3);
    const files = await readdir(output);
    const artifact = JSON.parse(await readFile(join(output, files[0]!), "utf8")) as {
      measurements: unknown[]; halt: { haltReason: string; haltedAtSize: number; haltedAtBatch: number; resetAt: string };
    };
    assert.equal(artifact.measurements.length, 1);
    assert.equal(artifact.halt.haltReason, "HTTP_503_EXHAUSTED");
    assert.equal(artifact.halt.haltedAtSize, 25);
    assert.equal(artifact.halt.haltedAtBatch, 1);
    assert.match(artifact.halt.resetAt, /^2026-/);
  });

  it("shows help and missing-token errors without making any request", async () => {
    let requested = false;
    const logs: string[] = [];
    assert.equal(await runRecentBatchSizeCli(["--help"], {
      fetch: (async () => { requested = true; throw new Error("unexpected"); }) as typeof fetch,
      io: { log: (message) => logs.push(message), error: () => undefined },
    }), 0);
    assert.equal(logs[0], RECENT_BATCH_SIZE_HELP);
    assert.equal(await runRecentBatchSizeCli(["AuditUser"], {
      fetch: (async () => { requested = true; throw new Error("unexpected"); }) as typeof fetch,
      io: { log: () => undefined, error: () => undefined },
    }), 1);
    assert.equal(requested, false);
  });
});
