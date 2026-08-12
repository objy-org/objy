export function valueKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function typeOf(value) {
  return valueKind(value);
}

export function shapeId(fields) {
  let h = 0x811c9dc5;
  const str = JSON.stringify(fields);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function layoutOf(entries) {
  return [...new Set(entries.map(([name]) => name))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({ name }));
}

function stableKey(value) {
  return `${valueKind(value)}:${JSON.stringify(sortForKey(value))}`;
}

function sortForKey(value) {
  if (Array.isArray(value)) return value.map(sortForKey);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, sortForKey(val)]),
    );
  }
  return value;
}

function cloneValue(value) {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

function estBytes(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 1;
  if (typeof value === "string") return value.length * 2;
  return JSON.stringify(value).length * 2;
}

class ValueColumn {
  constructor(capacity = 8) {
    this.codes = new Array(capacity).fill(0);
    this.keyToCode = new Map();
    this.values = [undefined];
    this.refs = [0];
    this.freeCodes = [];
  }

  ensure(row) {
    if (row < this.codes.length) return;
    let cap = this.codes.length || 8;
    while (row >= cap) cap *= 2;
    this.codes.length = cap;
    this.codes.fill(0, row + 1);
  }

  set(row, value) {
    this.ensure(row);
    const oldCode = this.codes[row];
    if (oldCode) this._release(oldCode);
    const nextCode = this._codeFor(value);
    this.refs[nextCode]++;
    this.codes[row] = nextCode;
  }

  get(row) {
    return cloneValue(this.values[this.codes[row]]);
  }

  getForQuery(row) {
    return this.values[this.codes[row]];
  }

  clear(row) {
    const code = this.codes[row];
    if (!code) return;
    this._release(code);
    this.codes[row] = 0;
  }

  bytes() {
    let total = this.codes.length * 8;
    for (const value of this.values) {
      if (value !== undefined) total += estBytes(value);
    }
    return total;
  }

  stats() {
    return {
      kind: "value",
      capacity: this.codes.length,
      values: this.keyToCode.size,
      bytes: this.bytes(),
    };
  }

  _codeFor(value) {
    const key = stableKey(value);
    const existing = this.keyToCode.get(key);
    if (existing) return existing;

    const code = this.freeCodes.pop() || this.values.length;
    this.keyToCode.set(key, code);
    this.values[code] = cloneValue(value);
    this.refs[code] = 0;
    return code;
  }

  _release(code) {
    this.refs[code]--;
    if (this.refs[code] > 0) return;

    const key = stableKey(this.values[code]);
    this.keyToCode.delete(key);
    this.values[code] = undefined;
    this.refs[code] = 0;
    this.freeCodes.push(code);
  }
}

export class Shape {
  constructor(fields) {
    this.id = shapeId(fields);
    this.fields = fields;
    this.byName = new Set(fields.map((f) => f.name));
    this.columns = {};
    for (const f of fields) this.columns[f.name] = new ValueColumn();
    this.rows = new Map();
    this.free = [];
    this.length = 0;
  }

  hasField(name) {
    return this.byName.has(name);
  }

  _ensure(row) {
    for (const f of this.fields) this.columns[f.name].ensure(row);
  }

  push(id, values) {
    const row = this.free.length ? this.free.pop() : this.length++;
    this._ensure(row);
    this.rows.set(id, row);
    for (const f of this.fields) this.columns[f.name].set(row, values[f.name]);
    return row;
  }

  set(id, name, value) {
    const row = this.rows.get(id);
    if (row === undefined || !this.hasField(name)) return false;
    this.columns[name].set(row, value);
    return true;
  }

  remove(id) {
    const row = this.rows.get(id);
    if (row === undefined) return;
    for (const f of this.fields) this.columns[f.name].clear(row);
    this.rows.delete(id);
    this.free.push(row);
  }

  read(id) {
    const row = this.rows.get(id);
    if (row === undefined) return undefined;
    const out = {};
    for (const f of this.fields) out[f.name] = this.columns[f.name].get(row);
    return out;
  }

  readForQuery(id) {
    const row = this.rows.get(id);
    if (row === undefined) return undefined;
    const out = {};
    for (const f of this.fields) out[f.name] = this.columns[f.name].getForQuery(row);
    return out;
  }

  bytes() {
    let total = 0;
    for (const f of this.fields) total += this.columns[f.name].bytes();
    return total;
  }

  columnStats() {
    return Object.fromEntries(this.fields.map((f) => [f.name, this.columns[f.name].stats()]));
  }
}

export class ShapeStore {
  constructor() {
    this.shapes = new Map();
    this.loc = new Map();
  }

  ensureShape(layout) {
    const id = shapeId(layout);
    let shape = this.shapes.get(id);
    if (!shape) {
      shape = new Shape(layout);
      this.shapes.set(id, shape);
    }
    return shape;
  }

  rebuild(id, live) {
    const old = this.loc.get(id);
    if (old) {
      const shape = this.shapes.get(old.shapeId);
      shape.remove(id);
      if (shape.rows.size === 0) this.shapes.delete(old.shapeId);
      this.loc.delete(id);
    }
    if (!live.length) return;
    const layout = layoutOf(live);
    const shape = this.ensureShape(layout);
    shape.push(id, Object.fromEntries(live));
    this.loc.set(id, { shapeId: shape.id });
  }

  writeField(id, field, value, live) {
    const old = this.loc.get(id);
    if (old) {
      const shape = this.shapes.get(old.shapeId);
      if (shape.hasField(field)) {
        shape.set(id, field, value);
        return;
      }
    }
    this.rebuild(id, live);
  }

  removeObject(id) {
    const old = this.loc.get(id);
    if (!old) return;
    const shape = this.shapes.get(old.shapeId);
    shape.remove(id);
    if (shape.rows.size === 0) this.shapes.delete(old.shapeId);
    this.loc.delete(id);
  }

  read(id) {
    const old = this.loc.get(id);
    if (!old) return undefined;
    return this.shapes.get(old.shapeId).read(id);
  }

  readForQuery(id) {
    const old = this.loc.get(id);
    if (!old) return undefined;
    return this.shapes.get(old.shapeId).readForQuery(id);
  }

  shapeStats() {
    return [...this.shapes.values()].map((s) => ({
      shapeId: s.id,
      fields: s.fields,
      rows: s.rows.size,
      bytes: s.bytes(),
      columns: s.columnStats(),
    }));
  }
}
