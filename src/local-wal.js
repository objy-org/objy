import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

export class LocalWalStore {
  constructor({ dir = ".spread-db/wal", nodeId, fsync = true, flushMs = 0, maxRecordBytes = 4 * 1024 * 1024, maxOpsPerRecord = 1000 } = {}) {
    if (!nodeId) throw new Error("local WAL node id is required");
    this.dir = resolve(dir);
    this.nodeId = String(nodeId);
    this.fsync = fsync !== false;
    this.flushMs = Math.max(0, Number(flushMs) || 0);
    this.maxRecordBytes = Math.max(1024, Number(maxRecordBytes) || 4 * 1024 * 1024);
    this.maxOpsPerRecord = Math.max(1, Number(maxOpsPerRecord) || 1000);
    this.filePath = `${this.dir}/${safePathPart(this.nodeId)}/wal.jsonl`;
  }

  async append(records = []) {
    if (!records.length) return { records: 0, bytes: 0 };
    await mkdir(dirname(this.filePath), { recursive: true });
    const handle = await open(this.filePath, "a");
    let bytes = 0;
    try {
      for (const record of records) {
        const line = `${JSON.stringify(record)}\n`;
        bytes += Buffer.byteLength(line);
        await handle.write(line, undefined, "utf8");
      }
      if (this.fsync) await handle.sync();
    } finally {
      await handle.close();
    }
    return { records: records.length, bytes };
  }

  async readRecords() {
    if (!await exists(this.filePath)) {
      return { records: [], skippedPartialRecords: 0 };
    }

    const complete = await endsWithNewline(this.filePath);
    const records = [];
    let skippedPartialRecords = 0;
    let previousLine = null;
    let previousLineNo = 0;
    let lineNo = 0;
    const lines = createInterface({
      input: createReadStream(this.filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (previousLine !== null) pushRecord(records, parseLine(previousLine, previousLineNo, false));
      previousLine = line;
      previousLineNo = ++lineNo;
    }

    if (previousLine !== null) {
      try {
        pushRecord(records, parseLine(previousLine, previousLineNo, !complete));
      } catch (err) {
        if (!complete) skippedPartialRecords++;
        else throw err;
      }
    }

    return { records, skippedPartialRecords };
  }

  async truncate() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const handle = await open(this.filePath, "w");
    try {
      if (this.fsync) await handle.sync();
    } finally {
      await handle.close();
    }
    return { records: 0 };
  }
}

function parseLine(line, lineNo, allowPartial) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch (err) {
    if (allowPartial) throw err;
    throw new Error(`failed to parse local WAL record at line ${lineNo}: ${err.message}`);
  }
}

function pushRecord(records, record) {
  if (record) records.push(record);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function endsWithNewline(path) {
  const info = await stat(path);
  if (info.size === 0) return true;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, info.size - 1);
    return buffer[0] === 10;
  } finally {
    await handle.close();
  }
}

function safePathPart(value) {
  return encodeURIComponent(String(value));
}
