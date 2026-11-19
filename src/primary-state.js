import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const clocks = new Map();
const memoryClocks = new WeakMap();
const SUFFIX = ".publications/";
const RECORD = /^(\d{16})-(\d{16})-[\w-]+\.json$/;
export const CLUSTER_ADMINISTRATION = Symbol("cluster administration");

export function primaryFor(node, database) {
  const shards = node.shardMap.shardsForCollection();
  const shard = database === undefined ? shards[0] : node.shardMap.shardForObject("", "", database);
  return node.peersForShard(shard)[0] || null;
}

export function isPrimary(node, database) {
  const peer = primaryFor(node, database);
  return !node.url || !peer || node._isSelfPeer(peer);
}

export function requirePrimary(node, database) {
  if (!isPrimary(node, database)) {
    throw Object.assign(new Error("administrative operation must run on its primary"), { status: 503, code: "PRIMARY_REQUIRED" });
  }
}

// The local clock is persisted before issuing a PUT. Late requests retain their
// old order, including after a process restart; ownership changes use a new epoch.
export class PrimaryStateStore {
  constructor({ storage, node, clockPath, epoch = () => node?.shardMapSnapshot().ownershipEpoch || 0 } = {}) {
    this.storage = storage;
    this.epoch = epoch;
    if (clockPath) {
      const path = resolve(clockPath);
      if (!clocks.has(path)) clocks.set(path, new PublicationClock(path));
      this.clock = clocks.get(path);
    } else {
      if (!memoryClocks.has(storage)) memoryClocks.set(storage, new PublicationClock());
      this.clock = memoryClocks.get(storage);
    }
    this.pending = new Map();
  }

  async read(key, keys) {
    const prefix = `${key}${SUFFIX}`;
    const records = (keys || await this.storage.list(prefix)).filter((path) => path.startsWith(prefix) && RECORD.test(path.slice(prefix.length))).sort();
    const path = records.at(-1);
    if (!path) return { body: await this.storage.get(key), revision: "", key };
    const body = await this.storage.get(path);
    if (body === null) throw new Error(`published state is missing: ${path}`);
    return { body: body === "null" ? null : body, revision: path.slice(prefix.length), key: path };
  }

  async adopt(key, current) {
    if ((Number(current.revision.slice(0, 16)) || 0) >= this.epoch()) return current;
    const published = await this.publish(key, current.body, { previous: current.revision });
    await this.prune(key);
    return published;
  }

  publish(key, body, { previous, guard } = {}) {
    const pending = (this.pending.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const current = await this.read(key);
      if (current.revision && Number(current.revision.slice(0, 16)) > this.epoch()) throw publicationConflict("publication belongs to a newer primary ownership epoch");
      if (previous !== undefined && previous !== current.revision) throw publicationConflict("state changed during publication");
      guard?.();
      const old = current.revision ? Number(current.revision.slice(17, 33)) : 0;
      const revision = `${pad(this.epoch())}-${pad(await this.clock.next(old))}-${randomUUID()}.json`;
      guard?.();
      const path = `${key}${SUFFIX}${revision}`;
      await this.storage.put(path, typeof body === "string" ? body : JSON.stringify(body), "application/json");
      return { body: body === null ? null : typeof body === "string" ? body : JSON.stringify(body), revision, key: path };
    });
    this.pending.set(key, pending);
    pending.finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); }).catch(() => {});
    return pending;
  }

  async prune(key, keep = 2) {
    const prefix = `${key}${SUFFIX}`;
    const paths = (await this.storage.list(prefix)).filter((path) => path.startsWith(prefix) && RECORD.test(path.slice(prefix.length))).sort();
    return this.storage.delete(paths.slice(0, Math.max(0, paths.length - keep)));
  }
}

export function publicationKeys(keys) {
  return [...new Set(keys.map(publicationBase))];
}

export function isPublicationKey(key) { return publicationBase(key) !== key; }

function publicationBase(key) {
  const boundary = key.lastIndexOf(SUFFIX);
  return boundary < 0 || !RECORD.test(key.slice(boundary + SUFFIX.length)) ? key : key.slice(0, boundary);
}

export function publicationConflict(message) {
  return Object.assign(new Error(message), { code: "SNAPSHOT_CONFLICT", status: 409 });
}

class PublicationClock {
  constructor(path) { this.path = path; this.value = 0; this.loaded = false; this.pending = Promise.resolve(); }

  next(minimum) {
    const pending = this.pending.catch(() => {}).then(async () => {
      if (!this.loaded) {
        if (this.path) {
          try {
            const value = JSON.parse(await readFile(this.path, "utf8"));
            if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid publication clock");
            this.value = value;
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        this.loaded = true;
      }
      this.value = Math.max(this.value, minimum) + 1;
      if (!Number.isSafeInteger(this.value)) throw new Error("publication clock exhausted");
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}`;
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(this.value)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return this.value;
    });
    this.pending = pending;
    return pending;
  }
}

function pad(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid publication order");
  return String(value).padStart(16, "0");
}
