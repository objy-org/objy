import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
export function staticServer(directory, { route } = {}) {
  const root = resolve(directory);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (route && (await route(req, res, url))) return;
      const path = resolve(
        root,
        "." +
          decodeURIComponent(
            url.pathname === "/" ? "/index.html" : url.pathname,
          ),
      );
      if (!path.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      const data = await readFile(path);
      res.writeHead(200, {
        "content-type": types[extname(path)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    } catch (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500).end("Unavailable");
    }
  });
}
