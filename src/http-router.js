import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

export class HttpRouter {
  constructor({ maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
    this.routes = [];
    this.maxBodyBytes = maxBodyBytes;
  }

  add(method, pattern, handler) {
    this.routes.push({ method, pattern, handler, ...compilePattern(pattern) });
    return this;
  }

  get(pattern, handler) {
    return this.add("GET", pattern, handler);
  }

  post(pattern, handler) {
    return this.add("POST", pattern, handler);
  }

  put(pattern, handler) {
    return this.add("PUT", pattern, handler);
  }

  patch(pattern, handler) {
    return this.add("PATCH", pattern, handler);
  }

  delete(pattern, handler) {
    return this.add("DELETE", pattern, handler);
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    req.path = url.pathname;
    req.query = url.searchParams;
    req.maxBodyBytes = this.maxBodyBytes;

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = url.pathname.match(route.re);
      if (!match) continue;
      req.params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
      await route.handler(req, res);
      return true;
    }
    return false;
  }
}

export function json(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export async function readJson(req, fallback = {}) {
  const raw = await readBody(req);
  if (!raw) return fallback;
  return JSON.parse(raw);
}

export function isNdjsonRequest(req) {
  const type = String(req.headers?.["content-type"] || "").toLowerCase().split(";")[0].trim();
  return type === "application/x-ndjson" || type === "application/ndjson";
}

export async function* readNdjson(req, { maxObjectBytes = 0 } = {}) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let line = 0;
  let totalBytes = 0;
  const maxBytes = Number(maxObjectBytes) || 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    req._bodyBytes = totalBytes;
    buffer += decoder.write(chunk);

    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const rawLine = stripTrailingCarriageReturn(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      line += 1;
      if (!rawLine.trim()) continue;
      yield parseNdjsonLine(rawLine, line, maxBytes);
    }

    if (maxBytes && Buffer.byteLength(buffer) > maxBytes) {
      throw ndjsonError(413, "object is too large", { line: line + 1, bytes: Buffer.byteLength(buffer), maxObjectBytes: maxBytes });
    }
  }

  buffer += decoder.end();
  if (buffer.length > 0) {
    const rawLine = stripTrailingCarriageReturn(buffer);
    line += 1;
    if (rawLine.trim()) yield parseNdjsonLine(rawLine, line, maxBytes);
  }
}

export function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  const payload = body || "";
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  if (req._bodyText !== undefined) return req._bodyText;
  req._bodyText = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const maxBodyBytes = req.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    req.on("data", (chunk) => {
      size += chunk.length;
      req._bodyBytes = size;
      if (size > maxBodyBytes) {
        if (settled) return;
        settled = true;
        const err = new Error("payload too large");
        err.status = 413;
        err.body = { error: err.message, maxBodyBytes };
        reject(err);
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
  return req._bodyText;
}

function parseNdjsonLine(rawLine, line, maxObjectBytes) {
  const bytes = Buffer.byteLength(rawLine);
  if (maxObjectBytes && bytes > maxObjectBytes) {
    throw ndjsonError(413, "object is too large", { line, bytes, maxObjectBytes });
  }
  try {
    return { line, bytes, value: JSON.parse(rawLine) };
  } catch {
    throw ndjsonError(400, `invalid NDJSON at line ${line}`, { line });
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

function compilePattern(pattern) {
  if (pattern === "/") return { re: /^\/$/, names: [] };
  const names = [];
  const source = pattern
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      return escapeRegex(segment);
    })
    .join("/");
  return { re: new RegExp(`^/${source}$`), names };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
