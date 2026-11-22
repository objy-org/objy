import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const { hashPassword, hmacSha256, parsePasswordHash, passwordNeedsUpgrade, verifyPassword } = createRequire(import.meta.url)("../src/lib/crypto.cjs");

test("built-in crypto preserves existing password hashes", async () => {
  const stored = "pbkdf2$sha256$10000$00112233445566778899aabbccddeeff$12692e36cf3996532fc79e05b0a662c0a2e7e257ef8d8eeeb30c31bb30a29747";

  assert.equal(await hashPassword("correct horse battery staple", {
    iterations: 10_000,
    salt: "00112233445566778899aabbccddeeff",
  }), stored);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
  assert.equal(passwordNeedsUpgrade(stored), true);
});

test("passwords use stronger parameters and independent random salts", async () => {
  const [a, b] = await Promise.all([hashPassword("secret"), hashPassword("secret")]);
  assert.notEqual(a, b);
  for (const hash of [a, b]) {
    const parsed = parsePasswordHash(hash);
    assert.equal(parsed.iterations, 600_000);
    assert.equal(parsed.salt.length, 32);
    assert.equal(parsed.hash.length, 64);
    assert.equal(passwordNeedsUpgrade(hash), false);
    assert.equal(await verifyPassword("secret", hash), true);
    assert.equal(await verifyPassword("wrong", hash), false);
  }
});

test("invalid or excessive hash parameters are rejected before deriving", async () => {
  const valid = "pbkdf2$sha256$10000$00112233445566778899aabbccddeeff$12692e36cf3996532fc79e05b0a662c0a2e7e257ef8d8eeeb30c31bb30a29747";
  for (const value of [null, "", valid.replace("10000", "0"), valid.replace("10000", "1000001"),
    valid.replace("10000", "99999999999999"), valid.replace("sha256", "sha1"), valid.slice(0, -2),
    valid.replace("00112233445566778899aabbccddeeff", "aa"), valid + "$extra", "a".repeat(10000)]) {
    assert.equal(parsePasswordHash(value), null);
    assert.equal(await verifyPassword("secret", value), false);
  }
  await assert.rejects(hashPassword("secret", { iterations: 1_000_001 }), /parameters/);
  await assert.rejects(hashPassword("secret", { salt: "zz".repeat(16) }), /parameters/);
  await assert.rejects(hashPassword("x".repeat(1025)), (error) => error.status === 400);
  await assert.rejects(hashPassword("\u00e9".repeat(513)), /UTF-8 bytes/);
  assert.equal(await verifyPassword("x".repeat(1025), valid), false);
});

test("password derivation leaves the event loop available", async () => {
  let finished = false;
  const hashing = hashPassword("secret").then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  await hashing;
});

test("password work has a bounded queue that recovers after overload", async () => {
  const results = await Promise.allSettled(Array.from({ length: 35 }, () => hashPassword("secret")));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 34);
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 503);
  assert.equal(rejected[0].reason.headers["retry-after"], "1");
  assert.ok(parsePasswordHash(await hashPassword("after overload")));
});

test("built-in crypto preserves JWT HMAC output", () => {
  assert.equal(
    Buffer.from(hmacSha256("jwt-secret", "header.payload")).toString("hex"),
    "e55ccf57a0aa28fea3b084299990b57c424bc1e2c35b8bd9d3eb1ad5a37d6550",
  );
});
