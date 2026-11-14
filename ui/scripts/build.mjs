import { build } from "esbuild";
import {
  mkdir,
  copyFile,
  readdir,
  rm,
  readFile,
  writeFile,
  mkdtemp,
  cp,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

export async function buildSite({ serverOutput = false } = {}) {
  const staging = await mkdtemp(join(tmpdir(), "objy-build-"));
  try {
    const options = {
      absWorkingDir: root,
      outdir: staging,
      bundle: true,
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "linked",
      metafile: true,
    };
    const results = await Promise.all([
      build({ ...options, splitting: true, format: "esm", entryPoints: {
        app: "src/ui/app.js", styles: "src/ui/styles.css", theme: "src/ui/theme.css",
      } }),
      // Keep the reusable component self-contained, loadable by a plain script tag.
      build({ ...options, format: "iife", entryPoints: {
        "components/data-explorer": "src/ui/components/data-explorer.js",
      } }),
    ]);
    if (
      results.some((result) => Object.keys(result.metafile.inputs).some((path) =>
        /node_modules\/@objy\/(db|server)\//.test(path),
      ))
    ) {
      throw new Error("The UI must not bundle a database engine or server.");
    }
    let html = await readFile(join(root, "src/index.html"), "utf8");
    for (const file of [
      "app.js",
      "components/data-explorer.js",
      "styles.css",
      "theme.css",
    ]) {
      const hash = createHash("sha256")
        .update(await readFile(join(staging, file)))
        .digest("hex")
        .slice(0, 8);
      html = html.replace(`/${file}"`, `/${file}?v=${hash}"`);
    }
    await writeFile(join(staging, "index.html"), html);
    await mkdir(join(staging, "licenses"));
    await copyFile(
      join(
        dirname(fileURLToPath(import.meta.resolve("@objy/client"))),
        "LICENSE",
      ),
      join(staging, "licenses/objy-client.txt"),
    );
    const pdfPackage = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
    await mkdir(join(staging, "pdf"));
    await copyFile(join(pdfPackage, "legacy/build/pdf.worker.mjs"), join(staging, "pdf/pdf.worker.js"));
    for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"])
      await cp(join(pdfPackage, directory), join(staging, "pdf", directory), { recursive: true });
    await copyFile(join(pdfPackage, "LICENSE"), join(staging, "licenses/pdfjs.txt"));
    // Finish the build before touching the served directory; retain its inode for
    // existing static servers. dist contains generated files only.
    const outputs = [join(root, "dist")];
    if (serverOutput) outputs.push(resolve(root, "../public/ui"));
    for (const output of outputs) {
      await mkdir(output, { recursive: true });
      for (const file of await readdir(output))
        await rm(join(output, file), { recursive: true, force: true });
      await cp(staging, output, { recursive: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildSite({ serverOutput: process.argv.includes("--server") });
  console.log("Built dist/ from src/.");
}
