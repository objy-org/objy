class Heap {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }

  get size() {
    return this.items.length;
  }

  peek() {
    return this.items[0];
  }

  push(item) {
    this.items.push(item);
    this.up(this.items.length - 1);
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.down(0);
    }
    return top;
  }

  up(index) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.items[index], this.items[parent]) >= 0) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  down(index) {
    for (;;) {
      let best = index;
      const left = index * 2 + 1;
      const right = left + 1;
      if (left < this.items.length && this.compare(this.items[left], this.items[best]) < 0) best = left;
      if (right < this.items.length && this.compare(this.items[right], this.items[best]) < 0) best = right;
      if (best === index) break;
      [this.items[index], this.items[best]] = [this.items[best], this.items[index]];
      index = best;
    }
  }
}

function minHeap() {
  return new Heap((left, right) => left.dist - right.dist);
}

function maxHeap() {
  return new Heap((left, right) => right.dist - left.dist);
}

export function angularDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class HNSWIndex {
  constructor({ M = 16, efConstruction = 200, getVec } = {}) {
    if (typeof getVec !== "function") {
      throw new TypeError("HNSWIndex requires getVec(id)");
    }
    this.M = positiveInt(M, 16);
    this.M0 = this.M * 2;
    this.ef = positiveInt(efConstruction, 200);
    this.mL = 1 / Math.log(this.M);
    this.getVec = getVec;
    this.nodes = new Map();
    this.entryPoint = null;
    this.maxLayer = -1;
    this.deleted = new Set();
  }

  get size() {
    return this.nodes.size - this.deleted.size;
  }

  insert(id, vec) {
    const key = String(id);
    if (!Array.isArray(vec)) return;
    if (this.nodes.has(key)) this._unlinkExisting(key);

    const level = Math.floor(-Math.log(Math.random()) * this.mL);
    const node = { neighbors: Array.from({ length: level + 1 }, () => []) };
    this.nodes.set(key, node);

    if (this.entryPoint === null) {
      this.entryPoint = key;
      this.maxLayer = level;
      return;
    }

    const epVec = this.getVec(this.entryPoint);
    let entry = epVec ? [{ id: this.entryPoint, dist: angularDistance(vec, epVec) }] : [];

    for (let layer = this.maxLayer; layer > level; layer--) {
      const found = this._searchLayer(entry, vec, 1, layer);
      if (found.length) entry = found.slice(0, 1);
    }

    for (let layer = Math.min(level, this.maxLayer); layer >= 0; layer--) {
      const maxNeighbors = layer === 0 ? this.M0 : this.M;
      const candidates = this._searchLayer(entry, vec, this.ef, layer);
      const neighbors = this._selectNeighbors(candidates, maxNeighbors);
      node.neighbors[layer] = neighbors.map((neighbor) => neighbor.id);

      for (const neighbor of neighbors) {
        const other = this.nodes.get(neighbor.id);
        if (!other) continue;
        if (!other.neighbors[layer]) other.neighbors[layer] = [];
        other.neighbors[layer].push(key);
        if (other.neighbors[layer].length > maxNeighbors) {
          const otherVec = this.getVec(neighbor.id);
          if (!otherVec) continue;
          const pruned = other.neighbors[layer]
            .map((id) => {
              const candidateVec = this.getVec(id);
              return candidateVec ? { id, dist: angularDistance(otherVec, candidateVec) } : null;
            })
            .filter(Boolean)
            .sort((left, right) => left.dist - right.dist);
          other.neighbors[layer] = this._selectNeighbors(pruned, maxNeighbors).map((item) => item.id);
        }
      }

      entry = candidates;
    }

    if (level > this.maxLayer) {
      this.maxLayer = level;
      this.entryPoint = key;
    }
  }

  remove(id) {
    const key = String(id);
    if (!this.nodes.has(key)) return;
    this.deleted.add(key);
    if (this.entryPoint === key) this._resetEntryPoint();
  }

  search(queryVec, k, ef = Math.max(k, 20)) {
    if (!this.entryPoint) return [];
    const epVec = this.getVec(this.entryPoint);
    if (!epVec) return [];

    let entry = [{ id: this.entryPoint, dist: angularDistance(queryVec, epVec) }];
    for (let layer = this.maxLayer; layer > 0; layer--) {
      const found = this._searchLayer(entry, queryVec, 1, layer);
      if (found.length) entry = found.slice(0, 1);
    }

    return this._searchLayer(entry, queryVec, Math.max(positiveInt(ef, 20), k), 0).slice(0, k);
  }

  clear() {
    this.nodes.clear();
    this.deleted.clear();
    this.entryPoint = null;
    this.maxLayer = -1;
  }

  _searchLayer(entryPoints, queryVec, ef, layer) {
    const visited = new Set(entryPoints.map((entry) => entry.id));
    const candidates = minHeap();
    const result = maxHeap();

    for (const entry of entryPoints) {
      candidates.push(entry);
      result.push(entry);
    }

    while (candidates.size > 0) {
      const current = candidates.pop();
      if (result.size >= ef && current.dist > result.peek().dist) break;

      const node = this.nodes.get(current.id);
      if (!node) continue;
      for (const neighborId of node.neighbors[layer] || []) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        if (this.deleted.has(neighborId)) continue;
        const neighborVec = this.getVec(neighborId);
        if (!neighborVec) continue;
        const dist = angularDistance(queryVec, neighborVec);
        if (result.size < ef || dist < result.peek().dist) {
          candidates.push({ id: neighborId, dist });
          result.push({ id: neighborId, dist });
          if (result.size > ef) result.pop();
        }
      }
    }

    const out = [];
    while (result.size > 0) out.push(result.pop());
    return out.reverse();
  }

  _selectNeighbors(candidates, maxNeighbors) {
    const selected = [];
    const discarded = [];
    for (const candidate of candidates) {
      if (selected.length >= maxNeighbors) break;
      const candidateVec = this.getVec(candidate.id);
      if (!candidateVec) continue;
      let good = true;
      for (const current of selected) {
        const currentVec = this.getVec(current.id);
        if (currentVec && angularDistance(candidateVec, currentVec) < candidate.dist) {
          good = false;
          break;
        }
      }
      if (good) selected.push(candidate);
      else discarded.push(candidate);
    }
    for (const candidate of discarded) {
      if (selected.length >= maxNeighbors) break;
      selected.push(candidate);
    }
    return selected;
  }

  _unlinkExisting(id) {
    const old = this.nodes.get(id);
    for (let layer = 0; layer < old.neighbors.length; layer++) {
      for (const neighborId of old.neighbors[layer] || []) {
        const neighbor = this.nodes.get(neighborId);
        if (neighbor?.neighbors[layer]) {
          neighbor.neighbors[layer] = neighbor.neighbors[layer].filter((entry) => entry !== id);
        }
      }
    }
    this.nodes.delete(id);
    this.deleted.delete(id);
    if (this.entryPoint === id) this._resetEntryPoint();
  }

  _resetEntryPoint() {
    let bestId = null;
    let bestLayer = -1;
    for (const [id, node] of this.nodes) {
      if (this.deleted.has(id)) continue;
      const layer = node.neighbors.length - 1;
      if (layer > bestLayer) {
        bestId = id;
        bestLayer = layer;
      }
    }
    this.entryPoint = bestId;
    this.maxLayer = bestLayer;
  }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
