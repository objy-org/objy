import { existsSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";

const DEFAULT_REJECT_PERCENT = 85;
const DEFAULT_RESUME_PERCENT = 78;
const DEFAULT_CHECK_MS = 1000;
const RETRY_AFTER_SECONDS = 5;

export class MemoryGuard {
  constructor(config = {}, deps = {}) {
    this.enabled = config.enabled === true;
    this.rejectWritesPercent = percent(
      config.rejectWritesPercent ?? config.maxRssPercent,
      DEFAULT_REJECT_PERCENT,
    );
    this.resumeWritesPercent = percent(config.resumeWritesPercent, Math.min(DEFAULT_RESUME_PERCENT, this.rejectWritesPercent));
    if (this.resumeWritesPercent > this.rejectWritesPercent) {
      throw new Error("memoryGuard.resumeWritesPercent must be <= memoryGuard.rejectWritesPercent");
    }
    this.checkMs = positiveInt(config.checkMs, DEFAULT_CHECK_MS);
    this.getUsage = deps.getUsage || (() => process.memoryUsage());
    this.now = deps.now || (() => Date.now());
    const detected = deps.limitBytes
      ? { bytes: deps.limitBytes, source: "injected" }
      : memoryLimit(config);
    this.limitBytes = detected.bytes;
    this.limitSource = detected.source;
    this.acceptingWrites = true;
    this.lastSample = null;
    this.lastSampleAt = 0;
  }

  status({ force = false } = {}) {
    if (!this.enabled) {
      const sample = this._sample(force);
      return {
        enabled: false,
        acceptingWrites: true,
        writeState: "accepting",
        ...sample,
      };
    }

    const sample = this._sample(force);
    if (this.acceptingWrites && sample.rssPercent >= this.rejectWritesPercent) {
      this.acceptingWrites = false;
    } else if (!this.acceptingWrites && sample.rssPercent <= this.resumeWritesPercent) {
      this.acceptingWrites = true;
    }

    return {
      enabled: true,
      acceptingWrites: this.acceptingWrites,
      writeState: this.acceptingWrites ? "accepting" : "rejecting",
      rejectWritesPercent: this.rejectWritesPercent,
      resumeWritesPercent: this.resumeWritesPercent,
      checkMs: this.checkMs,
      ...sample,
    };
  }

  writeRejection() {
    const status = this.status({ force: true });
    if (status.acceptingWrites) return null;
    return {
      status: 507,
      headers: { "retry-after": String(RETRY_AFTER_SECONDS) },
      body: {
        error: "peer memory limit exceeded",
        rssMb: status.rssMb,
        limitMb: status.limitMb,
        rssPercent: status.rssPercent,
        writeState: status.writeState,
      },
    };
  }

  assertCanWrite() {
    const rejection = this.writeRejection();
    if (!rejection) return true;
    const err = new Error(rejection.body.error);
    err.status = rejection.status;
    err.body = rejection.body;
    err.headers = rejection.headers;
    throw err;
  }

  _sample(force = false) {
    const at = this.now();
    if (!force && this.lastSample && at - this.lastSampleAt < this.checkMs) return this.lastSample;
    const usage = this.getUsage();
    const rss = Number(usage.rss) || 0;
    const limit = this.limitBytes || 1;
    this.lastSample = {
      rss,
      rssMb: mib(rss),
      limitBytes: limit,
      limitMb: mib(limit),
      limitSource: this.limitSource,
      rssPercent: Math.round((rss / limit) * 10_000) / 100,
    };
    this.lastSampleAt = at;
    return this.lastSample;
  }
}

export function createMemoryGuard(config = {}, deps = {}) {
  if (config instanceof MemoryGuard) return config;
  return new MemoryGuard(config || {}, deps);
}

function memoryLimit(config = {}) {
  if (Number.isFinite(config.limitBytes) && config.limitBytes > 0) {
    return { bytes: Math.floor(config.limitBytes), source: "config" };
  }
  if (Number.isFinite(config.limitMb) && config.limitMb > 0) {
    return { bytes: Math.floor(config.limitMb * 1024 * 1024), source: "config" };
  }
  return detectedMemoryLimit();
}

function detectedMemoryLimit() {
  const host = totalmem();
  const cgroup = cgroupMemoryLimit();
  if (cgroup && cgroup < host) return { bytes: cgroup, source: "cgroup" };
  return { bytes: host, source: "os" };
}

function cgroupMemoryLimit() {
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8").trim();
    if (!raw || raw === "max") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER) return Math.floor(value);
  }
  return null;
}

function percent(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function mib(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}
