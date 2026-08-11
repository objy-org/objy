import { test } from "node:test";
import assert from "node:assert/strict";
import { ShapeStore, shapeId, layoutOf, typeOf } from "../src/shape.js";

test("shape id is deterministic and layout-sensitive", () => {
  const a = layoutOf([["name", "x"], ["age", 1], ["ok", true]]);
  const b = layoutOf([["age", 2], ["ok", false], ["name", "y"]]);
  const c = layoutOf([["name", "x"], ["score", 1]]);
  assert.equal(shapeId(a), shapeId(b));
  assert.notEqual(shapeId(a), shapeId(c));
});

test("valueKind classifies dynamic values for diagnostics only", () => {
  assert.equal(typeOf(1), "number");
  assert.equal(typeOf("s"), "string");
  assert.equal(typeOf(true), "boolean");
  assert.equal(typeOf(null), "null");
  assert.equal(typeOf(undefined), "undefined");
  assert.equal(typeOf({}), "object");
  assert.equal(typeOf([]), "array");
});

test("objects with the same layout share one shape", () => {
  const s = new ShapeStore();
  s.rebuild("a", [["x", 1], ["y", "s"]]);
  s.rebuild("b", [["y", "t"], ["x", 2]]);
  s.rebuild("c", [["x", 1], ["y", 3]]);
  assert.equal(s.shapes.size, 1);
});

test("read returns what was written", () => {
  const s = new ShapeStore();
  s.rebuild("a", [["n", 42], ["s", "hi"], ["b", true], ["z", null], ["o", { k: 1 }]]);
  assert.deepEqual(s.read("a"), { n: 42, s: "hi", b: true, z: null, o: { k: 1 } });
});

test("in-place write keeps the same shape", () => {
  const s = new ShapeStore();
  s.rebuild("a", [["n", 1]]);
  const before = s.shapeStats()[0];
  s.writeField("a", "n", 99, [["n", 99]]);
  assert.equal(s.shapeStats()[0].shapeId, before.shapeId);
  assert.equal(s.read("a").n, 99);
});

test("type change stays in the same shape", () => {
  const s = new ShapeStore();
  s.rebuild("a", [["n", 1], ["tag", "x"]]);
  const before = s.shapeStats()[0].shapeId;
  s.writeField("a", "tag", 5, [["n", 1], ["tag", 5]]);
  assert.deepEqual(s.read("a"), { n: 1, tag: 5 });
  const shapes = s.shapeStats();
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].shapeId, before);
  assert.deepEqual(shapes[0].fields, [
    { name: "n" },
    { name: "tag" },
  ]);
});

test("removed and freed rows are reused", () => {
  const s = new ShapeStore();
  s.rebuild("a", [["n", 1]]);
  s.rebuild("b", [["n", 2]]);
  s.removeObject("a");
  s.rebuild("c", [["n", 3]]);
  assert.equal(s.read("a"), undefined);
  assert.equal(s.read("b").n, 2);
  assert.equal(s.read("c").n, 3);
  assert.equal(s.shapeStats()[0].rows, 2);
});

test("strings grow and survive many writes", () => {
  const s = new ShapeStore();
  for (let i = 0; i < 500; i++) s.rebuild(`id${i}`, [["s", `v${i}`]]);
  for (let i = 0; i < 500; i++) assert.equal(s.read(`id${i}`).s, `v${i}`);
});

test("repeated variable-width values are interned per shape column", () => {
  const s = new ShapeStore();
  for (let i = 0; i < 20; i++) {
    s.rebuild(`id${i}`, [
      ["status", "active"],
      ["payload", { role: "reader" }],
    ]);
  }

  const stats = s.shapeStats()[0];
  assert.equal(stats.columns.status.kind, "value");
  assert.equal(stats.columns.status.values, 1);
  assert.equal(stats.columns.payload.kind, "value");
  assert.equal(stats.columns.payload.values, 1);

  s.writeField("id0", "status", "paused", [
    ["status", "paused"],
    ["payload", { role: "reader" }],
  ]);
  assert.equal(s.shapeStats()[0].columns.status.values, 2);

  s.removeObject("id0");
  assert.equal(s.shapeStats()[0].columns.status.values, 1);
});
