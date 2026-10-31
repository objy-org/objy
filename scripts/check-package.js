import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseVariants } from "./build-release-variants.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = await buildReleaseVariants();

check("db", "@objy/db", [
  "browser.js",
  "index.d.ts",
  "LICENSE",
  "node.js",
  "NOTICE.md",
  "package.json",
  "README.md",
  "runtime-browser.js",
  "runtime-node.js",
  "shared.js",
]);
check("server", "@objy/server", [
  "API.md",
  "bin/objy.js",
  "client/index.js",
  "LICENSE",
  "NOTICE.md",
  "objydb.config.json",
  "package.json",
  "public/index.html",
  "src/api.js",
  "src/index.js",
]);

for (const path of ["browser.js", "runtime-browser.js", "shared.js"]) {
  const source = await readFile(join(root, manifest.packages.db.stage, path), "utf8");
  if (/["']node:[^"']+["']/.test(source)) {
    throw new Error(`database browser path ${path} contains a Node.js runtime import`);
  }
  for (const forbidden of ["@aws-sdk/", "src/server.js", "src/persistence.js"]) {
    if (source.includes(forbidden)) throw new Error(`database browser path ${path} contains forbidden runtime reference ${forbidden}`);
  }
}

for (const path of manifest.packages.server.files.map(({ path }) => path)) {
  if (["src/browser.js", "src/compression.js", "src/core.js", "src/core.d.ts", "src/database.js"].includes(path) || path.startsWith("release/")) {
    throw new Error(`server package contains local-database or release source ${path}`);
  }
}

if (Object.keys(manifest.packages).sort().join(",") !== "db,server") {
  throw new Error("release must contain exactly the database and server npm packages");
}

function check(id, expectedName, required) {
  const item = manifest.packages[id];
  if (item.name !== expectedName) throw new Error(`${id} package must be named ${expectedName}, received ${item.name}`);
  const paths = new Set(item.files.map(({ path }) => path));
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`${id} package is missing ${path}`);
  }
  console.log(`${item.name}@${item.version}: ${paths.size} files, ${item.size} bytes`);
}
