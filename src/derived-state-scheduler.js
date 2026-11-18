import { yieldToEventLoop } from "./runtime.js";

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_BATCH_SIZE = 4096;
const DEFAULT_MAX_SLICE_MS = 12;

export class DerivedStateScheduler {
  constructor(options = {}) {
    this.maxConcurrent = positiveInt(options.maxConcurrent, DEFAULT_MAX_CONCURRENT);
    this.batchSize = positiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
    this.maxSliceMs = positiveInt(options.maxSliceMs, DEFAULT_MAX_SLICE_MS);
    this.queue = [];
    this.active = new Set();
    this.completed = 0;
    this.failed = 0;
    this.closed = false;
  }

  schedule(name, run, { owner = null } = {}) {
    if (typeof run !== "function") throw new TypeError("derived state job requires a run function");
    if (this.closed) return Promise.reject(new Error("derived state scheduler is closed"));

    return new Promise((resolve, reject) => {
      this.queue.push({
        name: String(name || "derived-state"),
        run,
        owner,
        cancelled: false,
        resolve,
        reject,
      });
      this._drain();
    });
  }

  cancel(owner) {
    if (owner === null || owner === undefined) return 0;
    let cancelled = 0;
    this.queue = this.queue.filter((job) => {
      if (job.owner !== owner) return true;
      job.cancelled = true;
      job.resolve(undefined);
      cancelled++;
      return false;
    });
    for (const job of this.active) {
      if (job.owner !== owner || job.cancelled) continue;
      job.cancelled = true;
      cancelled++;
    }
    return cancelled;
  }

  stats() {
    return {
      active: this.active.size,
      queued: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      jobs: [...this.active].map((job) => ({
        name: job.name,
        startedAt: new Date(job.startedAt).toISOString(),
      })),
    };
  }

  close() {
    this.closed = true;
    const pending = this.queue.splice(0);
    for (const job of pending) job.reject(new Error("derived state scheduler is closed"));
  }

  _drain() {
    while (!this.closed && this.active.size < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      job.startedAt = Date.now();
      this.active.add(job);
      this._run(job);
    }
  }

  async _run(job) {
    const context = new DerivedStateJobContext(this, job);
    try {
      await yieldToEventLoop();
      job.resolve(job.cancelled ? undefined : await job.run(context));
      this.completed++;
    } catch (error) {
      this.failed++;
      job.reject(error);
    } finally {
      this.active.delete(job);
      this._drain();
    }
  }
}

export class WorkBudget {
  constructor(options = {}) {
    this.batchLimit = positiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
    this.maxSliceMs = positiveInt(options.maxSliceMs, DEFAULT_MAX_SLICE_MS);
    this.lastYieldAt = Date.now();
  }

  checkpoint(processed = 0) {
    const count = Math.max(0, Math.floor(Number(processed) || 0));
    const shouldYieldByBatch = count > 0 && count % this.batchLimit === 0;
    const shouldYieldByTime = Date.now() - this.lastYieldAt >= this.maxSliceMs;
    if (!shouldYieldByBatch && !shouldYieldByTime) return;
    return this.yield();
  }

  async yield() {
    await yieldToEventLoop();
    this.lastYieldAt = Date.now();
  }
}

class DerivedStateJobContext extends WorkBudget {
  constructor(scheduler, job) {
    super(scheduler);
    this.scheduler = scheduler;
    this.job = job;
  }

  get cancelled() {
    return this.scheduler.closed || this.job.cancelled;
  }

  get batchSize() {
    return Math.min(64, this.scheduler.batchSize);
  }

  async forEach(values, visit, { beforeBatch, limit = Infinity } = {}) {
    let processed = 0;
    if (limit <= 0) return !this.cancelled;
    beforeBatch?.();
    for (const value of values) {
      if (this.cancelled || visit(value) === false) return false;
      if (++processed % this.batchSize === 0 || processed % this.scheduler.batchSize === 0) {
        const pause = this.checkpoint(processed);
        if (pause) {
          await pause;
          beforeBatch?.();
        }
      }
      if (processed >= limit) break;
    }
    if (processed % this.batchSize) {
      const pause = this.checkpoint(processed);
      if (pause) await pause;
    }
    return !this.cancelled;
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
