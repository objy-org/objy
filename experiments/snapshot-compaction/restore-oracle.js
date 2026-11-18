import assert from "node:assert/strict";
import { CRDTNode } from "../../src/crdt.js";
import { PersistenceManager } from "../../src/persistence.js";
import { MemoryObjectStorage } from "../../src/object-storage.js";

// Independent acceptance oracle. This currently exposes a pre-existing baseline
// failure; keep it outside the passing experiment tests rather than blessing it.
const storage = new MemoryObjectStorage();
const node = new CRDTNode({ id: "receiver" });
const restored = new CRDTNode({ id: "restored" });
const persistence = new PersistenceManager({ node, storage, flushMs: 0, snapshotMs: 0 });
try {
  persistence.start();
  node.insertManyCount("app", "items", Array.from({ length: 10 }, (_, i) => ({ _id: String(i), value: i })));
  await persistence.checkpoint();
  node.applyRemote("origin", [{
    kind: "putObj", db: "app", coll: "items", id: "0", value: { value: 999 },
    ts: { c: 50, n: "origin" }, from: "origin", seq: 1, shard: "default",
  }], node._cursorKey("origin", { database: "app", collection: "items", shard: "default" }));
  await persistence.flush();
  const stats = await new PersistenceManager({ node: restored, storage }).restore();
  console.log(JSON.stringify({ expected: node.get("app", "items", "0"), actual: restored.get("app", "items", "0"), stats }, null, 2));
  assert.deepEqual(restored.get("app", "items", "0"), node.get("app", "items", "0"), "remote journal tail must survive restore");
} finally {
  await persistence.stop();
  node.db.dispose();
  restored.db.dispose();
}
