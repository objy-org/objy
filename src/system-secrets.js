import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_KEY = "system/secrets.json";

export async function resolveSystemSecrets({
  jwtSecret,
  clusterSecret,
  storage,
  prefix = "spread-db",
  localPath,
} = {}) {
  const configured = {
    jwtSecret: optionalSecret(jwtSecret),
    clusterSecret: optionalSecret(clusterSecret),
  };
  if (configured.jwtSecret && configured.clusterSecret) return configured;

  const store = storage
    ? new ObjectSecretStore(storage, `${normalizePrefix(prefix)}/${DEFAULT_KEY}`)
    : new FileSecretStore(localPath);
  let stored = await store.load();
  if (!stored) {
    const candidate = {
      version: 1,
      jwtSecret: configured.jwtSecret || randomSecret(),
      clusterSecret: configured.clusterSecret || randomSecret(),
      createdAt: new Date().toISOString(),
    };
    await store.create(candidate);
    stored = await store.load();
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
  constructor(storage, key) {
    this.storage = storage;
    this.key = key;
  }

  async load() {
    const raw = await this.storage.get(this.key);
    return raw ? parseSecrets(raw) : null;
  }

  async create(value) {
    return this.storage.putIfAbsent(this.key, JSON.stringify(value), "application/json");
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
    try {
      await writeFile(this.path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    }
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
