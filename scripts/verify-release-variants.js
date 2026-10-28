import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildReleaseVariants } from "./build-release-variants.js";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const manifest = await buildReleaseVariants();

await verifyPackage("core", async (workspace) => {
  await node(workspace, `
    import assert from "node:assert/strict";
    import { createDatabase } from "objydb";

    const database = createDatabase({ storage: { engine: "object" } });
    await database.createDatabase("package_test");
    await database.database("package_test").createCollection("assets", {
      indexes: ["status"],
      columns: ["score"],
    });
    const assets = database.database("package_test").collection("assets");
    await assets.insertMany([
      { _id: "one", status: "active", score: 12 },
      { _id: "two", status: "archived", score: 8 },
    ]);
    await assets.ready();
    assert.deepEqual((await assets.find({ status: "active" })).map(({ _id }) => _id), ["one"]);
    assert.equal((await assets.search({ $aggregate: { fields: { total: { $sum: "score" } } } }))[0].total, 20);
    database.close();
  `);
});

await verifyPackage("browser", async (workspace) => {
  await node(workspace, `
    import assert from "node:assert/strict";
    import { createDatabase } from "@objydb/browser";
    const database = createDatabase();
    await database.createDatabase("browser_package");
    assert.deepEqual(await database.listDatabases(), { databases: ["browser_package"] });
    database.close();
  `);
});

await verifyPackage("server", async (workspace) => {
  await node(workspace, `
    import assert from "node:assert/strict";
    import { createClient, startServer } from "@objydb/server";
    import { createObjectHookRegistry } from "@objydb/server/hooks";

    assert.equal(typeof createClient, "function");
    assert.equal(typeof createObjectHookRegistry, "function");
    const runtime = await startServer({ port: 0, bootstrapLogger: () => {} });
    try {
      const response = await fetch(\`http://127.0.0.1:\${runtime.port}/health\`);
      assert.equal(response.status, 200);
    } finally {
      await new Promise((resolve) => runtime.server.close(resolve));
      runtime.node.db.dispose();
    }
  `);

  const cli = join(workspace, "node_modules/@objydb/server/bin/objy.js");
  const { stdout } = await command(workspace, process.execPath, [cli, "--version"]);
  if (stdout.trim() !== manifest.version) {
    throw new Error(`server CLI version mismatch: ${stdout.trim()} != ${manifest.version}`);
  }
});

console.log(`release packages passed isolated install and runtime smoke tests (${manifest.version})`);

async function verifyPackage(id, verify) {
  const workspace = await mkdtemp(join(tmpdir(), `objydb-${id}-`));
  const artifact = join(root, ".release/artifacts", manifest.packages[id].artifact);
  try {
    await writeFile(join(workspace, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await command(workspace, "npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      artifact,
    ]);
    await verify(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function node(workspace, source) {
  await command(workspace, process.execPath, ["--input-type=module", "--eval", source]);
}

async function command(workspace, file, args) {
  try {
    return await run(file, args, {
      cwd: workspace,
      env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    const details = [err.stdout, err.stderr].filter(Boolean).join("\n");
    throw new Error(`${file} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`, { cause: err });
  }
}
