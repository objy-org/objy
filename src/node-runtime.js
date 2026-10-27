import { getHeapStatistics } from "node:v8";
import { constants, deflateSync, inflateSync } from "node:zlib";

export const nodeCompression = Object.freeze({
  encodeUtf8(value) {
    return Buffer.from(String(value));
  },
  decodeUtf8(value) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  },
  compress(value) {
    const compressed = deflateSync(value, { level: constants.Z_BEST_SPEED });
    const compact = new Uint8Array(compressed.byteLength);
    compact.set(compressed);
    return compact;
  },
  decompress(value) {
    return inflateSync(value);
  },
});

export function readHeapUsageRatio() {
  const stats = getHeapStatistics();
  const limit = Number(stats.heap_size_limit) || 0;
  return limit > 0 ? (Number(stats.used_heap_size) || 0) / limit : 0;
}
