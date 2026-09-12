export function summarizeCompression(entries = []) {
  const collectionCount = entries.reduce((sum, entry) => {
    const count = Number(entry.collectionCount);
    return sum + (Number.isFinite(count) ? count : 1);
  }, 0);
  const liveObjects = sum(entries, "liveObjects");
  const compressedObjects = sum(entries, "compressedObjects");
  const uncompressedBytes = sum(entries, "uncompressedBytes");
  const compressedBytes = sum(entries, "compressedBytes");
  const savedBytes = uncompressedBytes - compressedBytes;
  return {
    collectionCount,
    liveObjects,
    compressedObjects,
    coveragePercent: percentOf(compressedObjects, liveObjects),
    uncompressedBytes,
    compressedBytes,
    savedBytes,
    savedPercent: percentOf(savedBytes, uncompressedBytes),
  };
}

export function percentOf(value, total) {
  const numerator = Number(value);
  const denominator = Number(total);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function sum(entries, field) {
  return entries.reduce((total, entry) => total + (Number(entry[field]) || 0), 0);
}
