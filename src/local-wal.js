import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DEFAULT_LOCAL_WAL_DIR } from "./config.js";

export class LocalWalStore {
  constructor({ dir = DEFAULT_LOCAL_WAL_DIR, nodeId, fsync = true, flushMs = 0, maxRecordBytes = 4 * 1024 * 1024, maxOpsPerRecord = 1000 } = {}) {
    if (!nodeId) throw new Error("local WAL node id is required");
    this.dir = resolve(dir);
    this.nodeId = String(nodeId);
    this.fsync = fsync !== false;
    this.flushMs = Math.max(0, Number(flushMs) || 0);
    this.maxRecordBytes = Math.max(1024, Number(maxRecordBytes) || 4 * 1024 * 1024);
    this.maxOpsPerRecord = Math.max(1, Number(maxOpsPerRecord) || 1000);
    this.filePath = `${this.dir}/${safePathPart(this.nodeId)}/wal.jsonl`;
    this.io = Promise.resolve();
  }

  append(records = []) {
    return this._serialize(async () => {
      if (!records.length) return { records: 0, bytes: 0 };
      await mkdir(dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, "a");
      let bytes = 0;
      let start;
      try {
        start = (await handle.stat()).size;
        for (const record of records) {
          const line = `${JSON.stringify(record)}\n`;
          bytes += Buffer.byteLength(line);
          await handle.writeFile(line, "utf8");
        }
        if (this.fsync) await handle.sync();
      } catch (error) {
        if (start !== undefined) {
          await handle.truncate(start);
          if (this.fsync) await handle.sync();
        }
        throw error;
      } finally {
        await handle.close();
      }
      return { records: records.length, bytes };
    });
  }

  readRecords() {
    return this._serialize(() => this._readRecords());
  }

  async _readRecords() {
    if (!await exists(this.filePath)) {
      return { records: [], skippedPartialRecords: 0 };
    }

    const records = [];
    let skippedPartialRecords = 0;
    let lineNo = 0;
    let validBytes = 0;
    let fragments = [];
    let fragmentBytes = 0;
    for await (const chunk of createReadStream(this.filePath)) {
      let start = 0;
      let end;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const part = chunk.subarray(start, end);
        const line = fragments.length ? Buffer.concat([...fragments, part], fragmentBytes + part.length) : part;
        pushRecord(records, parseLine(line.toString("utf8"), ++lineNo));
        validBytes += fragmentBytes + part.length + 1;
        fragments = [];
        fragmentBytes = 0;
        start = end + 1;
      }
      if (start < chunk.length) {
        const part = chunk.subarray(start);
        fragments.push(part);
        fragmentBytes += part.length;
      }
    }

    if (fragmentBytes) {
      const tail = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
      let complete = false;
      try {
        pushRecord(records, parseLine(tail.toString("utf8"), lineNo + 1));
        complete = true;
      } catch {
        skippedPartialRecords++;
      }
      // Recovery leaves a valid append boundary, including a missing final newline.
      const handle = await open(this.filePath, "r+");
      try {
        if (complete) await handle.write("\n", validBytes + tail.length, "utf8");
        else await handle.truncate(validBytes);
        if (this.fsync) await handle.sync();
      } finally {
        await handle.close();
      }
    }

    return { records, skippedPartialRecords };
  }

  truncate(covered = () => true) {
    return this._serialize(async () => {
      if (!covered()) return { records: 0, skipped: true };
      await mkdir(dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, "a+");
      try {
        if (!covered()) return { records: 0, skipped: true };
        await handle.truncate(0);
        if (this.fsync) await handle.sync();
      } finally {
        await handle.close();
      }
      return { records: 0 };
    });
  }

  _serialize(run) {
    const operation = this.io.then(run);
    this.io = operation.catch(() => {});
    return operation;
  }
}

function parseLine(line, lineNo) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch (err) {
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

function safePathPart(value) {
  return encodeURIComponent(String(value));
}
