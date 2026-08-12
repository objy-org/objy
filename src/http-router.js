const MAX_BODY = 64 * 1024 * 1024;

export class HttpRouter {
  constructor() {
    this.routes = [];
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
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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
