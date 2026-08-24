import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FollowedAccount } from "./domain/account.js";
import type { AccountActivityResult } from "./domain/activity.js";
import {
  CheckpointError,
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
    );
    const recent = result(user, 0);
    recordRecentResults(checkpoint, [recent]);
    recordHistoricalResult(checkpoint, {
      ...recent,
      lastVisibleActivityAt: null,
      historicalLookupStatus: "NO_PAST_ACTIVITY",
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

  it("detects new and removed following accounts conservatively", () => {
    const one = account("one", 1);
    const removed = account("removed", 2);
    const added = account("added", 3);
    const changes = compareFollowing([one, removed], [one, added]);

    assert.deepEqual(changes.added.map(({ login }) => login), ["added"]);
    assert.deepEqual(changes.removed.map(({ login }) => login), ["removed"]);
  });
});
