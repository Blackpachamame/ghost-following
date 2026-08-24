import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HELP, parseArgs, parseUsername, UsageError } from "./args.js";

describe("parseArgs", () => {
  it("uses 365 days by default", () => {
    assert.deepEqual(parseArgs(["Blackpachamame"]), {
      help: false,
      username: "Blackpachamame",
      days: 365,
    });
  });

  it("accepts a custom positive integer period", () => {
    assert.deepEqual(parseArgs(["octocat", "--days", "180"]), {
      help: false,
      username: "octocat",
      days: 180,
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
        jsonPath: "reports/audit.json",
        csvPath: "reports/audit.csv",
      },
    );
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
