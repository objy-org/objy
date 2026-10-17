import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const { hashPassword, hmacSha256, verifyPassword } = createRequire(import.meta.url)("../src/lib/crypto.cjs");

test("built-in crypto preserves existing password hashes", () => {
  const stored = "pbkdf2$sha256$10000$00112233445566778899aabbccddeeff$12692e36cf3996532fc79e05b0a662c0a2e7e257ef8d8eeeb30c31bb30a29747";

  assert.equal(hashPassword("correct horse battery staple", {
    iterations: 10_000,
    salt: "00112233445566778899aabbccddeeff",
  }), stored);
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
});

test("built-in crypto preserves JWT HMAC output", () => {
  assert.equal(
    Buffer.from(hmacSha256("jwt-secret", "header.payload")).toString("hex"),
    "e55ccf57a0aa28fea3b084299990b57c424bc1e2c35b8bd9d3eb1ad5a37d6550",
  );
});
