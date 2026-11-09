import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRelease } from "./build-release.js";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = await buildRelease();
const workspace = await mkdtemp(join(tmpdir(), "objy-server-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await command(workspace, "npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(root, ".release", "artifacts", manifest.package.artifact),
  ]);
  await command(workspace, process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { startServer } from "@objy/server";
    import { createObjectHookRegistry } from "@objy/server/hooks";

    assert.equal(typeof createObjectHookRegistry, "function");
    const runtime = await startServer({ port: 0, bootstrapLogger: () => {} });
    try {
      const health = await fetch(\`http://127.0.0.1:\${runtime.port}/health\`);
      assert.equal(health.status, 200);
      const client = await fetch(\`http://127.0.0.1:\${runtime.port}/client.js\`);
      assert.equal(client.status, 404);
    } finally {
      await new Promise((resolve) => runtime.server.close(resolve));
      runtime.node.db.dispose();
    }
  `]);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log(`server release passed isolated install and runtime smoke tests (${manifest.version})`);

async function command(cwd, file, args) {
  try {
    return await run(file, args, {
      cwd,
      env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    const details = [err.stdout, err.stderr].filter(Boolean).join("\n");
    throw new Error(`${file} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`, { cause: err });
  }
}
