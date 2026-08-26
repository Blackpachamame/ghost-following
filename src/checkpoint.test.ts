import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FollowedAccount } from "./domain/account.js";
import type { AccountActivityResult } from "./domain/activity.js";
import {
  CheckpointError,
  CheckpointWriter,
  checkpointHistoricalResults,
  checkpointPathFor,
  checkpointRecentResults,
  compareFollowing,
  createCheckpoint,
  loadCheckpoint,
  recordHistoricalResult,
  recordRecentResults,
  removeCheckpoint,
  validateResumeCheckpoint,
  writeCheckpointAtomic,
  type AuditCheckpoint,
} from "./checkpoint.js";

const period = {
  from: "2026-02-25T00:00:00.000Z",
  to: "2026-08-24T00:00:00.000Z",
  days: 180,
};

function account(login: string, id: number): FollowedAccount {
  return { login, id, type: "User", htmlUrl: `https://github.com/${login}` };
}

function result(value: FollowedAccount, total: number): AccountActivityResult {
  return {
    account: value,
    status: total > 0 ? "ACTIVE" : "NO_RECENT_VISIBLE_ACTIVITY",
    activity: {
      login: value.login,
      periodStart: period.from,
      periodEnd: period.to,
      totalContributions: total,
      totalCommitContributions: total,
      totalIssueContributions: 0,
      totalPullRequestContributions: 0,
      totalPullRequestReviewContributions: 0,
      restrictedContributionsCount: 0,
      hasAnyContributions: total > 0,
      hasAnyRestrictedContributions: false,
      hasActivityInThePast: false,
    },
  };
}

describe("audit checkpoint", () => {
  it("creates, atomically replaces and reloads completed recent/historical work", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "ghost-checkpoint-"));
    const root = join(tempDirectory, "checkpoints");
    const path = checkpointPathFor("Owner", root);
    assert.notEqual(path, checkpointPathFor("Owner"));
    const user = account("one", 1);
    const checkpoint = createCheckpoint(
      "Owner",
      period,
      [user],
      new Date("2026-08-24T00:00:00.000Z"),
      3,
    );
    const recent = result(user, 0);
    recordRecentResults(checkpoint, [recent]);
    recordHistoricalResult(checkpoint, {
      ...recent,
      lastVisibleActivityAt: null,
      historicalLookupStatus: "NOT_FOUND_IN_LOOKBACK",
    });

    try {
      await writeCheckpointAtomic(
        path,
        checkpoint,
        new Date("2026-08-24T00:01:00.000Z"),
      );
      await writeCheckpointAtomic(
        path,
        checkpoint,
        new Date("2026-08-24T00:02:00.000Z"),
      );
      const loaded = await loadCheckpoint(path);

      assert.equal(loaded.schemaVersion, 1);
      assert.equal(loaded.username, "Owner");
      assert.deepEqual(loaded.period, period);
      assert.equal(loaded.historyYears, 3);
      assert.equal(checkpointRecentResults(loaded).length, 1);
      assert.equal(checkpointHistoricalResults(loaded).length, 1);
      assert.equal(loaded.updatedAt, "2026-08-24T00:02:00.000Z");
      assert.deepEqual(await readdir(root), ["owner.json"]);
      assert.doesNotMatch(
        await readFile(path, "utf8"),
        /obvious-test-token|authorization|headers|contributionDays/,
      );

      await removeCheckpoint(path);
      await assert.rejects(access(path));
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("loads a schema 1 legacy NO_PAST_ACTIVITY result for resume correction", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "ghost-checkpoint-legacy-"));
    const path = checkpointPathFor("Owner", join(tempDirectory, "checkpoints"));
    const user = account("legacy", 1);
    const recent = result(user, 0);
    const checkpoint = createCheckpoint("Owner", period, [user]);
    delete (checkpoint as Partial<AuditCheckpoint>).historyYears;
    recordRecentResults(checkpoint, [recent]);
    (checkpoint.completedHistoricalActivity as Record<string, unknown>)[
      "legacy"
    ] = {
      ...recent,
      lastVisibleActivityAt: null,
      historicalLookupStatus: "NO_PAST_ACTIVITY",
    };

    try {
      await writeCheckpointAtomic(path, checkpoint);
      const loaded = await loadCheckpoint(path);
      const legacy = checkpointHistoricalResults(loaded)[0] as unknown as {
        historicalLookupStatus?: string;
      };

      assert.equal(loaded.schemaVersion, 1);
      assert.equal(loaded.historyYears, 5);
      assert.equal(legacy.historicalLookupStatus, "NO_PAST_ACTIVITY");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects incompatible usernames and requested periods", () => {
    const checkpoint = createCheckpoint("Owner", period, []);
    assert.throws(
      () => validateResumeCheckpoint(checkpoint, "another", 180),
      CheckpointError,
    );
    assert.throws(
      () => validateResumeCheckpoint(checkpoint, "owner", 365),
      /Checkpoint period does not match requested audit period/,
    );
    assert.doesNotThrow(() =>
      validateResumeCheckpoint(checkpoint, "owner", 180),
    );
  });

  it("inherits resume history when omitted and rejects an explicit mismatch", () => {
    const checkpoint = createCheckpoint("Owner", period, [], new Date(), 3);
    assert.equal(
      validateResumeCheckpoint(checkpoint, "owner", 180),
      3,
    );
    assert.equal(
      validateResumeCheckpoint(checkpoint, "owner", 180, 3),
      3,
    );
    assert.throws(
      () => validateResumeCheckpoint(checkpoint, "owner", 180, 1),
      /historical configuration \(3 years\).*--history-years 1/,
    );
  });

  it("detects new and removed following accounts conservatively", () => {
    const one = account("one", 1);
    const removed = account("removed", 2);
    const added = account("added", 3);
    const changes = compareFollowing([one, removed], [one, added]);

    assert.deepEqual(changes.added.map(({ login }) => login), ["added"]);
    assert.deepEqual(changes.removed.map(({ login }) => login), ["removed"]);
  });

  it("serializes concurrent historical saves and commits the newest snapshot last", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "ghost-checkpoint-race-"));
    const root = join(tempDirectory, "checkpoints");
    const path = checkpointPathFor("Owner", root);
    const users = [account("one", 1), account("two", 2), account("three", 3)];
    const checkpoint = createCheckpoint("Owner", period, users);
    const recent = users.map((user) => result(user, 0));
    recordRecentResults(checkpoint, recent);
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let writeCalls = 0;
    const historicalCounts: number[] = [];
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteRelease = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writer = new CheckpointWriter(path, {
      fileSystem: {
        async writeFile(filePath, data, options) {
          writeCalls += 1;
          activeWrites += 1;
          maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
          historicalCounts.push(
            Object.keys(
              (JSON.parse(data) as AuditCheckpoint)
                .completedHistoricalActivity,
            ).length,
          );
          try {
            if (writeCalls === 1) {
              markFirstWriteStarted();
              await firstWriteRelease;
            }
            await nodeWriteFile(filePath, data, options);
          } finally {
            activeWrites -= 1;
          }
        },
      },
    });
    const complete = (
      item: AccountActivityResult,
      now: Date,
    ): Promise<void> => {
      recordHistoricalResult(checkpoint, {
        ...item,
        lastVisibleActivityAt: null,
        historicalLookupStatus: "NOT_FOUND_IN_LOOKBACK",
      });
      return writer.save(checkpoint, now);
    };

    try {
      const first = complete(recent[0]!, new Date("2026-08-24T00:01:00.000Z"));
      await firstWriteStarted;
      const second = complete(
        recent[1]!,
        new Date("2026-08-24T00:02:00.000Z"),
      );
      const third = complete(
        recent[2]!,
        new Date("2026-08-24T00:03:00.000Z"),
      );
      releaseFirstWrite();
      await Promise.all([first, second, third]);
      await writer.flush();

      const loaded = await loadCheckpoint(path);
      assert.equal(maximumActiveWrites, 1);
      assert.deepEqual(historicalCounts, [1, 2, 3]);
      assert.equal(checkpointRecentResults(loaded).length, 3);
      assert.equal(checkpointHistoricalResults(loaded).length, 3);
      assert.equal(loaded.updatedAt, "2026-08-24T00:03:00.000Z");
      assert.deepEqual(await readdir(root), ["owner.json"]);
    } finally {
      releaseFirstWrite();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("preserves the previous checkpoint and exposes rename failure context", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "ghost-checkpoint-fail-"));
    const root = join(tempDirectory, "checkpoints");
    const path = checkpointPathFor("Owner", root);
    const user = account("one", 1);
    const checkpoint = createCheckpoint("Owner", period, [user]);
    recordRecentResults(checkpoint, [result(user, 0)]);

    try {
      await writeCheckpointAtomic(
        path,
        checkpoint,
        new Date("2026-08-24T00:01:00.000Z"),
      );
      const previous = await readFile(path, "utf8");
      recordHistoricalResult(checkpoint, {
        ...result(user, 0),
        lastVisibleActivityAt: null,
        historicalLookupStatus: "NOT_FOUND_IN_LOOKBACK",
      });
      const filesystemCause = Object.assign(new Error("file is locked"), {
        code: "EPERM",
      });
      const failingWriter = new CheckpointWriter(path, {
        fileSystem: {
          async rename() {
            throw filesystemCause;
          },
        },
      });

      await assert.rejects(
        failingWriter.save(
          checkpoint,
          new Date("2026-08-24T00:02:00.000Z"),
        ),
        (error: unknown) => {
          assert.ok(error instanceof CheckpointError);
          assert.equal(error.cause, filesystemCause);
          assert.match(error.message, /during rename/);
          assert.match(error.message, /EPERM/);
          assert.match(error.message, /file is locked/);
          assert.doesNotMatch(
            error.message,
            /Authorization|Bearer|obvious-test-token/,
          );
          return true;
        },
      );

      assert.equal(await readFile(path, "utf8"), previous);
      assert.deepEqual(await readdir(root), ["owner.json"]);
      assert.equal((await loadCheckpoint(path)).schemaVersion, 1);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
