import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDTNode } from "../src/crdt.js";
import { ObjectRowStore } from "../src/object-store.js";

function objectNode() {
  return new CRDTNode({
    id: "object-node",
    storage: {
      engine: "object",
      object: {
        valueDirectory: {
          minRefs: 2,
          maxStringLength: 32,
          maxKeyBytes: 128,
        },
      },
    },
  });
}

test("object storage engine supports CRUD and queries through CRDTNode", () => {
  const n = objectNode();
  n.createCollection("db", "events", { indexes: ["status", "tenant"] });

  n.insertMany("db", "events", [
    { _id: "a", status: "open", tenant: "acme", payload: { score: 1 } },
    { _id: "b", status: "closed", tenant: "acme", payload: { score: 2 } },
    { _id: "c", status: "open", tenant: "globex", payload: { score: 3 } },
  ]);

  assert.deepEqual(n.get("db", "events", "a"), {
    _id: "a",
    status: "open",
    tenant: "acme",
    payload: { score: 1 },
  });
  assert.deepEqual(n.find("db", "events", { status: "open" }).map((item) => item._id).sort(), ["a", "c"]);

  n.update("db", "events", "a", { payload: { score: 10 } });
  assert.equal(n.get("db", "events", "a").payload.score, 10);

  n.replace("db", "events", "b", { status: "open", tenant: "initech" });
  assert.deepEqual(n.find("db", "events", { status: "open" }).map((item) => item._id).sort(), ["a", "b", "c"]);

  n.remove("db", "events", "c");
  assert.equal(n.get("db", "events", "c"), undefined);
  assert.equal(n.count("db", "events"), 2);

  const stats = n.stats("db", "events")[0];
  assert.equal(stats.engine, "object");
  assert.equal(stats.rows, 2);
  assert.ok(stats.valueDirectory.entries > 0);
});

test("object row store pools repeated small values and skips large unique strings", () => {
  const store = new ObjectRowStore({
    valueDirectory: {
      minRefs: 2,
      maxStringLength: 12,
      maxKeyBytes: 0,
    },
  });

  store.rebuild("a", [["status", "open"], ["blob", "x".repeat(100)]]);
  store.rebuild("b", [["status", "open"], ["blob", "y".repeat(100)]]);
  store.rebuild("c", [["status", "open"], ["blob", "z".repeat(100)]]);

  let stats = store.shapeStats()[0].valueDirectory;
  assert.equal(stats.entries, 1);
  assert.equal(stats.refs, 2);
  assert.equal(store.read("a").blob.length, 100);

  store.removeObject("b");
  stats = store.shapeStats()[0].valueDirectory;
  assert.equal(stats.entries, 1);
  assert.equal(stats.refs, 1);

  store.removeObject("c");
  stats = store.shapeStats()[0].valueDirectory;
  assert.equal(stats.entries, 0);
});

test("object row store promotes values only after runtime repeats on the same path", () => {
  const store = new ObjectRowStore({
    valueDirectory: {
      minRefs: 2,
      maxCandidates: 16,
      maxCandidatesPerPath: 2,
      maxStringLength: 32,
      maxKeyBytes: 128,
    },
  });

  store.rebuild("a", [["left", "same"], ["right", "same"]]);
  let stats = store.shapeStats()[0].valueDirectory;
  assert.equal(stats.entries, 0);
  assert.equal(stats.candidates, 2);
  assert.equal(stats.candidatePaths, 2);

  store.rebuild("b", [["left", "same"], ["right", "other"]]);
  stats = store.shapeStats()[0].valueDirectory;
  assert.equal(stats.entries, 1);
  assert.equal(stats.refs, 1);
});

test("object row store does not expose mutable internal objects", () => {
  const store = new ObjectRowStore();
  store.rebuild("a", [["nested", { score: 1 }]]);

  const first = store.read("a");
  first.nested.score = 99;

  assert.deepEqual(store.read("a"), { nested: { score: 1 } });
});
