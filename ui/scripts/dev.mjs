import { watch } from "node:fs";
import { join } from "node:path";
import { buildSite, root } from "./build.mjs";
import { staticServer } from "./static-server.mjs";

await buildSite();
const port = Number(process.env.PORT || 4317);
const server = staticServer(join(root, "dist"));
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () =>
  console.log(`OBJY Studio: http://127.0.0.1:${port}/`),
);
let timer,
  building = false,
  pending = false;
async function rebuild() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  try {
    await buildSite();
    console.log("Rebuilt. Refresh the browser to see changes.");
  } catch (error) {
    console.error(error.message);
  } finally {
    building = false;
    if (pending) {
      pending = false;
      rebuild();
    }
  }
}
const watcher = watch(join(root, "src"), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 100);
});
function close() {
  watcher.close();
  clearTimeout(timer);
  server.close(() => process.exit(0));
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
