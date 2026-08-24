export function chunkValues<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError("Chunk size must be a positive integer.");
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
