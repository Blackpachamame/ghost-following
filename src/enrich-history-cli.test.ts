import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runEnrichHistoryCli } from "./enrich-history-cli.js";
import { HELP, parseEnrichHistoryArgs, formatEnrichHistoryResumeCommand } from "./enrich-history/args.js";
import { historyEnrichmentCheckpointPathFor, loadHistoryEnrichmentCheckpoint } from "./enrich-history/checkpoint.js";
import type { AccountAuditResult, AuditResult } from "./domain/audit.js";
import { CSV_HEADERS, serializeAuditCsv } from "./export/csv.js";
import { serializeAuditJson } from "./export/json.js";
import { HISTORICAL_ACTIVITY_QUERY } from "./github/graphql.js";

const TOKEN = "offline-test-token";
const completedAt = new Date("2030-01-01T12:00:00.000Z");
const period = { days: 365, from: "2025-09-04T21:28:34.891Z", to: "2026-09-04T21:28:34.891Z" };
const quiet = "NO_RECENT_VISIBLE_ACTIVITY";
type Status = AccountAuditResult["status"];

function account(login: string, status: Status): AccountAuditResult {
  const count = status === "ACTIVE" ? 7 : status === quiet ? 0 : null;
  return {
    login, url: `https://github.com/${login}`, accountType: "User", status,
    recentPeriodDays: 365, totalContributions: count, commitContributions: count,
    pullRequestContributions: count, pullRequestReviewContributions: count,
    issueContributions: count, restrictedContributionsCount: count,
    hasActivityInThePast: status === "UNKNOWN" ? null : false,
    lastVisibleActivityAt: null, historicalLookupStatus: status === quiet ? "NOT_REQUESTED" : null,
  };
}

function sourceReport(statuses: Status[] = [quiet, quiet]): AuditResult {
  const accounts = statuses.map((status, index) => account(`person-${index}`, status));
  const count = (status: Status) => statuses.filter((value) => value === status).length;
  return {
    schemaVersion: 1, generatedAt: period.to, user: "source-user", period, history: { years: 0 },
    summary: {
      followingTotal: statuses.length + 2, eligibleUsers: statuses.length, unsupportedAccounts: 2,
      active: count("ACTIVE"), noRecentVisibleActivity: count(quiet),
      insufficientVisibility: count("INSUFFICIENT_VISIBILITY"), unknown: count("UNKNOWN"),
      coverage: statuses.length ? ((count("ACTIVE") + count(quiet)) / statuses.length) * 100 : null,
    },
    accounts,
    rateLimits: {
      rest: { limit: 5000, remaining: 4000, resetAt: "2026-09-04T22:00:00.000Z" },
      graphql: { cost: 12, limit: 5000, remaining: 0, resetAt: "2026-09-04T22:00:00.000Z" },
    },
  };
}

interface Query { query: string; variables: { login: string; from: string; to: string } }

function historicalResponse(query: Query, options: {
  date?: string; restrictedDate?: string; remaining?: number; failed?: boolean;
} = {}): Response {
  return new Response(JSON.stringify({ data: {
    user: options.failed ? null : {
      login: query.variables.login,
      contributionsCollection: {
        startedAt: query.variables.from, endedAt: query.variables.to,
        hasAnyContributions: options.date !== undefined,
        hasAnyRestrictedContributions: options.restrictedDate !== undefined,
        restrictedContributionsCount: options.restrictedDate === undefined ? 0 : 1,
        latestRestrictedContributionDate: options.restrictedDate ?? null,
        contributionCalendar: {
          totalContributions: options.date === undefined ? 0 : 1,
          weeks: options.date === undefined ? [] : [{
            contributionDays: [{ date: options.date, contributionCount: 1 }],
          }],
        },
      },
    },
    rateLimit: { cost: 1, limit: 5000, remaining: options.remaining ?? 4900,
      resetAt: "2030-01-01T13:00:00.000Z" },
  } }), { status: 200 });
}

function mockedFetch(handler: (query: Query) => Response | Promise<Response>): typeof fetch {
  return (async (url, init) => {
    assert.equal(String(url), "https://api.github.com/graphql", "no REST requests");
    const query = JSON.parse(String(init?.body)) as Query;
    assert.equal(query.query, HISTORICAL_ACTIVITY_QUERY, "only production historical queries");
    return handler(query);
  }) as typeof fetch;
}

function rateLimitResponse(kind: "PRIMARY" | "SECONDARY" | "UNKNOWN"): Response {
  return new Response(JSON.stringify({ message: kind === "SECONDARY"
    ? `You have exceeded a secondary rate limit. ${TOKEN}` : `API rate limit exceeded. ${TOKEN}` }), {
    status: kind === "PRIMARY" ? 403 : 429,
    headers: {
      "x-ratelimit-limit": "5000", "x-ratelimit-remaining": kind === "PRIMARY" ? "0" : "4000",
      "x-ratelimit-reset": String(Date.parse("2030-01-01T13:00:00.000Z") / 1000),
      "retry-after": "75",
    },
  });
}

async function fixture(statuses?: Status[]) {
  const root = await mkdtemp(join(tmpdir(), "ghost-enrichment-cli-"));
  const input = join(root, "source report.json");
  const json = join(root, "output report.json");
  const csv = join(root, "output report.csv");
  const checkpointRoot = join(root, "checkpoint");
  const checkpoint = historyEnrichmentCheckpointPathFor("source-user", checkpointRoot);
  const source = sourceReport(statuses);
  await writeFile(input, serializeAuditJson(source));
  const messages: string[] = [];
  const errors: string[] = [];
  const options = {
    token: TOKEN, checkpointRoot, now: () => completedAt, concurrency: 1,
    io: { log: (line: string) => messages.push(line), error: (line: string) => errors.push(line) },
  };
  const args = [input, "--history-years", "2", "--json", json, "--csv", csv];
  return { root, input, json, csv, checkpoint, source, messages, errors, options, args,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("enrich-history arguments and help", () => {
  it("shows help without token lookup, filesystem or requests", async () => {
    const logs: string[] = [];
    for (const flag of ["--help", "-h"]) {
      assert.equal(await runEnrichHistoryCli([flag], {
        getToken() { assert.fail("must not read token"); },
        fetch: mockedFetch(() => assert.fail("must not fetch")),
        io: { log: (line) => logs.push(line), error: () => assert.fail("unexpected error") },
      }), 0);
    }
    assert.deepEqual(logs, [HELP, HELP]);
  });

  it("accepts exactly years 1..5 with required JSON and optional CSV/resume", () => {
    for (const years of [1, 2, 3, 4, 5]) {
      assert.deepEqual(parseEnrichHistoryArgs(["in.json", "--history-years", String(years), "--json", "out.json"]), {
        help: false, inputPath: "in.json", historyYears: years, jsonPath: "out.json", resume: false,
      });
    }
    assert.deepEqual(parseEnrichHistoryArgs(["in.json", "--history-years", "5", "--json", "out.json", "--csv", "out.csv", "--resume"]), {
      help: false, inputPath: "in.json", historyYears: 5, jsonPath: "out.json", csvPath: "out.csv", resume: true,
    });
  });

  it("rejects missing or invalid options with exit 2 and usage before requests", async () => {
    const cases = [
      [], ["in.json", "--json", "out.json"], ["in.json", "--history-years", "5"],
      ["in.json", "--history-years", "5", "--json", "out.json", "--mystery"],
      ...["0", "6", "-1", "1.5", "01", "NaN"].map((years) =>
        ["in.json", "--history-years", years, "--json", "out.json"]),
    ];
    for (const args of cases) {
      const errors: string[] = [];
      assert.equal(await runEnrichHistoryCli(args, {
        fetch: mockedFetch(() => assert.fail("must not fetch")),
        getToken() { assert.fail("must not read token"); },
        io: { log() {}, error: (line) => errors.push(line) },
      }), 2);
      assert.match(errors.join("\n"), /Usage: npm run enrich-history/);
    }
  });

  it("keeps exports and quotes spaces and Windows backslashes in resume commands", () => {
    assert.equal(formatEnrichHistoryResumeCommand({
      inputPath: "reports/my report.json", historyYears: 5, jsonPath: "reports/out report.json", csvPath: "reports/out report.csv",
    }), "npm run enrich-history -- 'reports/my report.json' --history-years 5 --resume --json 'reports/out report.json' --csv 'reports/out report.csv'");
    const path = String.raw`C:\reports\audit.json`;
    assert.equal(formatEnrichHistoryResumeCommand({ inputPath: path, historyYears: 3, jsonPath: String.raw`C:\reports\out.json` }),
      String.raw`npm run enrich-history -- 'C:\reports\audit.json' --history-years 3 --resume --json 'C:\reports\out.json'`);
  });
});

describe("enrich-history offline workflow", () => {
  it("preserves an ACTIVE LingDong- account without historical queries", async () => {
    const f = await fixture(["ACTIVE"]);
    try {
      Object.assign(f.source.accounts[0]!, {
        login: "LingDong-", url: "https://github.com/LingDong-",
        totalContributions: 339, commitContributions: 333,
        pullRequestContributions: 0, pullRequestReviewContributions: 0,
        issueContributions: 0, restrictedContributionsCount: 0, hasActivityInThePast: true,
      });
      const sourceBytes = serializeAuditJson(f.source);
      await writeFile(f.input, sourceBytes);
      assert.equal(await runEnrichHistoryCli(f.args, {
        ...f.options, token: "",
        getToken() { assert.fail("must not read token"); },
        fetch: mockedFetch(() => assert.fail("ACTIVE must not generate queries")),
      }), 0, f.errors.join("\n"));
      const output = JSON.parse(await readFile(f.json, "utf8")) as AuditResult;
      assert.deepEqual(output.accounts, f.source.accounts);
      assert.equal(output.accounts[0]!.login, "LingDong-");
      assert.equal(output.accounts[0]!.status, "ACTIVE");
      assert.deepEqual(output.summary, f.source.summary);
      assert.equal(await readFile(f.input, "utf8"), sourceBytes);
      assert.equal(await readFile(f.csv, "utf8"), serializeAuditCsv(output));
    } finally { await f.cleanup(); }
  });

  it("queries a quiet trailing-hyphen login exactly as a GraphQL variable and preserves it", async () => {
    const f = await fixture([quiet]);
    const queries: Query[] = [];
    try {
      Object.assign(f.source.accounts[0]!, {
        login: "quiet-user-", url: "https://github.com/quiet-user-",
      });
      const sourceBytes = serializeAuditJson(f.source);
      await writeFile(f.input, sourceBytes);
      assert.equal(await runEnrichHistoryCli(f.args, {
        ...f.options,
        fetch: mockedFetch((query) => {
          queries.push(query);
          assert.equal(query.variables.login, "quiet-user-");
          assert.equal(query.query, HISTORICAL_ACTIVITY_QUERY);
          assert.ok(!query.query.includes("quiet-user-"));
          return historicalResponse(query, { date: "2025-03-17" });
        }),
      }), 0, f.errors.join("\n"));
      assert.equal(queries.length, 1);
      const output = JSON.parse(await readFile(f.json, "utf8")) as AuditResult;
      assert.deepEqual(output.accounts, [{
        ...f.source.accounts[0]!,
        historicalLookupStatus: "FOUND", lastVisibleActivityAt: "2025-03-17",
      }]);
      assert.equal(output.accounts[0]!.login, "quiet-user-");
      assert.equal(output.accounts[0]!.status, quiet);
      assert.deepEqual(output.summary, f.source.summary);
      assert.equal(await readFile(f.input, "utf8"), sourceBytes);
      assert.equal(await readFile(f.csv, "utf8"), serializeAuditCsv(output));
    } finally { await f.cleanup(); }
  });

  it("rejects bad sources before token access or GitHub", async () => {
    const cases: Array<{ contents?: string; change?: (audit: AuditResult) => void; error: RegExp }> = [
      { contents: "sensitive-file-contents", error: /JSON/i },
      { contents: '{"password":"sensitive-file-contents",', error: /JSON/i },
      { change: (source) => { (source as { schemaVersion: number }).schemaVersion = 2; }, error: /schema/i },
      { change: (source) => { source.history.years = 3; }, error: /already contains historical/i },
    ];
    for (const testCase of cases) {
      const f = await fixture();
      try {
        testCase.change?.(f.source);
        await writeFile(f.input, testCase.contents ?? serializeAuditJson(f.source));
        assert.equal(await runEnrichHistoryCli(f.args, {
          ...f.options, token: "", getToken() { assert.fail("must not read token"); },
          fetch: mockedFetch(() => assert.fail("must not fetch")),
        }), 1);
        assert.match(f.errors.join("\n"), testCase.error);
        assert.doesNotMatch(f.errors.join("\n"), /sensitive-file-contents/);
        await assert.rejects(access(f.json));
        await assert.rejects(access(f.checkpoint));
      } finally { await f.cleanup(); }
    }
  });

  it("rejects a missing input before GitHub", async () => {
    const f = await fixture();
    try {
      await rm(f.input);
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options,
        fetch: mockedFetch(() => assert.fail("must not fetch")) }), 1);
      assert.match(f.errors.join("\n"), /read|exist|found/i);
    } finally { await f.cleanup(); }
  });

  it("rejects normalized input/output aliases and preserves the source", async () => {
    const f = await fixture();
    try {
      const bytes = await readFile(f.input);
      const alias = join(f.root, "unused", "..", "source report.json");
      for (const destination of ["--json", "--csv"]) {
        const args = [...f.args];
        args[args.indexOf(destination) + 1] = alias;
        assert.equal(await runEnrichHistoryCli(args, { ...f.options,
          fetch: mockedFetch(() => assert.fail("must not fetch")) }), 1);
      }
      assert.deepEqual(await readFile(f.input), bytes);
    } finally { await f.cleanup(); }
  });

  it("writes a zero-candidate report without token or requests and preserves all source data", async () => {
    const f = await fixture(["ACTIVE"]);
    try {
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options, token: "",
        getToken() { assert.fail("must not read token"); },
        fetch: mockedFetch(() => assert.fail("must not fetch")) }), 0);
      const output = JSON.parse(await readFile(f.json, "utf8")) as AuditResult;
      assert.deepEqual(output, { ...f.source, history: { years: 2 }, generatedAt: completedAt.toISOString() });
      assert.equal(await readFile(f.csv, "utf8"), serializeAuditCsv(output));
      await assert.rejects(access(f.checkpoint));
    } finally { await f.cleanup(); }
  });

  it("enriches only quiet accounts with FOUND/not-found/FAILED using source windows and unchanged recent/summary", async () => {
    const f = await fixture(["ACTIVE", "ACTIVE", quiet, quiet, quiet, "UNKNOWN"]);
    const queries: Query[] = [];
    try {
      const sourceBytes = await readFile(f.input);
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options, fetch: mockedFetch((query) => {
        queries.push(query);
        return historicalResponse(query, {
          ...(query.variables.login === "person-2" ? { date: "2025-03-17", restrictedDate: "2025-04-18" } : {}),
          failed: query.variables.login === "person-4",
          remaining: queries.length === 4 ? 4999 : 4700 - queries.length,
        });
      }) }), 0, f.errors.join("\n"));
      assert.deepEqual(queries.map(({ variables }) => variables.login), ["person-2", "person-3", "person-3", "person-4"]);
      assert.deepEqual(queries[0]?.variables, {
        login: "person-2", from: "2024-09-04T21:28:34.891Z", to: "2025-09-04T21:28:34.890Z",
      });
      assert.deepEqual(queries[2]?.variables, {
        login: "person-3", from: "2023-09-04T21:28:34.891Z", to: "2024-09-04T21:28:34.890Z",
      });
      const output = JSON.parse(await readFile(f.json, "utf8")) as AuditResult;
      assert.equal(output.schemaVersion, 1);
      assert.equal(output.history.years, 2);
      assert.equal(output.generatedAt, completedAt.toISOString());
      assert.deepEqual(output.summary, f.source.summary);
      assert.deepEqual(output.period, f.source.period);
      assert.deepEqual(output.accounts[0], f.source.accounts[0]);
      assert.deepEqual(output.accounts[1], f.source.accounts[1]);
      assert.deepEqual(output.accounts[5], f.source.accounts[5]);
      assert.deepEqual(output.accounts.slice(2, 5).map((a) => [a.historicalLookupStatus, a.lastVisibleActivityAt]), [
        ["FOUND", "2025-04-18"], ["NOT_FOUND_IN_LOOKBACK", null], ["FAILED", null],
      ]);
      for (const [index, item] of output.accounts.entries()) {
        assert.deepEqual({ ...item, historicalLookupStatus: f.source.accounts[index]!.historicalLookupStatus,
          lastVisibleActivityAt: f.source.accounts[index]!.lastVisibleActivityAt }, f.source.accounts[index]);
      }
      assert.deepEqual(output.rateLimits.rest, f.source.rateLimits.rest);
      assert.equal(output.rateLimits.graphql?.remaining, 4999, "latest observed snapshot, even after quota increases");
      assert.deepEqual(await readFile(f.input), sourceBytes);
      assert.equal(await readFile(f.json, "utf8"), serializeAuditJson(output));
      const csv = await readFile(f.csv, "utf8");
      assert.equal(csv.split("\n")[0], CSV_HEADERS.join(","));
      assert.equal(csv, serializeAuditCsv(output));
      assert.match(f.messages.join("\n"), /Enriching historical activity: 3 \/ 3/);
      await assert.rejects(access(f.checkpoint));
    } finally { await f.cleanup(); }
  });

  it("never queries insufficient-visibility or unknown accounts", async () => {
    const f = await fixture(["INSUFFICIENT_VISIBILITY", "UNKNOWN"]);
    try {
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options, token: "",
        fetch: mockedFetch(() => assert.fail("must not fetch")) }), 0);
      const output = JSON.parse(await readFile(f.json, "utf8")) as AuditResult;
      assert.deepEqual(output.accounts, f.source.accounts);
    } finally { await f.cleanup(); }
  });

  for (const kind of ["PRIMARY", "SECONDARY", "UNKNOWN"] as const) {
    it(`persists completed work on ${kind} rate limit; resume skips it and retains exports`, async () => {
      const f = await fixture();
      try {
        await writeFile(f.json, "old JSON");
        await writeFile(f.csv, "old CSV");
        assert.equal(await runEnrichHistoryCli(f.args, { ...f.options, fetch: mockedFetch(async (query) => {
          if (query.variables.login === "person-0") return historicalResponse(query, { date: "2025-03-17" });
          const saved = await loadHistoryEnrichmentCheckpoint(f.checkpoint);
          assert.equal(saved.completedHistoricalActivity["person-0"]?.historicalLookupStatus, "FOUND");
          return rateLimitResponse(kind);
        }) }), 1);
        const saved = await loadHistoryEnrichmentCheckpoint(f.checkpoint);
        assert.deepEqual(Object.keys(saved.completedHistoricalActivity), ["person-0"]);
        const error = f.errors.join("\n");
        assert.match(error, /Progress saved/);
        assert.match(error, kind === "PRIMARY" ? /primary rate limit exhausted/ :
          kind === "SECONDARY" ? /secondary rate limit reached/ : /not provide enough information to classify/);
        assert.match(error, /75 seconds/);
        assert.ok(error.includes(formatEnrichHistoryResumeCommand({
          inputPath: f.input, historyYears: 2, jsonPath: f.json, csvPath: f.csv,
        })));
        assert.equal(await readFile(f.json, "utf8"), "old JSON");
        assert.equal(await readFile(f.csv, "utf8"), "old CSV");
        const checkpointText = await readFile(f.checkpoint, "utf8");
        for (const text of [error, checkpointText]) assert.ok(!text.includes(TOKEN));
        for (const forbidden of ["Authorization", "contributionCalendar", "jsonPath", "csvPath", "totalContributions"]) {
          assert.ok(!checkpointText.includes(forbidden));
        }
        const resumedQueries: string[] = [];
        assert.equal(await runEnrichHistoryCli([...f.args, "--resume"], { ...f.options, fetch: mockedFetch((query) => {
          resumedQueries.push(query.variables.login);
          return historicalResponse(query, { date: "2025-05-01" });
        }) }), 0);
        assert.deepEqual(resumedQueries, ["person-1"]);
        assert.match(f.messages.join("\n"), /Enriching historical activity: 2 \/ 2/);
        await assert.rejects(access(f.checkpoint));
      } finally { await f.cleanup(); }
    });
  }

  it("resumes after a secondary limit without repeating a completed exported trailing-hyphen login", async () => {
    const f = await fixture([quiet, quiet]);
    const firstQueries: string[] = [];
    const found = {
      login: "quiet-user-", lastVisibleActivityAt: "2025-03-17",
      historicalLookupStatus: "FOUND",
    };
    try {
      f.source.accounts = [account("quiet-user-", quiet), account("second-user", quiet)];
      const sourceBytes = serializeAuditJson(f.source);
      await writeFile(f.input, sourceBytes);
      assert.equal(await runEnrichHistoryCli(f.args, {
        ...f.options,
        fetch: mockedFetch(async (query) => {
          firstQueries.push(query.variables.login);
          if (query.variables.login === "quiet-user-") {
            return historicalResponse(query, { date: found.lastVisibleActivityAt });
          }
          assert.equal(query.variables.login, "second-user");
          const saved = await loadHistoryEnrichmentCheckpoint(f.checkpoint);
          assert.deepEqual(saved.completedHistoricalActivity, { "quiet-user-": found });
          return rateLimitResponse("SECONDARY");
        }),
      }), 1, f.errors.join("\n"));
      assert.deepEqual(firstQueries, ["quiet-user-", "second-user"]);
      assert.match(f.errors.join("\n"), /secondary rate limit reached/);
      assert.match(f.errors.join("\n"), /Progress saved/);
      const saved = await loadHistoryEnrichmentCheckpoint(f.checkpoint);
      assert.deepEqual(saved.completedHistoricalActivity, { "quiet-user-": found });
      assert.equal(saved.user, f.source.user);
      assert.equal(saved.schemaVersion, 1);
      await assert.rejects(access(f.json));
      await assert.rejects(access(f.csv));

      const resumedQueries: string[] = [];
      assert.equal(await runEnrichHistoryCli([...f.args, "--resume"], {
        ...f.options,
        fetch: mockedFetch((query) => {
          resumedQueries.push(query.variables.login);
          assert.equal(query.variables.login, "second-user");
          return historicalResponse(query, { date: "2025-05-01" });
        }),
      }), 0, f.errors.join("\n"));
      assert.deepEqual(resumedQueries, ["second-user"]);
      const output = JSON.parse(await readFile(f.json, "utf8")) as AuditResult;
      assert.deepEqual(output.accounts[0], {
        ...f.source.accounts[0]!,
        lastVisibleActivityAt: found.lastVisibleActivityAt,
        historicalLookupStatus: found.historicalLookupStatus,
      });
      assert.equal(output.accounts[0]!.login, "quiet-user-");
      assert.equal(output.accounts[0]!.status, quiet);
      assert.equal(output.accounts[0]!.historicalLookupStatus, "FOUND");
      assert.deepEqual(output.summary, f.source.summary);
      assert.deepEqual(output.period, f.source.period);
      assert.equal(await readFile(f.input, "utf8"), sourceBytes);
      assert.equal(await readFile(f.csv, "utf8"), serializeAuditCsv(output));
      assert.match(f.messages.join("\n"), /Enriching historical activity: 2 \/ 2/);
      await assert.rejects(access(f.checkpoint));
    } finally { await f.cleanup(); }
  });

  it("rejects modified source and incompatible requested years on resume before GitHub", async () => {
    const f = await fixture();
    try {
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options,
        fetch: mockedFetch(() => rateLimitResponse("SECONDARY")) }), 1);
      const original = await readFile(f.input, "utf8");
      await writeFile(f.input, original + "\n");
      assert.equal(await runEnrichHistoryCli([...f.args, "--resume"], { ...f.options, token: "",
        getToken() { assert.fail("must not read token"); }, fetch: mockedFetch(() => assert.fail("must not fetch")) }), 1);
      assert.match(f.errors.at(-1)!, /hash|source.*chang|source.*match/i);
      await writeFile(f.input, original);
      const incompatible = [...f.args, "--resume"];
      incompatible[incompatible.indexOf("--history-years") + 1] = "3";
      assert.equal(await runEnrichHistoryCli(incompatible, { ...f.options,
        fetch: mockedFetch(() => assert.fail("must not fetch")) }), 1);
      assert.match(f.errors.at(-1)!, /histor|years/i);
    } finally { await f.cleanup(); }
  });

  it("fresh replaces incompatible checkpoint and does not reuse completed accounts", async () => {
    const f = await fixture();
    try {
      await mkdir(f.options.checkpointRoot);
      await writeFile(f.checkpoint, '{"incompatible":true}');
      const logins: string[] = [];
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options, fetch: mockedFetch((query) => {
        logins.push(query.variables.login);
        return historicalResponse(query, { date: "2025-03-17" });
      }) }), 0);
      assert.deepEqual(logins, ["person-0", "person-1"]);
    } finally { await f.cleanup(); }
  });

  it("keeps a complete checkpoint on CSV export failure; resume exports without token or queries", async () => {
    const f = await fixture([quiet]);
    try {
      await mkdir(f.csv);
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options,
        fetch: mockedFetch((query) => historicalResponse(query, { failed: true })) }), 1);
      const saved = await loadHistoryEnrichmentCheckpoint(f.checkpoint);
      assert.equal(saved.completedHistoricalActivity["person-0"]?.historicalLookupStatus, "FAILED");
      assert.match(f.errors.join("\n"), /Failed to write CSV/);
      await rm(f.csv, { recursive: true });
      assert.equal(await runEnrichHistoryCli([...f.args, "--resume"], { ...f.options, token: "",
        getToken() { assert.fail("must not read token"); },
        fetch: mockedFetch(() => assert.fail("must not repeat even FAILED accounts")) }), 0);
      const output = JSON.parse(await readFile(f.json, "utf8")) as AuditResult;
      assert.deepEqual(output.rateLimits.graphql, saved.lastGraphqlRateLimit);
      assert.equal(output.accounts[0]?.historicalLookupStatus, "FAILED");
      await access(f.csv);
      await assert.rejects(access(f.checkpoint));
    } finally { await f.cleanup(); }
  });

  it("keeps checkpoint when JSON export fails", async () => {
    const f = await fixture([quiet]);
    try {
      await mkdir(f.json);
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options,
        fetch: mockedFetch((query) => historicalResponse(query, { date: "2025-03-17" })) }), 1);
      assert.equal(Object.keys((await loadHistoryEnrichmentCheckpoint(f.checkpoint)).completedHistoricalActivity).length, 1);
      await assert.rejects(access(f.csv));
      assert.match(f.errors.join("\n"), /Failed to write JSON/);
    } finally { await f.cleanup(); }
  });

  it("drains in-flight accounts before returning a fatal interruption and persists their completion", async () => {
    const f = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    try {
      const running = runEnrichHistoryCli(f.args, { ...f.options, concurrency: 2, fetch: mockedFetch(async (query) => {
        if (query.variables.login === "person-0") {
          setTimeout(release, 20);
          return rateLimitResponse("SECONDARY");
        }
        await blocked;
        return historicalResponse(query, { date: "2025-03-17" });
      }) });
      assert.equal(await running, 1);
      const saved = await loadHistoryEnrichmentCheckpoint(f.checkpoint);
      assert.equal(saved.completedHistoricalActivity["person-1"]?.historicalLookupStatus, "FOUND");
      await assert.rejects(access(f.json));
    } finally { release(); await f.cleanup(); }
  });

  it("requires a token only for pending work and rejects a missing resume checkpoint locally", async () => {
    const f = await fixture();
    try {
      for (const args of [f.args, [...f.args, "--resume"]]) {
        assert.equal(await runEnrichHistoryCli(args, { ...f.options, token: "",
          fetch: mockedFetch(() => assert.fail("must not fetch")) }), 1);
        await assert.rejects(access(f.checkpoint));
      }
      assert.match(f.errors[0]!, /requires GITHUB_TOKEN/);
      assert.match(f.errors[1]!, /No historical enrichment checkpoint/);
    } finally { await f.cleanup(); }
  });

  it("saves a full quota snapshot from a GraphQL HTTP-200 primary rate-limit response", async () => {
    const f = await fixture();
    try {
      const lastRate = { cost: 2, limit: 5000, remaining: 0, resetAt: "2030-01-01T13:00:00.000Z" };
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options, fetch: mockedFetch((query) => {
        if (query.variables.login === "person-0") return historicalResponse(query, { date: "2025-03-17" });
        return new Response(JSON.stringify({
          data: { rateLimit: lastRate }, errors: [{ message: "API rate limit exceeded", type: "RATE_LIMITED" }],
        }), { status: 200 });
      }) }), 1);
      const saved = await loadHistoryEnrichmentCheckpoint(f.checkpoint);
      assert.deepEqual(saved.lastGraphqlRateLimit, lastRate);
      assert.equal(Object.keys(saved.completedHistoricalActivity).length, 1);
      assert.match(f.errors.join("\n"), /primary rate limit exhausted/);
      await assert.rejects(access(f.json));
    } finally { await f.cleanup(); }
  });

  it("redacts the token in fatal API messages while preserving resumable progress", async () => {
    const f = await fixture();
    try {
      assert.equal(await runEnrichHistoryCli(f.args, { ...f.options, fetch: mockedFetch(() =>
        new Response(JSON.stringify({ message: `Diagnostic echoed ${TOKEN}` }), { status: 400 })) }), 1);
      const error = f.errors.join("\n");
      assert.match(error, /HTTP 400/);
      assert.match(error, /\[REDACTED\]/);
      assert.ok(!error.includes(TOKEN));
      assert.ok(!(await readFile(f.checkpoint, "utf8")).includes(TOKEN));
      await assert.rejects(access(f.json));
    } finally { await f.cleanup(); }
  });


});
