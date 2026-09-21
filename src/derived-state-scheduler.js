import { setImmediate as yieldToEventLoop } from "node:timers/promises";

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
        enqueuedAt: Date.now(),
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

class DerivedStateJobContext {
  constructor(scheduler, job) {
    this.scheduler = scheduler;
    this.job = job;
    this.lastYieldAt = Date.now();
  }

  get cancelled() {
    return this.job.cancelled;
  }

  async checkpoint(processed = 0) {
    const count = Math.max(0, Math.floor(Number(processed) || 0));
    const shouldYieldByBatch = count > 0 && count % this.scheduler.batchSize === 0;
    const shouldYieldByTime = Date.now() - this.lastYieldAt >= this.scheduler.maxSliceMs;
    if (!shouldYieldByBatch && !shouldYieldByTime) return;
    this.lastYieldAt = Date.now();
    await yieldToEventLoop();
  }

  async yield() {
    this.lastYieldAt = Date.now();
    await yieldToEventLoop();
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
