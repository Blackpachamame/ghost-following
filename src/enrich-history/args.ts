import { UsageError } from "../args.js";
import { formatCliArgument } from "../utils/cli-presentation.js";

export const USAGE = "Usage: npm run enrich-history -- <input.json> --history-years <1-5> --json <output.json> [--csv <output.csv>] [--resume]";

export const HELP = [
  "github-ghost-following enrich-history",
  "",
  "Enrich an existing report with visible historical activity without repeating recent queries.",
  "",
  USAGE,
  "",
  "Options:",
  "  --history-years <1-5> Required historical lookback before the source recent period",
  "  --json <output.json> Required JSON output, different from the input",
  "  --csv <output.csv>   Optional CSV output",
  "  --resume             Resume a compatible history enrichment checkpoint",
  "  -h, --help           Show help",
  "",
  "Accepts schemaVersion 1 reports with history.years = 0 only.",
  "GITHUB_TOKEN is required only when historical accounts remain pending.",
].join("\n");

export interface EnrichHistoryOptions {
  help: false;
  inputPath: string;
  historyYears: number;
  jsonPath: string;
  csvPath?: string;
  resume: boolean;
}

export function parseEnrichHistoryArgs(
  args: readonly string[],
): EnrichHistoryOptions | { help: true } {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const inputPath = args[0];
  if (!inputPath || inputPath.startsWith("-")) {
    throw new UsageError("Expected an input JSON report path.");
  }
  let historyYears: number | undefined;
  let jsonPath: string | undefined;
  let csvPath: string | undefined;
  let resume = false;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index]!;
    if (!["--history-years", "--json", "--csv", "--resume"].includes(option)) {
      throw new UsageError(`Unknown option or unexpected argument: ${JSON.stringify(option)}.`);
    }
    if (seen.has(option)) throw new UsageError(`Duplicate option: ${option}.`);
    seen.add(option);
    if (option === "--resume") {
      resume = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("-")) throw new UsageError(`Missing value for ${option}.`);
    if (option === "--history-years") {
      if (!/^[1-5]$/.test(value)) {
        throw new UsageError("Invalid value for --history-years: expected an integer from 1 to 5.");
      }
      historyYears = Number(value);
    } else if (option === "--json") jsonPath = value;
    else csvPath = value;
  }
  if (historyYears === undefined) throw new UsageError("Missing required --history-years <1-5>.");
  if (jsonPath === undefined) throw new UsageError("Missing required --json <output.json>.");
  return { help: false, inputPath, historyYears, jsonPath, resume,
    ...(csvPath === undefined ? {} : { csvPath }) };
}

export function formatEnrichHistoryResumeCommand(
  options: Pick<EnrichHistoryOptions, "inputPath" | "historyYears" | "jsonPath" | "csvPath">,
): string {
  const args = [
    "npm run enrich-history --", formatCliArgument(options.inputPath),
    `--history-years ${options.historyYears}`, "--resume",
    `--json ${formatCliArgument(options.jsonPath)}`,
  ];
  if (options.csvPath !== undefined) args.push(`--csv ${formatCliArgument(options.csvPath)}`);
  return args.join(" ");
}

