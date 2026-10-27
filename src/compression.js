import { strFromU8, strToU8, unzlibSync, zlibSync } from "fflate";

const FAST = Object.freeze({ level: 1 });

export function encodeUtf8(value) {
  return strToU8(String(value));
}

export function decodeUtf8(value) {
  return strFromU8(value);
}

export function compress(value) {
  return zlibSync(value, FAST);
}

export function decompress(value) {
  return unzlibSync(value);
}
