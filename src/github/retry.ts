export const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);
export const TRANSIENT_MAX_ATTEMPTS = 3;
export const TRANSIENT_BACKOFF_MS = [1_000, 2_000] as const;
export const MAX_RETRY_AFTER_MS = 5_000;

export type Sleep = (delayMs: number) => Promise<void>;

export interface RetryOptions {
  sleep?: Sleep;
}

export interface ProcessedRetryOptions<T> extends RetryOptions {
  processResponse(response: Response): Promise<T>;
  isRetryableProcessError(error: unknown): boolean;
  createProcessRetryExhaustedError(
    error: unknown,
    attempts: number,
    response: Response,
  ): Error;
}

export interface RetriedResponse {
  response: Response;
  attempts: number;
}

export interface RetriedProcessedResponse<T> extends RetriedResponse {
  result: T;
}

export class TransientTransportRetryExhaustedError extends Error {
  override readonly name = "TransientTransportRetryExhaustedError";

  constructor(
    readonly attempts: number,
    options: ErrorOptions,
  ) {
    super(
      `Transient GitHub transport failure after ${attempts} attempts.`,
      options,
    );
  }
}

const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isRetryableTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    if (
      typeof current.code === "string" &&
      RETRYABLE_TRANSPORT_CODES.has(current.code)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function retryDelayMs(response: Response, failedAttempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isSafeInteger(seconds)) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  return TRANSIENT_BACKOFF_MS[failedAttempt - 1] ?? 0;
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function processesResponse<T>(
  options: RetryOptions | ProcessedRetryOptions<T>,
): options is ProcessedRetryOptions<T> {
  return "processResponse" in options;
}

export function requestWithTransientRetry(
  request: () => Promise<Response>,
  options?: RetryOptions,
): Promise<RetriedResponse>;
export function requestWithTransientRetry<T>(
  request: () => Promise<Response>,
  options: ProcessedRetryOptions<T>,
): Promise<RetriedProcessedResponse<T>>;
export async function requestWithTransientRetry<T>(
  request: () => Promise<Response>,
  options: RetryOptions | ProcessedRetryOptions<T> = {},
): Promise<RetriedResponse | RetriedProcessedResponse<T>> {
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await request();
    } catch (error) {
      if (!isRetryableTransportError(error)) throw error;
      if (attempt === TRANSIENT_MAX_ATTEMPTS) {
        throw new TransientTransportRetryExhaustedError(attempt, {
          cause: error,
        });
      }
      await sleep(TRANSIENT_BACKOFF_MS[attempt - 1] ?? 0);
      continue;
    }

    if (
      TRANSIENT_HTTP_STATUSES.has(response.status) &&
      attempt < TRANSIENT_MAX_ATTEMPTS
    ) {
      const delayMs = retryDelayMs(response, attempt);
      await discardResponse(response);
      await sleep(delayMs);
      continue;
    }

    if (!processesResponse(options)) {
      return { response, attempts: attempt };
    }

    try {
      const result = await options.processResponse(response);
      return { response, attempts: attempt, result };
    } catch (error) {
      if (!options.isRetryableProcessError(error)) throw error;
      if (attempt === TRANSIENT_MAX_ATTEMPTS) {
        throw options.createProcessRetryExhaustedError(
          error,
          attempt,
          response,
        );
      }
      await discardResponse(response);
      await sleep(TRANSIENT_BACKOFF_MS[attempt - 1] ?? 0);
    }
  }

  throw new Error("Transient retry loop ended unexpectedly.");
}
