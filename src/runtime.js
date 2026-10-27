const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function randomUUID() {
  const crypto = webCrypto();
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomBase64Url(size) {
  const bytes = randomBytes(size);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const left = bytes[index];
    const middle = bytes[index + 1];
    const right = bytes[index + 2];
    out += BASE64URL[left >> 2];
    out += BASE64URL[((left & 3) << 4) | ((middle ?? 0) >> 4)];
    if (middle !== undefined) out += BASE64URL[((middle & 15) << 2) | ((right ?? 0) >> 6)];
    if (right !== undefined) out += BASE64URL[right & 63];
  }
  return out;
}

export function yieldToEventLoop() {
  return new Promise((resolve) => {
    if (typeof globalThis.setImmediate === "function") globalThis.setImmediate(resolve);
    else globalThis.setTimeout(resolve, 0);
  });
}

function randomBytes(size) {
  const length = Number(size);
  if (!Number.isInteger(length) || length <= 0) throw new TypeError("random byte count must be a positive integer");
  const bytes = new Uint8Array(length);
  webCrypto().getRandomValues(bytes);
  return bytes;
}

function webCrypto() {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto;
  throw new Error("Web Crypto is required");
}
