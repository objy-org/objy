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
  constructor({ storage, name = "objy-studio-connections" } = {}) {
    this.storage = storage;
    this.name = name;
    this.prefix = `${name}:connection:`;
  }
  open() {
    try {
      // Access the browser getter here so blocked storage still allows a
      // page-local connection instead of preventing the UI from opening.
      if (this.storage === undefined) this.storage = globalThis.localStorage;
      const probe = `${this.name}:probe`;
      this.storage.setItem(probe, "1");
      this.storage.removeItem(probe);
    } catch {
      throw new Error(
        "Browser storage is unavailable. This connection will last for this page only.",
      );
    }
  }
  key(id) {
    return this.prefix + encodeURIComponent(id);
  }
  list() {
    const records = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(this.prefix)) continue;
      const record = this.read(key);
      if (record && key === this.key(record.id)) records.push(record);
    }
    return records;
  }
  read(key) {
    const value = this.storage.getItem(key);
    if (value === null) return null;
    try {
      return cleanRecord(JSON.parse(value));
    } catch {
      // Ignore malformed records without using their address or credentials.
      return null;
    }
  }
  get(id) {
    const record = this.read(this.key(id));
    return record?.id === id ? record : null;
  }
  put(record) {
    this.storage.setItem(this.key(record.id), JSON.stringify(cleanRecord(record)));
  }
  active() {
    return this.storage.getItem(`${this.name}:active`);
  }
  setActive(id) {
    const key = `${this.name}:active`;
    if (id) this.storage.setItem(key, id);
    else this.storage.removeItem(key);
  }
  remove(id) {
    this.storage.removeItem(this.key(id));
    if (this.active() === id) this.setActive(null);
  }
}

export function loginRequired() {
  return Object.assign(
    new Error("Saved login has expired or was removed. Sign in again."),
    { status: 401, code: "LOGIN_REQUIRED" },
  );
}

// Each tab's official client owns renewal and coalesces concurrent renewals.
// OBJY refresh tokens remain valid after renewal; no cross-tab lock is needed.
export function storedSessionAccess(storage, record, onStorageError) {
  let dirty = false;
  let pending = 0;
  const matches = (latest) =>
    latest?.generation === record.generation && latest.url === record.url;
  function save(value) {
    const latest = storage.get(record.id);
    // Recheck after the request: forgetting or replacing a connection must not
    // be undone by its old client's delayed response.
    if (matches(latest) && (!latest.requiresAuth || latest.session)) {
      latest.session = value
        ? { url: record.url, ...savedSession(value, record) }
        : null;
      storage.put(latest);
    }
    dirty = false;
  }
  return async (session, operation) => {
    const latest = storage.get(record.id);
    if (!matches(latest) || (latest.requiresAuth && !latest.session)) {
      session.clear();
      throw loginRequired();
    }
    // Retry a failed token save without replaying a completed database write.
    if (dirty) save(session.get());
    // Pick up another tab's renewed credentials only while this client is idle.
    // setSession during a request would invalidate the SDK's renewal/replay.
    else if (!pending) {
      const saved = latest.session;
      const value = saved ? savedSession(saved, record) : null;
      if (JSON.stringify(session.get()) !== JSON.stringify(value)) session.set(value);
    }
    const before = JSON.stringify(session.get());
    pending++;
    try {
      return await operation();
    } finally {
      pending--;
      const current = session.get();
      if (JSON.stringify(current) !== before) {
        dirty = true;
        try {
          save(current);
        } catch (error) {
          onStorageError(error);
        }
      }
    }
  };
}
