import { randomBase64Url } from "./runtime.js";

const DEFAULT_BYTES = 12;

export function createObjectId(bytes = DEFAULT_BYTES) {
  return randomBase64Url(bytes);
}
