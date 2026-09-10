import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { normalizeAccount } from "../domain/account.js";
import type { AuditResult } from "../domain/audit.js";
import { serializeAuditJson } from "../export/json.js";
import { assertDistinctPaths, AuditInputError, readAuditExport } from "./input.js";

function sourceFixture(): AuditResult {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-04T22:00:00.000Z",
    user: "Owner",
    period: { days: 365, from: "2025-09-04T21:28:34.891Z", to: "2026-09-04T21:28:34.891Z" },
    history: { years: 0 },
    summary: {
      followingTotal: 3, eligibleUsers: 2, unsupportedAccounts: 1,
      active: 1, noRecentVisibleActivity: 1, insufficientVisibility: 0, unknown: 0, coverage: 100,
    },
    accounts: [
      {
        login: "active", url: "https://github.com/active", accountType: "User", status: "ACTIVE",
        recentPeriodDays: 365, totalContributions: 4, commitContributions: 2,
        pullRequestContributions: 1, pullRequestReviewContributions: 0, issueContributions: 1,
        restrictedContributionsCount: 0, hasActivityInThePast: true,
        lastVisibleActivityAt: null, historicalLookupStatus: null,
      },
      {
        login: "quiet", url: "https://github.com/quiet", accountType: "User", status: "NO_RECENT_VISIBLE_ACTIVITY",
        recentPeriodDays: 365, totalContributions: 0, commitContributions: 0,
        pullRequestContributions: 0, pullRequestReviewContributions: 0, issueContributions: 0,
        restrictedContributionsCount: 0, hasActivityInThePast: false,
        lastVisibleActivityAt: null, historicalLookupStatus: "NOT_REQUESTED",
      },
    ],
    rateLimits: {
      rest: { limit: 5000, remaining: 4995, resetAt: null },
      graphql: { cost: 1, limit: 5000, remaining: 4900, resetAt: "2026-09-04T23:00:00.000Z" },
    },
  };
}

async function tempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ghost-enrichment-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeSource(directory: string, value: unknown = sourceFixture()): Promise<string> {
  const path = join(directory, "source.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

describe("historical enrichment source reader", () => {
  it("accepts the public schema and preserves all account, summary and extra fields", async (t) => {
    const directory = await tempDirectory(t);
    const source = sourceFixture();
    Object.assign(source, { extra: { retained: true } });
    Object.assign(source.accounts[0]!, { recentNote: "retain this field" });
    const contents = serializeAuditJson(source);
    const path = join(directory, "source.json");
    await writeFile(path, contents);
    const loaded = await readAuditExport(path);
    assert.deepEqual(loaded.audit, source);
    assert.equal(loaded.sourceHash, createHash("sha256").update(contents).digest("hex"));
    assert.equal(await readFile(path, "utf8"), contents);
    assert.equal(Object.hasOwn(loaded.audit.accounts[0]!, "hasAnyContributions"), false);
  });

  it("reads exported REST logins without applying manual CLI username rules", async (t) => {
    const directory = await tempDirectory(t);
    for (const login of ["LingDong-", "quiet-user-", "normal-user", "abc123", "legacy--user"]) {
      const normalized = normalizeAccount({
        login, id: 1, type: "User", html_url: `https://github.com/${login}`,
      });
      const source = sourceFixture();
      const index = login === "quiet-user-" ? 1 : 0;
      Object.assign(source.accounts[index]!, {
        login: normalized.login, url: normalized.htmlUrl, accountType: normalized.type,
      });
      const path = join(directory, "source.json");
      await writeFile(path, serializeAuditJson(source));
      const { audit } = await readAuditExport(path);
      assert.deepEqual(audit, source);
      assert.equal(audit.accounts[index]!.login, login);
    }
    const source = sourceFixture();
    source.user = "LingDong-";
    await assert.rejects(readAuditExport(await writeSource(directory, source)), /user must be a valid GitHub username/);
  });

  it("rejects empty, non-string, untrimmed and control-containing exported logins in every account", async (t) => {
    const directory = await tempDirectory(t);
    const invalidLogins = [
      "", null, 123, " user", "user ", "user\nother", "user\r", "user\tother",
      "user\u0000other", "user\u001bother", "user\u007fother", "user\u0085other",
    ];
    for (const index of [0, 1]) {
      for (const login of invalidLogins) {
        const source = sourceFixture();
        Object.assign(source.accounts[index]!, { login });
        await assert.rejects(readAuditExport(await writeSource(directory, source)), {
          name: "AuditInputError",
          message: `Invalid input report: accounts[${index}].login must be a nonempty string without surrounding whitespace or control characters.`,
        });
      }
    }
  });

  it("fingerprints original bytes, including whitespace", async (t) => {
    const directory = await tempDirectory(t);
    const path = await writeSource(directory);
    const original = await readAuditExport(path);
    await writeFile(path, `${serializeAuditJson(sourceFixture())}\n`);
    const reformatted = await readAuditExport(path);
    assert.deepEqual(reformatted.audit, original.audit);
    assert.notEqual(reformatted.sourceHash, original.sourceHash);
  });

  it("reports unreadable and malformed inputs without source contents or native parse errors", async (t) => {
    const directory = await tempDirectory(t);
    await assert.rejects(readAuditExport(join(directory, "absent.json")), /Could not read input report/);
    const path = join(directory, "invalid.json");
    await writeFile(path, '{"secret":"synthetic-secret-do-not-print",');
    await assert.rejects(readAuditExport(path), (error: unknown) => {
      assert.ok(error instanceof AuditInputError);
      assert.equal(error.message, "Input report is not valid JSON.");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error), /synthetic-secret|Unexpected|SyntaxError/);
      return true;
    });
    const invalidEncoding = Buffer.from(JSON.stringify(sourceFixture()));
    invalidEncoding[invalidEncoding.indexOf("Owner")] = 0xff;
    await writeFile(path, invalidEncoding);
    await assert.rejects(readAuditExport(path), /Input report is not valid JSON/);
  });

  it("rejects unsupported schema and already enriched source reports", async (t) => {
    const directory = await tempDirectory(t);
    const unsupported = { ...sourceFixture(), schemaVersion: 2 };
    await assert.rejects(readAuditExport(await writeSource(directory, unsupported)), /Unsupported.*schemaVersion/);
    const enriched = sourceFixture();
    enriched.history.years = 3;
    await assert.rejects(readAuditExport(await writeSource(directory, enriched)), /already contains historical lookup.*history.years = 0/);
  });

  it("rejects unsafe usernames, invalid dates, unknown statuses and malformed public fields", async (t) => {
    const directory = await tempDirectory(t);
    const cases: { change: (source: AuditResult) => void; expected: RegExp }[] = [
      { change: (source) => { source.user = "../synthetic-secret"; }, expected: /user must be a valid GitHub username/ },
      { change: (source) => { source.user = "owner\n"; }, expected: /user must be a valid GitHub username/ },
      { change: (source) => { source.generatedAt = "2026-02-30T00:00:00.000Z"; }, expected: /generatedAt/ },
      { change: (source) => { source.period.days = 0; }, expected: /period.days/ },
      { change: (source) => { source.period.from = source.period.to; }, expected: /must precede/ },
      { change: (source) => { Object.assign(source.accounts[0]!, { login: null }); }, expected: /login/ },
      { change: (source) => { source.accounts[0]!.accountType = "Organization"; }, expected: /accountType/ },
      { change: (source) => { Object.assign(source.accounts[0]!, { status: "GHOST" }); }, expected: /status is not recognized/ },
      { change: (source) => { source.accounts[0]!.totalContributions = -1; }, expected: /totalContributions/ },
      { change: (source) => { source.accounts[0]!.recentPeriodDays = 7; }, expected: /recentPeriodDays/ },
      { change: (source) => { delete (source.accounts[0] as Partial<AuditResult["accounts"][number]>).hasActivityInThePast; }, expected: /hasActivityInThePast/ },
      { change: (source) => { Object.assign(source, { accounts: {} }); }, expected: /accounts must be an array/ },
      { change: (source) => { Object.assign(source, { summary: null }); }, expected: /summary must be an object/ },
    ];
    for (const { change, expected } of cases) {
      const source = sourceFixture();
      change(source);
      await assert.rejects(readAuditExport(await writeSource(directory, source)), expected);
    }
  });

  it("requires unrequested historical fields for quiet candidates", async (t) => {
    const directory = await tempDirectory(t);
    for (const historicalLookupStatus of [null, "FOUND", "FAILED", "NOT_FOUND_IN_LOOKBACK"] as const) {
      const source = sourceFixture();
      source.accounts[1]!.historicalLookupStatus = historicalLookupStatus;
      await assert.rejects(readAuditExport(await writeSource(directory, source)), /must have historicalLookupStatus NOT_REQUESTED/);
    }
    const source = sourceFixture();
    source.accounts[1]!.lastVisibleActivityAt = "2024-01-01";
    await assert.rejects(readAuditExport(await writeSource(directory, source)), /lastVisibleActivityAt null/);
  });

  it("validates unique logins and summary consistency without changing classifications", async (t) => {
    const directory = await tempDirectory(t);
    const duplicate = sourceFixture();
    duplicate.accounts[1]!.login = "ACTIVE";
    await assert.rejects(readAuditExport(await writeSource(directory, duplicate)), /unique logins/);
    const inconsistent = sourceFixture();
    inconsistent.summary.active = 2;
    await assert.rejects(readAuditExport(await writeSource(directory, inconsistent)), /summary counts/);
    const coverage = sourceFixture();
    coverage.summary.coverage = 90;
    await assert.rejects(readAuditExport(await writeSource(directory, coverage)), /summary.coverage/);
    const unknown = sourceFixture();
    Object.assign(unknown.accounts[0]!, { status: "UNKNOWN", totalContributions: null, hasActivityInThePast: null });
    unknown.summary.active = 0;
    unknown.summary.unknown = 1;
    unknown.summary.coverage = 50;
    const { audit } = await readAuditExport(await writeSource(directory, unknown));
    assert.deepEqual(audit, unknown);
  });

  it("accepts unavailable rate limits and empty accounts using the serialized schema nulls", async (t) => {
    const directory = await tempDirectory(t);
    const source = sourceFixture();
    source.accounts = [];
    source.summary = {
      followingTotal: 1, eligibleUsers: 0, unsupportedAccounts: 1, active: 0,
      noRecentVisibleActivity: 0, insufficientVisibility: 0, unknown: 0, coverage: null,
    };
    source.rateLimits = { rest: { limit: null, remaining: null, resetAt: null }, graphql: null };
    assert.deepEqual((await readAuditExport(await writeSource(directory, source))).audit, source);
    Object.assign(source, { rateLimits: { rest: source.rateLimits.rest } });
    await assert.rejects(readAuditExport(await writeSource(directory, source)), /rateLimits.graphql/);
    source.rateLimits = sourceFixture().rateLimits;
    source.rateLimits.graphql!.cost = -1;
    await assert.rejects(readAuditExport(await writeSource(directory, source)), /rateLimits.graphql.cost/);
  });
});

describe("historical enrichment immutable source paths", () => {
  it("rejects equivalent absolute, relative and normalized source destinations", async (t) => {
    const directory = await tempDirectory(t);
    const source = await writeSource(directory);
    const equivalent = `${relative(process.cwd(), directory)}${sep}unused${sep}..${sep}source.json`;
    await assert.rejects(assertDistinctPaths(source, [{ path: equivalent, label: "JSON output" }]), /Input and JSON output paths must be different/);
    await assert.rejects(assertDistinctPaths(source, [{ path: source, label: "CSV output" }]), /Input and CSV output paths must be different/);
    if (process.platform === "win32") {
      await assert.rejects(assertDistinctPaths(source, [{ path: source.toUpperCase(), label: "JSON output" }]), /paths must be different/);
    }
    await assertDistinctPaths(source, [{ path: join(directory, "new", "output.json"), label: "JSON output" }]);
  });

  it("rejects hard links to the source for JSON, CSV and checkpoint destinations", async (t) => {
    const directory = await tempDirectory(t);
    const source = await writeSource(directory);
    const alias = join(directory, "alias.json");
    await link(source, alias);
    for (const label of ["JSON output", "CSV output", "Checkpoint"]) {
      await assert.rejects(assertDistinctPaths(source, [{ path: alias, label }]), /paths must be different/);
    }
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), sourceFixture());
  });

  it("rejects source and output aliases through symlinked directories", async (t) => {
    const directory = await tempDirectory(t);
    const actual = join(directory, "actual");
    const alias = join(directory, "alias");
    await mkdir(actual);
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const source = await writeSource(actual);
    await assert.rejects(assertDistinctPaths(source, [{ path: join(alias, "source.json"), label: "JSON output" }]), /Input and JSON output paths must be different/);
    await assert.rejects(assertDistinctPaths(source, [
      { path: join(actual, "new", "output.json"), label: "JSON output" },
      { path: join(alias, "new", "output.json"), label: "CSV output" },
    ]), /JSON output and CSV output paths must be different/);
  });

  it("rejects mutual output aliases even when neither destination exists", async (t) => {
    const directory = await tempDirectory(t);
    const source = await writeSource(directory);
    const output = join(directory, "output.json");
    await assert.rejects(assertDistinctPaths(source, [
      { path: output, label: "JSON output" }, { path: output, label: "CSV output" },
    ]), /JSON output and CSV output paths must be different/);
  });
});