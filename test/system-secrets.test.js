import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
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

test("replicas wait for the primary's object-storage secret set", async () => {
  const storage = new MemoryObjectStorage();
  const path = join(mkdtempSync(join(tmpdir(), "objydb-secrets-")), "candidate.json");
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => resolveSystemSecrets({
    storage,
    prefix: "cluster-a",
    localPath: path,
    primary: i === 7,
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

test("local node processes still share generated secrets without S3", { timeout: 15000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "objy-secrets-process-"));
  const config = join(directory, "config.json"), children = [];
  writeFileSync(config, JSON.stringify({ auth: { enabled: false }, persistence: { mode: "off", localWal: { dir: join(directory, "wal") } } }));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) { const closed = once(child, "exit"); child.kill("SIGTERM"); await closed; }
    rmSync(directory, { recursive: true, force: true });
  });
  const start = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/index.js", "--config", config, "--node", id, "--port", "0"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const port = output.match(/listening on http:\/\/localhost:(\d+)/)?.[1];
      if (port) resolve(Number(port));
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => { if (code) reject(new Error(output)); });
  });
  const ports = await Promise.all([start("a"), start("b")]);
  const { clusterSecret } = JSON.parse(readFileSync(join(directory, "system-secrets.json"), "utf8"));
  for (const port of ports) {
    const response = await fetch(`http://127.0.0.1:${port}/cluster/shards`, { headers: { "x-objydb-cluster-secret": clusterSecret }, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    await response.text();
  }
});
