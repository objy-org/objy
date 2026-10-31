import * as compression from "./compression.js";
import { createDatabaseWithRuntime } from "./database.js";

const browserRuntime = Object.freeze({ compression });

export function createDatabase(options = {}) {
  return createDatabaseWithRuntime(options, browserRuntime);
}
