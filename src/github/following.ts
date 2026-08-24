import { normalizeAccount, type FollowedAccount } from "../domain/account.js";
import { GitHubClient, type RateLimitSnapshot } from "./client.js";
import { GitHubUnexpectedResponseError } from "./errors.js";

const API_ROOT = "https://api.github.com";

export interface FollowingResult {
  accounts: FollowedAccount[];
  rateLimit: RateLimitSnapshot;
}

export async function getFollowing(
  client: GitHubClient,
  username: string,
): Promise<FollowingResult> {
  let nextUrl: string | undefined =
    `${API_ROOT}/users/${encodeURIComponent(username)}/following?per_page=100`;
  let lastRateLimit: RateLimitSnapshot = {};
  const visitedUrls = new Set<string>();
  const accounts: FollowedAccount[] = [];

  while (nextUrl !== undefined) {
    if (visitedUrls.has(nextUrl)) {
      throw new GitHubUnexpectedResponseError(
        "pagination contained a repeated next-page URL.",
      );
    }
    visitedUrls.add(nextUrl);

    const page = await client.getPage(nextUrl, username);
    lastRateLimit = page.rateLimit;

    for (const [index, value] of page.data.entries()) {
      try {
        accounts.push(normalizeAccount(value));
      } catch (error) {
        throw new GitHubUnexpectedResponseError(
          `account ${index + 1} on page ${visitedUrls.size} is invalid.`,
          { cause: error },
        );
      }
    }

    nextUrl = page.nextUrl;
  }

  return { accounts, rateLimit: lastRateLimit };
}

