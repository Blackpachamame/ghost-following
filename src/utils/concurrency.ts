export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("Concurrency must be a positive integer.");
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= values.length) {
        return;
      }

      const value = values[index];
      if (value === undefined) {
        stopped = true;
        throw new Error("Concurrency pool received an invalid work item.");
      }

      try {
        results[index] = await mapper(value, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

