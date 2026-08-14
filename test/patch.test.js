import test from "node:test";
import assert from "node:assert/strict";
import { applyPatchToObject } from "../src/patch.js";

test("applies Mongo-like $set and $unset dot paths", () => {
  const current = {
    _id: "a",
    name: "Ada",
    age: 36,
    profile: { city: "Berlin", legacy: true },
    tags: ["math"],
  };

  const next = applyPatchToObject(current, {
    $set: {
      "profile.city": "Hamburg",
      status: "active",
    },
    $unset: ["age", "profile.legacy"],
  });

  assert.deepEqual(next, {
    name: "Ada",
    profile: { city: "Hamburg" },
    tags: ["math"],
    status: "active",
  });
  assert.deepEqual(current.profile, { city: "Berlin", legacy: true });
});

test("supports object-form $unset and rejects non-operator keys", () => {
  assert.deepEqual(
    applyPatchToObject({ _id: "a", a: 1, b: 2 }, { $unset: { a: true } }),
    { b: 2 },
  );

  assert.throws(
    () => applyPatchToObject({ _id: "a", a: 1 }, { a: 2 }),
    /unsupported patch key "a"/,
  );
});

test("rejects protected ids and invalid paths", () => {
  assert.throws(
    () => applyPatchToObject({ _id: "a" }, { $set: { _id: "b" } }),
    /_id cannot be changed/,
  );
  assert.throws(
    () => applyPatchToObject({ _id: "a" }, { $unset: ["a..b"] }),
    /valid dot-notation path/,
  );
});
