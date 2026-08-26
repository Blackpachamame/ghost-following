import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HELP, parseArgs, parseUsername, UsageError } from "./args.js";

describe("parseArgs", () => {
  it("uses 365 days by default", () => {
    assert.deepEqual(parseArgs(["Blackpachamame"]), {
      help: false,
      username: "Blackpachamame",
      days: 365,
      resume: false,
    });
  });

  it("keeps historical lookup disabled unless explicitly requested", () => {
    const parsed = parseArgs(["Blackpachamame"]);
    assert.equal(parsed.help, false);
    if (!parsed.help) assert.equal(parsed.historyYears, undefined);
  });

  it("accepts every history year value from 1 through 5", () => {
    for (const historyYears of [1, 2, 3, 4, 5]) {
      const parsed = parseArgs([
        "octocat",
        "--history-years",
        String(historyYears),
      ]);
      assert.equal(parsed.help, false);
      if (!parsed.help) assert.equal(parsed.historyYears, historyYears);
    }
    assert.match(HELP, /--history-years <1-5>/);
    assert.match(HELP, /default: disabled/);
  });

  it("rejects every invalid history year value", () => {
    for (const value of ["0", "6", "-1", "1.5", "foo"]) {
      assert.throws(
        () => parseArgs(["octocat", "--history-years", value]),
        /Invalid value for --history-years/,
      );
    }
    assert.throws(
      () => parseArgs(["octocat", "--history-years"]),
      /Missing value for --history-years/,
    );
  });

  it("accepts a custom positive integer period", () => {
    assert.deepEqual(parseArgs(["octocat", "--days", "180"]), {
      help: false,
      username: "octocat",
      days: 180,
      resume: false,
    });
  });

  it("rejects every invalid --days value", () => {
    for (const value of ["0", "-1", "abc", "12.5", "NaN"]) {
      assert.throws(
        () => parseArgs(["octocat", "--days", value]),
        /Invalid value for --days: expected a positive integer/,
      );
    }
  });

  it("supports help without a username", () => {
    assert.deepEqual(parseArgs(["--help"]), { help: true });
    assert.deepEqual(parseArgs(["-h"]), { help: true });
    assert.match(HELP, /--json <path>/);
  });

  it("requires a username outside help mode", () => {
    assert.throws(() => parseArgs([]), /Expected a GitHub username/);
  });

  it("rejects unknown options", () => {
    assert.throws(
      () => parseArgs(["octocat", "--foo"]),
      /Unknown option: --foo/,
    );
  });

  it("requires paths for JSON and CSV", () => {
    assert.throws(
      () => parseArgs(["octocat", "--json"]),
      /Missing value for --json/,
    );
    assert.throws(
      () => parseArgs(["octocat", "--csv"]),
      /Missing value for --csv/,
    );
  });

  it("accepts JSON and CSV exports simultaneously", () => {
    assert.deepEqual(
      parseArgs([
        "octocat",
        "--days",
        "90",
        "--json",
        "reports/audit.json",
        "--csv",
        "reports/audit.csv",
      ]),
      {
        help: false,
        username: "octocat",
        days: 90,
        resume: false,
        jsonPath: "reports/audit.json",
        csvPath: "reports/audit.csv",
      },
    );
  });

  it("accepts --resume without exposing checkpoint internals", () => {
    assert.deepEqual(parseArgs(["octocat", "--resume", "--days", "180"]), {
      help: false,
      username: "octocat",
      days: 180,
      resume: true,
    });
    assert.match(HELP, /--resume/);
    assert.doesNotMatch(HELP, /batch-size|checkpoint-path|no-checkpoint/);
  });
});

describe("parseUsername compatibility", () => {
  it("accepts one valid GitHub username", () => {
    assert.equal(parseUsername(["name-123"]), "name-123");
  });

  it("rejects invalid GitHub username syntax", () => {
    for (const username of ["-name", "name-", "two--hyphens", "has space", ""]) {
      assert.throws(() => parseUsername([username]), UsageError);
    }
  });
});
