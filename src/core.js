import { createDatabaseWithRuntime } from "./database.js";
import { nodeCompression, readHeapUsageRatio } from "./node-runtime.js";

const nodeRuntime = Object.freeze({ compression: nodeCompression, readHeapUsageRatio });

export function createDatabase(options = {}) {
  return createDatabaseWithRuntime(options, nodeRuntime);
}
