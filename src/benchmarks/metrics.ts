export interface GraphQLErrorDetail {
  message: string;
  path: string | null;
  scope: "global" | "partial";
}

export interface AggregatedGraphQLError {
  message: string;
  count: number;
  scopes: Array<"global" | "partial">;
  examplePaths: string[];
}

export interface BenchmarkRequestObservation {
  durationMs: number;
  responseBytes: number;
  graphqlCost?: number;
  remaining?: number;
  successfulUsers: number;
  failedUsers: number;
  graphqlErrors: number;
  globalGraphqlErrors: number;
  partialGraphqlErrors: number;
  nullUsers: number;
  httpErrors: number;
  graphqlErrorDetails?: readonly GraphQLErrorDetail[];
}

export interface StrategyMetrics {
  strategy: string;
  batchSize: number;
  sampleSize: number;
  httpRequests: number;
  successfulUsers: number;
  failedUsers: number;
  durationMs: number;
  averageRequestMs: number;
  totalGraphqlCost: number;
  costPerUser: number;
  remainingBefore: number | null;
  remainingAfter: number | null;
  approxResponseBytes: number;
  graphqlErrors: number;
  globalGraphqlErrors: number;
  partialGraphqlErrors: number;
  nullUsers: number;
  httpErrors: number;
  graphqlErrorMessages: AggregatedGraphQLError[];
}

export interface BenchmarkSummary {
  bestRequestReduction: string | null;
  lowestCostPerUser: string | null;
  bestLatency: string | null;
  largestFullySuccessfulBatch: string | null;
  firstFailingBatch: string | null;
}

export function aggregateGraphqlErrors(
  details: readonly GraphQLErrorDetail[],
): AggregatedGraphQLError[] {
  const grouped = new Map<string, AggregatedGraphQLError>();
  for (const detail of details) {
    const current = grouped.get(detail.message) ?? {
      message: detail.message,
      count: 0,
      scopes: [],
      examplePaths: [],
    };
    current.count += 1;
    if (!current.scopes.includes(detail.scope)) current.scopes.push(detail.scope);
    if (
      detail.path !== null &&
      current.examplePaths.length < 5 &&
      !current.examplePaths.includes(detail.path)
    ) {
      current.examplePaths.push(detail.path);
    }
    grouped.set(detail.message, current);
  }
  return [...grouped.values()].sort(
    (left, right) => right.count - left.count || left.message.localeCompare(right.message),
  );
}

export function isFullySuccessfulStrategy(metrics: StrategyMetrics): boolean {
  return (
    metrics.successfulUsers === metrics.sampleSize &&
    metrics.failedUsers === 0 &&
    metrics.httpErrors === 0 &&
    metrics.graphqlErrors === 0
  );
}

export function summarizeStrategies(
  metrics: readonly StrategyMetrics[],
): BenchmarkSummary {
  const successful = metrics.filter(isFullySuccessfulStrategy);
  const successfulBatches = successful.filter(({ batchSize }) => batchSize > 1);
  const failingBatches = metrics.filter(
    (item) => item.batchSize > 1 && !isFullySuccessfulStrategy(item),
  );

  return {
    bestRequestReduction:
      [...successful].sort(
        (left, right) =>
          left.httpRequests - right.httpRequests ||
          right.batchSize - left.batchSize,
      )[0]?.strategy ?? null,
    lowestCostPerUser:
      [...successful].sort(
        (left, right) =>
          left.costPerUser - right.costPerUser ||
          left.durationMs - right.durationMs,
      )[0]?.strategy ?? null,
    bestLatency:
      [...successful].sort(
        (left, right) => left.durationMs - right.durationMs,
      )[0]?.strategy ?? null,
    largestFullySuccessfulBatch:
      [...successfulBatches].sort(
        (left, right) => right.batchSize - left.batchSize,
      )[0]?.strategy ?? null,
    firstFailingBatch:
      [...failingBatches].sort(
        (left, right) => left.batchSize - right.batchSize,
      )[0]?.strategy ?? null,
  };
}

function requireNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number.`);
  }
}

export function calculateStrategyMetrics(input: {
  strategy: string;
  batchSize: number;
  sampleSize: number;
  remainingBefore: number | null;
  observations: readonly BenchmarkRequestObservation[];
}): StrategyMetrics {
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize <= 0) {
    throw new RangeError("Batch size must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.sampleSize) || input.sampleSize < 0) {
    throw new RangeError("Sample size must be a non-negative integer.");
  }

  for (const observation of input.observations) {
    requireNonNegative(observation.durationMs, "durationMs");
    requireNonNegative(observation.responseBytes, "responseBytes");
  }

  const durationMs = input.observations.reduce(
    (total, observation) => total + observation.durationMs,
    0,
  );
  const totalGraphqlCost = input.observations.reduce(
    (total, observation) => total + (observation.graphqlCost ?? 0),
    0,
  );
  const remainingAfter = [...input.observations]
    .reverse()
    .find(({ remaining }) => remaining !== undefined)?.remaining;

  return {
    strategy: input.strategy,
    batchSize: input.batchSize,
    sampleSize: input.sampleSize,
    httpRequests: input.observations.length,
    successfulUsers: input.observations.reduce(
      (total, observation) => total + observation.successfulUsers,
      0,
    ),
    failedUsers: input.observations.reduce(
      (total, observation) => total + observation.failedUsers,
      0,
    ),
    durationMs,
    averageRequestMs:
      input.observations.length === 0
        ? 0
        : durationMs / input.observations.length,
    totalGraphqlCost,
    costPerUser:
      input.sampleSize === 0 ? 0 : totalGraphqlCost / input.sampleSize,
    remainingBefore: input.remainingBefore,
    remainingAfter: remainingAfter ?? input.remainingBefore,
    approxResponseBytes: input.observations.reduce(
      (total, observation) => total + observation.responseBytes,
      0,
    ),
    graphqlErrors: input.observations.reduce(
      (total, observation) => total + observation.graphqlErrors,
      0,
    ),
    globalGraphqlErrors: input.observations.reduce(
      (total, observation) => total + observation.globalGraphqlErrors,
      0,
    ),
    partialGraphqlErrors: input.observations.reduce(
      (total, observation) => total + observation.partialGraphqlErrors,
      0,
    ),
    nullUsers: input.observations.reduce(
      (total, observation) => total + observation.nullUsers,
      0,
    ),
    httpErrors: input.observations.reduce(
      (total, observation) => total + observation.httpErrors,
      0,
    ),
    graphqlErrorMessages: aggregateGraphqlErrors(
      input.observations.flatMap(
        ({ graphqlErrorDetails }) => graphqlErrorDetails ?? [],
      ),
    ),
  };
}
