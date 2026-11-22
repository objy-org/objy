import test from "node:test";
import assert from "node:assert/strict";
import { browserViewable, openAttachment } from "../src/ui/attachments.js";

function tabFixture(t) {
  const tab = { opener: {}, closed: false, document: { title: "", body: {} },
    location: { replace(url) { tab.url = url; } }, close() { tab.closed = true; } };
  const previous = globalThis.window;
  globalThis.window = { open: () => tab };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  return tab;
}

test("native tabs accept passive MIME types, not executable documents or guessed extensions", () => {
  for (const type of ["application/pdf", "application/json", "text/plain; charset=utf-8", "IMAGE/PNG", "image/jpeg", "audio/mpeg", "video/mp4"])
    assert.equal(browserViewable(type), true, type);
  for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml", "application/octet-stream", "", "image/html"])
    assert.equal(browserViewable(type), false, type);
});

test("reserve a tab before awaiting the client; detach opener and retain the blob until close", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const tab = tabFixture(t), blob = new Blob(["native text"], { type: "text/plain" });
  const revoke = t.mock.method(URL, "revokeObjectURL");
  let finish;
  const pending = openAttachment(() => new Promise(resolve => { finish = resolve; }), "note.txt");
  assert.equal(tab.opener, null);
  assert.equal(tab.document.title, "note.txt");
  assert.equal(tab.document.body.textContent, "Loading attachment…");
  finish(blob);
  await pending;
  assert.match(tab.url, /^blob:/);
  assert.equal(await (await fetch(tab.url)).text(), "native text");
  t.mock.timers.tick(60_000);
  assert.equal(revoke.mock.callCount(), 0, "An open native viewer must keep its save/reload URL");
  tab.close();
  t.mock.timers.tick(1000);
  assert.equal(revoke.mock.callCount(), 1);
});

test("blocked tabs do not fetch; failed downloads close their blank tab", async (t) => {
  const tab = tabFixture(t);
  await assert.rejects(openAttachment(async () => { throw new Error("File unavailable"); }, "file"), /File unavailable/);
  assert.equal(tab.closed, true);
  window.open = () => null;
  await assert.rejects(openAttachment(() => { assert.fail("Must not fetch without a tab"); }, "file"), /Allow pop-ups/);
});

test("closing a loading tab cancels the authenticated request", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const tab = tabFixture(t);
  let signal;
  const pending = openAttachment((requestSignal) => {
    signal = requestSignal;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  }, "file");
  tab.close();
  t.mock.timers.tick(1000);
  assert.equal(signal.aborted, true);
  await pending;
  assert.equal(tab.url, undefined);
});
