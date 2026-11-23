import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Connections, ConnectionStorage } from "../src/data/connections.js";
import { createServerAdapter } from "../src/data/adapters.js";
import { testServer } from "./helpers/server.mjs";

const password = "session-test-password";
function memoryStorage() {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key: (i) => [...entries.keys()][i] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}
async function fixture(t, auth = {}) {
  const server = await testServer({
    auth: { enabled: true, ...auth },
    environment: { OBJYDB_ADMIN_PASSWORD: password },
  });
  t.after(() => server.close());
  const localStorage = memoryStorage();
  const storage = () => new ConnectionStorage({ storage: localStorage });
  const manager = async (options) => {
    const value = new Connections({ storage: storage(), ...options });
    t.after(() => value.close());
    await value.restore();
    return value;
  };
  const login = (m) =>
    m.connect({ url: server.url, username: "admin", password });
  return { server, storage, localStorage, manager, login };
}

test("reload restores official-client login and selected server; only whitelisted metadata/tokens are saved", async (t) => {
  const f = await fixture(t),
    first = await f.manager();
  const entry = await f.login(first);
  await entry.store.createDatabase("saved_on_server");
  await entry.store.createCollections("saved_on_server", ["items"]);
  await entry.store.insertObjects("saved_on_server", "items", [
    { name: "not-in-browser-storage" },
  ]);
  entry.viewState = {
    drafts: [["object", { text: "draft-not-saved" }]],
    collection: "private-selection-not-saved",
  };
  const record = await first.storage.get(entry.id);
  assert.equal(record.url, f.server.url + "/");
  assert.deepEqual(Object.keys(record.session).sort(), [
    "accessToken",
    "collection",
    "database",
    "refreshToken",
    "url",
  ]);
  for (const value of [
    password,
    "not-in-browser-storage",
    "private-selection-not-saved",
    "draft-not-saved",
  ])
    assert.ok(!JSON.stringify(record).includes(value));
  const second = await f.manager();
  assert.equal(second.activeId, entry.id);
  assert.equal(
    (await second.active.store.query("saved_on_server", "items"))[0].name,
    "not-in-browser-storage",
  );
  assert.deepEqual(second.active.viewState, {});
  await first.close();
  assert.ok(
    (await second.storage.get(entry.id)).session,
    "page teardown must not erase saved login",
  );
});

test("concurrent tabs renew through their own official clients and persist a usable session for reload", async (t) => {
  const f = await fixture(t, {
    accessTokenTtlSeconds: 1,
    refreshTokenTtlSeconds: 60,
  });
  let logins = 0,
    renewals = 0;
  f.server.runtime.server.on("request", (req) => {
    if (req.url.endsWith("/auth")) logins++;
    if (req.url.endsWith("/renew")) renewals++;
  });
  const first = await f.manager(),
    entry = await f.login(first),
    second = await f.manager();
  const original = (await first.storage.get(entry.id)).session;
  await delay(2100);
  await Promise.all([
    first.active.store.refresh(),
    first.active.store.adapter.getClusterStatus(),
    second.active.store.refresh(),
    second.active.store.adapter.getClusterStatus(),
  ]);
  const renewed = (await first.storage.get(entry.id)).session;
  assert.ok(
    renewed.accessToken !== original.accessToken,
    "access token was not renewed",
  );
  assert.ok(
    renewed.refreshToken !== original.refreshToken,
    "refresh token was not replaced",
  );
  assert.equal(renewals, 2, "the SDK coalesces renewal within each client");
  assert.equal(logins, 1);
  const third = await f.manager();
  assert.equal(third.activeId, entry.id);
  assert.equal(logins, 1);
  assert.ok(
    third.active.store.adapter.getSession().accessToken === renewed.accessToken,
  );
});

test("expired refresh credentials are removed while the saved server remains available for sign-in", async (t) => {
  const f = await fixture(t, {
    accessTokenTtlSeconds: 1,
    refreshTokenTtlSeconds: 1,
  });
  const first = await f.manager(),
    entry = await f.login(first);
  await delay(2100);
  await assert.rejects(first.use(entry.id), /Authentication/);
  assert.equal((await first.storage.get(entry.id)).session, null);
  const second = await f.manager();
  assert.equal(second.activeId, null);
  assert.equal(second.entries.size, 1);
  assert.equal(second.entries.get(entry.id).needsLogin, true);
  assert.match(second.restoreError, /expired|removed/);
  assert.equal(second.entries.get(entry.id).record.username, "admin");
});

test("offline restore and ordinary permission failures retain tokens and allow retry", async (t) => {
  const f = await fixture(t),
    first = await f.manager(),
    entry = await f.login(first);
  const original = (await first.storage.get(entry.id)).session;
  let fault = "offline";
  const second = await f.manager({
    adapterFactory: (options) =>
      createServerAdapter({
        ...options,
        fetch: async (url, init) => {
          if (fault === "offline") throw new TypeError("Offline");
          if (fault === "forbidden")
            return new Response(JSON.stringify({ error: "Denied" }), {
              status: 403,
            });
          return fetch(url, init);
        },
      }),
  });
  assert.equal(second.activeId, null);
  assert.match(second.restoreError, /Could not reach/);
  assert.ok(
    JSON.stringify((await first.storage.get(entry.id)).session) ===
      JSON.stringify(original),
  );
  fault = "forbidden";
  await assert.rejects(second.use(entry.id), /permission/);
  assert.ok(
    JSON.stringify((await first.storage.get(entry.id)).session) ===
      JSON.stringify(original),
  );
  fault = "";
  await second.use(entry.id);
  assert.equal(second.activeId, entry.id);
});

test("a rejected access token clears saved credentials without replaying the operation", async (t) => {
  const f = await fixture(t),
    first = await f.manager(),
    entry = await f.login(first);
  let attempts = 0;
  const second = await f.manager({
    adapterFactory: (options) =>
      createServerAdapter({
        ...options,
        fetch: async () => {
          attempts++;
          return new Response(JSON.stringify({ error: "Invalid token" }), {
            status: 401,
          });
        },
      }),
  });
  assert.equal(attempts, 1);
  assert.equal(second.activeId, null);
  assert.equal((await first.storage.get(entry.id)).session, null);
});

test("forget removes credentials immediately and stale tabs cannot restore or use the deleted session", async (t) => {
  const f = await fixture(t);
  let release,
    started,
    block = false;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const first = await f.manager({
    adapterFactory: (options) =>
      createServerAdapter({
        ...options,
        fetch: async (url, init) => {
          if (block) {
            started();
            await barrier;
          }
          return fetch(url, init);
        },
      }),
  });
  const entry = await f.login(first),
    second = await f.manager();
  await first.active.store.loadDatabase("_global");
  block = true;
  const request = first.active.store.query("_global", "users");
  await waiting;
  await second.disconnect(entry.id);
  assert.equal(first.storage.get(entry.id), null);
  release();
  await request;
  assert.equal(await first.storage.get(entry.id), null);
  await assert.rejects(first.active.store.refresh(), /Authentication/);
  assert.equal(await first.storage.get(entry.id), null);
  const third = await f.manager();
  assert.equal(third.entries.size, 0);
  assert.equal(third.activeId, null);
});

test("server identity and authentication scope are bound to the saved session", async (t) => {
  const f = await fixture(t),
    first = await f.manager(),
    entry = await f.login(first);
  const record = await first.storage.get(entry.id);
  await first.storage.put({ ...record, url: "http://127.0.0.1:1/" });
  assert.equal((await first.storage.get(entry.id)).session, null);
  const second = await f.manager();
  assert.equal(second.activeId, null);
  assert.equal(second.entries.get(entry.id).needsLogin, true);
  await first.storage.put({ ...record, collection: "different" });
  assert.equal((await first.storage.get(entry.id)).session, null);
  await assert.rejects(
    first.connect({ url: "http://user:password@127.0.0.1:1" }),
    /without credentials/,
  );
});

test("replacement login invalidates old clients instead of redirecting their operations", async (t) => {
  const f = await fixture(t),
    first = await f.manager(),
    entry = await f.login(first),
    second = await f.manager();
  await second.connect(
    { url: f.server.url, username: "admin", password },
    { id: entry.id },
  );
  await assert.rejects(
    first.active.store.createDatabase("must_not_exist"),
    /Authentication/,
  );
  await second.active.store.refresh();
  assert.ok(
    !second.active.store.databases.some((db) => db.name === "must_not_exist"),
  );
});

for (const change of ["forget", "replace"]) {
  test(`a delayed renewal cannot undo ${change} in another tab`, async (t) => {
    const f = await fixture(t, {
      accessTokenTtlSeconds: 1,
      refreshTokenTtlSeconds: 60,
    });
    let started, release;
    const waiting = new Promise((resolve) => { started = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const first = await f.manager({
      adapterFactory: (options) => createServerAdapter({
        ...options,
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          if (url.endsWith("/renew")) {
            started();
            await barrier;
          }
          return response;
        },
      }),
    });
    const entry = await f.login(first), second = await f.manager();
    await delay(2100);
    const request = first.active.store.refresh();
    await waiting;
    if (change === "forget") await second.disconnect(entry.id);
    else await second.connect(
      { url: f.server.url, username: "admin", password }, { id: entry.id },
    );
    const expected = first.storage.get(entry.id);
    release();
    await request;
    assert.deepEqual(first.storage.get(entry.id), expected);
    await assert.rejects(first.active.store.refresh(), /Authentication/);
    assert.deepEqual(first.storage.get(entry.id), expected);
  });
}

test("storage failure after renewal never turns a confirmed database write into a retry", async (t) => {
  const f = await fixture(t, {
    accessTokenTtlSeconds: 1,
    refreshTokenTtlSeconds: 60,
  });
  const first = await f.manager(),
    entry = await f.login(first);
  await entry.store.createDatabase("test");
  await entry.store.createCollections("test", ["items"]);
  await delay(2100);
  const put = first.storage.put.bind(first.storage);
  first.storage.put = () => {
    throw new Error("Storage full");
  };
  const receipt = await entry.store.insertObjects("test", "items", [
    { _id: "exactly-once" },
  ]);
  assert.equal(receipt.inserted, 1);
  assert.match(first.warning, /Storage full/);
  first.storage.put = put;
  await entry.store.refresh();
  assert.equal((await entry.store.query("test", "items")).length, 1);
  assert.ok(
    (await first.storage.get(entry.id)).session.accessToken ===
      entry.store.adapter.getSession().accessToken,
  );
});

test("failed local credential deletion is reported and cannot falsely claim the connection was forgotten", async (t) => {
  const f = await fixture(t),
    first = await f.manager(),
    entry = await f.login(first);
  first.storage.remove = () => {
    throw new Error("Storage blocked");
  };
  await assert.rejects(first.disconnect(entry.id), /Storage blocked/);
  assert.equal(first.activeId, entry.id);
  assert.ok((await first.storage.get(entry.id)).session);
});

test("unavailable browser storage is visible and allows only an explicitly page-local connection", async (t) => {
  const f = await fixture(t);
  const manager = new Connections({
    storage: new ConnectionStorage({ storage: null }),
  });
  t.after(() => manager.close());
  await manager.restore();
  assert.equal(manager.storage, null);
  assert.match(manager.warning, /page only/);
  await f.login(manager);
  assert.ok(manager.active);
});

test("a blocked localStorage getter is handled when opening storage", (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("Storage blocked"); },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
  const storage = new ConnectionStorage();
  assert.throws(() => storage.open(), /page only/);
});

test("corrupt saved metadata is ignored without contacting its address", async (t) => {
  const f = await fixture(t),
    first = await f.manager();
  f.localStorage.setItem(first.storage.key("broken"), JSON.stringify({
    version: 1,
    id: "broken",
    generation: "one",
    url: "https://name:secret@example.com",
    database: "_global",
    collection: "users",
  }));
  f.localStorage.setItem(first.storage.key("bad-json"), "{");
  f.localStorage.setItem("unrelated-app-setting", "untouched");
  await first.storage.setActive("broken");
  let attempts = 0;
  const second = await f.manager({
    adapterFactory: () => {
      attempts++;
      throw new Error("Must not contact corrupt address");
    },
  });
  assert.equal(attempts, 0);
  assert.equal(second.activeId, null);
  assert.equal(second.entries.size, 0);
  assert.equal(f.localStorage.getItem("unrelated-app-setting"), "untouched");
});

test("saved connections restore the selected server and never send one server token to another", async (t) => {
  const f = await fixture(t),
    first = await f.manager();
  const a = await f.login(first);
  const other = await testServer({
    auth: { enabled: true },
    environment: { OBJYDB_ADMIN_PASSWORD: "other-server-password" },
  });
  t.after(() => other.close());
  const b = await first.connect({
    url: other.url,
    username: "admin",
    password: "other-server-password",
  });
  const tokens = new Map();
  tokens.set(f.server.url, (await first.storage.get(a.id)).session.accessToken);
  tokens.set(other.url, (await first.storage.get(b.id)).session.accessToken);
  const second = await f.manager({
    adapterFactory: (options) =>
      createServerAdapter({
        ...options,
        fetch: async (url, init) => {
          const expected = tokens.get(new URL(url).origin);
          assert.ok(
            expected &&
              new Headers(init.headers).get("authorization") ===
                `Bearer ${expected}`,
            "wrong server credentials",
          );
          return fetch(url, init);
        },
      }),
  });
  assert.equal(second.entries.size, 2);
  assert.equal(second.activeId, b.id);
  await second.use(a.id);
  assert.equal(second.activeId, a.id);
  await second.disconnect(a.id);
  const third = await f.manager();
  assert.equal(third.entries.size, 1);
  assert.equal(third.activeId, null, "forget must not choose another server");
});
