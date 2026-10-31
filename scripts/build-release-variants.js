import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseRoot = join(root, ".release");
const stagingRoot = join(releaseRoot, "staging");
const artifactsRoot = join(releaseRoot, "artifacts");

export async function buildReleaseVariants() {
  const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  const database = await buildDatabase(sourcePackage);
  const server = await buildServer(sourcePackage);
  const packages = {};

  for (const variant of [database, server]) {
    const packed = await packVariant(variant);
    packages[variant.id] = packed;
  }

  const browserModule = `objy-db-${sourcePackage.version}.esm.js`;
  const standalone = await bundle({
    entry: join(root, "src/browser.js"),
    outfile: join(artifactsRoot, browserModule),
    platform: "browser",
  });
  assertPortableInputs("standalone browser", standalone.metafile.inputs);

  const checksumFiles = [
    ...Object.values(packages).map(({ artifact }) => artifact),
    browserModule,
  ].sort();
  const checksums = [];
  for (const file of checksumFiles) {
    const body = await readFile(join(artifactsRoot, file));
    checksums.push(`${createHash("sha256").update(body).digest("hex")}  ${file}`);
  }
  await writeFile(join(artifactsRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);

  const manifest = {
    version: sourcePackage.version,
    packages,
    standalone: browserModule,
    checksums: "SHA256SUMS",
  };
  await writeJson(join(releaseRoot, "manifest.json"), manifest);

  for (const item of Object.values(packages)) {
    console.log(`${item.name}@${item.version}: ${item.files.length} files, ${item.size} bytes -> ${item.artifact}`);
  }
  console.log(`release artifacts -> ${relative(root, artifactsRoot)}`);
  return manifest;
}

async function buildDatabase(sourcePackage) {
  const stage = join(stagingRoot, "db");
  await mkdir(stage, { recursive: true });

  const shared = await bundle({
    entry: join(root, "src/database.js"),
    outfile: join(stage, "shared.js"),
    platform: "neutral",
  });
  assertPortableInputs("database", shared.metafile.inputs);
  const browserRuntime = await bundle({
    entry: join(root, "src/compression.js"),
    outfile: join(stage, "runtime-browser.js"),
    platform: "browser",
  });
  assertPortableInputs("browser runtime", browserRuntime.metafile.inputs);
  await bundle({
    entry: join(root, "src/node-runtime.js"),
    outfile: join(stage, "runtime-node.js"),
    platform: "node",
  });
  await writeFile(join(stage, "node.js"), nodeDatabaseEntry());
  await writeFile(join(stage, "browser.js"), browserDatabaseEntry());
  await copyFile(join(root, "src/core.d.ts"), join(stage, "index.d.ts"));
  await copyReleaseFiles(stage, "db.README.md");
  const manifest = packageManifest(sourcePackage, {
    name: "@objy/db",
    description: "The universal in-memory OBJY DB for Node.js and browsers.",
    main: "./node.js",
    browser: "./browser.js",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        node: "./node.js",
        browser: "./browser.js",
        default: "./browser.js",
      },
    },
    sideEffects: false,
    publishConfig: { access: "public" },
  });
  await writeJson(join(stage, "package.json"), manifest);
  return { id: "db", stage };
}

async function buildServer(sourcePackage) {
  const stage = join(stagingRoot, "server");
  await mkdir(stage, { recursive: true });
  await cp(join(root, "bin"), join(stage, "bin"), { recursive: true });
  await cp(join(root, "src"), join(stage, "src"), { recursive: true });
  await rm(join(stage, "src/browser.js"));
  await rm(join(stage, "src/core.js"));
  await rm(join(stage, "src/core.d.ts"));
  await rm(join(stage, "src/compression.js"));
  await rm(join(stage, "src/database.js"));
  await mkdir(join(stage, "public"), { recursive: true });
  await copyFile(join(root, "public/index.html"), join(stage, "public/index.html"));
  await copyFile(join(root, "public/objy-db-logo.png"), join(stage, "public/objy-db-logo.png"));
  await copyFile(join(root, "API.md"), join(stage, "API.md"));
  await copyFile(join(root, "objydb.config.json"), join(stage, "objydb.config.json"));
  await copyReleaseFiles(stage, "server.README.md");

  const manifest = packageManifest(sourcePackage, {
    name: "@objy/server",
    description: sourcePackage.description,
    keywords: [
      ...(sourcePackage.keywords || []),
      "sharding",
      "replication",
      "s3",
    ],
    main: "./src/api.js",
    exports: {
      ".": "./src/api.js",
      "./hooks": "./src/object-hooks.js",
    },
    bin: sourcePackage.bin,
    engines: sourcePackage.engines,
    dependencies: without(sourcePackage.dependencies, "fflate"),
    publishConfig: { access: "public" },
  });
  await writeJson(join(stage, "package.json"), manifest);
  return { id: "server", stage };
}

async function bundle({ entry, outfile, platform }) {
  return build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform,
    target: "es2022",
    treeShaking: true,
    legalComments: "none",
    metafile: true,
  });
}

function assertPortableInputs(variant, inputs) {
  const forbidden = [
    "src/auth.js",
    "src/config.js",
    "src/files.js",
    "src/index.js",
    "src/interfaces/",
    "src/local-wal.js",
    "src/node-runtime.js",
    "src/object-storage.js",
    "src/persistence.js",
    "src/plugin-loader.js",
    "src/replication-scheduler.js",
    "src/server.js",
    "src/shard-map-store.js",
    "src/shard-router.js",
    "src/system-secrets.js",
  ];
  const paths = Object.keys(inputs).map((path) => path.replaceAll("\\", "/"));
  const bad = paths.find((path) => forbidden.some((fragment) => path.includes(fragment)));
  if (bad) throw new Error(`${variant} package includes server module ${bad}`);
}

function nodeDatabaseEntry() {
  return `import { createDatabaseWithRuntime } from "./shared.js";
import { nodeCompression, readHeapUsageRatio } from "./runtime-node.js";

const runtime = Object.freeze({ compression: nodeCompression, readHeapUsageRatio });

export function createDatabase(options = {}) {
  return createDatabaseWithRuntime(options, runtime);
}
`;
}

function browserDatabaseEntry() {
  return `import { createDatabaseWithRuntime } from "./shared.js";
import * as compression from "./runtime-browser.js";

const runtime = Object.freeze({ compression });

export function createDatabase(options = {}) {
  return createDatabaseWithRuntime(options, runtime);
}
`;
}

function without(object = {}, ...keys) {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(object).filter(([key]) => !excluded.has(key)));
}

async function packVariant(variant) {
  const { stdout } = await run("npm", [
    "pack",
    variant.stage,
    "--pack-destination",
    artifactsRoot,
    "--ignore-scripts",
    "--json",
  ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const [pack] = JSON.parse(stdout);
  const source = join(artifactsRoot, basename(pack.filename));
  const artifact = variant.expectedArtifact || basename(pack.filename);
  if (basename(source) !== artifact) await rename(source, join(artifactsRoot, artifact));
  return {
    name: pack.name,
    version: pack.version,
    artifact,
    stage: relative(root, variant.stage),
    size: pack.size,
    unpackedSize: pack.unpackedSize,
    files: pack.files.map(({ path, size }) => ({ path, size })),
  };
}

function packageManifest(sourcePackage, fields) {
  return {
    ...fields,
    version: sourcePackage.version,
    type: "module",
    author: sourcePackage.author,
    repository: sourcePackage.repository,
    bugs: sourcePackage.bugs,
    homepage: sourcePackage.homepage,
    keywords: fields.keywords || sourcePackage.keywords,
    license: sourcePackage.license,
  };
}

async function copyReleaseFiles(stage, readme) {
  await copyFile(join(root, "release", readme), join(stage, "README.md"));
  await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
  await copyFile(join(root, "NOTICE.md"), join(stage, "NOTICE.md"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) await buildReleaseVariants();
