import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  parseRecentQueryComparisonArgs,
  RECENT_QUERY_COMPARISON_HELP,
  runRecentQueryComparisonCli,
} from "./recent-query-comparison-cli.js";
import type { RecentQueryComparison } from "./recent-query-comparison.js";
import { formatRecentQueryComparison, writeRecentQueryComparison } from "./recent-query-report.js";
import { loadRecentQuerySource, RecentQuerySourceError } from "./recent-query-source.js";

const directories: string[] = [];
const PERIOD = { from: "2025-08-25T00:00:00.000Z", to: "2026-08-25T00:00:00.000Z", days: 365 };

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "recent-query-test-"));
  directories.push(path);
  return path;
}

afterEach(async () => { while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true }); });

function line(timestamp: string, login = "Alice"): string {
  return JSON.stringify({ timestamp, auditUsername: "AuditUser", phase: "recent", period: PERIOD,
    httpStatus: 504, attempts: 3, batchSize: 1, logins: [login] });
}

function graphQLFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
    return new Response(JSON.stringify({ data: {
      u0: { login: body.variables.login0, contributionsCollection: {
        startedAt: PERIOD.from, endedAt: PERIOD.to, hasAnyContributions: true,
        hasAnyRestrictedContributions: false, hasActivityInThePast: false,
        restrictedContributionsCount: 0, totalCommitContributions: 1, totalIssueContributions: 0,
        totalPullRequestContributions: 0, totalPullRequestReviewContributions: 0,
        contributionCalendar: { totalContributions: 1 },
      } }, rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-08-25T02:00:00Z" },
    } }));
  }) as typeof fetch;
}

function comparison(timestamp = "2026-08-25T03:00:00.000Z"): RecentQueryComparison {
  return { schemaVersion: 1, comparisonTimestamp: timestamp, auditUsername: "AuditUser", sourcePath: "source.jsonl",
    sourceIncident: { timestamp: "2026-08-25T01:00:00Z", period: PERIOD, httpStatus: 504, attempts: 3,
      batchSize: 1, logins: ["Alice"] }, runs: 1,
    variants: [], measurements: [], parity: [] };
}

describe("recent query comparison CLI and files", () => {
  it("parses help and all supported options", () => {
    assert.deepEqual(parseRecentQueryComparisonArgs(["--help"]), { help: true });
    assert.deepEqual(parseRecentQueryComparisonArgs(["AuditUser", "--timestamp", "2026-08-25T01:00:00Z", "--source", "archive.jsonl", "--runs", "3"]), {
      help: false, auditUsername: "AuditUser", timestamp: "2026-08-25T01:00:00Z", source: "archive.jsonl", runs: 3,
    });
    assert.deepEqual(parseRecentQueryComparisonArgs(["AuditUser"]), { help: false, auditUsername: "AuditUser", runs: 1 });
  });

  it("accepts only runs 1, 2 and 3", () => {
    for (const value of ["1", "2", "3"]) assert.equal(parseRecentQueryComparisonArgs(["AuditUser", "--runs", value]).help, false);
    for (const value of ["0", "4", "-1", "1.5", "foo"]) assert.throws(() => parseRecentQueryComparisonArgs(["AuditUser", "--runs", value]));
    assert.throws(() => parseRecentQueryComparisonArgs(["AuditUser", "--runs"]));
  });

  it("selects latest valid and exact timestamp while ignoring malformed JSONL", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "incidents.jsonl");
    await writeFile(source, [line("2026-08-25T01:00:00Z", "Alice"), "{bad", line("2026-08-25T02:00:00Z", "Bob")].join("\n"));
    assert.equal((await loadRecentQuerySource("AuditUser", { source })).incident.logins[0], "Bob");
    assert.equal((await loadRecentQuerySource("AuditUser", { source, timestamp: "2026-08-25T01:00:00Z" })).incident.logins[0], "Alice");
    await assert.rejects(() => loadRecentQuerySource("AuditUser", { source, timestamp: "2026-08-25T09:00:00Z" }),
      (error) => error instanceof RecentQuerySourceError && /No valid recent failure incident/.test(error.message));
  });

  it("accepts a legacy 25-login source for query comparison", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "legacy-25.jsonl");
    const logins = Array.from({ length: 25 }, (_value, index) => `legacy-${index}`);
    await writeFile(source, JSON.stringify({
      timestamp: "2026-08-25T01:00:00Z", auditUsername: "AuditUser", phase: "recent", period: PERIOD,
      httpStatus: 504, attempts: 3, batchSize: 25, logins,
    }));
    assert.deepEqual((await loadRecentQuerySource("AuditUser", { source })).incident.logins, logins);
  });

  it("uses the standard source path when --source is absent", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "AuditUser-failures.jsonl");
    await writeFile(path, line("2026-08-25T01:00:00Z"));
    const loaded = await loadRecentQuerySource("AuditUser", { root });
    assert.equal(loaded.path, path);
  });

  it("uses wx collision suffixes and writes a safe JSON schema", async () => {
    const root = await temporaryDirectory();
    const first = await writeRecentQueryComparison(comparison(), { root });
    const second = await writeRecentQueryComparison(comparison(), { root });
    assert.notEqual(first, second);
    assert.match(second, /-1\.json$/);
    const contents = await readFile(first, "utf8");
    const lower = contents.toLowerCase();
    assert.equal(JSON.parse(contents).schemaVersion, 1);
    /* Superseded malformed literal retained only inside this comment.
    for (const forbidden of ["test-token", "authorization", "\query\", "responsebody", "contributioncalendar"]) {
      assert.equal(lower.includes(forbidden), false);
    }
    */
    const quotedQueryKey = String.fromCharCode(34) + "query" + String.fromCharCode(34);
    for (const forbidden of ["test-token", "authorization", quotedQueryKey, "responsebody", "contributioncalendar"]) {
      assert.equal(lower.includes(forbidden), false);
    }
  });

  it("surfaces classification and detail mismatches in the terminal summary", () => {
    const value = comparison();
    value.parity = [
      { run: 1, shape: "FULL", variant: "CLASSIFIER_MINIMAL", classificationParity: "MISMATCH",
        classificationMismatches: ["Alice"], detailParity: "NOT_APPLICABLE", detailMismatches: [] },
      { run: 1, shape: "FULL", variant: "NUMERIC_MINIMAL", classificationParity: "MATCH",
        classificationMismatches: [], detailParity: "MISMATCH", detailMismatches: ["Alice"] },
    ];
    const output = formatRecentQueryComparison(value, "saved.json");
    assert.match(output, /Classification parity mismatches: 1/);
    assert.match(output, /Detail parity mismatches: 1/);
    assert.match(output, /semantic equivalence was not observed/);
  });

  it("runs fully offline, leaves source unchanged, and creates only its own output", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "archived.jsonl");
    const output = join(root, "query-comparisons");
    const original = line("2026-08-25T01:00:00Z") + "\n";
    await writeFile(source, original);
    const logs: string[] = [];
    const errors: string[] = [];
    const exit = await runRecentQueryComparisonCli(["AuditUser", "--source", source, "--runs", "1"], {
      token: "test-token", fetch: graphQLFetch(), sleep: async () => undefined,
      now: new Date("2026-08-25T03:00:00Z"), outputRoot: output,
      io: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    });
    assert.equal(exit, 0);
    assert.equal(errors.length, 0);
    assert.match(logs[0]!, /Recent Query Comparison/);
    assert.equal(await readFile(source, "utf8"), original);
    const outputFiles = await readdir(output);
    assert.equal(outputFiles.length, 1);
    const saved = (await readFile(join(output, outputFiles[0]!), "utf8")).toLowerCase();
    assert.match(saved, /responsebodybytes/);
    for (const forbidden of [
      "test-token", "authorization",
      String.fromCharCode(34) + "query" + String.fromCharCode(34) + ":",
      String.fromCharCode(34) + "payload" + String.fromCharCode(34) + ":",
      String.fromCharCode(34) + "contributionscollection" + String.fromCharCode(34) + ":",
    ]) {
      assert.equal(saved.includes(forbidden), false, `artifact contains forbidden marker ${forbidden}`);
    }
    for (const absent of ["reports", "checkpoints", "investigations"]) {
      await assert.rejects(() => access(join(root, absent)));
    }
    assert.deepEqual((await readdir(root)).sort(), ["archived.jsonl", "query-comparisons"]);
  });

  it("shows help without a token and reports usage errors distinctly", async () => {
    const logs: string[] = [];
    assert.equal(await runRecentQueryComparisonCli(["--help"], { io: { log: (value) => logs.push(value), error: () => undefined } }), 0);
    assert.equal(logs[0], RECENT_QUERY_COMPARISON_HELP);
    const errors: string[] = [];
    assert.equal(await runRecentQueryComparisonCli(["AuditUser", "--runs", "4"], { io: { log: () => undefined, error: (value) => errors.push(value) } }), 2);
    assert.match(errors[0]!, /--runs must be 1, 2 or 3/);
  });

  it("resolves an explicit source path without modifying it", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "source.jsonl");
    await writeFile(source, line("2026-08-25T01:00:00Z"));
    assert.equal((await loadRecentQuerySource("AuditUser", { source })).path, resolve(source));
  });
});
