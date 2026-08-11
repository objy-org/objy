export const DEFAULT_VECTOR_FIELD = "_vec";

export function isValidVector(value) {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export function cloneVector(value) {
  return isValidVector(value) ? [...value] : null;
}

export function cosine(a, b) {
  if (!isValidVector(a) || !isValidVector(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function rankBySimilarity(rows, queryVec, {
  limit = 20,
  getVec,
  idOf = (row) => row?.id,
} = {}) {
  if (!isValidVector(queryVec) || typeof getVec !== "function") return [];
  const scored = [];
  for (const row of rows || []) {
    const id = idOf(row);
    if (id === undefined || id === null) continue;
    const vec = getVec(String(id));
    if (!isValidVector(vec) || vec.length !== queryVec.length) continue;
    scored.push({ row, score: cosine(queryVec, vec) });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, Math.max(0, limit)).map(({ row, score }) => ({ ...row, _score: score }));
}

export function normalizeVectorConfig(config = {}) {
  if (config === false || config.enabled === false) {
    return { enabled: false, field: null, hnsw: normalizeHnswConfig({}) };
  }
  return {
    enabled: true,
    field: typeof config.field === "string" && config.field.length > 0 ? config.field : DEFAULT_VECTOR_FIELD,
    hnsw: normalizeHnswConfig(config.hnsw),
  };
}

function normalizeHnswConfig(config = {}) {
  return {
    M: positiveInt(config.M, 16),
    efConstruction: positiveInt(config.efConstruction, 200),
    efSearch: positiveInt(config.efSearch, 0),
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
