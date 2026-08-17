import { stableKey } from "./query.js";

const DEFAULT_VALUE_DIRECTORY = Object.freeze({
  enabled: true,
  minRefs: 2,
  maxEntries: 100_000,
  maxCandidates: 4_096,
  maxCandidatesPerPath: 256,
  maxPaths: 1_024,
  maxStringLength: 256,
  maxKeyBytes: 512,
  poolStructuredValues: false,
  maxNestedContainerEntries: 64,
});

export class ObjectRowStore {
  constructor(options = {}) {
    this.rows = new Map();
    this.valueDirectory = new ValueDirectory(options.valueDirectory);
  }

  rebuild(id, live, options = {}) {
    const old = this.rows.get(id);
    if (old) this.valueDirectory.releaseAll(old.refs);
    this.rows.delete(id);

    if (!live.length) return;
    const refs = [];
    const value = {};
    const storeOptions = { trusted: options.trusted === true };
    for (const [key, item] of live) value[key] = this.valueDirectory.store(item, refs, key, storeOptions);
    this.rows.set(id, { value, refs });
  }

  removeObject(id) {
    const old = this.rows.get(id);
    if (!old) return;
    this.valueDirectory.releaseAll(old.refs);
    this.rows.delete(id);
  }

  read(id) {
    const row = this.rows.get(id);
    return row ? cloneValue(row.value) : undefined;
  }

  readForQuery(id) {
    return this.rows.get(id)?.value;
  }

  bytes() {
    let total = 0;
    for (const row of this.rows.values()) total += estimateValue(row.value);
    return total + this.valueDirectory.bytes();
  }

  shapeStats() {
    return [{
      engine: "object",
      rows: this.rows.size,
      bytes: this.bytes(),
      valueDirectory: this.valueDirectory.stats(),
    }];
  }
}

class ValueDirectory {
  constructor(options = {}) {
    const config = { ...DEFAULT_VALUE_DIRECTORY, ...(options || {}) };
    this.enabled = config.enabled !== false;
    this.minRefs = positiveInt(config.minRefs, DEFAULT_VALUE_DIRECTORY.minRefs);
    this.maxEntries = positiveInt(config.maxEntries, DEFAULT_VALUE_DIRECTORY.maxEntries);
    this.maxCandidates = positiveInt(config.maxCandidates, DEFAULT_VALUE_DIRECTORY.maxCandidates);
    this.maxCandidatesPerPath = positiveInt(config.maxCandidatesPerPath, DEFAULT_VALUE_DIRECTORY.maxCandidatesPerPath);
    this.maxPaths = positiveInt(config.maxPaths, DEFAULT_VALUE_DIRECTORY.maxPaths);
    this.maxStringLength = positiveInt(config.maxStringLength, DEFAULT_VALUE_DIRECTORY.maxStringLength);
    this.maxKeyBytes = positiveInt(config.maxKeyBytes, DEFAULT_VALUE_DIRECTORY.maxKeyBytes);
    this.poolStructuredValues = config.poolStructuredValues === true;
    this.maxNestedContainerEntries = positiveInt(config.maxNestedContainerEntries, DEFAULT_VALUE_DIRECTORY.maxNestedContainerEntries);
    this.pool = new Map();
    this.pathCandidates = new Map();
    this.candidateCount = 0;
  }

  store(value, refs, path = "$", options = {}) {
    if (!this.enabled) return cloneValue(value, options);

    const key = this.keyFor(value);
    if (key) {
      const pooled = this.pool.get(key);
      if (pooled) {
        pooled.refs++;
        refs.push(key);
        return pooled.value;
      }
      if (this.shouldPromote(path, key)) {
        const stored = deepFreeze(cloneValue(value));
        this.pool.set(key, {
          value: stored,
          refs: 1,
          bytes: estimateValue(stored),
        });
        this.deleteCandidate(path, key);
        refs.push(key);
        return stored;
      }
    }

    return this.cloneWithNestedPooling(value, refs, path, options);
  }

  cloneWithNestedPooling(value, refs, path, options = {}) {
    if (options.trusted && !this.poolStructuredValues) return value;
    if (Array.isArray(value)) {
      if (value.length > this.maxNestedContainerEntries) return cloneValue(value, options);
      return value.map((item) => this.store(item, refs, `${path}[]`, options));
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length > this.maxNestedContainerEntries) return cloneValue(value, options);
      return Object.fromEntries(
        entries.map(([key, item]) => [key, this.store(item, refs, `${path}.${key}`, options)]),
      );
    }
    return cloneValue(value, options);
  }

  releaseAll(refs) {
    for (const key of refs || []) this.release(key);
  }

  release(key) {
    const pooled = this.pool.get(key);
    if (!pooled) return;
    pooled.refs--;
    if (pooled.refs <= 0) this.pool.delete(key);
  }

  shouldPromote(path, key) {
    if (this.pool.size >= this.maxEntries) return false;
    const candidates = this.candidatesForPath(path);
    if (!candidates) return false;
    const count = (candidates.get(key) || 0) + 1;
    if (count >= this.minRefs) return true;
    this.rememberCandidate(candidates, key, count);
    return false;
  }

  candidatesForPath(path) {
    const normalized = path || "$";
    let candidates = this.pathCandidates.get(normalized);
    if (candidates) return candidates;
    if (this.pathCandidates.size >= this.maxPaths) return null;
    candidates = new Map();
    this.pathCandidates.set(normalized, candidates);
    return candidates;
  }

  rememberCandidate(candidates, key, count) {
    if (this.maxCandidates <= 0 || this.maxCandidatesPerPath <= 0) return;
    if (candidates.has(key)) {
      candidates.set(key, count);
      return;
    }
    while (this.candidateCount >= this.maxCandidates && this.dropOldestCandidate()) {}
    if (this.candidateCount >= this.maxCandidates) return;
    if (candidates.size >= this.maxCandidatesPerPath) {
      const oldest = candidates.keys().next().value;
      if (oldest !== undefined) {
        candidates.delete(oldest);
        this.candidateCount--;
      }
    }
    if (this.candidateCount < this.maxCandidates && candidates.size < this.maxCandidatesPerPath) {
      candidates.set(key, count);
      this.candidateCount++;
    }
  }

  deleteCandidate(path, key) {
    const candidates = this.pathCandidates.get(path || "$");
    if (!candidates?.delete(key)) return;
    this.candidateCount--;
  }

  dropOldestCandidate() {
    for (const candidates of this.pathCandidates.values()) {
      const oldest = candidates.keys().next().value;
      if (oldest === undefined) continue;
      candidates.delete(oldest);
      this.candidateCount--;
      return true;
    }
    return false;
  }

  keyFor(value) {
    if (typeof value === "string") {
      if (value.length > this.maxStringLength) return null;
      return `string:${value}`;
    }
    if (!this.poolStructuredValues) return null;
    if (Array.isArray(value) || isPlainObject(value)) {
      const key = stableKey(value);
      if (!key || key.length > this.maxKeyBytes) return null;
      return `${Array.isArray(value) ? "array" : "object"}:${key}`;
    }
    return null;
  }

  bytes() {
    let total = 0;
    for (const [key, entry] of this.pool) total += key.length * 2 + entry.bytes;
    for (const candidates of this.pathCandidates.values()) {
      for (const key of candidates.keys()) total += key.length * 2 + 8;
    }
    return total;
  }

  stats() {
    let refs = 0;
    for (const entry of this.pool.values()) refs += entry.refs;
    return {
      enabled: this.enabled,
      entries: this.pool.size,
      refs,
      candidates: this.candidateCount,
      candidatePaths: this.pathCandidates.size,
      bytes: this.bytes(),
      minRefs: this.minRefs,
      maxEntries: this.maxEntries,
      maxCandidates: this.maxCandidates,
      maxCandidatesPerPath: this.maxCandidatesPerPath,
      maxPaths: this.maxPaths,
      maxStringLength: this.maxStringLength,
      maxKeyBytes: this.maxKeyBytes,
      poolStructuredValues: this.poolStructuredValues,
      maxNestedContainerEntries: this.maxNestedContainerEntries,
    };
  }
}

function cloneValue(value, options = {}) {
  if (value === null || typeof value !== "object") return value;
  if (options.trusted) return value;
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function estimateValue(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 1;
  if (typeof value === "string") return value.length * 2;
  if (Array.isArray(value)) return 24 + value.reduce((sum, item) => sum + 8 + estimateValue(item), 0);
  if (typeof value === "object") {
    return 32 + Object.entries(value).reduce((sum, [key, item]) => {
      return sum + key.length * 2 + 8 + estimateValue(item);
    }, 0);
  }
  return 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
