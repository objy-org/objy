import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PrimaryStateStore } from "./primary-state.js";

const DEFAULT_KEY = "system/secrets.json";
const DEFAULT_PREFIX = "objydb";

export async function resolveSystemSecrets({
  jwtSecret,
  clusterSecret,
  storage,
  prefix = DEFAULT_PREFIX,
  localPath,
  primary = true,
  timeoutMs = 60_000,
  node,
} = {}) {
  const configured = {
    jwtSecret: optionalSecret(jwtSecret),
    clusterSecret: optionalSecret(clusterSecret),
  };
  if (configured.jwtSecret && configured.clusterSecret) return configured;

  const store = storage
    ? new ObjectSecretStore(new PrimaryStateStore({ storage, node,
      ...(localPath ? { clockPath: resolve(dirname(localPath), "publication-clock.json") } : {}),
    }), `${normalizePrefix(prefix)}/${DEFAULT_KEY}`, primary)
    : new FileSecretStore(localPath);
  let stored = await store.load();
  if (!stored) {
    if (storage && !primary) {
      const deadline = Date.now() + timeoutMs;
      while (!stored && Date.now() < deadline) {
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
        stored = await store.load();
      }
      if (!stored) throw new Error("system secrets are not initialized; start the cluster primary first");
    } else {
      const candidate = {
        version: 1,
        jwtSecret: configured.jwtSecret || randomSecret(),
        clusterSecret: configured.clusterSecret || randomSecret(),
        createdAt: new Date().toISOString(),
      };
      if (storage) {
        // Persist the candidate before upload. An ambiguous PUT retry must publish
        // the same secrets, not generate a second set after a restart.
        const scope = createHash("sha256").update(`${normalizePrefix(prefix)}/${DEFAULT_KEY}`).digest("hex").slice(0, 16);
        const local = new FileSecretStore(localPath && `${localPath}.${scope}`);
        if (!await local.load()) await local.create(candidate);
        await store.create(await local.load());
      } else await store.create(candidate);
      stored = await store.load();
    }
  }

  const resolved = {
    jwtSecret: configured.jwtSecret || stored?.jwtSecret,
    clusterSecret: configured.clusterSecret || stored?.clusterSecret,
  };
  if (!resolved.jwtSecret || !resolved.clusterSecret) {
    throw new Error("stored OBJY DB secrets are invalid");
  }
  return resolved;
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

class ObjectSecretStore {
  constructor(states, key, primary) {
    this.states = states;
    this.key = key;
    this.primary = primary;
  }

  async load() {
    const current = await this.states.read(this.key);
    const value = current.body ? parseSecrets(current.body) : null;
    if (value && this.primary) await this.states.adopt(this.key, current);
    return value;
  }

  async create(value) {
    await this.states.publish(this.key, value);
    await this.states.prune(this.key);
  }
}

class FileSecretStore {
  constructor(path) {
    if (!path) throw new Error("local system secret path is required");
    this.path = path;
  }

  async load() {
    try {
      return parseSecrets(await readFile(this.path, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async create(value) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomSecret(12)}`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
      finally { await file.close(); }
      await link(temporary, this.path);
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    } finally { await rm(temporary, { force: true }); }
  }
}

function parseSecrets(raw) {
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !optionalSecret(value.jwtSecret) || !optionalSecret(value.clusterSecret)) {
    throw new Error("stored OBJY DB secrets are invalid");
  }
  return value;
}

function optionalSecret(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizePrefix(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}
