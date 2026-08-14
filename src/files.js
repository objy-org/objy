import { randomUUID } from "node:crypto";
import { createObjectId } from "./object-id.js";
import { createObjectStorage } from "./object-storage.js";

const DEFAULT_PREFIX = "spread-db/files";
const DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const ALLOWED_FILE_KEYS = new Set(["storage", "key", "mimeType"]);

export function createFileService(config = {}, persistenceConfig = {}) {
  const mode = config.mode || "off";
  if (mode === "off" || mode === false) return null;
  const storage = createObjectStorage({
    mode,
    s3: {
      ...(persistenceConfig?.s3 || {}),
      ...(config.s3 || {}),
    },
  });
  return new FileService({
    storage,
    prefix: config.prefix || DEFAULT_PREFIX,
    storageName: config.storageName || mode,
    maxUploadBytes: positiveInt(config.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES),
  });
}

export class FileService {
  constructor({ storage, prefix = DEFAULT_PREFIX, storageName = "s3", maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES } = {}) {
    if (!storage) throw new Error("file storage is required");
    this.storage = storage;
    this.prefix = normalizePrefix(prefix);
    this.storageName = storageName;
    this.maxUploadBytes = positiveInt(maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES);
  }

  keyPrefix(database, collection, id) {
    return [
      this.prefix,
      "db",
      encodeKeyPart(database),
      "collection",
      encodeKeyPart(collection),
      "object",
      encodeKeyPart(id),
      "blob",
    ].join("/");
  }

  key(database, collection, id, fileId = createObjectId()) {
    return `${this.keyPrefix(database, collection, id)}/${encodeKeyPart(fileId)}`;
  }

  metadata(database, collection, id, mimeType) {
    return {
      storage: this.storageName,
      key: this.key(database, collection, id),
      mimeType: cleanMimeType(mimeType),
    };
  }

  attach(database, collection, object, file) {
    if (object?._file !== undefined) throw httpError(400, "object._file is server-owned");
    return {
      ...(object || {}),
      _file: this.metadata(database, collection, object?._id, file?.mimeType),
    };
  }

  normalizeObject(database, collection, object) {
    if (!isPlainObject(object) || object._file === undefined) return object;
    if (object._file === null) {
      const { _file, ...rest } = object;
      return rest;
    }
    return {
      ...object,
      _file: this.normalizeMetadata(database, collection, object._id, object._file),
    };
  }

  normalizeMetadata(database, collection, id, metadata) {
    if (!isPlainObject(metadata)) throw httpError(400, "object._file must be a plain object");
    for (const key of Object.keys(metadata)) {
      if (!ALLOWED_FILE_KEYS.has(key)) throw httpError(400, `object._file.${key} is not supported`);
    }
    if (metadata.storage !== this.storageName) throw httpError(400, `object._file.storage must be ${this.storageName}`);
    const prefix = `${this.keyPrefix(database, collection, id)}/`;
    const keySuffix = typeof metadata.key === "string" && metadata.key.startsWith(prefix)
      ? metadata.key.slice(prefix.length)
      : "";
    if (!keySuffix || keySuffix.includes("/")) {
      throw httpError(400, "object._file.key must match the server-derived file key");
    }
    return {
      storage: this.storageName,
      key: metadata.key,
      mimeType: cleanMimeType(metadata.mimeType),
    };
  }

  fileKeyFromObject(database, collection, object) {
    if (!object?._file) return null;
    return this.normalizeMetadata(database, collection, object._id, object._file).key;
  }

  async put(database, collection, id, metadata, file) {
    const normalized = this.normalizeMetadata(database, collection, id, metadata);
    await this.storage.putBlob(normalized.key, file.body, normalized.mimeType);
    return normalized;
  }

  async get(database, collection, id, metadata) {
    const normalized = this.normalizeMetadata(database, collection, id, metadata);
    return this.storage.getBlob(normalized.key);
  }

  async deleteObjectFile(database, collection, object) {
    const key = this.fileKeyFromObject(database, collection, object);
    if (!key) return false;
    await this.storage.delete([key]);
    return true;
  }
}

export function isMultipartRequest(req) {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("multipart/form-data");
}

export async function readMultipartObjectFile(req, { maxBytes = DEFAULT_MAX_UPLOAD_BYTES, assertCanBuffer = null } = {}) {
  const parts = parseMultipart(await readRawBody(req, maxBytes, assertCanBuffer), multipartBoundary(req));
  const objectPart = parts.find((part) => part.name === "object");
  const filePart = parts.find((part) => part.name === "file");
  if (!objectPart) throw httpError(400, 'multipart field "object" is required');
  if (!filePart) throw httpError(400, 'multipart field "file" is required');

  let object;
  try {
    object = JSON.parse(objectPart.body.toString("utf8"));
  } catch {
    throw httpError(400, 'multipart field "object" must be valid JSON');
  }
  if (!isPlainObject(object)) throw httpError(400, 'multipart field "object" must be a plain object');

  return {
    object,
    file: {
      filename: filePart.filename || null,
      mimeType: cleanMimeType(filePart.contentType),
      body: filePart.body,
    },
  };
}

export function buildMultipartObjectFile({ object, file }) {
  const boundary = `spread-db-${randomUUID()}`;
  const chunks = [
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="object"\r\ncontent-type: application/json\r\n\r\n`),
    Buffer.from(JSON.stringify(object)),
    Buffer.from(`\r\n--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${escapeHeader(file.filename || "blob")}"\r\ncontent-type: ${cleanMimeType(file.mimeType)}\r\n\r\n`),
    Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body || ""),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function writeBlobResponse(res, blob, fallbackContentType = "application/octet-stream") {
  const headers = {
    "content-type": blob.contentType || fallbackContentType,
  };
  if (Number.isFinite(blob.contentLength)) headers["content-length"] = String(blob.contentLength);
  res.writeHead(200, headers);
  if (Buffer.isBuffer(blob.body) || typeof blob.body === "string") {
    res.end(blob.body);
    return;
  }
  for await (const chunk of blob.body) res.write(chunk);
  res.end();
}

async function readRawBody(req, maxBytes, assertCanBuffer = null) {
  if (req._bodyBuffer !== undefined) return req._bodyBuffer;
  assertCanBuffer?.();
  req._bodyBuffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
      req.destroy();
    };
    req.on("data", (chunk) => {
      try {
        assertCanBuffer?.();
      } catch (err) {
        fail(err);
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        fail(httpError(413, "payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
  return req._bodyBuffer;
}

function multipartBoundary(req) {
  const contentType = req.headers["content-type"];
  const match = typeof contentType === "string" ? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i) : null;
  const boundary = match?.[1] || match?.[2];
  if (!boundary) throw httpError(400, "multipart boundary is required");
  return boundary.trim();
}

function parseMultipart(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = buffer.indexOf(marker);
  if (pos < 0) throw httpError(400, "invalid multipart body");

  while (pos >= 0) {
    pos += marker.length;
    if (buffer.slice(pos, pos + 2).toString("ascii") === "--") break;
    if (buffer.slice(pos, pos + 2).toString("ascii") !== "\r\n") throw httpError(400, "invalid multipart boundary");
    pos += 2;

    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), pos);
    if (headerEnd < 0) throw httpError(400, "invalid multipart headers");
    const headers = parsePartHeaders(buffer.slice(pos, headerEnd).toString("utf8"));
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(Buffer.from(`\r\n--${boundary}`), bodyStart);
    if (next < 0) throw httpError(400, "invalid multipart body");
    parts.push({
      name: dispositionParam(headers["content-disposition"], "name"),
      filename: dispositionParam(headers["content-disposition"], "filename"),
      contentType: headers["content-type"],
      body: buffer.slice(bodyStart, next),
    });
    pos = next + 2;
  }

  return parts.filter((part) => part.name);
}

function parsePartHeaders(raw) {
  const headers = {};
  for (const line of raw.split("\r\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function dispositionParam(header, name) {
  const match = typeof header === "string" ? header.match(new RegExp(`${name}="([^"]*)"`)) : null;
  return match ? match[1] : null;
}

function cleanMimeType(value) {
  return typeof value === "string" && value.length > 0 ? value : "application/octet-stream";
}

function normalizePrefix(value) {
  const cleaned = String(value || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");
  return cleaned || DEFAULT_PREFIX;
}

function encodeKeyPart(value) {
  return encodeURIComponent(String(value));
}

function escapeHeader(value) {
  return String(value).replace(/["\r\n]/g, "_");
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
