import { randomBytes } from "node:crypto";

const DEFAULT_BYTES = 12;

export function createObjectId(bytes = DEFAULT_BYTES) {
  return randomBytes(bytes).toString("base64url");
}
