import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { WorkBudget } from "./derived-state-scheduler.js";
import { ShardMap, liveShardOrder, planLiveShardMap } from "./shard-map.js";
import { isPrimary, primaryFor } from "./primary-state.js";
import { shardMapFromHttp } from "./interfaces/cluster.js";
import { CLUSTER_SECRET_HEADER, clusterSecretMatches } from "./cluster-secret.js";
import { NDJSON_CONTENT_TYPE, isNdjsonContentType, parseNdjsonBatches } from "./ndjson.js";

export const TOPOLOGY_HEADER = "x-objydb-topology";
const PATH = "/cluster/migration";
const BATCH_SIZE = 512;
const BATCH_BYTES = 4 * 1024 * 1024;
const TRANSFER_CONCURRENCY = 4;

// The source map owns all API traffic until one durable map publication commits
// the handover. Pending copies share storage, but never the active read view.
export class LiveResharding {
  constructor({ node, shardMapStore, persistence, replication, secret, memoryGuard, timeoutMs = 60_000 }) {
    Object.assign(this, { node, shardMapStore, persistence, replication, secret, memoryGuard, timeoutMs });
    this.scope = new AsyncLocalStorage();
    this.requests = new Set();
    this.running = null;
    this.lastError = null;
    this.sealed = node.shardMap.migration?.phase === "sealing";
    this.filtering = Boolean(node.shardMap.migration);
    this.copied = 0;
    this.deltas = 0;
    this.abort = new AbortController();
    this.instance = randomUUID();
    this.instances = {};
    this.ready = node.shardMap.migration?.phase === "committed" &&
      persistence?.restoredTopology === node.shardMap.migration.target.topology.id ? node.shardMap.migration.id : null;
    this.commands = Promise.resolve();
    this.cursor = Symbol("migration import");
    node.migration = this;
  }

  status() {
    const state = this.node.shardMap.migration;
    return state ? { id: state.id, phase: state.phase, running: Boolean(this.running),
      stage: this.stage || null, copied: this.copied, deltas: this.deltas, error: this.lastError?.message || null } : null;
  }

  get topology() { return this.node.shardMap.topology?.id || "standalone"; }

  visible(database, collection, id) {
    return !this.filtering || this.node.ownsShard(this.node.shardForObject(database, collection, id));
  }

  readOptions(database, collection, options) {
    if (!this.filtering) return options;
    if (this.node.shardMap.migration?.phase !== "committed") {
      const owned = this.node.ownedShardTargets().map((target) => target.shard);
      const ids = this.node.db.idsForShards(database, collection, owned);
      if (ids) return { ...options, includeIds: options.includeIds || ids };
    }
    const allow = options.includeId;
    return { ...options,
      includeId: (id) => this.visible(database, collection, id) && (!allow || allow(id)) };
  }

  assertSchema() {
    if (this.scope.getStore()?.internal) return;
    if (this.node.shardMap.migration) throw unavailable("schema changes wait until live resharding finishes");
  }

  assertMutation() {
    if (this.scope.getStore()?.internal) return;
    const captured = this.scope.getStore()?.topology;
    if (captured && captured !== this.topology) throw stale();
    if (this.sealed) {
      throw unavailable("topology handover is pending");
    }
  }

  assertRemote(ops) {
    if (this.scope.getStore()?.internal || !this.node.shardMap.names.length) return;
    if (ops.some((op) => op.shard && !this.node.shardMap.shards.has(op.shard))) throw stale();
  }

  async stop() {
    this.abort.abort(new Error("migration is stopping"));
    await this.running;
  }

  headers() {
    return { [TOPOLOGY_HEADER]: this.scope.getStore()?.topology || this.topology };
  }

  request(req, action) {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (!path.startsWith("/api/") || path === "/api/config") return action();
    const streaming = isNdjsonContentType(req.headers["content-type"]);
    const forwarded = req.headers["x-objydb-forwarded"] === "1" && clusterSecretMatches(req.headers[CLUSTER_SECRET_HEADER], this.secret);
    const run = () => {
      if (forwarded && req.headers[TOPOLOGY_HEADER] && req.headers[TOPOLOGY_HEADER] !== this.topology) throw stale();
      this.assertMutation();
      return action();
    };
    if (streaming) return this.scope.run({ streaming: true, forwarded, topology: this.topology }, run);
    return this._admit(run, { schema: isSchemaRequest(req, path) });
  }

  batch(action) {
    const context = this.scope.getStore();
    if (!context?.streaming) return action();
    if (context.forwarded && context.topology !== this.topology) throw stale();
    return this._admit(action);
  }

  _admit(action, extra = {}) {
    const entry = { ...extra };
    const context = { topology: this.topology };
    // Register before invoking user hooks, even when they complete synchronously.
    this.requests.add(entry);
    entry.promise = this.scope.run(context, async () => { this.assertMutation(); return action(); }).finally(() => this.requests.delete(entry));
    return entry.promise;
  }

  async start(desired) {
    if (!this.persistence?.durable || !this.shardMapStore?.durable) throw Object.assign(new Error("live resharding requires S3 persistence and an S3 shard map store"), { status: 409 });
    const existing = this.node.shardMap.migration;
    if (existing) {
      const requested = liveShardOrder(existing.source, desired).map((name) => desired.shards[name].peers.map((peer) => String(peer.url).replace(/\/+$/, "")));
      const expected = Object.values(existing.target.shards).map((shard) => shard.peers.map((peer) => peer.url));
      if (JSON.stringify(requested) !== JSON.stringify(expected)) throw Object.assign(new Error("another live topology change is pending"), { status: 409 });
      this.resume();
      return this.status();
    }
    const source = this.node.shardMapSnapshot();
    this.copied = this.deltas = 0;
    const target = planLiveShardMap(source, desired);
    validateMembers(source, target);
    const migration = { id: target.topology.id, phase: "copying", source, target, startedAt: new Date().toISOString() };
    const published = await this.shardMapStore.publishState({ ...source, migration });
    this.install(published.shardMap);
    this.resume();
    return this.status();
  }

  resume() {
    if (this.running || !this.node.shardMap.migration || !isPrimary(this.node)) return this.running;
    this.lastError = null;
    this.running = this._run().catch((error) => { this.lastError = error; }).finally(() => { this.running = null; });
    return this.running;
  }

  install(map) {
    const current = this.node.shardMapSnapshot();
    if (current.topology?.id === map.topology.id && JSON.stringify(peerLayout(current)) === JSON.stringify(peerLayout(map))) {
      this.node.shardMap.migration = map.migration || null;
    } else this.node.replaceShardMap(shardMapFromHttp(map, this.node.id, { secret: this.secret }));
    if (map.migration) this.filtering = true;
    this.sealed = map.migration ? map.migration.phase !== "copying" : false;
  }

  command(body) {
    const run = this.commands.catch(() => {}).then(() => this._command(body));
    this.commands = run;
    return run;
  }

  async _command({ id, phase, frontiers, catalog, instance, instances }) {
    this.abort.signal.throwIfAborted();
    if (instance && instance !== this.instance) throw Object.assign(new Error("migration participant restarted; retry the topology update"), { status: 409 });
    const map = await this.shardMapStore.load();
    if (map?.migration?.id !== id) throw stale();
    this.install(map);
    const state = map.migration;
    const source = new ShardMap(state.source);
    const target = new ShardMap(state.target);
    if (!members(state).includes(this.node.url)) throw stale();
    if (instances) this.instances = instances;
    switch (phase) {
      case "prepare": {
        if (state.phase === "committed") throw stale();
        await Promise.all([...this.requests].filter((request) => request.schema).map((request) => request.promise.catch(() => {})));
        await this.persistence.checkpointing;
        const seq = await this.persistence.flushThrough();
        return { node: this.node.id, seq, instance: this.instance, catalog: this._catalog() };
      }
      case "sync": {
        await this.scope.run({ internal: true }, async () => {
          for (const entry of this.node.ownedShardTargets()) for (const peer of this.node._syncPeersForTarget(entry)) {
            await this.node.syncPeer(peer, this.node.syncScopeForShard(entry.shard), { until: frontiers });
          }
        });
        return {};
      }
      case "catalog":
        await this.node.lifecycle.load();
        this.scope.run({ internal: true }, () => {
          // A learner has no authoritative source partition. Discard any
          // incomplete prior attempt or stale local cache before recopying.
          if (!this.node.ownedShardTargets().length) {
            for (const database of this.node.listDatabases()) this.node.db.deleteDatabase(database);
          }
          for (const entry of catalog) {
            this.node.db.setDatabaseMeta(entry.database, entry.meta);
            for (const collection of entry.collections) {
              if (JSON.stringify(this.node.getCollectionMeta(entry.database, collection.name)) !== JSON.stringify(collection.meta)) {
                this.node.setCollectionMeta(entry.database, collection.name, collection.meta);
              }
            }
          }
        });
        return {};
      case "copy": {
        const ops = this._baseOps(source, target);
        return { copied: await this._distribute(ops, target, "base", true) };
      }
      case "checkpoint": {
        for (const entry of this._catalog()) for (const collection of entry.collections) {
          for (const [shard, config] of Object.entries(state.target.shards)) {
            if (config.peers[0].url !== this.node.url) continue;
            const scope = { database: entry.database, collection: collection.name, shard };
            await this.persistence._writeSnapshot(scope, `live-${id}-${randomUUID()}`, { seq: 0, lastSeen: new Map() }, {
              topologyId: id, cursors: state.frontiers,
              objects: withShard(storedObjects(this.node.db.getCollection(scope.database, scope.collection),
                (objectId) => target.shardForObject(scope.database, scope.collection, objectId) === shard), shard),
              isOwner: () => this.node.shardMap.migration?.id === id && this.node.shardMap.migration.phase !== "committed",
            });
          }
        }
        return {};
      }
      case "seal": {
        if (state.phase !== "sealing") throw stale();
        this.sealed = true;
        await deadline((async () => {
          await this.replication.quiesce();
          await Promise.allSettled([...this.requests].map((request) => request.promise));
          await Promise.allSettled([...this.node.lifecycle.work].map((work) => work.promise));
        })(), this.timeoutMs);
        const seq = await this.persistence.flushThrough();
        this.ready = id;
        return { node: this.node.id, seq };
      }
      case "flush":
        await this.persistence.flushThrough();
        return {};
      case "activate":
        if (state.phase !== "committed") throw stale();
        if (this.ready !== id) {
          await this.scope.run({ internal: true }, async () => {
            for (const target of this.node.ownedShardTargets()) await this.persistence.restoreScope(this.node.syncScopeForShard(target.shard));
          });
          this.ready = id;
        }
        for (const target of this.node.ownedShardTargets()) {
          const scope = this.node.syncScopeForShard(target.shard);
          for (const [origin, seq] of Object.entries(state.target.originSequences || {})) {
            const key = this.node._cursorKey(origin, scope);
            this.node.lastSeen.set(key, Math.max(this.node.lastSeen.get(key) || 0, seq));
          }
        }
        this.sealed = false;
        this.replication.resume();
        return {};
      case "cleanup":
        if (state.phase !== "committed") throw stale();
        await this._cleanup();
        return {};
      default: throw Object.assign(new Error("invalid migration command"), { status: 400 });
    }
  }

  async receive(id, mode, stream, signal, instance) {
    if (instance !== this.instance) throw Object.assign(new Error("migration destination restarted; retry the topology update"), { status: 409 });
    const state = this.node.shardMap.migration;
    if (!state || state.id !== id || state.phase === "committed" || !["base", "delta"].includes(mode)) throw stale();
    const target = new ShardMap(state.target);
    const source = new ShardMap(state.source);
    let received = 0;
    for await (const ops of parseNdjsonBatches(stream, { maxBatchObjects: BATCH_SIZE, maxBatchBytes: BATCH_BYTES, label: "migration" })) {
      signal?.throwIfAborted();
      for (const op of ops) {
        const shard = target.shardForObject(op.db, op.coll, op.id);
        if (typeof op.db !== "string" || !op.db || typeof op.coll !== "string" || !op.coll || typeof op.id !== "string" || !op.id ||
            op.shard !== shard || !target.peersFor(shard).some((peer) => peer.url === this.node.url) ||
            !Number.isSafeInteger(op.ts?.c) || op.ts.c < 1 || typeof op.ts.n !== "string" ||
            !["putObj", "delObj", "touch"].includes(op.kind) ||
            (mode === "delta" && (!Object.hasOwn(state.frontiers, op.from) || !Number.isSafeInteger(op.seq) || op.seq < 1))) throw stale();
      }
      await this.persistence.withCapacity(() => this.scope.run({ internal: true }, () => {
        this.memoryGuard?.assertCanWrite();
        if (this.node.shardMap.migration?.id !== id || this.node.shardMap.migration.phase === "committed") throw stale();
        const stored = ops.map((op) => {
          const shard = source.shardForObject(op.db, op.coll, op.id);
          return source.peersFor(shard).some((peer) => peer.url === this.node.url) ? { ...op, shard } : op;
        });
        this.node.applyRemote("migration", stored, this.cursor, { notify: false });
        this.node.lastSeen.delete(this.cursor);
        // Even an equal-version local row needs a target journal entry: its
        // source journal is in a different durable shard namespace.
        if (mode === "delta") this.persistence._queueOps(ops);
      }), { signal, bytes: ops.byteLength });
      received += ops.length;
    }
    return { received };
  }

  async _run() {
    const durable = await this.shardMapStore.load();
    this.install(durable);
    if (!durable.migration) return;
    let state = this.node.shardMap.migration;
    if (state.phase !== "committed") {
      const peers = members(state);
      this.instances = {};
      const prepared = await this._all(peers, "prepare");
      frontiersOf(prepared);
      this.instances = Object.fromEntries(prepared.map((entry, index) => [peers[index], entry.instance]));
      const sourceUrls = urls(state.source);
      const sources = prepared.filter((entry, index) => sourceUrls.includes(peers[index]));
      const initial = state.frontiers || frontiersOf(sources);
      await this._publish({ ...state, frontiers: initial });
      state = this.node.shardMap.migration;
      await this._all(sourceUrls, "sync", { frontiers: frontiersOf(sources) });
      const catalog = mergeCatalogs(sources.map((entry) => entry.catalog));
      await this._all(peers, "catalog", { catalog });
      const donors = [...new Set(Object.values(state.source.shards).map((shard) => shard.peers[0].url))];
      this.stage = "copy";
      for (const url of donors) this.copied += (await this._call(url, { id: state.id, phase: "copy", instances: this.instances })).copied;
      await this._all(sourceUrls, "flush");
      // All journals, including those from writes accepted by non-primary
      // replicas, are retained until this migration has finished.
      const frontier = frontiersOf(await this._all(sourceUrls, "prepare"));
      await this._tail(initial, frontier);
      await this._all(peers, "checkpoint");
      if (state.phase !== "sealing") await this._publish({ ...state, phase: "sealing" });
      const final = frontiersOf(await this._all(peers, "seal"));
      await this._tail(frontier, final);
      await this._all(peers, "flush");
      const pending = this.node.shardMap.migration;
      // Reserve one stream position for the durable ownership barrier. Even a
      // destination with no locally originated writes now has a catch-up floor.
      const originSequences = Object.fromEntries(Object.entries(final).map(([origin, seq]) => [origin, seq + 1]));
      await this._publish({ ...pending, phase: "committed", target: { ...pending.target,
        originSequences: { ...pending.source.originSequences, ...originSequences } } });
    }
    state = this.node.shardMap.migration;
    const peers = members(state);
    await this._all(peers, "activate");
    await this._all(peers, "cleanup");
    const published = await this.shardMapStore.publishState(state.target);
    this.install(published.shardMap);
    await this._all(peers.filter((url) => url !== this.node.url), "finished", { map: published.shardMap });
  }

  async finish(map) {
    const stored = await this.shardMapStore.load();
    if (stored.migration || stored.topology.id !== map.topology.id) throw stale();
    this.install(stored);
    this.replication.resume();
  }

  async _publish(migration) {
    this.abort.signal.throwIfAborted();
    const map = migration.phase === "committed" ? migration.target : migration.source;
    try {
      const published = await this.shardMapStore.publishState({ ...map, migration });
      this.install(published.shardMap);
    } catch (error) {
      // A failed response does not prove that S3 rejected the publication.
      const stored = await this.shardMapStore.load();
      if (stored?.migration?.id !== migration.id || stored.migration.phase !== migration.phase) throw error;
      this.install(stored);
    }
  }

  async _tail(after, until) {
    this.stage = "catch-up";
    const state = this.node.shardMap.migration;
    const source = Object.keys(state.source.shards);
    const target = new ShardMap(state.target);
    const writers = Object.fromEntries(Object.keys(state.frontiers).map((origin) => [origin, until[origin] || 0]));
    const operations = this.persistence.migrationJournalOps(source, after, writers);
    const mapped = async function* () {
      for await (const op of operations) yield { ...op, shard: target.shardForObject(op.db, op.coll, op.id) };
    };
    this.deltas += await this._distribute(mapped(), target, "delta");
  }

  async *_baseOps(source, target) {
    for (const entry of this._catalog()) for (const collection of entry.collections) {
      const database = entry.database, name = collection.name;
      // Test placement before hydration. Each source shard has one donor.
      const rows = storedObjects(this.node.db.getCollection(database, name), (id) => {
          const previous = source.peersFor(source.shardForObject(database, name, id));
          return previous[0]?.url === this.node.url && target.peersFor(target.shardForObject(database, name, id))
            .some((peer) => !previous.some((old) => old.url === peer.url));
        });
      for await (const row of rows) {
        yield { kind: row.deleted ? "delObj" : "putObj", db: database, coll: name, id: row.id,
          ts: row.deleted || row.ts, value: row.value, shard: target.shardForObject(database, name, row.id),
          from: this.node.id, seq: 0 };
      }
    }
  }

  async _distribute(ops, target, mode, skipExisting = false) {
    const state = this.node.shardMap.migration;
    const source = new ShardMap(state.source);
    const batches = new Map();
    let bytes = 0;
    const flush = async () => {
      const destinations = [...batches];
      for (let offset = 0; offset < destinations.length; offset += TRANSFER_CONCURRENCY) {
        const results = await Promise.allSettled(destinations.slice(offset, offset + TRANSFER_CONCURRENCY).map(async ([url, batch]) => {
          if (url === this.node.url) await this.receive(state.id, mode, Readable.from(batch), undefined, this.instances[url]);
          else await this._fetch(url, `${PATH}?id=${encodeURIComponent(state.id)}&mode=${mode}`, Readable.from(batch), true);
        }));
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      }
      batches.clear(); bytes = 0;
    };
    let sent = 0;
    for await (const op of ops) {
      this.abort.signal.throwIfAborted();
      const previous = source.peersFor(source.shardForObject(op.db, op.coll, op.id));
      const line = `${JSON.stringify(op)}\n`;
      const lineBytes = Buffer.byteLength(line);
      let full = false;
      for (const peer of target.peersFor(op.shard)) {
        if (skipExisting && previous.some((old) => old.url === peer.url)) continue;
        const batch = batches.get(peer.url) || [];
        batch.push(line); batches.set(peer.url, batch);
        bytes += lineBytes; sent++;
        if (batch.length >= BATCH_SIZE) full = true;
      }
      if (full || bytes >= BATCH_BYTES) await flush();
    }
    if (batches.size) await flush();
    return sent;
  }

  async _cleanup() {
    const budget = new WorkBudget();
    let scanned = 0;
    for (const entry of this._catalog()) for (const collection of entry.collections) {
      const store = this.node.db.getCollection(entry.database, collection.name);
      let retired = [];
      for (const [id] of store.meta) {
        const shard = this.node.shardForObject(entry.database, collection.name, id);
        if (this.node.ownsShard(shard)) store.relocateObject(id, shard);
        else retired.push(id);
        if (retired.length >= BATCH_SIZE) { store.retireObjects(retired); retired = []; }
        const pause = budget.checkpoint(++scanned);
        if (pause) await pause;
      }
      store.retireObjects(retired);
    }
    // Old in-memory operations must never be advertised as target history.
    this.node.log = this.node.log.filter((op) => {
      if (this.node.shardMap.shards.has(op.shard)) return true;
      this.node.trimmed = Math.max(this.node.trimmed, op.seq);
      return false;
    });
    this.node.markHistoryTruncated();
    this.filtering = false;
  }

  _catalog() {
    return this.node.listDatabases().map((database) => ({ database, meta: this.node.getDatabaseMeta(database),
      collections: this.node.listCollections(database).map((name) => ({ name, meta: this.node.getCollectionMeta(database, name) })) }));
  }

  async _all(peers, phase, body = {}) {
    this.stage = phase;
    const results = await Promise.allSettled(peers.map((url) => this._call(url, { ...body, id: this.node.shardMap.migration?.id, phase })));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return results.map((result) => result.value);
  }

  async _call(url, body) {
    if (!["activate", "cleanup", "finished"].includes(body.phase)) body = { ...body, instance: this.instances[url] };
    try {
      if (url === this.node.url) return await (body.phase === "finished" ? this.finish(body.map) : this.command(body));
      return await this._fetch(url, PATH, body);
    } catch (error) {
      throw Object.assign(new Error(`migration ${body.phase} on ${url}: ${error.message}`, { cause: error }), { status: error.status || 503 });
    }
  }

  async _fetch(url, path, body, stream = false) {
    const response = await fetch(`${url}${path}`, { method: "POST",
      headers: { [CLUSTER_SECRET_HEADER]: this.secret, "content-type": stream ? NDJSON_CONTENT_TYPE : "application/json",
        ...(stream ? { "x-objydb-migration-instance": this.instances[url] } : {}) },
      body: stream ? body : JSON.stringify(body), ...(stream ? { duplex: "half" } : {}),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.timeoutMs * (stream ? 1 : 10))]),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || `migration peer returned ${response.status}`), { status: response.status });
    return result;
  }
}

function urls(map) { return [...new Set(Object.values(map.shards).flatMap((shard) => shard.peers.map((peer) => peer.url)))]; }
function peerLayout(map) { return Object.keys(map.shards).sort().map((name) => [name, map.shards[name].peers.map((peer) => peer.url || peer.nodeId || peer.key)]); }
async function* withShard(rows, shard) { for await (const row of rows) yield { ...row, shard }; }
async function* storedObjects(collection, includeId) {
  const budget = new WorkBudget();
  let selected = [], scanned = 0;
  for (const [id] of collection.meta) {
    if (includeId(id)) selected.push(id);
    if (++scanned % BATCH_SIZE) continue;
    yield* collection.snapshotObjects({ ids: selected });
    selected = [];
    const pause = budget.checkpoint(scanned);
    if (pause) await pause;
  }
  yield* collection.snapshotObjects({ ids: selected });
}
function members(state) { return [...new Set([...urls(state.source), ...urls(state.target)])]; }
function frontiersOf(results) {
  if (results.some((entry) => typeof entry?.node !== "string" || !entry.node || !Number.isSafeInteger(entry.seq) || entry.seq < 0)) {
    throw new Error("migration participants must report valid node IDs and sequence positions");
  }
  const entries = results.map(({ node, seq }) => [node, seq]);
  if (new Set(entries.map(([node]) => node)).size !== entries.length) throw new Error("migration participants must have unique node IDs");
  return Object.fromEntries(entries);
}
function validateMembers(source, target) {
  if (!Object.keys(target.shards).length || [...Object.values(source.shards), ...Object.values(target.shards)].some((shard) => !shard.peers.length || shard.peers.some((peer) => !peer.url))) {
    throw Object.assign(new Error("live resharding requires addressable peers for every shard"), { status: 400 });
  }
  if (primaryFor({ shardMap: new ShardMap(source), peersForShard: (shard) => source.shards[shard]?.peers || [] })?.url !==
      Object.values(target.shards)[0].peers[0].url) throw Object.assign(new Error("retain the administrative primary during live resharding"), { status: 409 });
}
function mergeCatalogs(catalogs) {
  const dbs = new Map();
  for (const catalog of catalogs) for (const entry of catalog) {
    const database = dbs.get(entry.database) || { ...entry, collections: new Map() };
    for (const collection of entry.collections) database.collections.set(collection.name, collection);
    dbs.set(entry.database, database);
  }
  return [...dbs.values()].map((entry) => ({ ...entry, collections: [...entry.collections.values()] }));
}
function isSchemaRequest(req, path) {
  return req.method !== "GET" && (path.endsWith("/meta") || path.includes("/collections") || path.startsWith("/api/databases"));
}
function stale() { return Object.assign(new Error("request belongs to another topology"), { status: 409, code: "STALE_TOPOLOGY", body: { error: "request belongs to another topology", code: "STALE_TOPOLOGY", operationStarted: false } }); }
function unavailable(message) { return Object.assign(new Error(message), { status: 503, headers: { "retry-after": "1" } }); }
function deadline(work, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable("handover drain timed out; retry the topology update")), milliseconds); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
