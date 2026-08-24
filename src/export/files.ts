import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditResult } from "../domain/audit.js";
import { serializeAuditCsv } from "./csv.js";
import { serializeAuditJson } from "./json.js";

export class ExportWriteError extends Error {
  override readonly name = "ExportWriteError";

  constructor(
    readonly format: "JSON" | "CSV",
    readonly path: string,
    options?: ErrorOptions,
  ) {
    const detail =
      options?.cause instanceof Error ? ` ${options.cause.message}` : "";
    super(
      `Failed to write ${format} export to ${JSON.stringify(path)}.${detail}`,
      options,
    );
  }
}

async function writeExport(
  format: "JSON" | "CSV",
  path: string,
  contents: string,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  } catch (error) {
    throw new ExportWriteError(format, path, { cause: error });
  }
}

export async function writeAuditExports(
  audit: AuditResult,
  paths: { jsonPath?: string; csvPath?: string },
): Promise<void> {
  if (paths.jsonPath !== undefined) {
    await writeExport("JSON", paths.jsonPath, serializeAuditJson(audit));
  }
  if (paths.csvPath !== undefined) {
    await writeExport("CSV", paths.csvPath, serializeAuditCsv(audit));
  }
}
