import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { text } from "../http-router.js";

const UI_HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "index.html"),
  "utf8",
);
const API_DOCS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "API.md"),
  "utf8",
);
const LOGO_PNG = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "fastobject-logo.png"),
);

export function createUiInterface() {
  return {
    name: "ui",
    register(router) {
      const send = (req, res) => text(res, 200, UI_HTML, "text/html; charset=utf-8");
      const sendApiDocs = (req, res) => text(res, 200, API_DOCS, "text/markdown; charset=utf-8");
      const sendLogo = (req, res) => {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": LOGO_PNG.byteLength,
          "cache-control": "public, max-age=86400",
        });
        res.end(LOGO_PNG);
      };
      router.get("/", send);
      router.get("/ui", send);
      router.get("/index.html", send);
      router.get("/fastobject-logo.png", sendLogo);
      router.get("/API.md", sendApiDocs);
    },
  };
}
