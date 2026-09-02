import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  parseRecentCompositionArgs,
  RECENT_COMPOSITION_HELP,
  runRecentCompositionCli,
} from "./recent-composition-cli.js";

const roots: string[] = [];
const PERIOD = { from: "2025-08-26T12:26:11.722Z", to: "2026-08-26T12:26:11.722Z", days: 365 };

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "composition-cli-"));
  roots.push(root);
  return root;
}

function incidentLine(timestamp: string, logins: readonly string[]): string {
  return JSON.stringify({
    timestamp,
    auditUsername: "AuditUser",
    phase: "recent",
    period: PERIOD,
    httpStatus: 504,
    attempts: 3,
    batchSize: logins.length,
    logins,
  });
}

function successfulFetch(seen: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const serialized = String(init?.body);
    seen.push(serialized);
    const body = JSON.parse(serialized) as { variables: Record<string, string> };
    const data: Record<string, unknown> = {
      rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-08-28T02:00:00Z" },
    };
    const loginKeys = Object.keys(body.variables).filter((key) => key.startsWith("login"));
    for (const key of loginKeys) {
      const index = Number(key.slice(5));
      data[`u${index}`] = {
        login: body.variables[key],
        contributionsCollection: {
          startedAt: PERIOD.from,
          endedAt: PERIOD.to,
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
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

describe("recent composition CLI arguments", () => {
  it("parses FULL/LEFT/RIGHT case-insensitively and defaults to FULL", () => {
    assert.deepEqual(parseRecentCompositionArgs(["AuditUser"]), {
      help: false, auditUsername: "AuditUser", target: "FULL", runs: 1,
    });
    for (const value of ["FULL", "left", "Right"]) {
      const parsed = parseRecentCompositionArgs(["AuditUser", "--target", value]);
      assert.equal(parsed.help, false);
      if (!parsed.help) assert.equal(parsed.target, value.toUpperCase());
    }
  });

  it("parses timestamp, source and runs together", () => {
    assert.deepEqual(parseRecentCompositionArgs([
      "AuditUser", "--source", "archive.jsonl", "--timestamp", "2026-08-26T13:36:53.707Z",
      "--target", "RIGHT", "--runs", "3",
    ]), {
      help: false,
      auditUsername: "AuditUser",
      source: "archive.jsonl",
      timestamp: "2026-08-26T13:36:53.707Z",
      target: "RIGHT",
      runs: 3,
    });
  });

  it("rejects invalid or missing targets, invalid runs and duplicate options", () => {
    assert.throws(() => parseRecentCompositionArgs(["AuditUser", "--target", "foo"]), /FULL, LEFT or RIGHT/);
    assert.throws(() => parseRecentCompositionArgs(["AuditUser", "--target"]), /requires a value/);
    for (const value of ["0", "4", "-1", "1.5", "foo"]) {
      assert.throws(() => parseRecentCompositionArgs(["AuditUser", "--runs", value]), /1, 2 or 3/);
    }
    assert.throws(() => parseRecentCompositionArgs(["AuditUser", "--target", "FULL", "--target", "RIGHT"]), /only once/);
  });

  it("documents live GraphQL cost and every isolation boundary", () => {
    const lower = RECENT_COMPOSITION_HELP.toLowerCase();
    for (const phrase of ["live graphql", "no audit", "rest", "historical", "checkpoint", "production change", "composition", "n-1"]) {
      assert.equal(lower.includes(phrase), true, `missing help phrase ${phrase}`);
    }
  });
});

describe("recent composition CLI isolation", () => {
  it("replays a legacy FULL25 source and preserves LEFT12/RIGHT13 shapes", async () => {
    const root = await tempRoot();
    const source = join(root, "legacy-25.jsonl");
    const output = join(root, "composition-probes");
    const logins = Array.from({ length: 25 }, (_value, index) => `legacy-${index}`);
    await writeFile(source, incidentLine("2026-08-26T13:36:53.707Z", logins));
    const seen: string[] = [];
    const exit = await runRecentCompositionCli(["AuditUser", "--source", source, "--target", "FULL"], {
      token: "test-token", fetch: successfulFetch(seen), sleep: async () => undefined,
      now: new Date("2026-08-28T01:00:00Z"), outputRoot: output,
      io: { log: () => undefined, error: () => undefined },
    });
    assert.equal(exit, 0);
    const sizes = seen.slice(0, 3).map((body) => Object.keys((JSON.parse(body) as { variables: Record<string, string> }).variables)
      .filter((key) => key.startsWith("login")).length);
    assert.deepEqual(sizes, [25, 12, 13]);
  });

  it("selects the exact timestamp and RIGHT target, preserves source, and writes only composition-probes", async () => {
    const root = await tempRoot();
    const source = join(root, "failures.jsonl");
    const output = join(root, "diagnostics", "composition-probes");
    const queryComparisons = join(root, "diagnostics", "query-comparisons");
    const investigations = join(root, "diagnostics", "investigations");
    await mkdir(queryComparisons, { recursive: true });
    await mkdir(investigations, { recursive: true });
    await writeFile(join(queryComparisons, "sentinel"), "query-safe");
    await writeFile(join(investigations, "sentinel"), "investigation-safe");
    const selectedTimestamp = "2026-08-26T13:36:53.707Z";
    const original = [
      incidentLine(selectedTimestamp, ["a", "b", "c", "d"]),
      "{malformed",
      incidentLine("2026-08-26T14:00:00.000Z", ["w", "x", "y", "z"]),
    ].join("\n") + "\n";
    await writeFile(source, original);
    const seen: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const exit = await runRecentCompositionCli([
      "AuditUser", "--source", source, "--timestamp", selectedTimestamp, "--target", "RIGHT", "--runs", "1",
    ], {
      token: "test-token",
      fetch: successfulFetch(seen),
      sleep: async () => undefined,
      now: new Date("2026-08-28T01:00:00Z"),
      outputRoot: output,
      io: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    });
    assert.equal(exit, 0);
    assert.equal(errors.length, 0);
    assert.match(logs[0]!, /Selected target: RIGHT/);
    assert.match(logs[0]!, /Target size: 2/);
    assert.equal(seen.length, 3);
    const first = JSON.parse(seen[0]!) as { variables: Record<string, string> };
    assert.deepEqual([first.variables.login0, first.variables.login1], ["c", "d"]);
    assert.equal(await readFile(source, "utf8"), original);
    assert.equal(await readFile(join(queryComparisons, "sentinel"), "utf8"), "query-safe");
    assert.equal(await readFile(join(investigations, "sentinel"), "utf8"), "investigation-safe");
    await assert.rejects(() => access(join(root, "reports")));
    await assert.rejects(() => access(join(root, "checkpoints")));
    const outputFiles = await readdir(output);
    assert.equal(outputFiles.length, 1);
    const artifact = (await readFile(join(output, outputFiles[0]!), "utf8")).toLowerCase();
    assert.equal(artifact.includes("test-token"), false);
    assert.equal(artifact.includes("authorization"), false);
    assert.equal(artifact.includes("\query\:"), false);
    assert.equal(artifact.includes("contributioncalendar"), false);
  });

  it("shows help without token/request and rejects usage separately", async () => {
    const logs: string[] = [];
    assert.equal(await runRecentCompositionCli(["--help"], {
      io: { log: (message) => logs.push(message), error: () => undefined },
    }), 0);
    assert.equal(logs[0], RECENT_COMPOSITION_HELP);
    const errors: string[] = [];
    assert.equal(await runRecentCompositionCli(["AuditUser", "--target", "foo"], {
      io: { log: () => undefined, error: (message) => errors.push(message) },
    }), 2);
    assert.match(errors[0]!, /--target must be FULL, LEFT or RIGHT/);
  });

  it("requires a token before reading source or making a request", async () => {
    let requested = false;
    const errors: string[] = [];
    const exit = await runRecentCompositionCli(["AuditUser"], {
      fetch: (async () => { requested = true; throw new Error("unexpected"); }) as typeof fetch,
      io: { log: () => undefined, error: (message) => errors.push(message) },
    });
    assert.equal(exit, 1);
    assert.equal(requested, false);
    assert.match(errors[0]!, /GITHUB_TOKEN is required/);
  });
});
