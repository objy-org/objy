import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportDirectory = resolve(root, ".performance-results");

await rm(reportDirectory, { recursive: true, force: true });
await mkdir(reportDirectory, { recursive: true });
run(process.execPath, ["scripts/build-release.js"]);
run(process.execPath, [
  "--expose-gc",
  "benchmarks/server.js",
  ...process.argv.slice(2),
], { SERVER_REPORT_DIR: reportDirectory });

console.log(`server benchmark passed; reports: ${reportDirectory}`);

function run(command, args, extraEnvironment = {}) {
  const child = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnvironment },
    encoding: "utf8",
    stdio: "inherit",
  });
  if (child.status !== 0) process.exit(child.status || 1);
}
