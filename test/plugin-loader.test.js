import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObjectHookRegistry } from "../src/object-hooks.js";
import { loadPlugins } from "../src/plugin-loader.js";

test("file plugins register hooks relative to the config file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spread-db-plugin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "example.mjs"), `
    export function register({ objectHooks, options }) {
      objectHooks.register(options.name, async (context, next) => {
        context.input.objects[0].plugin = true;
        await next();
      });
    }
  `);

  const objectHooks = createObjectHookRegistry();
  await loadPlugins([{ file: "./example.mjs", options: { name: "example" } }], {
    configPath: join(directory, "spread-db.config.json"),
    objectHooks,
  });

  const hook = objectHooks.get("example");
  assert.ok(hook);
  const context = { input: { objects: [{}] } };
  await hook.handler(context, async () => {});
  assert.equal(context.input.objects[0].plugin, true);
});

test("invalid plugin files fail at startup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spread-db-plugin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "invalid.mjs"), "export const name = 'invalid';\n");
  await assert.rejects(
    loadPlugins(["./invalid.mjs"], { configPath: join(directory, "config.json") }),
    /must export register/,
  );
});
