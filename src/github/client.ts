import {
  GitHubHttpError,
  GitHubNetworkError,
  GitHubRateLimitError,
  GitHubUnexpectedResponseError,
  GitHubUserNotFoundError,
  type RateLimitDetails,
} from "./errors.js";
import {
  requestWithTransientRetry,
  TransientTransportRetryExhaustedError,
  type Sleep,
} from "./retry.js";

export interface RateLimitSnapshot extends RateLimitDetails {
  limit?: number;
  remaining?: number;
}

export interface GitHubPage {
  data: unknown[];
  nextUrl?: string;
  rateLimit: RateLimitSnapshot;
}

export interface GitHubClientOptions {
  token?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: Sleep;
}

function parseIntegerHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function readRateLimit(headers: Headers): RateLimitSnapshot {
  const limit = parseIntegerHeader(headers.get("x-ratelimit-limit"));
  const remaining = parseIntegerHeader(headers.get("x-ratelimit-remaining"));
  const resetSeconds = parseIntegerHeader(headers.get("x-ratelimit-reset"));
  const retryAfterSeconds = parseIntegerHeader(headers.get("retry-after"));
  const result: RateLimitSnapshot = {};

  if (limit !== undefined) result.limit = limit;
  if (remaining !== undefined) result.remaining = remaining;
  if (resetSeconds !== undefined) {
    const resetAt = new Date(resetSeconds * 1_000);
    if (!Number.isNaN(resetAt.getTime())) result.resetAt = resetAt;
  }
  if (retryAfterSeconds !== undefined) result.retryAfterSeconds = retryAfterSeconds;

  return result;
}

export function findNextPage(linkHeader: string | null): string | undefined {
  if (linkHeader === null) {
    return undefined;
  }

  for (const part of linkHeader.split(",")) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/);
    if (match?.[2]?.split(/\s+/).includes("next")) {
      return match[1];
    }
  }

  return undefined;
}

export async function readApiMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message;
    }
  } catch {
    // An error response is still represented by its HTTP status if the body is not JSON.
  }

  return undefined;
}

export class GitHubClient {
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: Sleep | undefined;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep;
  }

  async getPage(url: string, username: string): Promise<GitHubPage> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "github-ghost-following",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    if (this.#token) {
      headers.Authorization = `Bearer ${this.#token}`;
    }

    let response: Response;
    let attempts: number;
    try {
      const retried = await requestWithTransientRetry(
        () => this.#fetch(url, { headers }),
        this.#sleep === undefined ? {} : { sleep: this.#sleep },
      );
      response = retried.response;
      attempts = retried.attempts;
    } catch (error) {
      const exhausted =
        error instanceof TransientTransportRetryExhaustedError
          ? ` after ${error.attempts} attempts`
          : "";
      throw new GitHubNetworkError(
        `Could not reach GitHub while retrieving the following list for ${JSON.stringify(username)}${exhausted}.`,
        { cause: error },
      );
    }

    const rateLimit = readRateLimit(response.headers);

    if (response.status === 404) {
      throw new GitHubUserNotFoundError(username);
    }

    if (response.status === 403 || response.status === 429) {
      const apiMessage = await readApiMessage(response);
      throw new GitHubRateLimitError(
        rateLimit,
        response.status,
        apiMessage === undefined ? [] : [apiMessage],
      );
    }

    if (!response.ok) {
      throw new GitHubHttpError(
        response.status,
        response.statusText,
        await readApiMessage(response),
        attempts,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new GitHubUnexpectedResponseError("the body is not valid JSON.", {
        cause: error,
      });
    }

    if (!Array.isArray(data)) {
      throw new GitHubUnexpectedResponseError("expected an array of accounts.");
    }

    const nextUrl = findNextPage(response.headers.get("link"));
    return nextUrl === undefined
      ? { data, rateLimit }
      : { data, nextUrl, rateLimit };
  }
}
