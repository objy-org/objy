import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryObjectStorage } from "../src/object-storage.js";
import { resolveSystemSecrets } from "../src/system-secrets.js";

test("generated system secrets survive local restarts", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "objydb-secrets-")), "system-secrets.json");
  const first = await resolveSystemSecrets({ localPath: path });
  const second = await resolveSystemSecrets({ localPath: path });

  assert.deepEqual(second, first);
  assert.notEqual(first.jwtSecret, first.clusterSecret);
  assert.equal(first.jwtSecret.length, 43);
  assert.equal(first.clusterSecret.length, 43);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
});

test("concurrent peers converge on one object-storage secret set", async () => {
  const storage = new MemoryObjectStorage();
  const results = await Promise.all(Array.from({ length: 8 }, () => resolveSystemSecrets({
    storage,
    prefix: "cluster-a",
    localPath: "/unused",
  })));

  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await storage.list("cluster-a/system/")).length, 1);
});

test("explicit secrets require no persisted runtime state", async () => {
  const storage = new MemoryObjectStorage();
  const result = await resolveSystemSecrets({
    jwtSecret: "configured-jwt",
    clusterSecret: "configured-cluster",
    storage,
    prefix: "cluster-a",
  });

  assert.deepEqual(result, { jwtSecret: "configured-jwt", clusterSecret: "configured-cluster" });
  assert.deepEqual(await storage.list(), []);
});
