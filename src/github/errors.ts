export interface RateLimitDetails {
  limit?: number;
  remaining?: number;
  resetAt?: Date;
  retryAfterSeconds?: number;
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

  constructor(
    readonly details: RateLimitDetails,
    readonly status: number,
  ) {
    super("GitHub API rate limit reached or the request was temporarily restricted.");
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
