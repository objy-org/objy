import { isNdjsonContentType, parseNdjsonStream } from "./ndjson.js";

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
  // A downstream auth rejection cannot undo work already begun by this node.
  if (status >= 400 && res.operationStarted && body?.operationStarted === false) body = { ...body, operationStarted: true };
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

export function remoteHttpError(remote, fallback) {
  const err = new Error(remote.body?.error || fallback);
  err.status = remote.status;
  err.body = remote.body;
  return err;
}

export function isNdjsonRequest(req) {
  return isNdjsonContentType(req.headers?.["content-type"]);
}

export async function* readNdjson(req, { maxObjectBytes = 0 } = {}) {
  let totalBytes = 0;
  const counting = (async function* () {
    for await (const chunk of req) {
      totalBytes += chunk.length;
      req._bodyBytes = totalBytes;
      yield chunk;
    }
  })();

  for await (const entry of parseNdjsonStream(counting, { maxObjectBytes, label: "NDJSON" })) {
    req._bodyBytes = totalBytes;
    yield entry;
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
