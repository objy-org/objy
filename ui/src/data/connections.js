import { ObjyStore, createServerAdapter } from "./objy-store.js";
import {
  serverAddress,
  savedSession,
  storedSessionAccess,
  loginRequired,
} from "./connection-storage.js";
export { ConnectionStorage } from "./connection-storage.js";
export { ClusterMonitor } from "./cluster-status.js";

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Persist only whitelisted connection metadata and sessions. Explorer data,
// selection and drafts remain in this page's memory.
export class Connections {
  constructor({
    storage = null,
    onChange = () => {},
    events = globalThis,
    adapterFactory = createServerAdapter,
  } = {}) {
    this.entries = new Map();
    this.activeId = null;
    this.storage = storage;
    this.onChange = onChange;
    this.warning = "";
    this.restoreError = "";
    this.adapterFactory = adapterFactory;
    this.events = events;
    this.onStorage = (event) => {
      if (!this.storage || event.storageArea !== this.storage.storage) return;
      try {
        if (event.key === null) {
          for (const id of this.entries.keys()) this.externalChange(id);
        } else if (event.key.startsWith(this.storage.prefix)) {
          this.externalChange(decodeURIComponent(event.key.slice(this.storage.prefix.length)));
        }
      } catch (error) {
        this.storageError(error);
      }
    };
    events.addEventListener?.("storage", this.onStorage);
  }
  get active() {
    return this.entries.get(this.activeId);
  }
  entry(id, store, record) {
    return { id, store, record, error: "", needsLogin: false, viewState: {},
      loading: new Set(), errors: new Map(), refreshing: false };
  }
  storageError(error) {
    this.warning = error.message;
    this.onChange();
  }
  async restore() {
    if (!this.storage) return this;
    try {
      await this.storage.open();
    } catch (error) {
      this.storageError(error);
      this.storage = null;
      return this;
    }
    try {
      for (const record of await this.storage.list())
        this.entries.set(record.id, this.entry(record.id, null, record));
      const active = await this.storage.active();
      if (this.entries.has(active)) {
        try {
          await this.use(active);
        } catch (error) {
          this.restoreError = error.message;
        }
      }
    } catch (error) {
      this.storageError(error);
    }
    return this;
  }
  access(record) {
    return storedSessionAccess(this.storage, record, (error) =>
      this.storageError(error),
    );
  }
  async connect(options, { id } = {}) {
    const url = serverAddress(options.url);
    const record = {
      version: 1,
      id: id || randomId(),
      generation: randomId(),
      url,
      username: options.username || "",
      database: options.database || "_global",
      collection: options.collection || "users",
      requiresAuth: Boolean(options.username),
      session: null,
    };
    const store = await new ObjyStore(
      this.adapterFactory({ ...options, url }),
    ).open();
    const session = savedSession(store.adapter.getSession(), record);
    record.session = session ? { url, ...session } : null;
    if (this.storage) {
      try {
        this.storage.put(record);
        store.adapter.persistWith(this.access(record));
      } catch (error) {
        // A login is not a database write, so it can fail clearly when the user
        // asked for persistence. Do not claim that a session was saved.
        await store.close();
        this.storageError(error);
        throw error;
      }
    }
    const previous = this.entries.get(record.id);
    const entry = this.entry(record.id, store, record);
    id = record.id;
    this.entries.set(id, entry);
    this.activeId = id;
    this.restoreError = "";
    if (previous?.store) await previous.store.close();
    await this.saveActive();
    return entry;
  }
  async saveActive() {
    if (this.storage)
      try {
        await this.storage.setActive(this.activeId);
      } catch (error) {
        this.storageError(error);
      }
  }
  async use(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Connection no longer exists.");
    try {
      if (!entry.store) {
        const record = this.storage ? await this.storage.get(id) : entry.record;
        if (!record || (record.requiresAuth && !record.session))
          throw loginRequired();
        entry.record = record;
        entry.store = await new ObjyStore(
          this.adapterFactory({
            url: record.url,
            session: record.session
              ? savedSession(record.session, record)
              : null,
            sessionAccess: this.storage ? this.access(record) : undefined,
          }),
        ).open();
      } else await entry.store.refresh();
    } catch (error) {
      entry.error = error.message;
      entry.needsLogin = error.status === 401;
      // Failed switches never change the active operation target.
      throw error;
    }
    entry.error = "";
    entry.needsLogin = false;
    this.restoreError = "";
    this.activeId = id;
    await this.saveActive();
    return entry;
  }
  async disconnect(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Delete credentials first; pending requests recheck the saved connection.
    // A failed deletion stays visible rather than falsely claiming sign-out.
    if (this.storage) this.storage.remove(id);
    // Never silently redirect subsequent operations to another server.
    if (id === this.activeId) this.activeId = null;
    this.entries.delete(id);
    this.restoreError = "";
    await entry.store?.close();
  }
  externalChange(id) {
    const entry = this.entries.get(id);
    const record = this.storage.get(id);
    if (entry && record?.generation === entry.record.generation) return;
    if (entry && (!record || record.generation !== entry.record.generation)) {
      if (this.activeId === entry.id) this.activeId = null;
      this.entries.delete(entry.id);
      // Invalidate the SDK immediately; requests already sent may still complete.
      entry.store?.adapter.close();
    }
    if (record && !this.entries.has(record.id))
      this.entries.set(record.id, this.entry(record.id, null, record));
    this.onChange();
  }
  async close() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.activeId = null;
    await Promise.all(entries.map((entry) => entry.store?.close()));
    this.events.removeEventListener?.("storage", this.onStorage);
  }
}
