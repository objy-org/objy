import { parentPort, workerData } from "node:worker_threads";

const RESULT_BATCH_SIZE = 20000;

const columns = new Map(
  normalizePaths(workerData?.paths).map((path) => [path, { values: new Map(), nonScalar: new Set() }]),
);

parentPort.on("message", (message = {}) => {
  if (message.type === "batch") {
    addBatch(message.rows);
    parentPort.postMessage({ type: "batch-ack" });
    return;
  }

  if (message.type === "finish") {
    emitResults();
  }
});

function addBatch(rows = []) {
  for (const row of rows) {
    const id = String(row?.id || "");
    if (!id) continue;

    for (const [path, value] of Object.entries(row.values || {})) {
      const column = columns.get(path);
      if (!column) continue;
      column.values.set(id, value);
      column.nonScalar.delete(id);
    }

    for (const path of row.nonScalar || []) {
      const column = columns.get(path);
      if (!column) continue;
      column.values.delete(id);
      column.nonScalar.add(id);
    }
  }
}

function emitResults() {
  for (const [path, column] of columns) {
    emitValueBatches(path, column.values);
    emitIdBatches(path, column.nonScalar);
  }
  parentPort.postMessage({ type: "done" });
}

function emitValueBatches(path, values) {
  let batch = [];
  for (const entry of values) {
    batch.push(entry);
    if (batch.length >= RESULT_BATCH_SIZE) {
      parentPort.postMessage({ type: "values-batch", path, entries: batch });
      batch = [];
    }
  }
  if (batch.length) parentPort.postMessage({ type: "values-batch", path, entries: batch });
}

function emitIdBatches(path, ids) {
  let batch = [];
  for (const id of ids) {
    batch.push(id);
    if (batch.length >= RESULT_BATCH_SIZE) {
      parentPort.postMessage({ type: "non-scalar-batch", path, ids: batch });
      batch = [];
    }
  }
  if (batch.length) parentPort.postMessage({ type: "non-scalar-batch", path, ids: batch });
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.map((path) => String(path || "").trim()).filter(Boolean))];
}
