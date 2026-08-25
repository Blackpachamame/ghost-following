import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AccountActivity } from "../domain/activity.js";
import {
  GitHubAuthenticationError,
  GitHubGraphQLFatalError,
  GitHubHttpError,
  GitHubNetworkError,
  GitHubRateLimitError,
} from "../github/errors.js";
import { GitHubGraphQLClient } from "../github/graphql.js";
import { TransientTransportRetryExhaustedError } from "../github/retry.js";
import {
  recentBatchFailureDiagnosticPathFor,
  type RecentBatchFailureIncident,
} from "./recent-batch-failures.js";
import {
  formatRecentBatchInvestigation,
  investigateRecentBatch,
  loadLatestRecentBatchFailureIncident,
  type RecentBatchInvestigation,
  type RecentBatchInvestigationClient,
  writeRecentBatchInvestigation,
} from "./recent-batch-investigation.js";

const AUDIT_USERNAME = "AuditUser";
const SOURCE_TIMESTAMP = "2026-08-25T01:40:41.234Z";
const INVESTIGATION_TIMESTAMP = new Date("2026-08-25T02:00:00.000Z");
const PERIOD = {
  from: "2025-08-24T23:41:55.948Z",
  to: "2026-08-24T23:41:55.948Z",
  days: 365,
};

function logins(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => "user-" + index);
}

function incident(
  values: readonly string[] = logins(25),
): RecentBatchFailureIncident {
  return {
    timestamp: SOURCE_TIMESTAMP,
    auditUsername: AUDIT_USERNAME,
    phase: "recent",
    period: { ...PERIOD },
    httpStatus: 504,
    attempts: 3,
    batchSize: values.length,
    logins: [...values],
  };
}

function activity(login: string): AccountActivity {
  return {
    login,
    periodStart: PERIOD.from,
    periodEnd: PERIOD.to,
    totalContributions: 1,
    totalCommitContributions: 1,
    totalIssueContributions: 0,
    totalPullRequestContributions: 0,
    totalPullRequestReviewContributions: 0,
    restrictedContributionsCount: 0,
    hasAnyContributions: true,
    hasAnyRestrictedContributions: false,
    hasActivityInThePast: false,
  };
}

function successfulResponse(values: readonly string[]) {
  return {
    items: values.map((login) => ({
      login,
      status: "SUCCESS" as const,
      activity: activity(login),
    })),
    rateLimit: {
      cost: 1,
      limit: 5_000,
      remaining: 4_999,
      resetAt: new Date("2026-08-25T03:00:00.000Z"),
    },
  };
}

function resourceLimitResponse(values: readonly string[]) {
  return {
    items: values.map((login) => ({
      login,
      status: "RESOURCE_LIMIT" as const,
      error: "Resource limits for this query exceeded.",
    })),
  };
}

function successfulGraphQLPayload(bodyText: string): unknown {
  const body = JSON.parse(bodyText) as {
    variables: Record<string, string>;
  };
  const keys = Object.keys(body.variables)
    .filter((key) => /^login\d+$/.test(key))
    .sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)));
  const data: Record<string, unknown> = {
    rateLimit: {
      cost: 1,
      limit: 5_000,
      remaining: 4_999,
      resetAt: "2026-08-25T03:00:00.000Z",
    },
  };
  for (const [index, key] of keys.entries()) {
    const login = body.variables[key]!;
    data["u" + index] = {
      login,
      contributionsCollection: {
        startedAt: body.variables.from,
        endedAt: body.variables.to,
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
  return { data };
}

function scriptedClient(
  handler: (
    values: readonly string[],
    request: number,
  ) => ReturnType<typeof successfulResponse> | ReturnType<typeof resourceLimitResponse>,
  calls: string[][],
): RecentBatchInvestigationClient {
  return {
    async getAccountActivities(values) {
      calls.push([...values]);
      return handler(values, calls.length);
    },
  };
}

describe("recent batch investigation source", () => {
  it("loads the latest valid incident and preserves its exact batch and period", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-source-"));
    const path = recentBatchFailureDiagnosticPathFor(AUDIT_USERNAME, root);
    const older = incident(["older"]);
    const latest = {
      ...incident(["exact-a", "exact-b"]),
      timestamp: "2026-08-25T01:50:00.000Z",
      httpStatus: 502,
    };
    try {
      await mkdir(root, { recursive: true });
      await writeFile(
        path,
        [
          JSON.stringify(older),
          "{invalid-json",
          JSON.stringify(latest),
          JSON.stringify({ ...latest, phase: "historical" }),
        ].join("\n") + "\n",
        "utf8",
      );

      const loaded = await loadLatestRecentBatchFailureIncident(
        AUDIT_USERNAME,
        { root },
      );

      assert.deepEqual(loaded.logins, ["exact-a", "exact-b"]);
      assert.deepEqual(loaded.period, PERIOD);
      assert.equal(loaded.timestamp, latest.timestamp);
      assert.equal(loaded.httpStatus, 502);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("recent batch investigation strategy", () => {
  it("stops after one successful full-batch request as NOT_REPRODUCED", async () => {
    const calls: string[][] = [];
    const source = incident();
    const result = await investigateRecentBatch(
      scriptedClient((values) => successfulResponse(values), calls),
      source,
      INVESTIGATION_TIMESTAMP,
    );

    assert.deepEqual(calls, [source.logins]);
    assert.equal(result.conclusion, "NOT_REPRODUCED");
    assert.equal(result.tree[0]?.outcome, "SUCCESS");
    assert.equal(result.tree[0]?.children, undefined);
    assert.deepEqual(result.period, PERIOD);
  });

  for (const status of [502, 504]) {
    it(`splits an exhausted HTTP ${status} batch into sequential 12 + 13 successes`, async () => {
      const calls: string[][] = [];
      const result = await investigateRecentBatch(
        scriptedClient((values) => {
          if (values.length === 25) {
            throw new GitHubHttpError(status, "", undefined, 3);
          }
          return successfulResponse(values);
        }, calls),
        incident(),
        INVESTIGATION_TIMESTAMP,
      );

      assert.deepEqual(calls.map(({ length }) => length), [25, 12, 13]);
      assert.equal(result.conclusion, "SPLIT_RESOLVED");
      assert.deepEqual(result.singletonTimeouts, []);
      assert.equal(result.tree[0]?.outcome, "HTTP_TIMEOUT");
      assert.equal(result.tree[0]?.splitReason, "HTTP_TIMEOUT");
      assert.deepEqual(
        result.tree[0]?.children?.map(({ outcome }) => outcome),
        ["SUCCESS", "SUCCESS"],
      );
    });
  }

  it("builds the exact nested 25 → 12 + 13 → 6 + 7 tree", async () => {
    const calls: string[][] = [];
    const result = await investigateRecentBatch(
      scriptedClient((values) => {
        if (values.length === 25 || values.length === 13) {
          throw new GitHubHttpError(504, "", undefined, 3);
        }
        return successfulResponse(values);
      }, calls),
      incident(),
      INVESTIGATION_TIMESTAMP,
    );

    assert.deepEqual(calls.map(({ length }) => length), [25, 12, 13, 6, 7]);
    assert.equal(result.conclusion, "SPLIT_RESOLVED");
    assert.deepEqual(
      result.tree[0]?.children?.[1]?.children?.map(({ batchSize }) => batchSize),
      [6, 7],
    );
  });

  it("records a repeated singleton timeout without making a causal claim", async () => {
    const calls: string[][] = [];
    const source = incident([
      "timeout-user",
      "ok-a",
      "ok-b",
      "ok-c",
    ]);
    const result = await investigateRecentBatch(
      scriptedClient((values) => {
        if (values.includes("timeout-user")) {
          throw new GitHubHttpError(504, "", undefined, 3);
        }
        return successfulResponse(values);
      }, calls),
      source,
      INVESTIGATION_TIMESTAMP,
    );

    assert.deepEqual(calls.map(({ length }) => length), [4, 2, 1, 1, 2]);
    assert.equal(result.conclusion, "SINGLETON_TIMEOUTS");
    assert.deepEqual(result.singletonTimeouts, ["timeout-user"]);
    const output = formatRecentBatchInvestigation(result, "result.json");
    assert.match(output, /Repeated singleton timeout observed/);
    assert.match(output, /does not prove that an account caused/);
    assert.doesNotMatch(output, /private profile/i);
  });

  it("preserves multiple singleton timeouts from different branches", async () => {
    const calls: string[][] = [];
    const source = incident([
      "timeout-a",
      "ok-a",
      "timeout-b",
      "ok-b",
    ]);
    const result = await investigateRecentBatch(
      scriptedClient((values) => {
        if (values.some((login) => login.startsWith("timeout-"))) {
          throw new GitHubHttpError(502, "", undefined, 3);
        }
        return successfulResponse(values);
      }, calls),
      source,
      INVESTIGATION_TIMESTAMP,
    );

    assert.deepEqual(calls.map(({ length }) => length), [4, 2, 1, 1, 2, 1, 1]);
    assert.deepEqual(result.singletonTimeouts, ["timeout-a", "timeout-b"]);
    assert.equal(result.conclusion, "SINGLETON_TIMEOUTS");
  });

  it("does not split an exhausted HTTP 503 and stops inconclusive", async () => {
    const calls: string[][] = [];
    const result = await investigateRecentBatch(
      scriptedClient(() => {
        throw new GitHubHttpError(503, "Service Unavailable", undefined, 3);
      }, calls),
      incident(),
      INVESTIGATION_TIMESTAMP,
    );

    assert.equal(calls.length, 1);
    assert.equal(result.conclusion, "INCONCLUSIVE");
    assert.equal(result.tree[0]?.outcome, "SERVICE_UNAVAILABLE");
    assert.equal(result.tree[0]?.children, undefined);
    assert.deepEqual(result.singletonTimeouts, []);
  });

  it("does not split authentication failures", async () => {
    const calls: string[][] = [];
    const result = await investigateRecentBatch(
      scriptedClient(() => {
        throw new GitHubAuthenticationError();
      }, calls),
      incident(),
      INVESTIGATION_TIMESTAMP,
    );

    assert.equal(calls.length, 1);
    assert.equal(result.conclusion, "INCONCLUSIVE");
    assert.equal(result.tree[0]?.outcome, "FATAL");
    assert.equal(result.tree[0]?.error?.name, "GitHubAuthenticationError");
  });

  for (const status of [403, 429]) {
    it(`does not split HTTP ${status} rate limits`, async () => {
      const calls: string[][] = [];
      const result = await investigateRecentBatch(
        scriptedClient(() => {
          throw new GitHubRateLimitError({}, status);
        }, calls),
        incident(),
        INVESTIGATION_TIMESTAMP,
      );

      assert.equal(calls.length, 1);
      assert.equal(result.conclusion, "INCONCLUSIVE");
      assert.equal(result.tree[0]?.outcome, "FATAL");
      assert.equal(result.tree[0]?.error?.name, "GitHubRateLimitError");
    });
  }

  it("uses RESOURCE_LIMIT splitting with a distinct reason", async () => {
    const calls: string[][] = [];
    const result = await investigateRecentBatch(
      scriptedClient((values) =>
        values.length === 25
          ? resourceLimitResponse(values)
          : successfulResponse(values),
      calls),
      incident(),
      INVESTIGATION_TIMESTAMP,
    );

    assert.deepEqual(calls.map(({ length }) => length), [25, 12, 13]);
    assert.equal(result.tree[0]?.outcome, "RESOURCE_LIMIT");
    assert.equal(result.tree[0]?.splitReason, "RESOURCE_LIMIT");
    assert.deepEqual(
      result.tree[0]?.children?.map(({ outcome }) => outcome),
      ["SUCCESS", "SUCCESS"],
    );
    assert.equal(result.conclusion, "INCONCLUSIVE");
    assert.deepEqual(result.singletonTimeouts, []);
  });

  it("does not treat exhausted transport errors as HTTP timeouts", async () => {
    const calls: string[][] = [];
    const transportCause = new Error("socket closed") as Error & {
      code: string;
    };
    transportCause.code = "ECONNRESET";
    const result = await investigateRecentBatch(
      scriptedClient(() => {
        throw new GitHubNetworkError(
          "Could not reach the GitHub GraphQL endpoint after 3 attempts.",
          {
            cause: new TransientTransportRetryExhaustedError(3, {
              cause: transportCause,
            }),
          },
        );
      }, calls),
      incident(),
      INVESTIGATION_TIMESTAMP,
    );

    assert.equal(calls.length, 1);
    assert.equal(result.conclusion, "INCONCLUSIVE");
    assert.equal(result.tree[0]?.outcome, "FATAL");
    assert.equal(result.tree[0]?.error?.name, "GitHubNetworkError");
  });

  it("does not split unrelated GraphQL fatal errors", async () => {
    const calls: string[][] = [];
    const result = await investigateRecentBatch(
      scriptedClient(() => {
        throw new GitHubGraphQLFatalError("Schema response was invalid.");
      }, calls),
      incident(),
      INVESTIGATION_TIMESTAMP,
    );

    assert.equal(calls.length, 1);
    assert.equal(result.conclusion, "INCONCLUSIVE");
    assert.equal(result.tree[0]?.outcome, "FATAL");
    assert.equal(result.tree[0]?.error?.name, "GitHubGraphQLFatalError");
  });

  it("relies on central retries and does not split a recovered 504", async () => {
    let requests = 0;
    const delays: number[] = [];
    const bodies: string[] = [];
    const fetchMock = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests += 1;
      const body = String(init?.body);
      bodies.push(body);
      return requests === 1
        ? new Response("", { status: 504 })
        : new Response(JSON.stringify(successfulGraphQLPayload(body)), {
            status: 200,
          });
    }) as typeof fetch;
    const source = incident(["retry-a", "retry-b"]);

    const result = await investigateRecentBatch(
      new GitHubGraphQLClient({
        token: "test-token",
        fetch: fetchMock,
        sleep: async (delay) => void delays.push(delay),
      }),
      source,
      INVESTIGATION_TIMESTAMP,
    );

    assert.equal(requests, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(delays, [1_000]);
    assert.equal(result.conclusion, "NOT_REPRODUCED");
    assert.equal(result.tree[0]?.outcome, "SUCCESS");
    assert.equal(result.tree[0]?.children, undefined);
  });
});

describe("recent batch investigation persistence", () => {
  it("creates unique Windows-safe files without secrets or overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "ghost-following-investigation-"));
    const result = await investigateRecentBatch(
      scriptedClient((values) => successfulResponse(values), []),
      incident(["safe-user"]),
      INVESTIGATION_TIMESTAMP,
    );
    try {
      const firstPath = await writeRecentBatchInvestigation(result, { root });
      const firstContents = await readFile(firstPath, "utf8");
      const secondPath = await writeRecentBatchInvestigation(result, { root });

      assert.notEqual(firstPath, secondPath);
      assert.match(firstPath, /AuditUser-2026-08-25T02-00-00-000Z\.json$/);
      assert.match(secondPath, /AuditUser-2026-08-25T02-00-00-000Z-1\.json$/);
      assert.equal(await readFile(firstPath, "utf8"), firstContents);
      const saved = JSON.parse(firstContents) as RecentBatchInvestigation;
      assert.equal(saved.schemaVersion, 1);
      assert.equal(saved.conclusion, "NOT_REPRODUCED");
      assert.equal(saved.sourceHttpStatus, 504);
      assert.equal(saved.sourceAttempts, 3);
      assert.deepEqual(saved.originalLogins, ["safe-user"]);
      assert.doesNotMatch(firstContents, /test-token/i);
      assert.doesNotMatch(firstContents, /authorization/i);
      assert.doesNotMatch(firstContents, /contributionsCollection/i);
      assert.doesNotMatch(firstContents, /query BatchAccountActivity/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
