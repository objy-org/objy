import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { text } from "../http-router.js";

const UI_HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "index.html"),
  "utf8",
);

export function createUiInterface() {
  return {
    name: "ui",
    register(router) {
      const send = (req, res) => text(res, 200, UI_HTML, "text/html; charset=utf-8");
      router.get("/", send);
      router.get("/ui", send);
      router.get("/index.html", send);
    },
  };
}
