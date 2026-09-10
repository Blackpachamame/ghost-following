import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { CheckpointError, CheckpointWriter, checkpointPathFor } from "../checkpoint.js";
import { createHistoricalPeriods } from "../domain/activity.js";
import type { AccountAuditResult, AuditResult } from "../domain/audit.js";
import {
  createHistoryEnrichmentCheckpoint,
  historyEnrichmentCheckpointPathFor,
  loadHistoryEnrichmentCheckpoint,
  validateHistoryEnrichmentResume,
  type CompletedHistoricalActivity,
  type HistoryEnrichmentCheckpoint,
} from "./checkpoint.js";

const sourceHash = "a".repeat(64);
const now = new Date("2026-09-09T10:00:00.000Z");
const period = {
  days: 365,
  from: "2025-09-04T21:28:34.891Z",
  to: "2026-09-04T21:28:34.891Z",
};

function account(
  login: string,
  status: AccountAuditResult["status"] = "NO_RECENT_VISIBLE_ACTIVITY",
): AccountAuditResult {
  return {
    login,
    url: "https://github.com/" + login,
    accountType: "User",
    status,
    recentPeriodDays: 365,
    totalContributions: status === "ACTIVE" ? 10 : 0,
    commitContributions: status === "ACTIVE" ? 10 : 0,
    pullRequestContributions: 0,
    pullRequestReviewContributions: 0,
    issueContributions: 0,
    restrictedContributionsCount: 0,
    hasActivityInThePast: false,
    lastVisibleActivityAt: null,
    historicalLookupStatus: status === "NO_RECENT_VISIBLE_ACTIVITY"
      ? "NOT_REQUESTED"
      : null,
  };
}

function auditFixture(): AuditResult {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-04T21:28:34.891Z",
    user: "Owner",
    period: { ...period },
    history: { years: 0 },
    summary: {
      followingTotal: 4,
      eligibleUsers: 4,
      unsupportedAccounts: 0,
      active: 1,
      noRecentVisibleActivity: 3,
      insufficientVisibility: 0,
      unknown: 0,
      coverage: 100,
    },
    accounts: [
      account("Active", "ACTIVE"),
      account("Found"),
      account("Quiet"),
      account("Failed"),
    ],
    rateLimits: {
      rest: { limit: 5000, remaining: 4900, resetAt: now.toISOString() },
      graphql: null,
    },
  };
}

function checkpointFixture(): HistoryEnrichmentCheckpoint {
  return createHistoryEnrichmentCheckpoint(auditFixture(), sourceHash, 3, now);
}

function completed(
  login: string,
  historicalLookupStatus: CompletedHistoricalActivity["historicalLookupStatus"] = "NOT_FOUND_IN_LOOKBACK",
  lastVisibleActivityAt: string | null = null,
): CompletedHistoricalActivity {
  return { login, historicalLookupStatus, lastVisibleActivityAt };
}

async function withCheckpointPath(
  run: (path: string, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ghost-history-checkpoint-"));
  try {
    await run(historyEnrichmentCheckpointPathFor("Owner", directory), directory);
  } finally {
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(absolute).startsWith("ghost-history-checkpoint-"));
    await rm(absolute, { recursive: true, force: true });
  }
}

describe("historical enrichment checkpoint", () => {
  it("uses a separate namespace and one case-normalized user destination", () => {
    const path = historyEnrichmentCheckpointPathFor("Owner");
    assert.notEqual(path, checkpointPathFor("Owner"));
    assert.equal(path, historyEnrichmentCheckpointPathFor("owner"));
    assert.equal(basename(path), "owner-history.json");
    assert.equal(
      path,
      resolve(".ghost-following", "history-enrichment", "owner-history.json"),
    );
    assert.throws(() => historyEnrichmentCheckpointPathFor("../escape"), CheckpointError);
    assert.throws(() => historyEnrichmentCheckpointPathFor("Owner\n"), CheckpointError);
    for (const user of ["quiet-user-", "legacy--user"]) {
      assert.throws(() => historyEnrichmentCheckpointPathFor(user), CheckpointError);
    }
    for (const user of ["CON", "NUL", "AUX", "COM1"]) {
      assert.equal(
        basename(historyEnrichmentCheckpointPathFor(user)),
        user.toLowerCase() + "-history.json",
      );
    }
  });

  it("creates only the fingerprint, identity, configuration and completed work state", () => {
    const audit = auditFixture();
    const checkpoint = createHistoryEnrichmentCheckpoint(audit, sourceHash, 3, now);
    assert.deepEqual(checkpoint, {
      schemaVersion: 1,
      sourceHash,
      user: "Owner",
      period,
      historyYears: 3,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedHistoricalActivity: {},
    });
    assert.notEqual(checkpoint.period, audit.period);
    assert.doesNotMatch(
      JSON.stringify(checkpoint),
      /accounts|summary|recentActivity|followingSnapshot|authorization|jsonPath|csvPath/i,
    );
    assert.throws(
      () => createHistoryEnrichmentCheckpoint(audit, "invalid", 3, now),
      /schema is invalid/,
    );
    assert.throws(
      () => createHistoryEnrichmentCheckpoint(audit, sourceHash, 0, now),
      /invalid historyYears/,
    );
    assert.throws(
      () => createHistoryEnrichmentCheckpoint(audit, sourceHash, 6, now),
      /invalid historyYears/,
    );
    assert.throws(
      () => createHistoryEnrichmentCheckpoint(audit, sourceHash, 3, new Date(NaN)),
      /valid creation date/,
    );
  });

  it("round-trips all terminal results through the existing atomic writer", async () => {
    await withCheckpointPath(async (path, directory) => {
      const checkpoint = checkpointFixture();
      checkpoint.completedHistoricalActivity = {
        found: completed("Found", "FOUND", "2024-09-17"),
        quiet: completed("Quiet"),
        failed: completed("Failed", "FAILED"),
      };
      checkpoint.lastGraphqlRateLimit = {
        cost: 1,
        limit: null,
        remaining: null,
        resetAt: null,
      };
      const writer = new CheckpointWriter(path);
      await writer.save(checkpoint, new Date("2026-09-09T10:01:00.000Z"));
      const loaded = await loadHistoryEnrichmentCheckpoint(path);
      assert.deepEqual(loaded, checkpoint);
      assert.equal(loaded.updatedAt, "2026-09-09T10:01:00.000Z");
      assert.doesNotThrow(() =>
        validateHistoryEnrichmentResume(loaded, auditFixture(), sourceHash, 3));
      assert.deepEqual(await readdir(directory), ["owner-history.json"]);
    });
  });

  it("round-trips exported trailing and repeated hyphens without changing completed logins", async () => {
    await withCheckpointPath(async (path) => {
      for (const login of ["quiet-user-", "legacy--user"]) {
        const audit = auditFixture();
        audit.accounts[1] = account(login);
        const checkpoint = createHistoryEnrichmentCheckpoint(audit, sourceHash, 3, now);
        const result = completed(login, "FOUND", "2025-03-17");
        checkpoint.completedHistoricalActivity[login.toLowerCase()] = result;
        await new CheckpointWriter(path).save(checkpoint, now);
        const loaded = await loadHistoryEnrichmentCheckpoint(path);
        assert.deepEqual(loaded, checkpoint);
        assert.deepEqual(loaded.completedHistoricalActivity[login.toLowerCase()], result);
        assert.equal(loaded.schemaVersion, 1);
        assert.doesNotThrow(() =>
          validateHistoryEnrichmentResume(loaded, audit, sourceHash, 3));
      }
    });
  });

  it("rejects corrupted completed logins even when their checkpoint keys match", async () => {
    await withCheckpointPath(async (path) => {
      for (const login of [
        "", " user", "user ", "user\nother", "user\tother", "user\u0000other",
        "user\r", "user\u001bother", "user\u007fother", "user\u0085other",
      ]) {
        const checkpoint = checkpointFixture();
        checkpoint.completedHistoricalActivity[login.toLowerCase()] = completed(login);
        await new CheckpointWriter(path).save(checkpoint, now);
        await assert.rejects(loadHistoryEnrichmentCheckpoint(path), /invalid completed historical activity/);
      }
    });
  });

  it("strips unrelated source, secret, error and export data while loading", async () => {
    await withCheckpointPath(async (path) => {
      const secretMarker = "offline-secret-marker";
      const raw = {
        ...checkpointFixture(),
        token: secretMarker,
        source: auditFixture(),
        jsonPath: "unused-output.json",
        csvPath: "unused-output.csv",
        period: { ...period, unrelated: secretMarker },
        completedHistoricalActivity: {
          failed: {
            ...completed("Failed", "FAILED"),
            historicalLookupError: secretMarker,
            rawResponse: { authorization: secretMarker },
            activity: { contributionDays: [secretMarker] },
          },
        },
        lastGraphqlRateLimit: {
          cost: 1,
          limit: 5000,
          remaining: 4999,
          resetAt: now.toISOString(),
          headers: secretMarker,
        },
      };
      await writeFile(path, JSON.stringify(raw), "utf8");
      const loaded = await loadHistoryEnrichmentCheckpoint(path);
      await new CheckpointWriter(path).save(loaded, now);
      const stored = await readFile(path, "utf8");
      assert.doesNotMatch(stored, /offline-secret-marker|rawResponse|headers|source":|jsonPath|csvPath|activity":/);
      assert.deepEqual(loaded.completedHistoricalActivity.failed, completed("Failed", "FAILED"));
      assert.deepEqual(loaded.lastGraphqlRateLimit, {
        cost: 1,
        limit: 5000,
        remaining: 4999,
        resetAt: now.toISOString(),
      });
    });
  });

  it("serializes concurrent snapshots even across writer instances sharing a path", async () => {
    await withCheckpointPath(async (path, directory) => {
      const checkpoint = checkpointFixture();
      let releaseFirst!: () => void;
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => { firstStarted = resolve; });
      const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const counts: number[] = [];
      const writer = new CheckpointWriter(path, {
        fileSystem: {
          async writeFile(target, data, options) {
            counts.push(Object.keys(
              (JSON.parse(data) as HistoryEnrichmentCheckpoint).completedHistoricalActivity,
            ).length);
            firstStarted();
            await released;
            await writeFile(target, data, options);
          },
        },
      });
      checkpoint.completedHistoricalActivity.found = completed("Found", "FOUND", "2024-09-17");
      const firstSave = writer.save(checkpoint, now);
      try {
        await started;
        checkpoint.completedHistoricalActivity.quiet = completed("Quiet");
        const secondSave = new CheckpointWriter(join(directory, ".", "owner-history.json"), {
          fileSystem: {
            async writeFile(target, data, options) {
              counts.push(Object.keys(
                (JSON.parse(data) as HistoryEnrichmentCheckpoint).completedHistoricalActivity,
              ).length);
              await writeFile(target, data, options);
            },
          },
        }).save(checkpoint, new Date("2026-09-09T10:01:00.000Z"));
        assert.deepEqual(counts, [1]);
        releaseFirst();
        await Promise.all([firstSave, secondSave]);
        const loaded = await loadHistoryEnrichmentCheckpoint(path);
        assert.deepEqual(counts, [1, 2]);
        assert.equal(Object.keys(loaded.completedHistoricalActivity).length, 2);
        assert.equal(loaded.updatedAt, "2026-09-09T10:01:00.000Z");
        assert.deepEqual(await readdir(directory), ["owner-history.json"]);
      } finally {
        releaseFirst();
        await firstSave.catch(() => undefined);
      }
    });
  });

  it("reports missing, invalid JSON and unsupported schema without raw contents", async () => {
    await withCheckpointPath(async (path) => {
      await assert.rejects(loadHistoryEnrichmentCheckpoint(path), /No historical enrichment checkpoint found/);
      await writeFile(path, "{ offline-secret-marker", "utf8");
      await assert.rejects(loadHistoryEnrichmentCheckpoint(path), (error: unknown) => {
        assert.ok(error instanceof CheckpointError);
        assert.match(error.message, /Could not read historical enrichment checkpoint/);
        assert.doesNotMatch(error.message, /offline-secret-marker/);
        return true;
      });
      await writeFile(path, JSON.stringify({ ...checkpointFixture(), schemaVersion: 2 }), "utf8");
      await assert.rejects(loadHistoryEnrichmentCheckpoint(path), /schema is invalid or unsupported/);
    });
  });

  it("rejects a changed source fingerprint before work can be reused", () => {
    const checkpoint = checkpointFixture();
    assert.throws(
      () => validateHistoryEnrichmentResume(checkpoint, auditFixture(), "b".repeat(64), 3),
      /sourceHash does not match.*source report has changed/,
    );
  });

  it("rejects historyYears, user and exact period mismatches", () => {
    const checkpoint = checkpointFixture();
    assert.throws(
      () => validateHistoryEnrichmentResume(checkpoint, auditFixture(), sourceHash, 5),
      /historyYears \(3\).*--history-years 5/,
    );
    const audit = auditFixture();
    audit.user = "Another";
    assert.throws(
      () => validateHistoryEnrichmentResume(checkpoint, audit, sourceHash, 3),
      /user does not match/,
    );
    for (const change of [
      { days: 180 },
      { from: "2025-09-04T21:28:34.890Z" },
      { to: "2026-09-04T21:28:34.890Z" },
    ]) {
      assert.throws(
        () => validateHistoryEnrichmentResume(
          checkpoint,
          { ...auditFixture(), period: { ...period, ...change } },
          sourceHash,
          3,
        ),
        /period does not match/,
      );
    }
  });

  it("rejects saved results for active, unknown, unsupported or absent accounts", () => {
    const audit = auditFixture();
    audit.accounts.push(account("Unknown", "UNKNOWN"));
    audit.accounts.push({ ...account("Organization"), accountType: "Organization" });
    for (const login of ["Active", "Unknown", "Organization", "Absent"]) {
      const checkpoint = checkpointFixture();
      checkpoint.completedHistoricalActivity[login.toLowerCase()] = completed(login);
      assert.throws(
        () => validateHistoryEnrichmentResume(checkpoint, audit, sourceHash, 3),
        /not a quiet candidate/,
      );
    }
  });

  it("accepts contribution days on both production lookback boundaries", () => {
    for (const from of [period.from, "2025-09-04T00:00:00.000Z", "2024-02-29T12:00:00.000Z"]) {
      const audit = auditFixture();
      audit.period.from = from;
      const windows = createHistoricalPeriods(audit.period, 3);
      for (const day of [windows[2]!.from.slice(0, 10), windows[0]!.to.slice(0, 10)]) {
        const checkpoint = createHistoryEnrichmentCheckpoint(audit, sourceHash, 3, now);
        checkpoint.completedHistoricalActivity.found = completed("Found", "FOUND", day);
        assert.doesNotThrow(() =>
          validateHistoryEnrichmentResume(checkpoint, audit, sourceHash, 3));
      }
    }
  });

  it("rejects unfinished statuses, malformed keys and incoherent or out-of-range dates", async () => {
    const invalidResults: unknown[] = [
      { login: "Found", historicalLookupStatus: "NOT_REQUESTED", lastVisibleActivityAt: null },
      { login: "Found", historicalLookupStatus: "UNKNOWN", lastVisibleActivityAt: null },
      completed("Found", "FOUND", null),
      completed("Found", "FOUND", "2024-02-30"),
      completed("Found", "FOUND", "2024-09-17T00:00:00.000Z"),
      completed("Found", "FOUND", "2022-09-03"),
      completed("Found", "FOUND", "2025-09-05"),
      completed("Found", "FAILED", "2024-09-17"),
      completed("Found", "NOT_FOUND_IN_LOOKBACK", "2024-09-17"),
      completed("../unsafe"),
    ];
    await withCheckpointPath(async (path) => {
      for (const invalid of invalidResults) {
        await writeFile(path, JSON.stringify({
          ...checkpointFixture(),
          completedHistoricalActivity: { found: invalid },
        }), "utf8");
        await assert.rejects(loadHistoryEnrichmentCheckpoint(path), CheckpointError);
      }
      await writeFile(path, JSON.stringify({
        ...checkpointFixture(),
        completedHistoricalActivity: { Found: completed("Found") },
      }), "utf8");
      await assert.rejects(loadHistoryEnrichmentCheckpoint(path), /invalid completed historical activity/);
    });
  });

  it("rejects invalid period, fingerprint, timestamps and GraphQL metadata", async () => {
    const invalidStates: Record<string, unknown>[] = [
      { sourceHash: "wrong-hash" },
      { user: "../unsafe" },
      { user: "quiet-user-" },
      { user: "legacy--user" },
      { historyYears: 0 },
      { historyYears: 6 },
      { createdAt: "2026-02-30T00:00:00.000Z" },
      { updatedAt: "invalid" },
      { period: { ...period, days: -1 } },
      { period: { ...period, from: period.to } },
      { completedHistoricalActivity: [] },
      { lastGraphqlRateLimit: { cost: 1, limit: null, remaining: -1, resetAt: null } },
      { lastGraphqlRateLimit: { cost: -1, limit: null, remaining: null, resetAt: null } },
      { lastGraphqlRateLimit: { cost: 1, limit: null, remaining: null, resetAt: "wrong" } },
      { lastGraphqlRateLimit: { cost: 1 } },
    ];
    await withCheckpointPath(async (path) => {
      for (const invalid of invalidStates) {
        await writeFile(path, JSON.stringify({ ...checkpointFixture(), ...invalid }), "utf8");
        await assert.rejects(loadHistoryEnrichmentCheckpoint(path), CheckpointError);
      }
    });
  });
});