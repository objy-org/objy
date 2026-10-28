import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseVariants } from "./build-release-variants.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = await buildReleaseVariants();

check("core", ["index.js", "index.d.ts", "browser.d.ts", "LICENSE", "NOTICE.md", "package.json", "README.md"]);
check("browser", ["index.js", "index.d.ts", "LICENSE", "NOTICE.md", "package.json", "README.md"]);
check("server", [
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

const portable = ["core", "browser"];
for (const id of portable) {
  const source = await readFile(join(root, manifest.packages[id].stage, "index.js"), "utf8");
  if (/["']node:[^"']+["']/.test(source)) {
    throw new Error(`${id} package contains a Node.js runtime import`);
  }
  for (const forbidden of ["@aws-sdk/", "src/server.js", "src/persistence.js"]) {
    if (source.includes(forbidden)) throw new Error(`${id} package contains forbidden runtime reference ${forbidden}`);
  }
}

for (const path of manifest.packages.server.files.map(({ path }) => path)) {
  if (path === "src/browser.js" || path === "src/browser.d.ts" || path.startsWith("release/")) {
    throw new Error(`server package contains browser or release source ${path}`);
  }
}

function check(id, required) {
  const item = manifest.packages[id];
  const paths = new Set(item.files.map(({ path }) => path));
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`${id} package is missing ${path}`);
  }
  console.log(`${item.name}@${item.version}: ${paths.size} files, ${item.size} bytes`);
}
