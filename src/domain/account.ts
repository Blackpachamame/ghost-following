export interface FollowedAccount {
  login: string;
  id: number;
  type: string;
  htmlUrl: string;
}

interface GitHubAccountShape {
  login: unknown;
  id: unknown;
  type: unknown;
  html_url: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAccount(value: unknown): FollowedAccount {
  if (!isRecord(value)) {
    throw new TypeError("Expected a GitHub account object.");
  }

  const account = value as unknown as GitHubAccountShape;

  if (typeof account.login !== "string" || account.login.length === 0) {
    throw new TypeError("GitHub account has an invalid login.");
  }

  if (!Number.isSafeInteger(account.id) || (account.id as number) <= 0) {
    throw new TypeError("GitHub account has an invalid id.");
  }

  if (typeof account.type !== "string" || account.type.length === 0) {
    throw new TypeError("GitHub account has an invalid type.");
  }

  if (typeof account.html_url !== "string" || account.html_url.length === 0) {
    throw new TypeError("GitHub account has an invalid profile URL.");
  }

  return {
    login: account.login,
    id: account.id as number,
    type: account.type,
    htmlUrl: account.html_url,
  };
}

export function groupAccountsByType(
  accounts: readonly FollowedAccount[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const account of accounts) {
    counts.set(account.type, (counts.get(account.type) ?? 0) + 1);
  }

  return counts;
}

