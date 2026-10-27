import { execFileSync } from "node:child_process";

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
}));
const paths = pack.files.map((file) => file.path);
const required = [
  "bin/objy.js",
  "client/index.js",
  "LICENSE",
  "NOTICE.md",
  "objydb.config.json",
  "package.json",
  "src/api.js",
  "src/index.js",
];
const forbidden = [
  /^\.npm-cache\//,
  /^\.DS_Store$/,
  /^browser-tests\//,
  /^benchmarks\//,
  /^examples\//,
  /^public\/branding\//,
  /^scripts\//,
  /^stress\//,
  /^test\//,
  /^test-results\//,
];

for (const path of required) {
  if (!paths.includes(path)) throw new Error(`published package is missing ${path}`);
}
for (const path of paths) {
  if (forbidden.some((pattern) => pattern.test(path))) {
    throw new Error(`published package contains private development file ${path}`);
  }
}

console.log(`package ${pack.id}: ${paths.length} files, ${pack.size} bytes`);
