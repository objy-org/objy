import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { MemoryObjectStorage } from "./object-storage.js";

export const CONTEXT_HEADER = "x-objydb-context";

export class ContextLifecycle {
  constructor({ node, persistence = null }) {
    this.node = node;
    this.persistence = persistence;
    this.storage = persistence?.storage || new MemoryObjectStorage();
    this.path = `${persistence?.prefix ?? "objydb"}/context-state.json`.replace(/^\/+/, "");
    this.records = new Map();
    this.contexts = new Map();
    this.revision = "";
    this.scope = new AsyncLocalStorage();
    this.work = new Set();
    this.runs = new Map();
    node.lifecycle = node.db.lifecycle = this;
  }

  record(database, collection) {
    const context = this.contexts.get(database);
    if (collection === undefined) return context?.database;
    const record = context?.collections.get(collection);
    return record?.parentId === (context?.database?.id || "") ? record : undefined;
  }

  ticket({ database, collection }) {
    return [this.record(database)?.id || "", collection === undefined ? "" : this.record(database, collection)?.id || ""];
  }

  assert(database, collection) {
    const scope = this.scope.getStore();
    if (scope?.internal) return;
    if ([this.record(database)?.status, this.record(database, collection)?.status].some((status) => status === "deleting" || status === "deleted")) throw pending("context is deleting or deleted; explicit creation is required");
    if (scope?.context && overlaps(scope.context, { database, collection }) && !same(scope.ticket, this.ticket(scope.context))) throw pending("operation predates deletion");
    if (scope?.context?.database === database && scope.context.collection === undefined && collection !== undefined) {
      const id = this.record(database, collection)?.id || "";
      scope.children ||= new Map();
      if (scope.children.has(collection) && scope.children.get(collection) !== id) throw pending("operation predates collection deletion");
      scope.children.set(collection, id);
    }
  }

  runRequest(req, forwarded, action) {
    if (req.method === "GET") return action();
    let context = req.params.database ? { database: req.params.database, collection: req.params.collection } : null;
    let ticket = context ? this.ticket(context) : null;
    let children;
    if (forwarded && req.headers[CONTEXT_HEADER]) {
      const incoming = JSON.parse(req.headers[CONTEXT_HEADER]);
      if ((context && (incoming.context.database !== context.database || (context.collection !== undefined && incoming.context.collection !== undefined && incoming.context.collection !== context.collection))) ||
        !same(incoming.ticket, this.ticket(incoming.context))) throw pending("forwarded operation predates deletion");
      ({ context, ticket } = incoming);
      children = new Map(incoming.children || []);
      for (const [name, id] of children) if (id !== (this.record(context.database, name)?.id || "")) throw pending("forwarded operation predates collection deletion");
    }
    req.contextTicket = { context, ticket, children };
    return this.scope.run(req.contextTicket, action);
  }

  requestHeader(req) {
    if (!req.contextTicket?.context) return {};
    const { context, ticket } = req.contextTicket;
    if (!same(ticket, this.ticket(context))) throw pending("operation predates deletion");
    const children = req.contextTicket.children;
    for (const [name, id] of children || []) if (id !== (this.record(context.database, name)?.id || "")) throw pending("operation predates collection deletion");
    return { [CONTEXT_HEADER]: JSON.stringify({ context, ticket, ...(children?.size ? { children: [...children] } : {}) }) };
  }

  track(context, action) {
    const item = { context, promise: null };
    item.promise = Promise.resolve().then(() => {
      if (context) this.assert(context.database, context.collection);
      return action();
    }).finally(() => this.work.delete(item));
    this.work.add(item);
    return item.promise;
  }

  internal(action) { return this.scope.run({ internal: true }, action); }

  obsolete(op) {
    if (!this.records.size) return false;
    return retired(this.record(op.db), op) || retired(this.record(op.db, op.coll), op);
  }

  async load() {
    this._install((await this._read(false)).records);
    const revived = [];
    for (const record of this.records.values()) {
      if (record.collection === undefined && record.status === "active" && this.node.db.isDatabaseDeleted(record.database)) {
        this.node.db.createDatabase(record.database);
        revived.push({ database: record.database });
      }
    }
    for (const record of this.records.values()) {
      if (record.collection !== undefined && this.record(record.database, record.collection) === record && record.status === "active" &&
          !this.node.db.isDatabaseDeleted(record.database) && this.node.db.isCollectionDeleted(record.database, record.collection)) {
        this.node.db.createCollection(record.database, record.collection);
        revived.push({ database: record.database, collection: record.collection });
      }
    }
    return revived;
  }

  async create(context, req, action) {
    const captured = req?.contextTicket;
    await this._change((records) => {
      this._assertNoOverlap(records, context);
      const parent = context.collection === undefined ? null : records[key({ database: context.database })];
      if (context.collection !== undefined && parent && parent.status !== "active") throw pending("database is not active");
      if (captured?.context && (!overlaps(captured.context, context) || !same(captured.ticket, this.ticket(captured.context)))) throw pending("operation predates deletion");
      const old = records[key(context)];
      if (!old || old.status === "active") return false;
      records[key(context)] = { ...old, status: "active", parentId: parent?.id || "" };
    });
    const ticket = this.ticket(context);
    if (req) Object.assign(req.contextTicket ||= {}, { context, ticket });
    return this.scope.run({ context, ticket }, action);
  }

  drop(context) {
    const slot = key(context);
    if (this.runs.has(slot)) return this.runs.get(slot);
    const run = this.internal(() => this._drop(context)).catch(async (error) => {
      const current = (await this._read()).records[slot];
      if (current?.status !== "deleted") throw error;
      this._install({ ...Object.fromEntries(this.records), [slot]: current });
    }).finally(() => this.runs.delete(slot));
    this.runs.set(slot, run);
    return run;
  }

  async _drop(context) {
    const members = this.node.shardMap.allPeers().filter((peer) => !this.node._isSelfPeer(peer));
    if (members.length && (!this.node.url || members.some((peer) => !peer.url))) throw failure("clustered deletion requires addressable peers and node.url", 503);
    const peers = [...new Set([...this.node.shardMap.allPeers().map((peer) => peer.url), this.node.url].filter(Boolean))].sort();
    if (peers.some((url) => url !== this.node.url) && !this.persistence) throw failure("clustered deletion requires shared persistence", 503);
    await this._change((records) => {
      this._assertNoOverlap(records, context, true);
      const old = records[key(context)];
      if (old && old.status !== "active") return false;
      const cursors = Object.assign(Object.create(null), old?.cursors);
      if (context.collection === undefined) {
        for (const child of Object.values(records)) if (child.database === context.database) {
          for (const [origin, seq] of Object.entries(child.cursors || {})) cursors[origin] = Math.max(cursors[origin] || 0, seq);
        }
      }
      records[key(context)] = { ...context, id: randomUUID(), status: "deleting", peers,
        topology: this._topology(), parentId: context.collection === undefined ? "" : records[key({ database: context.database })]?.id || "",
        cursors };
    });
    let record = this.record(context.database, context.collection);
    if (record.status === "deleted") return;
    this._checkTopology(record);
    const results = [await this.prepare(record), ...await this._all(record, "prepare")];
    await this._change((records) => {
      const current = records[key(context)];
      if (current?.id !== record.id || current.status !== "deleting") throw pending("deletion changed; retry");
      current.cursors = Object.assign(Object.create(null), current.cursors);
      for (const result of results) for (const [origin, seq] of Object.entries(result.cursors)) current.cursors[origin] = Math.max(current.cursors[origin] || 0, seq);
      current.collections = [...new Set([...(current.collections || []), ...results.flatMap((result) => result.collections || [])])];
    });
    record = this.record(context.database, context.collection);
    await this._all(record, "fence");
    this._checkTopology(record);
    try { await this._cleanup(record); }
    catch (error) { throw failure(`deletion pending: ${error.message}`, 503); }
    await this._change((records) => {
      const current = records[key(context)];
      if (current?.id !== record.id || current.status === "active") throw pending("deletion changed");
      if (context.collection === undefined) for (const [slot, child] of Object.entries(records)) {
        if (child.database === context.database && child.collection !== undefined) delete records[slot];
      }
      records[key(context)] = { ...context, id: current.id, status: "deleted", parentId: current.parentId, cursors: current.cursors };
    });
    // Participants have drained and fenced. Restarting peers read durable state
    // before restore, so completion notifications do not carry the safety barrier.
    await this._all({ ...record, status: "deleted" }, "finish").catch(() => {});
  }

  async command({ phase, record }) {
    if (!record?.id || !record.database || !["prepare", "fence", "finish"].includes(phase)) throw failure("invalid lifecycle command", 400);
    await this.load();
    const current = this.record(record.database, record.collection);
    if (current?.id !== record.id || current.status !== (phase === "finish" ? "deleted" : "deleting")) throw pending("stale lifecycle command");
    if (phase !== "finish") this._checkTopology(current);
    return phase === "prepare" ? this.internal(() => this.prepare(current)) : {};
  }

  async prepare(record) {
    const collections = record.collection === undefined ? this.node.listCollections(record.database) : [record.collection];
    await this._change((records) => {
      const current = records[key(record)];
      if (current?.id !== record.id || current.status !== "deleting") throw pending("stale deletion preparation");
      const names = [...new Set([...(current.collections || []), ...collections])];
      if (names.length === (current.collections || []).length) return false;
      current.collections = names;
    });
    this.internal(() => record.collection === undefined ? this.node.removeDatabase(record.database) : this.node.removeCollection(record.database, record.collection));
    const running = [this.persistence?.checkpointing, this.persistence?.flushing,
      ...[...this.work].filter((item) => !item.context || overlaps(item.context, record)).map((item) => item.promise)].filter(Boolean);
    await Promise.allSettled(running);
    await this.persistence?.flushLocal();
    const cursors = Object.assign(Object.create(null), { [this.node.id]: this.node.seq });
    for (const [source, seq] of this.node.lastSeen) {
      const origin = source.split("|")[0];
      cursors[origin] = Math.max(cursors[origin] || 0, seq);
    }
    return { cursors, collections };
  }

  async assertTopologyMutable() {
    const { records } = await this._read();
    if (Object.values(records).some((record) => record.status === "deleting")) throw pending("cannot change topology during deletion");
  }

  _assertNoOverlap(records, context, allowSame = false) {
    for (const record of Object.values(records)) {
      if (record.status === "deleting" && overlaps(record, context) && !(allowSame && key(record) === key(context))) throw pending("overlapping deletion is pending");
    }
  }

  _checkTopology(record) {
    if (record.topology !== this._topology()) throw pending("cluster membership changed during deletion");
  }

  _topology() {
    const { version, topology, shards } = this.node.shardMapSnapshot();
    return JSON.stringify({ version, topology, shards: Object.fromEntries(Object.keys(shards).sort().map((name) =>
      [name, shards[name].peers.map((peer) => peer.url || peer.key)])) });
  }

  async _all(record, phase) {
    const results = await Promise.allSettled(record.peers.filter((url) => url !== this.node.url).map((url) => this.send(url, { phase, record })));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failure(`deletion pending: ${failed.reason.message}`, 503);
    return results.map((result) => result.value);
  }

  async _read(versioned = true) {
    try {
      const value = versioned ? await this.storage.getVersioned(this.path) : { body: await this.storage.get(this.path) };
      return { records: decodeState(value.body), etag: value.etag };
    } catch (error) { throw failure(`context state unavailable: ${error.message}`, 503); }
  }

  async _change(change) {
    for (;;) {
      const stored = await this._read();
      this._install(stored.records);
      if (change(stored.records) === false) return;
      let written;
      try { written = await this.storage.putConditional(this.path, JSON.stringify({ version: 1, contexts: stored.records }), stored.etag); }
      catch (error) { throw failure(`context state unavailable: ${error.message}`, 503); }
      if (written) {
        this._install(stored.records);
        return;
      }
    }
  }

  _install(records) {
    this.records = new Map(Object.entries(records));
    this.contexts = new Map();
    this.revision = this.records.size ? createHash("sha256").update(JSON.stringify(records)).digest("base64url") : "";
    for (const record of this.records.values()) {
      this.node.seq = Math.max(this.node.seq, record.cursors?.[this.node.id] || 0);
      let context = this.contexts.get(record.database);
      if (!context) this.contexts.set(record.database, context = { collections: new Map() });
      if (record.collection === undefined) context.database = record;
      else context.collections.set(record.collection, record);
    }
  }

  async _cleanup(record) {
    const current = async () => {
      const item = (await this._read()).records[key(record)];
      return item?.id === record.id && item.status === "deleting";
    };
    const cleanup = async (storage, prefix, metadata = false) => {
      const paths = new Set(await storage.list(prefix));
      if (metadata) {
        paths.add(`${prefix}meta.json`);
        const collections = record.collection === undefined ? record.collections || [] : [record.collection];
        for (const name of collections) {
          const base = record.collection === undefined ? `${prefix}collection/${encodeURIComponent(name)}/` : prefix;
          paths.add(`${base}meta.json`);
          for (const shard of Object.keys(this.node.shardMapSnapshot().shards)) paths.add(`${base}shard/${encodeURIComponent(shard)}/latest.json`);
        }
        // Also fence heads that never finished their first conditional PUT.
        for (const path of paths) {
          const boundary = path.indexOf("/shard/", prefix.length - 1);
          if (boundary >= 0) paths.add(`${path.slice(0, path.indexOf("/", boundary + 7))}/latest.json`);
        }
      }
      if (!await current()) return;
      const immutable = [];
      for (const path of paths) {
        if (!metadata && !/\/object\/[^/]+\/blob\/[^/]+$/.test(path)) continue;
        if (metadata && /\/(?:db\/[^/]+\/meta|collection\/[^/]+\/meta|shard\/[^/]+\/latest)\.json$/.test(path)) {
          const old = await storage.getVersioned(path);
          if (!await current()) return;
          if (old.body !== null && JSON.parse(old.body).deletedBy === record.id) continue;
          if (!await storage.putConditional(path, JSON.stringify({ deletedBy: record.id }), old.etag)) {
            const value = await storage.get(path);
            if (!value || JSON.parse(value).deletedBy !== record.id) throw pending("metadata changed during cleanup");
          }
        } else immutable.push(path);
      }
      if (await current()) await storage.delete(immutable);
    };
    const prefix = (root) => `${root}/db/${encodeURIComponent(record.database)}${record.collection === undefined ? "" : `/collection/${encodeURIComponent(record.collection)}`}/`.replace(/^\/+/, "");
    if (this.persistence) await this.track(null, () => cleanup(this.storage, prefix(this.persistence.prefix), true));
    if (this.files?.storage) {
      const root = record.collection === undefined ? this.files.databasePrefix(record.database) : this.files.collectionPrefix(record.database, record.collection);
      await this.track(null, () => cleanup(this.files.storage, `${root}/`));
    }
    else if (this.files) throw new Error("file storage must support scoped key cleanup");
  }
}

function key({ database, collection }) { return JSON.stringify([database, collection ?? null]); }
function decodeState(raw) {
  if (raw === null) return {};
  const document = JSON.parse(raw);
  if (document?.version !== 1 || !document.contexts || typeof document.contexts !== "object" || Array.isArray(document.contexts)) throw new Error("invalid context state document");
  for (const [slot, record] of Object.entries(document.contexts)) {
    if (typeof record?.id !== "string" || !record.id || typeof record.database !== "string" || !record.database || slot !== key(record) ||
      !["active", "deleting", "deleted"].includes(record.status) || !record.cursors || typeof record.cursors !== "object" || Array.isArray(record.cursors) ||
      Object.values(record.cursors).some((seq) => !Number.isSafeInteger(seq) || seq < 0) ||
      (record.status === "deleting" && (!Array.isArray(record.peers) || typeof record.topology !== "string"))) throw new Error("invalid context state record");
  }
  return document.contexts;
}
function retired(record, op) { return !!record && (record.status !== "active" || !!op.from && op.seq <= (record.cursors?.[op.from] || 0)); }
function same(a, b) { return Array.isArray(a) && a[0] === b[0] && a[1] === b[1]; }
function overlaps(a, b) { return a.database === b.database && (a.collection === undefined || b.collection === undefined || a.collection === b.collection); }
function pending(reason = "deletion is pending") { return failure(reason, 409); }
function failure(message, status) { return Object.assign(new Error(message), { status, code: "CONTEXT_DELETING" }); }

