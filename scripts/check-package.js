import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease } from "./build-release.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = await buildRelease();
const item = manifest.package;

if (item.name !== "@objy/db") {
  throw new Error(`release package must be @objy/db, received ${item.name}`);
}
if (item.artifact !== `objy-db-${manifest.version}.tgz`) {
  throw new Error(`unexpected database release artifact: ${item.artifact}`);
}

const paths = new Set(item.files.map(({ path }) => path));
for (const path of [
  "README.md",
  "DB.md",
  "API.md",
  "LICENSE",
  "NOTICE.md",
  "objydb.config.json",
  "package.json",
  "public/ui/index.html",
  "public/ui/app.js",
  "public/ui/components/data-explorer.js",
  "public/ui/styles.css",
  "public/ui/theme.css",
  "public/ui/licenses/objy-client.txt",
  "public/ui/licenses/pdfjs.txt",
  "public/ui/pdf/pdf.worker.js",
  "public/ui/pdf/wasm/openjpeg.wasm",
  "public/ui/pdf/standard_fonts/LiberationSans-Regular.ttf",
  "src/api.js",
  "src/index.js",
]) {
  if (!paths.has(path)) throw new Error(`database package is missing ${path}`);
}

for (const path of paths) {
  if (["src/browser.js", "src/compression.js", "src/core.js", "src/core.d.ts", "src/database.js"].includes(path) ||
      path.startsWith("bin/") || path.startsWith("client/") || path.startsWith("release/") || path === "public/index.html" ||
      path.startsWith("ui/")) {
    throw new Error(`database package contains removed or private source ${path}`);
  }
}

const packageJson = JSON.parse(await readFile(join(root, item.stage, "package.json"), "utf8"));
if (packageJson.bin) throw new Error("database package must not expose a CLI binary");
if (packageJson.dependencies?.["@objy/client"]) throw new Error("database package must not depend on the standalone client");
if (packageJson.exports?.["./client"]) throw new Error("database package must not export the standalone client");

for (const path of ["README.md", "DB.md", "API.md"]) {
  const source = await readFile(join(root, path), "utf8");
  const packaged = await readFile(join(root, item.stage, path), "utf8");
  if (packaged !== source) throw new Error(`packaged ${path} differs from its source`);
}

console.log(`${item.name}@${item.version}: ${paths.size} files, ${item.size} bytes`);
