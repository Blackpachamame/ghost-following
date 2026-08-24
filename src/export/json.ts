import type { AuditResult } from "../domain/audit.js";

export function serializeAuditJson(audit: AuditResult): string {
  return `${JSON.stringify(audit, null, 2)}\n`;
}
