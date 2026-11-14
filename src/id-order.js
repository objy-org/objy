import { mergeOrdered, selectOrdered } from "./order.js";

const RUN_SIZE = 4096;

// IDs are immutable and RIDs are append-only. The unindexed tail is therefore
// represented by a position in the existing ID array, without a per-write log.
export class IdOrder {
  constructor(ids, scheduler, owner, name) {
    this.ids = ids;
    this.scheduler = scheduler;
    this.owner = owner;
    this.name = name;
    this.indexed = 0;
    this.runs = [];
    this.task = null;
    this.error = null;
    this.disposed = false;
    this.compare = (a, b) => ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0;
  }

  get complete() {
    return this.indexed === this.ids.length;
  }

  get bytes() {
    return this.runs.reduce((sum, run) => sum + (run?.byteLength || 0), 0);
  }

  request() {
    if (this.disposed || this.task || this.complete) return this.task;
    this.error = null;
    const task = this.scheduler.schedule(`id-order:${this.name}`, (job) => this._build(job), { owner: this.owner });
    this.task = task;
    task.then(() => {
      this.task = null;
      if (!this.complete) this.request();
    }, (error) => {
      this.task = null;
      this.error = error;
    });
    return task;
  }

  async ready() {
    while (!this.disposed && !this.complete) await this.request();
  }

  page(accepts, { offset = 0, limit = Infinity, sort } = {}) {
    if (limit <= 0) return [];
    this.request();
    const desc = sort === "desc";
    const compare = desc ? (a, b) => this.compare(b, a) : this.compare;
    const streams = this.runs.filter(Boolean).map((run) => iterateRun(run, desc, accepts));
    const tail = (function* (order) {
      for (let rid = order.indexed; rid < order.ids.length; rid++) if (accepts(rid)) yield rid;
    })(this);
    streams.push(selectOrdered(tail, compare, { limit: offset + limit }));
    const result = [];
    let skipped = 0;
    for (const rid of mergeOrdered(streams, compare)) {
      if (skipped++ < offset) continue;
      result.push(rid);
      if (result.length >= limit) break;
    }
    return result;
  }

  dispose() {
    this.disposed = true;
    this.runs = [];
  }

  async _build(job) {
    const target = this.ids.length;
    while (!this.disposed && !job.cancelled && this.indexed < target) {
      const end = Math.min(this.indexed + RUN_SIZE, target);
      if (end > 0x1_0000_0000) throw new RangeError("ID ordering exceeds the Uint32 RID range");
      let run = new Uint32Array(end - this.indexed);
      for (let i = 0; i < run.length; i++) run[i] = this.indexed + i;
      run.sort(this.compare);
      const firstLevel = Math.ceil(Math.log2(run.length));
      let level = firstLevel;
      while (this.runs[level]) {
        run = await mergeRuns(this.runs[level], run, this.compare, job);
        if (this.disposed || job.cancelled) return;
        level++;
      }
      // Publish a complete prefix atomically. Reads made during a merge still
      // see the old runs and include every newer RID through the tail.
      for (let i = firstLevel; i < level; i++) this.runs[i] = null;
      this.runs[level] = run;
      this.indexed = end;
      await job.checkpoint(RUN_SIZE);
    }
  }
}

function* iterateRun(run, desc, accepts) {
  for (let i = desc ? run.length - 1 : 0; desc ? i >= 0 : i < run.length; i += desc ? -1 : 1) {
    const rid = run[i];
    if (accepts(rid)) yield rid;
  }
}

async function mergeRuns(left, right, compare, job) {
  const out = new Uint32Array(left.length + right.length);
  let a = 0, b = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = b >= right.length || (a < left.length && compare(left[a], right[b]) <= 0) ? left[a++] : right[b++];
    if ((i + 1) % RUN_SIZE === 0) {
      await job.checkpoint(i + 1);
      if (job.cancelled) return out;
    }
  }
  return out;
}
