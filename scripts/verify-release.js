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
    const runtime = await startServer({ port: { port: 0, host: "127.0.0.1" }, auth: false, environment: {}, bootstrapLogger: () => {} });
    try {
      const health = await fetch(\`http://127.0.0.1:\${runtime.port}/health\`);
      assert.equal(health.status, 200);
      const client = await fetch(\`http://127.0.0.1:\${runtime.port}/client.js\`);
      assert.equal(client.status, 404);
      const base = "http://127.0.0.1:" + runtime.port;
      for (const route of ["/", "/ui", "/ui/"]) {
        const ui = await fetch(base + route);
        assert.equal(ui.status, 200);
        const html = await ui.text();
        assert.match(html, /OBJY/);
        assert.ok(html.includes("components/data-explorer"));
        for (const path of ["/app.js", "/styles.css", "/theme.css", "/components/data-explorer.js", "/licenses/objy-client.txt", "/pdf/pdf.worker.js", "/pdf/wasm/openjpeg.wasm", "/licenses/pdfjs.txt"]) {
          const asset = await fetch(base + path);
          assert.equal(asset.status, 200, path);
          assert.ok((await asset.arrayBuffer()).byteLength > 0);
        }
      }
    } finally {
      await runtime.replication.stop();
      runtime.server.closeAllConnections();
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
