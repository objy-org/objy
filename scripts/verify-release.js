import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRelease } from "./build-release.js";
import { withNode } from "../test/helpers/launcher.js";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = await buildRelease();
const workspace = await mkdtemp(join(tmpdir(), "objy-db-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await command(workspace, "npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(root, ".release", "artifacts", manifest.package.artifact),
  ]);
  const help = await command(workspace, "npm", ["exec", "--offline", "--", "objy", "--help"]);
  if (!help.stdout.includes("Usage: objy [options]")) throw new Error("installed objy help is missing");
  const version = await command(workspace, "npm", ["exec", "--offline", "--", "objy", "--version"]);
  if (version.stdout.trim() !== manifest.version) throw new Error("installed objy version does not match the package");
  await writeFile(join(workspace, "objydb.config.json"), JSON.stringify({
    node: { id: "installed-launcher" }, server: { port: 0 }, auth: { enabled: false },
  }));
  await withNode({ entry: join(workspace, "node_modules", "@objy", "db", "bin", "objy.js"), cwd: workspace }, async (base) => {
    const health = await fetch(`${base}/health`).then((response) => response.json());
    if (health.node !== "installed-launcher") throw new Error("installed objy ignored its config");
    const object = { _id: "installed", nested: { values: [1, "dynamic", null] } };
    const inserted = await fetch(`${base}/api/app/items/object`, {
      method: "POST", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify(object),
    });
    if (inserted.status !== 201) throw new Error(`installed objy insert failed: ${inserted.status}`);
    await inserted.json();
    const read = await fetch(`${base}/api/app/items/object/installed`).then((response) => response.json());
    if (JSON.stringify(read.nested) !== JSON.stringify(object.nested)) throw new Error("installed objy object readback failed");
  });
  await command(workspace, process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { startServer } from "@objy/db";
    import { createObjectHookRegistry } from "@objy/db/hooks";

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
        for (const path of ["/app.js", "/styles.css", "/theme.css", "/components/data-explorer.js", "/licenses/objy-client.txt"]) {
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

console.log(`database release passed isolated install, objy command, and runtime smoke tests (${manifest.version})`);

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
