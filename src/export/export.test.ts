import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AuditResult } from "../domain/audit.js";
import { CSV_HEADERS, escapeCsvValue, serializeAuditCsv } from "./csv.js";
import { ExportWriteError, writeAuditExports } from "./files.js";
import { serializeAuditJson } from "./json.js";

function auditFixture(): AuditResult {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-22T00:00:00.000Z",
    user: "owner",
    period: {
      days: 180,
      from: "2026-02-23T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
    },
    summary: {
      followingTotal: 2,
      eligibleUsers: 1,
      unsupportedAccounts: 1,
      active: 0,
      noRecentVisibleActivity: 1,
      insufficientVisibility: 0,
      unknown: 0,
      coverage: 100,
    },
    accounts: [
      {
        login: "comma,name",
        url: "https://example.test/\"quoted\"\nnext",
        accountType: "User",
        status: "NO_RECENT_VISIBLE_ACTIVITY",
        recentPeriodDays: 180,
        totalContributions: 0,
        commitContributions: 0,
        pullRequestContributions: 0,
        pullRequestReviewContributions: 0,
        issueContributions: 0,
        restrictedContributionsCount: 0,
        hasActivityInThePast: false,
        lastVisibleActivityAt: "2025-08-17",
        historicalLookupStatus: "FOUND",
      },
    ],
    rateLimits: {
      rest: { limit: 5000, remaining: 4998, resetAt: null },
      graphql: {
        cost: 1,
        limit: 5000,
        remaining: 4997,
        resetAt: "2026-08-22T01:00:00.000Z",
      },
    },
  };
}

describe("JSON export", () => {
  it("serializes schema, summary, accounts and nulls without secrets", () => {
    const output = serializeAuditJson(auditFixture());
    const parsed = JSON.parse(output) as AuditResult;

    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.summary.coverage, 100);
    assert.equal(parsed.accounts.length, 1);
    assert.equal(parsed.accounts[0]?.hasActivityInThePast, false);
    assert.equal(parsed.accounts[0]?.lastVisibleActivityAt, "2025-08-17");
    assert.equal(parsed.accounts[0]?.historicalLookupStatus, "FOUND");
    assert.doesNotMatch(output, /GITHUB_TOKEN|obvious-secret-value/);
  });
});

describe("CSV export", () => {
  it("uses the documented header and one row per eligible account", () => {
    const output = serializeAuditCsv(auditFixture());
    assert.equal(output.split("\n")[0], CSV_HEADERS.join(","));
    assert.match(output, /^login,profile_url,status,period_days,/);
    assert.equal(output.match(/NO_RECENT_VISIBLE_ACTIVITY/g)?.length, 1);
  });

  it("escapes commas, quotes and newlines and renders null as empty", () => {
    assert.equal(escapeCsvValue("one,two"), '"one,two"');
    assert.equal(escapeCsvValue('say "hello"'), '"say ""hello"""');
    assert.equal(escapeCsvValue("line one\nline two"), '"line one\nline two"');
    assert.equal(escapeCsvValue(null), "");

    const output = serializeAuditCsv(auditFixture());
    assert.match(output, /"comma,name"/);
    assert.match(output, /"https:\/\/example\.test\/""quoted""\nnext"/);
    assert.match(output, /false,2025-08-17,FOUND/);
    assert.doesNotMatch(output, /NO_PAST_ACTIVITY/);
  });
});

describe("export filesystem", () => {
  it("creates parent directories and writes JSON and CSV", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-export-"));
    const jsonPath = join(root, "nested", "json", "audit.json");
    const csvPath = join(root, "nested", "csv", "audit.csv");

    try {
      await writeAuditExports(auditFixture(), { jsonPath, csvPath });
      assert.equal(JSON.parse(await readFile(jsonPath, "utf8")).schemaVersion, 1);
      assert.match(await readFile(csvPath, "utf8"), /^login,profile_url/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("wraps filesystem failures with the export format and path", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-export-error-"));
    const blockingPath = join(root, "not-a-directory");
    await writeFile(blockingPath, "file", "utf8");

    try {
      await assert.rejects(
        writeAuditExports(auditFixture(), {
          jsonPath: join(blockingPath, "audit.json"),
        }),
        (error: unknown) => {
          assert.ok(error instanceof ExportWriteError);
          assert.equal(error.format, "JSON");
          assert.match(error.message, /Failed to write JSON export/);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
