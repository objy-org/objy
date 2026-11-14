import test from "node:test";
import assert from "node:assert/strict";
import { previewKind } from "../src/ui/attachments.js";
import { png, pdf } from "./helpers/attachment-fixtures.mjs";

test("preview uses response MIME and PDF bytes, never a filename or HTML content", async () => {
  assert.equal(await previewKind(new File([png], "picture.png", { type: "image/png" })), "image");
  assert.equal(await previewKind(new File([pdf], "file.pdf", { type: "application/pdf" })), "pdf");
  assert.equal(await previewKind(new File(["<script>alert(1)</script>"], "image.png", { type: "text/html" })), null);
  assert.equal(await previewKind(new Blob(["<script>alert(1)</script>"], { type: "application/pdf" })), null);
  assert.equal(await previewKind(new Blob([pdf], { type: "application/octet-stream" })), null);
});
