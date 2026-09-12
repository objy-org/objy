import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

export function isNdjsonContentType(value) {
  const type = String(value || "").toLowerCase().split(";")[0].trim();
  return type === "application/x-ndjson" || type === "application/ndjson";
}

export function acceptsNdjson(headers = {}) {
  return String(headers.accept || "").toLowerCase().includes("application/x-ndjson") ||
    String(headers.accept || "").toLowerCase().includes("application/ndjson");
}

export function ndjsonReadable(values = []) {
  return Readable.from(ndjsonLines(values));
}

export async function* parseNdjsonBatches(stream, {
  maxBatchObjects = 1000,
  maxBatchBytes = 0,
  maxObjectBytes = 0,
  label = "NDJSON",
} = {}) {
  let batch = [];
  let bytes = 0;
  const maxObjects = Math.max(1, Number(maxBatchObjects) || 1000);
  const maxBytes = Math.max(0, Number(maxBatchBytes) || 0);

  for await (const entry of parseNdjsonStream(stream, { maxObjectBytes, label })) {
    if (batch.length && maxBytes && bytes + entry.bytes > maxBytes) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(entry.value);
    bytes += entry.bytes;
    if (batch.length >= maxObjects || (maxBytes && bytes >= maxBytes)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
  }

  if (batch.length) yield batch;
}

export async function* parseNdjsonStream(stream, { maxObjectBytes = 0, label = "NDJSON" } = {}) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let line = 0;
  const maxBytes = Number(maxObjectBytes) || 0;

  for await (const chunk of asyncIterableStream(stream)) {
    buffer += decoder.write(Buffer.from(chunk));

    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const rawLine = stripTrailingCarriageReturn(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      line += 1;
      if (!rawLine.trim()) continue;
      yield parseNdjsonLine(rawLine, line, maxBytes, label);
    }

    if (maxBytes && Buffer.byteLength(buffer) > maxBytes) {
      throw ndjsonError(413, "object is too large", {
        line: line + 1,
        bytes: Buffer.byteLength(buffer),
        maxObjectBytes: maxBytes,
      });
    }
  }

  buffer += decoder.end();
  if (buffer.length > 0) {
    const rawLine = stripTrailingCarriageReturn(buffer);
    line += 1;
    if (rawLine.trim()) yield parseNdjsonLine(rawLine, line, maxBytes, label);
  }
}

async function* ndjsonLines(values) {
  for (const value of values || []) {
    yield `${JSON.stringify(value)}\n`;
  }
}

function asyncIterableStream(stream) {
  if (stream?.[Symbol.asyncIterator]) return stream;
  if (stream?.getReader) return Readable.fromWeb(stream);
  return stream || [];
}

function parseNdjsonLine(rawLine, line, maxObjectBytes, label) {
  const bytes = Buffer.byteLength(rawLine);
  if (maxObjectBytes && bytes > maxObjectBytes) {
    throw ndjsonError(413, "object is too large", { line, bytes, maxObjectBytes });
  }
  try {
    return { line, bytes, value: JSON.parse(rawLine) };
  } catch {
    throw ndjsonError(400, `invalid ${label} at line ${line}`, { line });
  }
}

function stripTrailingCarriageReturn(value) {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function ndjsonError(status, message, body) {
  const err = new Error(message);
  err.status = status;
  err.body = { error: message, ...body };
  return err;
}
