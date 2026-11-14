import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { text } from "../http-router.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const contentTypes = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".icc": "application/vnd.iccprofile",
};

// Register exact build assets only; never serve source, credentials or arbitrary paths.
function assets(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const url = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return assets(path, url);
    const type = contentTypes[extname(entry.name)];
    return entry.isFile() && type ? [{ url, type, body: readFileSync(path) }] : [];
  });
}

export function createUiInterface() {
  const directory = join(root, "public", "ui");
  let html;
  try {
    html = readFileSync(join(directory, "index.html"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("Build the server UI first with npm run build:ui.", { cause: error });
    throw error;
  }
  const files = assets(directory);
  const docs = readFileSync(join(root, "API.md"), "utf8");
  const logo = readFileSync(join(root, "public", "objy-db-logo.png"));
  const sendAsset = (body, type) => (_req, res) => {
    res.writeHead(200, {
      "content-type": type,
      "content-length": body.byteLength,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  };
  return {
    name: "ui",
    register(router) {
      const send = (_req, res) => {
        res.setHeader("cache-control", "no-store");
        text(res, 200, html, "text/html; charset=utf-8");
      };
      for (const path of ["/", "/ui", "/ui/", "/index.html"]) router.get(path, send);
      for (const file of files) router.get(file.url, sendAsset(file.body, file.type));
      router.get("/objy-db-logo.png", sendAsset(logo, "image/png"));
      router.get("/API.md", (_req, res) => text(res, 200, docs, "text/markdown; charset=utf-8"));
    },
  };
}
