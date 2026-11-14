import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildSite } from "../ui/scripts/build.mjs";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseRoot = join(root, ".release");
const stage = join(releaseRoot, "staging", "server");
const artifactsRoot = join(releaseRoot, "artifacts");

export async function buildRelease() {
  await buildSite({ serverOutput: true });
  const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  await cp(join(root, "src"), join(stage, "src"), { recursive: true });
  await mkdir(join(stage, "public"), { recursive: true });
  await cp(join(root, "public", "ui"), join(stage, "public", "ui"), { recursive: true });
  await copyFile(join(root, "public", "objy-db-logo.png"), join(stage, "public", "objy-db-logo.png"));
  await copyFile(join(root, "API.md"), join(stage, "API.md"));
  await copyFile(join(root, "objydb.config.json"), join(stage, "objydb.config.json"));
  await copyFile(join(root, "release", "server.README.md"), join(stage, "README.md"));
  await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
  await copyFile(join(root, "NOTICE.md"), join(stage, "NOTICE.md"));
  await writeJson(join(stage, "package.json"), packageManifest(sourcePackage));

  const packed = await packServer();
  const checksum = createHash("sha256")
    .update(await readFile(join(artifactsRoot, packed.artifact)))
    .digest("hex");
  await writeFile(join(artifactsRoot, "SHA256SUMS"), `${checksum}  ${packed.artifact}\n`);

  const manifest = {
    version: sourcePackage.version,
    package: packed,
    checksums: "SHA256SUMS",
  };
  await writeJson(join(releaseRoot, "manifest.json"), manifest);
  console.log(`${packed.name}@${packed.version}: ${packed.files.length} files, ${packed.size} bytes -> ${packed.artifact}`);
  console.log(`release artifacts -> ${relative(root, artifactsRoot)}`);
  return manifest;
}

async function packServer() {
  const { stdout } = await run("npm", [
    "pack",
    stage,
    "--pack-destination",
    artifactsRoot,
    "--ignore-scripts",
    "--json",
  ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const pack = parsePackResult(stdout);
  return {
    name: pack.name,
    version: pack.version,
    artifact: basename(pack.filename),
    stage: relative(root, stage),
    size: pack.size,
    unpackedSize: pack.unpackedSize,
    files: pack.files.map(({ path, size }) => ({ path, size })),
  };
}

function parsePackResult(stdout) {
  const result = JSON.parse(stdout);
  const packs = Array.isArray(result)
    ? result
    : result?.filename
      ? [result]
      : Object.values(result || {});
  const matches = packs.filter((pack) => pack && typeof pack === "object" && pack.filename);
  if (matches.length !== 1) throw new Error(`npm pack returned ${matches.length} package results`);
  return matches[0];
}

function packageManifest(sourcePackage) {
  return {
    name: "@objy/server",
    version: sourcePackage.version,
    description: sourcePackage.description,
    type: "module",
    main: "./src/api.js",
    exports: {
      ".": "./src/api.js",
      "./hooks": "./src/object-hooks.js",
    },
    engines: sourcePackage.engines,
    dependencies: sourcePackage.dependencies,
    author: sourcePackage.author,
    repository: sourcePackage.repository,
    bugs: sourcePackage.bugs,
    homepage: sourcePackage.homepage,
    keywords: sourcePackage.keywords,
    license: sourcePackage.license,
    publishConfig: { access: "public" },
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) await buildRelease();
