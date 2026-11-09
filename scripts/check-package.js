import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease } from "./build-release.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = await buildRelease();
const item = manifest.package;

if (item.name !== "@objy/server") {
  throw new Error(`release package must be @objy/server, received ${item.name}`);
}

const paths = new Set(item.files.map(({ path }) => path));
for (const path of [
  "API.md",
  "LICENSE",
  "NOTICE.md",
  "objydb.config.json",
  "package.json",
  "public/index.html",
  "src/api.js",
  "src/index.js",
]) {
  if (!paths.has(path)) throw new Error(`server package is missing ${path}`);
}

for (const path of paths) {
  if (["src/browser.js", "src/compression.js", "src/core.js", "src/core.d.ts", "src/database.js"].includes(path) ||
      path.startsWith("bin/") || path.startsWith("client/") || path.startsWith("release/")) {
    throw new Error(`server package contains removed or private source ${path}`);
  }
}

const packageJson = JSON.parse(await readFile(join(root, item.stage, "package.json"), "utf8"));
if (packageJson.bin) throw new Error("server package must not expose a CLI binary");
if (packageJson.dependencies?.["@objy/client"]) throw new Error("server package must not depend on the standalone client");
if (packageJson.exports?.["./client"]) throw new Error("server package must not export the standalone client");

console.log(`${item.name}@${item.version}: ${paths.size} files, ${item.size} bytes`);
