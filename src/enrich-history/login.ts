export function isExportedGitHubLogin(value: unknown): value is string {
  // REST logins are preserved data, not manually entered CLI usernames.
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}
