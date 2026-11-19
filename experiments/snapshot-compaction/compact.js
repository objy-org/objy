import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { parseNdjsonStream } from "../../src/ndjson.js";
import { Store } from "../../src/store.js";
import { isTopologyResharding } from "../../src/shard-map.js";
import { PrimaryStateStore } from "../../src/primary-state.js";

const MiB = 1024 * 1024;

// Experimental only: capture a durable cut, but never publish or delete inputs.
export async function captureCompaction(persistence, scope) {
  if (isTopologyResharding(persistence.node.shardMapSnapshot())) {
    throw new Error("experimental compaction does not handle an active reshard");
  }
  await persistence.flush();
  const coverage = persistence._snapshotCoverage();
  await persistence.flush();
  const root = persistence.prefix.replace(/^\/+|\/+$/g, "");
  const db = [root, "db", encodeURIComponent(scope.database)].filter(Boolean).join("/");
  const collection = `${db}/collection/${encodeURIComponent(scope.collection)}`;
  const base = `${collection}/shard/${encodeURIComponent(scope.shard)}`;
  const guardKeys = [
    `${base}/latest.json`, `${db}/meta.json`, `${collection}/meta.json`,
    `${root ? `${root}/` : ""}database-tombstones/${encodeURIComponent(scope.database)}.json`,
    `${db}/collection-tombstones/${encodeURIComponent(scope.collection)}.json`,
  ];
  const guards = [];
  for (const key of guardKeys) guards.push([key, (await persistence.states.read(key)).body]);
  if (guards[3][1] || guards[4][1]) throw new Error("cannot compact a deleted context");
  const snapshot = guards[0][1] ? JSON.parse(guards[0][1]) : null;
  const cursors = Object.assign(Object.create(null), snapshot?.cursors);
  if (snapshot?.node) cursors[snapshot.node] = Math.max(cursors[snapshot.node] || 0, snapshot.seq || 0);
  for (const [source, seq] of Object.entries(persistence._snapshotCursors(scope, coverage))) {
    cursors[source] = Math.max(cursors[source] || 0, seq);
  }
  const id = `candidate-${randomUUID()}`;
  return {
    scope, snapshot, cursors, guards,
    journals: await persistence.storage.list(`${base}/journal/`),
    output: `${base}/snapshots/${id}`,
    manifest: {
      version: 1, id, node: persistence.node.id, seq: cursors[persistence.node.id] || 0,
      createdAt: new Date().toISOString(), ...scope,
      topologyId: persistence.node.shardMapSnapshot().topology?.id || null,
      databaseMeta: guards[1][1] ? JSON.parse(guards[1][1]) : snapshot?.databaseMeta || {},
      collectionMeta: guards[2][1] ? JSON.parse(guards[2][1]) : snapshot?.collectionMeta || {},
      cursors, format: "jsonl",
    },
  };
}

export async function compactSnapshot(storage, plan, {
  workDir, runBytes = 16 * MiB, segmentBytes = 16 * MiB,
  maxRecordBytes = 8 * MiB, mergeWidth = 16, onProgress = () => {},
} = {}) {
  if (!workDir || !Number.isSafeInteger(runBytes) || runBytes < 1024 ||
      !Number.isSafeInteger(segmentBytes) || segmentBytes < 1024 ||
      !Number.isSafeInteger(mergeWidth) || mergeWidth < 2 ||
      !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new Error("invalid compaction limits or work directory");
  }
  if (!plan.output?.endsWith(`/snapshots/${plan.manifest.id}`) || !plan.manifest.id.startsWith("candidate-")) {
    throw new Error("compaction output must be an isolated candidate snapshot");
  }
  await mkdir(workDir, { recursive: true });
  const stats = { inputRows: 0, journalRows: 0, selectedOps: 0, initialRuns: 0, mergePasses: 0, diskWrittenBytes: 0, peakDiskBytes: 0 };
  let fileSerial = 0, ordinal = 0, diskBytes = 0;
  const newFile = () => join(workDir, `run-${fileSerial++}.txt`);
  const recordFile = async (path) => {
    const bytes = (await stat(path)).size;
    stats.diskWrittenBytes += bytes;
    diskBytes += bytes;
    stats.peakDiskBytes = Math.max(stats.peakDiskBytes, diskBytes);
    return { path, bytes };
  };
  const removeFiles = async (files) => {
    for (const file of files) { await rm(file.path); diskBytes -= file.bytes; }
  };
  let buffer = [], bufferBytes = 0, runs = [];
  const flushRun = async () => {
    if (!buffer.length) return;
    buffer.sort(compareRecords);
    const path = newFile();
    await writeRecords(path, buffer);
    runs.push(await recordFile(path));
    stats.initialRuns++;
    buffer = [];
    bufferBytes = 0;
  };
  const add = async (value, type, bytes) => {
    validateRow(value, type, plan.scope);
    if (buffer.length && bufferBytes + bytes + 128 > runBytes) await flushRun();
    const body = JSON.stringify(value);
    buffer.push({ id: String(value.id), ordinal: ordinal++, type, body });
    bufferBytes += Buffer.byteLength(body) + Buffer.byteLength(String(value.id)) + 128;
    stats.inputRows++;
    if (bufferBytes >= runBytes) await flushRun();
    if (stats.inputRows % 100000 === 0) onProgress({ stage: "runs", ...stats });
  };

  try {
    if (plan.snapshot) {
      for (const key of ["database", "collection", "shard"]) {
        if (plan.snapshot[key] !== plan.scope[key]) throw new Error("snapshot manifest belongs to another context");
      }
    }
    let snapshotRows = 0;
    for (const segment of plan.snapshot?.segments || []) {
      if (segment.format !== "jsonl" && !segment.key.endsWith(".jsonl")) throw new Error("candidate only accepts JSONL snapshot inputs");
      let count = 0;
      for await (const entry of readInput(storage, segment.key, maxRecordBytes)) {
        await add(entry.value, "snapshot", entry.bytes);
        count++;
        snapshotRows++;
      }
      if (count !== segment.count) throw new Error(`snapshot row count mismatch: ${segment.key}`);
    }
    if (plan.snapshot && snapshotRows !== plan.snapshot.objectCount) throw new Error("snapshot total row count mismatch");
    const baseCursors = Object.assign(Object.create(null), plan.snapshot?.cursors);
    if (plan.snapshot?.node) baseCursors[plan.snapshot.node] = Math.max(baseCursors[plan.snapshot.node] || 0, plan.snapshot.seq || 0);
    for (const key of plan.journals) {
      const writer = decodeURIComponent(key.split("/").at(-2));
      for await (const { value: op, bytes } of readInput(storage, key, maxRecordBytes)) {
        stats.journalRows++;
        validateRow(op, "op", plan.scope);
        const source = op.from || writer;
        if (!Number.isSafeInteger(op.seq) || op.seq < 1) throw new Error(`invalid journal sequence in ${key}`);
        if (!Number.isSafeInteger(plan.cursors[source])) throw new Error(`no durable cut for source ${source}`);
        if (op.seq <= (baseCursors[source] || 0) || op.seq > plan.cursors[source]) continue;
        await add(op, "op", bytes);
        stats.selectedOps++;
      }
    }
    await flushRun();
    while (runs.length > mergeWidth) {
      const next = [];
      for (let i = 0; i < runs.length; i += mergeWidth) {
        const group = runs.slice(i, i + mergeWidth), path = newFile();
        await writeRecords(path, mergeRuns(group));
        next.push(await recordFile(path));
        await removeFiles(group);
      }
      runs = next;
      stats.mergePasses++;
      onProgress({ stage: "merge", ...stats });
    }

    const segments = [];
    let lines = [], bytes = 0, objects = 0;
    const flushSegment = async () => {
      if (!lines.length) return;
      const key = `${plan.output}/segment-${String(segments.length).padStart(6, "0")}.jsonl`;
      await storage.put(key, `${lines.join("\n")}\n`, "application/x-ndjson");
      segments.push({ key, count: lines.length, bytes, format: "jsonl" });
      lines = [];
      bytes = 0;
      onProgress({ stage: "upload", segments: segments.length, objects });
    };
    // Reuse the real version rules in bounded, unindexed stores. A hot ID's
    // history is applied in batches, never retained in full or split across stores.
    const newStore = () => {
      const store = new Store({ engine: "object", vector: false });
      store.beginBulkLoad();
      return store;
    };
    let store = newStore(), batch = [], batchBytes = 0, inputBytes = 0, ids = 0, lastId;
    const applyBatch = () => {
      applyRecords(store, batch);
      batch = [];
      batchBytes = 0;
    };
    const emitStore = async () => {
      applyBatch();
      for (const row of store.collectionSnapshotObjects("compact", "rows")) {
        const line = JSON.stringify(row), rowBytes = Buffer.byteLength(line) + 1;
        if (lines.length && bytes + rowBytes > segmentBytes) await flushSegment();
        lines.push(line);
        bytes += rowBytes;
        objects++;
      }
      store.dispose();
      store = newStore();
      inputBytes = 0;
      ids = 0;
    };
    try {
      for await (const record of mergeRuns(runs)) {
        if (record.id !== lastId) {
          if (ids >= 256 || inputBytes >= runBytes) await emitStore();
          ids++;
          lastId = record.id;
        }
        const length = Buffer.byteLength(record.body);
        batch.push(record);
        batchBytes += length;
        inputBytes += length;
        if (batch.length >= 256 || batchBytes >= runBytes) applyBatch();
      }
      await emitStore();
      await flushSegment();
    } finally { store.dispose(); }

    // Staging is intentionally non-destructive. Changed inputs invalidate the job.
    for (const [key, expected] of plan.guards) {
      if ((await new PrimaryStateStore({ storage }).read(key)).body !== expected) throw new Error(`compaction input changed: ${key}`);
    }
    const manifest = { ...plan.manifest, objectCount: objects, segments };
    const manifestKey = `${plan.output}/manifest.json`;
    await storage.put(manifestKey, JSON.stringify(manifest), "application/json");
    return { manifestKey, manifest, ...stats };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function applyRecords(store, records) {
  for (let i = 0; i < records.length;) {
    const type = records[i].type, values = [];
    while (i < records.length && records[i].type === type) values.push(JSON.parse(records[i++].body));
    if (type === "snapshot") store.applySnapshotObjects("compact", "rows", values, { trustedValues: true });
    else store.applyOps(values.map((op) => ({ ...op, db: "compact", coll: "rows" })));
  }
}

function validateRow(row, type, scope) {
  const ts = type === "snapshot" ? row?.deleted || row?.ts : row?.ts;
  if (!row || typeof row.id !== "string" || !ts || !Number.isSafeInteger(ts.c) || typeof ts.n !== "string") {
    throw new Error("invalid compaction row or timestamp");
  }
  if (row.shard && row.shard !== scope.shard) throw new Error("compaction row belongs to another shard");
  if (type === "op" && (row.db !== scope.database || row.coll !== scope.collection || !["putObj", "delObj", "touch"].includes(row.kind))) {
    throw new Error("invalid compaction operation or context");
  }
}

async function* readInput(storage, key, maxObjectBytes) {
  const stream = await storage.getStream(key);
  if (!stream) throw new Error(`missing compaction input: ${key}`);
  try { yield* parseNdjsonStream(stream, { maxObjectBytes, label: key }); }
  finally { stream.destroy?.(); }
}

function compareRecords(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : a.ordinal - b.ordinal;
}

async function writeRecords(path, records) {
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  let error;
  stream.on("error", (value) => { error = value; });
  try {
    for await (const record of records) {
      if (error) throw error;
      if (!stream.write(`${JSON.stringify([record.id, record.ordinal, record.type])}\t${record.body}\n`)) await once(stream, "drain");
    }
    if (error) throw error;
    const finished = once(stream, "finish");
    stream.end();
    await finished;
  } finally { stream.destroy(); }
}

async function* readRun(path) {
  const stream = createReadStream(path), lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const boundary = line.indexOf("\t"), [id, ordinal, type] = JSON.parse(line.slice(0, boundary));
      yield { id, ordinal, type, body: line.slice(boundary + 1) };
    }
  } finally { lines.close(); stream.destroy(); }
}

async function* mergeRuns(files) {
  const readers = files.map(({ path }) => readRun(path)), heads = [];
  try {
    for (const reader of readers) heads.push(await reader.next());
    for (;;) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) {
        if (!heads[i].done && (best < 0 || compareRecords(heads[i].value, heads[best].value) < 0)) best = i;
      }
      if (best < 0) break;
      yield heads[best].value;
      heads[best] = await readers[best].next();
    }
  } finally {
    for (const reader of readers) await reader.return();
  }
}
