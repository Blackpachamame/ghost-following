import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findLatestContributionDay,
  formatDiagnosticReport,
  runDiagnostic,
  sanitizeDiagnosticText,
} from "./graphql-diagnostic.js";

describe("findLatestContributionDay", () => {
  it("returns the latest day with a positive contribution count", () => {
    assert.equal(
      findLatestContributionDay({
        weeks: [
          {
            contributionDays: [
              { date: "2025-06-27", contributionCount: 2 },
              { date: "2025-06-29", contributionCount: 0 },
            ],
          },
          {
            contributionDays: [
              { date: "2025-06-28", contributionCount: 1 },
            ],
          },
        ],
      }),
      "2025-06-28",
    );
  });

  it("returns null when every contribution count is zero", () => {
    assert.equal(
      findLatestContributionDay({
        weeks: [
          {
            contributionDays: [
              { date: "2025-06-28", contributionCount: 0 },
            ],
          },
        ],
      }),
      null,
    );
  });
});

it("sanitizes multiline profile text", () => {
  assert.equal(sanitizeDiagnosticText("first\nsecond\tthird"), "first second third");
});

it("requires GITHUB_TOKEN before making a diagnostic request", async () => {
  const previousToken = process.env.GITHUB_TOKEN;
  const errors: string[] = [];
  let fetchCalled = false;
  delete process.env.GITHUB_TOKEN;

  try {
    const exitCode = await runDiagnostic({
      fetch: (async () => {
        fetchCalled = true;
        return new Response("{}");
      }) as typeof fetch,
      io: {
        log() {},
        error(message) {
          errors.push(message);
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(fetchCalled, false);
    assert.deepEqual(errors, [
      "GITHUB_TOKEN is required for this diagnostic command.",
    ]);
  } finally {
    if (previousToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousToken;
    }
  }
});

it("formats a compact report without dumping contribution days", () => {
  const payload = {
    data: {
      aylxxn: {
        login: "aylxxn",
        userViewType: "PUBLIC",
        name: null,
        bio: "line one\nline two",
        url: "https://github.com/aylxxn",
        contributionsCollection: {
          startedAt: "2025-08-22T00:00:00Z",
          endedAt: "2026-08-22T00:00:00Z",
          hasAnyContributions: false,
          hasAnyRestrictedContributions: false,
          restrictedContributionsCount: 0,
          hasActivityInThePast: false,
          contributionYears: [],
          contributionCalendar: { totalContributions: 0 },
        },
      },
      undrbug: {
        login: "undrbug",
        userViewType: "PUBLIC",
        contributionsCollection: {
          startedAt: "2025-08-22T00:00:00Z",
          endedAt: "2026-08-22T00:00:00Z",
          hasAnyContributions: false,
          hasAnyRestrictedContributions: false,
          restrictedContributionsCount: 0,
          hasActivityInThePast: true,
          contributionYears: [2025],
          contributionCalendar: { totalContributions: 0, weeks: [] },
          mostRecentCollectionWithActivity: {
            startedAt: "2024-06-29T00:00:00Z",
            endedAt: "2025-06-29T00:00:00Z",
            hasAnyContributions: true,
            hasAnyRestrictedContributions: false,
            restrictedContributionsCount: 0,
            latestRestrictedContributionDate: null,
            contributionCalendar: {
              totalContributions: 1,
              weeks: [
                {
                  contributionDays: [
                    { date: "2025-06-28", contributionCount: 1 },
                  ],
                },
              ],
            },
          },
        },
      },
      rateLimit: {
        cost: 1,
        remaining: 4999,
        limit: 5000,
        resetAt: "2026-08-22T01:00:00Z",
      },
    },
  };

  const output = formatDiagnosticReport(payload);

  assert.match(output, /bio: "line one line two"/);
  assert.match(output, /latestContributionDay: "2025-06-28"/);
  assert.doesNotMatch(output, /contributionDays/);
});
