// Only connection metadata and client tokens belong here. Never objects,
// passwords, user profiles, database objects or editor drafts.
export function serverAddress(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use an HTTP(S) server URL without credentials, query parameters or a fragment.",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function savedSession(value, record) {
  if (!value) return null;
  if (
    value.database !== record.database ||
    value.collection !== record.collection ||
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    (value.refreshToken !== undefined && typeof value.refreshToken !== "string")
  ) {
    throw new Error("Saved login is invalid. Sign in again.");
  }
  return {
    database: value.database,
    collection: value.collection,
    accessToken: value.accessToken,
    ...(value.refreshToken ? { refreshToken: value.refreshToken } : {}),
  };
}

function cleanRecord(value) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.generation !== "string" ||
    !value.generation
  )
    throw new Error("Invalid saved connection.");
  const url = serverAddress(value.url);
  const record = {
    version: 1,
    id: value.id,
    generation: value.generation,
    url,
    username: typeof value.username === "string" ? value.username : "",
    database: value.database,
    collection: value.collection,
    requiresAuth: Boolean(value.requiresAuth),
    session: null,
  };
  for (const key of ["database", "collection"]) {
    if (
      typeof record[key] !== "string" ||
      !record[key] ||
      [".", ".."].includes(record[key])
    )
      throw new Error("Invalid authentication scope.");
  }
  if (value.session) {
    record.requiresAuth = true;
    // A token saved for one base URL must never follow an edited server address.
    if (value.session.url === url) {
      try {
        record.session = { url, ...savedSession(value.session, record) };
      } catch {
        /* Require a new login. */
      }
    }
  }
  return record;
}

export class ConnectionStorage {
  constructor({
    indexedDB = globalThis.indexedDB,
    locks = globalThis.navigator?.locks,
    name = "objy-studio-connections",
  } = {}) {
    this.indexedDB = indexedDB;
    this.locks = locks;
    this.name = name;
  }
  async open() {
    if (this.db) return;
    if (!this.indexedDB || !this.locks?.request)
      throw new Error(
        "This browser cannot safely save shared sessions. This connection will last for this page only.",
      );
    this.db = await new Promise((resolve, reject) => {
      let rejected = false;
      const request = this.indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("connections", { keyPath: "id" });
        request.result.createObjectStore("settings");
      };
      request.onsuccess = () =>
        rejected ? request.result.close() : resolve(request.result);
      request.onerror = () =>
        reject(
          new Error(
            "Saved connections could not be opened. Browser storage may be blocked.",
          ),
        );
      request.onblocked = () => {
        rejected = true;
        reject(
          new Error("Close other Studio tabs to update saved connections."),
        );
      };
    });
    this.db.onversionchange = () => this.close();
  }
  transaction(stores, mode, action) {
    return new Promise((resolve, reject) => {
      let result;
      const tx = this.db.transaction(stores, mode);
      tx.oncomplete = () => resolve(result?.result);
      tx.onabort = tx.onerror = () =>
        reject(
          new Error(
            "Browser storage could not be updated. Saved login may be out of date.",
          ),
        );
      try {
        result = action(tx);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
  lock(id, fn) {
    return this.locks.request(`${this.name}:session:${id}`, fn);
  }
  async list() {
    const values = await this.transaction(["connections"], "readonly", (tx) =>
      tx.objectStore("connections").getAll(),
    );
    const records = [];
    for (const value of values) {
      try {
        records.push(cleanRecord(value));
      } catch {
        /* Invalid metadata is never used for a request. */
      }
    }
    return records;
  }
  async get(id) {
    const value = await this.transaction(["connections"], "readonly", (tx) =>
      tx.objectStore("connections").get(id),
    );
    return value ? cleanRecord(value) : null;
  }
  put(record) {
    return this.transaction(["connections"], "readwrite", (tx) =>
      tx.objectStore("connections").put(cleanRecord(record)),
    );
  }
  active() {
    return this.transaction(["settings"], "readonly", (tx) =>
      tx.objectStore("settings").get("active"),
    );
  }
  setActive(id) {
    return this.transaction(["settings"], "readwrite", (tx) =>
      tx.objectStore("settings").put(id, "active"),
    );
  }
  remove(id) {
    return this.transaction(["connections", "settings"], "readwrite", (tx) => {
      tx.objectStore("connections").delete(id);
      const active = tx.objectStore("settings").get("active");
      active.onsuccess = () => {
        if (active.result === id) tx.objectStore("settings").delete("active");
      };
    });
  }
  close() {
    this.db?.close();
    this.db = null;
  }
}

export function loginRequired() {
  return Object.assign(
    new Error("Saved login has expired or was removed. Sign in again."),
    { status: 401, code: "LOGIN_REQUIRED" },
  );
}

// Cross-tab locking covers synchronization, the SDK request (including renewal),
// and saving rotated tokens. No custom retry or JWT-expiry interpretation.
export function storedSessionAccess(storage, record, onStorageError) {
  let dirty = false;
  return async (session, operation) =>
    storage.lock(record.id, async () => {
      const latest = await storage.get(record.id);
      if (
        !latest ||
        latest.generation !== record.generation ||
        latest.url !== record.url
      ) {
        session.clear();
        throw loginRequired();
      }
      if (latest.requiresAuth && !latest.session) {
        session.clear();
        throw loginRequired();
      }
      // If a prior save failed after renewal, never overwrite the newer in-memory
      // token with the older disk token. Retry saving it before another request.
      if (dirty) {
        latest.session = session.get()
          ? { url: record.url, ...savedSession(session.get(), record) }
          : null;
        await storage.put(latest);
        dirty = false;
      } else
        session.set(
          latest.session ? savedSession(latest.session, record) : null,
        );
      const before = JSON.stringify(session.get());
      try {
        return await operation();
      } finally {
        const current = session.get();
        if (JSON.stringify(current) !== before) {
          latest.session = current
            ? { url: record.url, ...savedSession(current, record) }
            : null;
          try {
            await storage.put(latest);
          } catch (error) {
            dirty = true;
            onStorageError(error);
          }
        }
      }
    });
}
