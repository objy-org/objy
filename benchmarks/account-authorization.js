import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const root = resolve(args.root || ".");
const moduleAt = (name) => import(pathToFileURL(resolve(root, "src", name)));
const { CRDTNode } = await moduleAt("crdt.js");
const { startServer } = await moduleAt("server.js");
const { nodeCompression } = await moduleAt("node-runtime.js");
const count = Number(args.objects || 10000), rounds = Number(args.rounds || 3);
const results = [];

for (const compressed of [false, true]) {
  for (const admin of [false, true]) {
    let decompressions = 0;
    const node = new CRDTNode({ id: "authorization-bench", operationLog: false,
      storage: { compression: { ...nodeCompression, decompress(value) {
        decompressions++;
        return nodeCompression.decompress(value);
      } } } });
    const meta = { indexes: ["group"], columns: ["score"], ...(compressed
      ? { tiering: { mode: "compressedMemory", keep: ["group"], minBytes: 1 } } : {}) };
    node.createCollection("bench", "items", meta);
    const payload = "Ordinary object data. ".repeat(512);
    const rows = Array.from({ length: count }, (_, i) => ({ _id: String(i), group: i % 4, score: i, payload }));
    node.insertManyCount("bench", "items", rows);
    await node.awaitIndexes("bench", "items");
    const state = await startServer({ node, auth: { jwtSecret: "benchmark-only" },
      environment: {}, bootstrapLogger: null, port: { host: "127.0.0.1", port: 0 } });
    const actor = { _id: "actor", username: "actor", admin,
      collectionPermissions: { read: ["items"], write: ["items"] } };
    const accessToken = state.auth.issueTokenPair("bench", "users", actor).accessToken;
    const milliseconds = [], decodeCounts = [];
    try {
      for (let round = -1; round < rounds; round++) {
        decompressions = 0;
        const start = performance.now();
        for (let i = 0; i < rows.length; i += 1000) {
          const response = await fetch(`http://127.0.0.1:${state.port}/api/bench/items/object`, {
            method: "PUT", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", prefer: "return=minimal" },
            body: JSON.stringify(rows.slice(i, i + 1000)),
          });
          assert.equal(response.status, 200);
          assert.equal((await response.json()).replaced, Math.min(1000, rows.length - i));
        }
        if (round >= 0) {
          milliseconds.push(Math.round(performance.now() - start));
          decodeCounts.push(decompressions);
        }
      }
      assert.equal(node.count("bench", "items"), count);
      global.gc?.();
      const memory = process.memoryUsage();
      results.push({ compressed, admin, objects: count, roundsMs: milliseconds, decompressions: decodeCounts,
        heapMiB: Math.round(memory.heapUsed / 1048576), rssMiB: Math.round(memory.rss / 1048576) });
    } finally {
      await state.replication.stop();
      state.server.closeAllConnections();
      await new Promise((resolve) => state.server.close(resolve));
      node.db.dispose();
      global.gc?.();
    }
  }
}
console.log(JSON.stringify({ root, results }, null, 2));
