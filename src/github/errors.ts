export interface RateLimitDetails {
  limit?: number;
  remaining?: number;
  resetAt?: Date;
  retryAfterSeconds?: number;
}

export type RateLimitKind = "PRIMARY" | "SECONDARY" | "UNKNOWN";

export function isExplicitSecondaryRateLimitMessage(message: string): boolean {
  return /secondary[\s-]+rate.?limit|abuse[\s-]+detection/i.test(message);
}

export function isRateLimitLikeMessage(message: string): boolean {
  return /rate.?limit/i.test(message) || isExplicitSecondaryRateLimitMessage(message);
}

export function classifyRateLimit(
  details: RateLimitDetails,
  safeMessages: readonly string[] = [],
): RateLimitKind {
  if (details.remaining === 0) return "PRIMARY";
  if (safeMessages.some(isExplicitSecondaryRateLimitMessage)) return "SECONDARY";
  return "UNKNOWN";
}

export class GitHubError extends Error {
  override readonly name: string = "GitHubError";
}

export class GitHubNetworkError extends GitHubError {
  override readonly name = "GitHubNetworkError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class GitHubUserNotFoundError extends GitHubError {
  override readonly name = "GitHubUserNotFoundError";

  constructor(readonly username: string) {
    super(`GitHub user ${JSON.stringify(username)} was not found.`);
  }
}

export class GitHubRateLimitError extends GitHubError {
  override readonly name = "GitHubRateLimitError";

  readonly kind: RateLimitKind;

  constructor(
    readonly details: RateLimitDetails,
    readonly status: number,
    safeMessages: readonly string[] = [],
  ) {
    super("GitHub API rate limit reached or the request was temporarily restricted.");
    this.kind = classifyRateLimit(details, safeMessages);
  }

  get remaining(): number | undefined {
    return this.details.remaining;
  }

  get limit(): number | undefined {
    return this.details.limit;
  }

  get resetAt(): Date | undefined {
    return this.details.resetAt;
  }

  get retryAfterSeconds(): number | undefined {
    return this.details.retryAfterSeconds;
  }
}

export class GitHubHttpError extends GitHubError {
  override readonly name = "GitHubHttpError";

  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly apiMessage?: string,
    readonly attempts = 1,
  ) {
    super(
      `GitHub API request failed with HTTP ${status}${
        statusText ? ` ${statusText}` : ""
      }${apiMessage ? `: ${apiMessage}` : ""}${
        attempts > 1 ? ` after ${attempts} attempts` : ""
      }.`,
    );
  }
}

export class GitHubUnexpectedResponseError extends GitHubError {
  override readonly name = "GitHubUnexpectedResponseError";

  constructor(message: string, options?: ErrorOptions) {
    super(`GitHub returned an unexpected response: ${message}`, options);
  }
}

export class GitHubAuthenticationError extends GitHubError {
  override readonly name = "GitHubAuthenticationError";

  constructor(message = "GITHUB_TOKEN is invalid or is not authorized for this request.") {
    super(message);
  }
}

export class GitHubGraphQLAccountError extends GitHubError {
  override readonly name = "GitHubGraphQLAccountError";

  constructor(
    message: string,
    readonly rateLimit?: RateLimitDetails & { cost?: number },
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class GitHubGraphQLFatalError extends GitHubError {
  override readonly name = "GitHubGraphQLFatalError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type GitHubGraphQLResponseBodyErrorCategory =
  | "INVALID_JSON"
  | "BODY_READ_FAILED";

export class GitHubGraphQLResponseBodyError extends GitHubError {
  override readonly name = "GitHubGraphQLResponseBodyError";

  constructor(
    readonly category: GitHubGraphQLResponseBodyErrorCategory,
    readonly status: number,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    const attemptsSuffix =
      attempts > 1 ? ` after ${attempts} attempts` : "";
    super(
      category === "INVALID_JSON"
        ? `GitHub GraphQL returned a body that is not valid JSON${attemptsSuffix}.`
        : `GitHub GraphQL response body could not be read${attemptsSuffix}.`,
      options,
    );
  }
}
