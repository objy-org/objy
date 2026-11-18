import assert from "node:assert/strict";

export const DB = "compaction_benchmark", COLL = "objects", SLOTS = 1024;
export const scope = { database: DB, collection: COLL, shard: "default" };
export const head = `benchmark/db/${DB}/collection/${COLL}/shard/default/latest.json`;
const text = "Object record with descriptions, specifications, comments and dynamic properties. ".repeat(48);
export const meta = {
  indexes: ["kind", "seed", "active"], columns: ["score"],
  tiering: { mode: "compressedMemory", keep: ["kind", "seed", "active", "rank", "label"], minBytes: 256 },
};
export function row(i) {
  return {
    _id: `r-${i}`, seed: true, kind: `g${i % 16}`, active: i % 3 !== 0, score: i % 1000, rank: i % 101,
    label: `Object ${i}`,
    payload: { title: `Document ${i}`, text: `${i}: ${text}`, codes: [i % 197, i % 53], nested: { enabled: i % 2 === 0, note: `Record ${i % 257}` } },
  };
}
export function live(slot, revision = 0) {
  return { ...row(slot), _id: `w-${slot}`, seed: false, revision, score: revision % 1000, label: `Write ${slot} revision ${revision}` };
}
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function quantiles(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b), p = (n) => sorted[Math.min(sorted.length - 1, Math.ceil(n * sorted.length) - 1)];
  return { n: sorted.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: sorted.at(-1) };
}
export async function request(url, token, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(url, {
    method, signal: AbortSignal.timeout(60000),
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `HTTP ${response.status}: ${raw.slice(0, 500)}`);
  return JSON.parse(raw);
}
