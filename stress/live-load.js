import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const PATH = "/api/stress/items";
const FIELDS = { count: { $count: true }, total: { $sum: "score" }, average: { $avg: "score" }, min: { $min: "score" }, max: { $max: "score" } };

// Fixed rows make every successful query checkable during concurrent writes.
// Mutable rows share the same collection, indexes, columns and compression.
export function mixedLoad({ count, call, stream, objectAt, nodes, batchSize = 20, writerRouting = "stable", profile = "mixed" }) {
  const known = new Map(), deleted = new Set(), metrics = new Map(), durations = new Map();
  const vectorRecall = new Map();
  const errors = [], tasks = [];
  let running = false, phase = "idle", since = performance.now(), nextNode = 0, serial = 0;
  const equalIds = [], rangeIds = [], tagIds = [];
  const allGroups = new Map(), filteredGroups = new Map(), scanGroups = new Map();
  for (let i = 0; i < count; i++) {
    if (i % 17 === 3 && i % 2 === 0) equalIds.push(i);
    if (i % 1000 >= 900 && i % 1000 < 910 && i % 2 === 1) rangeIds.push(i);
    if (i % 7 === 3) tagIds.push(i);
    accumulate(allGroups, i % 17, i % 1000);
    if (i % 2 === 0 && i % 1000 >= 800) accumulate(filteredGroups, i % 17, i % 1000);
    accumulate(scanGroups, `b${i % 5}`, i % 1000);
  }
  const idCompare = (a, b) => compare(`object-${a}`, `object-${b}`);
  equalIds.sort(idCompare); tagIds.sort(idCompare);
  rangeIds.sort((a, b) => b % 1000 - a % 1000 || idCompare(a, b));
  const first = (values) => values.slice(0, 50).map((i) => `object-${i}`);
  const queries = [
    { name: "index-equality", query: { kind: 3, active: true, $sort: { _id: 1 } }, ids: first(equalIds), interval: 100 },
    { name: "offset-page", query: { kind: 3, active: true, $sort: { _id: 1 }, $skip: 1000 }, ids: equalIds.slice(1000, 1050).map((i) => `object-${i}`), interval: 250 },
    { name: "column-range-sort", query: { kind: { $lt: 17 }, active: false, score: { $gte: 900, $lt: 910 }, $sort: { score: -1, _id: 1 } }, ids: first(rangeIds), interval: 150 },
    { name: "array-index", query: { kind: { $lt: 17 }, tags: { $contains: "tag3" }, $sort: { _id: 1 } }, ids: first(tagIds), interval: 150 },
    { name: "aggregate-index", query: aggregate("kind"), groups: allGroups, groupBy: "kind", interval: 300 },
    { name: "aggregate-page", query: { ...aggregate("kind"), $aggregate: { groupBy: "kind", fields: FIELDS, $sort: { kind: 1 }, $page: 2, $pageSize: 5 } },
      groups: new Map([...allGroups].filter(([kind]) => kind >= 5 && kind < 10)), groupBy: "kind", order: [5, 6, 7, 8, 9], interval: 500 },
    { name: "aggregate-filtered", query: { ...aggregate("kind"), active: true, score: { $gte: 800 } }, groups: filteredGroups, groupBy: "kind", interval: 500 },
    { name: "aggregate-scan", query: aggregate("bucket"), groups: scanGroups, groupBy: "bucket", interval: 2000 },
  ];

  function setPhase(value) {
    if (phase === value) return;
    const now = performance.now();
    durations.set(phase, (durations.get(phase) || 0) + now - since);
    phase = value; since = now;
  }
  async function measure(name, execute, objects = 0) {
    const started = performance.now(), label = phase;
    let status = 0, path;
    const observe = (response) => { status = response.status; path = response.path; };
    try { return await execute(observe); }
    finally {
      const key = `${label}/${name}`;
      const entry = metrics.get(key) || { phase: label, operation: name, times: [], successful: [], statuses: {}, paths: {}, objects: 0 };
      entry.times.push(performance.now() - started);
      entry.statuses[status] = (entry.statuses[status] || 0) + 1;
      if (status >= 200 && status < 300) { entry.objects += objects; entry.successful.push(performance.now() - started); }
      if (path) entry.paths[path] = (entry.paths[path] || 0) + 1;
      metrics.set(key, entry);
    }
  }
  const nodeIndex = () => nextNode++ % nodes;
  const transient = (error) => [0, 409, 502, 503, 504].includes(error.status);
  async function loop(action, interval) {
    try {
      while (running) { await action(); if (interval) await sleep(interval); }
    } catch (error) { errors.push(error.stack || error.message); running = false; }
  }
  async function readQuery(spec) {
    let rows;
    try {
      rows = await measure(spec.name, (observe) => call(nodeIndex(), "POST", `${PATH}/search`, {
        ...spec.query, $limit: 50, $refDepth: 0,
      }, observe));
    } catch (error) { if (transient(error)) return; throw error; }
    if (spec.ids) assert.deepEqual(rows.map((row) => row._id), spec.ids, `${phase}/${spec.name}`);
    else checkGroups(rows, spec.groups, spec.groupBy, `${phase}/${spec.name}`);
    if (spec.order) assert.deepEqual(rows.map((row) => row[spec.groupBy]), spec.order);
  }
  async function point() {
    const i = nextNode * 7919 % count;
    let row;
    try { row = await measure("point", (observe) => call(nodeIndex(), "GET", `${PATH}/object/object-${i}`, undefined, observe)); }
    catch (error) { if (transient(error)) return; throw error; }
    assert.equal(row.score, i % 1000);
    assert.equal(row.payload, objectAt(i).payload);
    assert.equal(row.owner?.object?.region, `region-${i % 16 % 4}`, "live reference must resolve to the immutable owner");
  }
  async function vector() {
    const label = phase;
    let rows;
    try { rows = await measure("vector", (observe) => call(nodeIndex(), "POST", `${PATH}/search`, {
      $vector: { vector: [1, 0, 0, 0], limit: 5 }, $refDepth: 0,
    }, observe)); }
    catch (error) { if (transient(error)) return; throw error; }
    assert.equal(rows.length, 5);
    assert.equal(new Set(rows.map((row) => row._id)).size, rows.length);
    let previous = Infinity;
    for (const row of rows) {
      const index = Number(row._id.replace(/^object-/, ""));
      assert.ok(Number.isInteger(index) && index >= 0 && index < Math.min(1000, count));
      assert.ok(Math.abs(row._score - (index === 0 ? 1 : 0)) < 1e-8, "vector score must match stored embedding");
      assert.ok(row._score <= previous, "vector results must be ranked");
      previous = row._score;
    }
    // HNSW is approximate. Record recall of this deliberately isolated vector
    // separately from invalid scores, duplicate IDs, or corrupted embeddings.
    const recall = vectorRecall.get(label) || { queries: 0, top1: 0, top5: 0 };
    recall.queries++; recall.top1 += Number(rows[0]._id === "object-0");
    recall.top5 += Number(rows.some((row) => row._id === "object-0"));
    vectorRecall.set(label, recall);
  }
  async function mutation(method, rows) {
    const deadline = Date.now() + 180_000;
    let pending = rows;
    let retried = false;
    for (;;) {
      try {
        const result = await measure(method, (observe) => stream(writerRouting === "round-robin" ? nodeIndex() : 0, method, pending, observe), pending.length);
        if (method === "POST") assert.equal(result.inserted, pending.length);
        if (method === "PUT") assert.equal(result.replaced, pending.length);
        if (method === "PATCH") { assert.equal(result.updated, pending.length); assert.equal(result.skipped, 0); }
        if (method === "DELETE") {
          assert.equal(result.deleted + result.skipped, pending.length);
          if (!retried) assert.equal(result.skipped, 0, "first delete attempt must find every acknowledged object");
        }
        return;
      } catch (error) {
        if (!transient(error) || Date.now() > deadline) throw error;
        retried = true;
        if (method === "POST" && error.status === 409) {
          // An interrupted sharded insert can commit some IDs. Retain stable
          // IDs and retry only missing rows, rather than overwriting results.
          try {
            const found = await call(nodeIndex(), "POST", `${PATH}/search`, { _id: { $in: pending.map((row) => row._id) }, $limit: 250, $refDepth: 0 });
            const ids = new Set(found.map((row) => row._id));
            pending = pending.filter((row) => !ids.has(row._id));
            if (!pending.length) return;
          } catch (readError) { if (!transient(readError)) throw readError; }
        }
        await sleep(25);
      }
    }
  }
  async function writeCycle() {
    const id = serial++;
    const rows = Array.from({ length: batchSize }, (_, offset) => ({
      _id: `traffic-${id}-${offset}`, kind: 100 + offset % 17, active: true, score: id + offset,
      bucket: "traffic", tags: ["traffic"], payload: "traffic-payload-".repeat(40), nested: { previous: true },
    }));
    await mutation("POST", rows);
    for (const row of rows) known.set(row._id, row);
    const replaced = rows.map((row) => ({ ...row, kind: row.kind + 17, active: false, score: row.score * -2 }));
    await mutation("PUT", replaced);
    for (const row of replaced) known.set(row._id, row);
    await mutation("PATCH", replaced.map((row) => ({ _id: row._id, $set: { score: row.score + 7, "nested.after": true }, $unset: ["nested.previous"] })));
    for (const row of replaced) known.set(row._id, { ...row, score: row.score + 7, nested: { after: true } });
    const removed = replaced.filter((_, i) => i % 2 === 0).map((row) => row._id);
    await mutation("DELETE", removed);
    for (const key of removed) { known.delete(key); deleted.add(key); }
  }
  async function verify() {
    for (let i = 0; i < nodes; i++) {
      const rows = await call(i, "POST", `${PATH}/search`, { ...aggregate("kind"), kind: { $gte: 17 } });
      const expected = new Map();
      for (const row of known.values()) accumulate(expected, row.kind, row.score);
      const live = [...known.values()];
      for (let offset = 0; offset < live.length; offset += 250) {
        const batch = live.slice(offset, offset + 250);
        const found = await call(i, "POST", `${PATH}/search`, { _id: { $in: batch.map((row) => row._id) }, $limit: 250, $refDepth: 0 });
        assert.equal(found.length, batch.length);
        for (const row of found) assert.deepEqual(row, known.get(row._id), `settled traffic object ${row._id}`);
      }
      const absent = [...deleted];
      for (let offset = 0; offset < absent.length; offset += 250) {
        assert.deepEqual(await call(i, "POST", `${PATH}/search`, { _id: { $in: absent.slice(offset, offset + 250) }, $limit: 250, $refDepth: 0 }), []);
      }
      checkGroups(rows, expected, "kind", "settled traffic");
      for (const spec of queries) await readQuery(spec);
    }
  }
  return {
    errors, known, deleted, setPhase, verify,
    start(label) {
      assert.equal(running, false); setPhase(label); running = true;
      if (profile === "indexed") {
        const selected = queries.filter((spec) => spec.name !== "aggregate-scan");
        let index = 0;
        tasks.push(loop(() => readQuery(selected[index++ % selected.length]), 100));
      } else for (const spec of queries) tasks.push(loop(() => readQuery(spec), spec.interval));
      tasks.push(loop(point, 20), loop(vector, 500), loop(writeCycle, 10), loop(writeCycle, 10));
    },
    async stop() { running = false; await Promise.all(tasks); tasks.length = 0; setPhase("settled"); },
    assertHealthy() { assert.deepEqual(errors, [], "mixed workload correctness errors"); },
    snapshot() {
      const elapsed = new Map(durations);
      elapsed.set(phase, (elapsed.get(phase) || 0) + performance.now() - since);
      return { cycles: serial, liveTraffic: known.size, deletedTraffic: deleted.size, errors, vectorRecall: Object.fromEntries(vectorRecall),
        phasesMs: Object.fromEntries(elapsed), requests: [...metrics.values()].map(({ times, successful, ...entry }) => {
          times.sort((a, b) => a - b);
          successful.sort((a, b) => a - b);
          const at = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
          const successAt = (p) => successful[Math.min(successful.length - 1, Math.floor(successful.length * p))];
          return { ...entry, requests: times.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: times.at(-1),
            success: { count: successful.length, p50: successAt(0.5), p95: successAt(0.95), p99: successAt(0.99), max: successful.at(-1) } };
        }) };
    },
  };
}

function aggregate(groupBy) { return { kind: { $in: Array.from({ length: 17 }, (_, i) => i) }, $aggregate: { groupBy, fields: FIELDS }, $refDepth: 0 }; }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function accumulate(groups, key, score) {
  const entry = groups.get(key) || { count: 0, total: 0, min: Infinity, max: -Infinity };
  entry.count++; entry.total += score; entry.min = Math.min(entry.min, score); entry.max = Math.max(entry.max, score);
  groups.set(key, entry);
}
function checkGroups(rows, expected, key, label) {
  assert.equal(rows.length, expected.size, `${label} group count`);
  for (const row of rows) {
    const group = expected.get(row[key]);
    assert.ok(group, `${label} unexpected group ${row[key]}`);
    for (const field of ["count", "total", "min", "max"]) assert.equal(row[field], group[field], `${label}/${row[key]}/${field}`);
    assert.ok(Math.abs(row.average - group.total / group.count) < 1e-8, `${label}/${row[key]}/average`);
  }
}
