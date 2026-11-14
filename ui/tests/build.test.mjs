import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  cp,
  symlink,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Script } from "node:vm";
import { root } from "../scripts/build.mjs";

test("a clean build needs no dist, preserves source and removes obsolete output", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "objy-clean-build-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  for (const path of ["src", "scripts", "package.json"])
    await cp(join(root, path), join(checkout, path), { recursive: true });
  await symlink(
    join(root, "..", "node_modules"),
    join(checkout, "node_modules"),
  );
  const before = await readFile(join(checkout, "src/ui/app.js"), "utf8");
  const build = () =>
    promisify(execFile)(process.execPath, ["scripts/build.mjs"], {
      cwd: checkout,
    });
  await build();
  // Consumers can load this one artifact without module imports or the app shell.
  new Script(await readFile(join(checkout, "dist/components/data-explorer.js"), "utf8"));
  const html = await readFile(join(checkout, "dist/index.html"), "utf8");
  for (const match of html.matchAll(
    /(?:href|src)="\/([^"?]+)(?:\?[^" ]*)?"/g,
  )) {
    assert.ok(
      (await readFile(join(checkout, "dist", match[1]))).length > 0,
      `Missing asset ${match[1]}`,
    );
  }
  assert.ok(
    !(await readdir(join(checkout, "dist"))).some((name) =>
      ["ai", "data", "__qa"].includes(name),
    ),
  );
  await writeFile(join(checkout, "dist/obsolete.js"), "unused");
  await build();
  assert.ok(!(await readdir(join(checkout, "dist"))).includes("obsolete.js"));
  assert.equal(await readFile(join(checkout, "src/ui/app.js"), "utf8"), before);
});
