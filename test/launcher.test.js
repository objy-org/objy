import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withNode } from "./helpers/launcher.js";

const run = promisify(execFile);
const entry = fileURLToPath(new URL("../bin/objy.js", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "objy-launcher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("launcher help and version require no config or runtime state", async (t) => {
  const cwd = await workspace(t);
  for (const option of ["--help", "-h"]) {
    const result = await run(process.execPath, [entry, option], { cwd, timeout: 10000 });
    assert.match(result.stdout, /Usage: objy \[options\]/);
    assert.match(result.stdout, /--config/);
    assert.equal(result.stderr, "");
  }
  for (const option of ["--version", "-v"]) {
    const result = await run(process.execPath, [entry, option], { cwd, timeout: 10000 });
    assert.equal(result.stdout.trim(), manifest.version);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("launcher preserves startup validation and exits nonzero on invalid config", async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(run(process.execPath, [entry], { cwd, timeout: 10000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /node id is required/);
    return true;
  });
  await writeFile(join(cwd, "invalid.json"), "{broken");
  await assert.rejects(run(process.execPath, [entry, "--config", "invalid.json"], { cwd, timeout: 10000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /failed to read config/);
    return true;
  });
});

test("launcher loads the working-directory config and supports independent node overrides", { timeout: 30000 }, async (t) => {
  const cwd = await workspace(t);
  const config = JSON.stringify({
    node: { id: "configured" }, server: { port: 0 }, auth: { enabled: false },
    cluster: { secret: "launcher-test-secret" },
  });
  await writeFile(join(cwd, "objydb.config.json"), config);
  await writeFile(join(cwd, "shared.json"), config);
  await withNode({ entry, cwd }, async (first) => {
    const firstHealth = await fetch(`${first}/health`).then((response) => response.json());
    assert.equal(firstHealth.node, "configured");
    const ui = await fetch(`${first}/ui`);
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /OBJY/);
    await withNode({ entry, cwd, args: ["-c", "shared.json", "-n", "overridden", "--url=http://127.0.0.1:9999", "--port=0"] }, async (second) => {
      assert.notEqual(first, second);
      const health = await fetch(`${second}/health`).then((response) => response.json());
      assert.equal(health.node, "overridden");
      const status = await fetch(`${second}/api/config`).then((response) => response.json());
      assert.equal(status.node.url, "http://127.0.0.1:9999");
    });
  });
});
