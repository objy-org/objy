import { compareSortValues, getPathValue } from "./query.js";

const MAX_REF_DEPTH = 8;

export function isReference(value) {
  return Boolean(
    isPlainObject(value) &&
      value.type === "reference" &&
      typeof value.collection === "string" &&
      value.collection.length > 0 &&
      value.value !== undefined &&
      value.value !== null &&
      String(value.value).length > 0,
  );
}

export function referenceTarget(ref, fallbackDatabase) {
  if (!isReference(ref)) return null;
  return {
    database: ref.database !== undefined && ref.database !== null ? String(ref.database) : fallbackDatabase,
    collection: String(ref.collection),
    id: String(ref.value),
  };
}

export function normalizeRefDepth(value, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(MAX_REF_DEPTH, Math.floor(n));
}

export function stripReferenceObjects(value) {
  return stripReferenceObjectsInner(value).value;
}

export function prepareReferenceValue(value) {
  const prepared = stripReferenceObjectsInner(value);
  return {
    value: prepared.value,
    hasReference: prepared.hasReference,
  };
}

export function expandReferencesSync(value, {
  database,
  depth = 1,
  getObject,
  seen = new Set(),
} = {}) {
  const refDepth = normalizeRefDepth(depth, 1);
  const prepared = prepareReferenceValue(value);
  if (refDepth <= 0 || !prepared.hasReference) return prepared.value;
  return expandReferencesSyncInner(prepared.value, {
    database,
    depth: refDepth,
    getObject,
    seen,
  });
}

export async function expandReferences(value, {
  database,
  depth = 1,
  getObject,
  seen = new Set(),
} = {}) {
  const refDepth = normalizeRefDepth(depth, 1);
  const prepared = prepareReferenceValue(value);
  if (refDepth <= 0 || !prepared.hasReference) return prepared.value;
  return expandReferencesInner(prepared.value, {
    database,
    depth: refDepth,
    getObject,
    seen,
  });
}

export async function expandReferenceObjects(objects, options = {}) {
  const out = [];
  for (const object of objects || []) out.push(await expandReferences(object, options));
  return out;
}

export function referenceDepthForQuery(query = {}) {
  return referenceDepthForCriteria(query);
}

export function referenceDepthForAggregateSpec(spec = {}) {
  if (!isPlainObject(spec)) return 0;
  let depth = 0;
  for (const path of asArray(spec.groupBy)) depth = Math.max(depth, referenceDepthForPath(path));
  for (const metric of ["sum", "avg", "min", "max"]) {
    for (const path of asArray(spec[metric])) depth = Math.max(depth, referenceDepthForPath(path));
  }
  if (isPlainObject(spec.fields)) {
    for (const definition of Object.values(spec.fields)) {
      if (!isPlainObject(definition)) continue;
      for (const [operator, operand] of Object.entries(definition)) {
        if (operator === "$count" && operand === true) continue;
        depth = Math.max(depth, referenceDepthForPath(operand));
      }
    }
  }
  return depth;
}

export function pathHasReferenceObject(path) {
  return referenceDepthForPath(path) > 0;
}

export function hasReferenceQuery(query = {}) {
  return referenceDepthForQuery(query) > 0;
}

export function referenceReadPlan(criteria = {}, options = {}) {
  const queryDepth = referenceDepthForQuery(criteria);
  const sortDepth = pathHasReferenceObject(options.sortBy) ? 1 : 0;
  const matchDepth = Math.max(queryDepth, sortDepth);
  const responseDepth = normalizeRefDepth(options.refDepth, matchDepth > 0 ? 1 : 0);
  return {
    queryDepth,
    sortDepth,
    matchDepth,
    responseDepth,
    expansionDepth: Math.max(matchDepth, normalizeRefDepth(options.refDepth, 0)),
  };
}

export function sortReferencePairs(pairs, options = {}) {
  if (!options.sortBy) return pairs;
  const direction = options.sort === "desc" ? -1 : 1;
  return [...pairs].sort((left, right) => {
    return compareSortValues(
      getPathValue(left.matchObject, options.sortBy),
      getPathValue(right.matchObject, options.sortBy),
    ) * direction;
  });
}

export function paginateReferencePairs(pairs, options = {}) {
  const offset = options.offset || 0;
  const limit = options.limit ?? Infinity;
  if (limit <= 0) return [];
  return pairs.slice(offset, offset + limit);
}

export function baseCriteriaForReferenceQuery(query = {}) {
  if (!isPlainObject(query)) return {};
  const out = {};

  for (const [path, expected] of Object.entries(query)) {
    if (path === "$and" && Array.isArray(expected)) {
      const children = expected.map(baseCriteriaForReferenceQuery).filter((child) => Object.keys(child).length > 0);
      if (children.length) out.$and = children;
      continue;
    }
    if (path.startsWith("$")) continue;
    if (pathHasReferenceObject(path) || valueHasReferencePath(expected)) continue;
    out[path] = expected;
  }

  return out;
}

function stripReferenceObjectsInner(value) {
  if (Array.isArray(value)) {
    let changed = false;
    let hasReference = false;
    const out = value.map((item) => {
      const stripped = stripReferenceObjectsInner(item);
      changed = changed || stripped.changed;
      hasReference = hasReference || stripped.hasReference;
      return stripped.value;
    });
    return changed
      ? { value: out, changed: true, hasReference }
      : { value, changed: false, hasReference };
  }

  if (!isPlainObject(value)) return { value, changed: false, hasReference: false };

  let changed = false;
  let hasReference = false;
  const out = {};
  const reference = isReference(value);
  if (reference) hasReference = true;
  for (const [key, item] of Object.entries(value)) {
    if (reference && key === "object") {
      changed = true;
      continue;
    }
    const stripped = stripReferenceObjectsInner(item);
    changed = changed || stripped.changed;
    hasReference = hasReference || stripped.hasReference;
    out[key] = stripped.value;
  }
  return changed
    ? { value: out, changed: true, hasReference }
    : { value, changed: false, hasReference };
}

function expandReferencesSyncInner(value, context) {
  if (Array.isArray(value)) return value.map((item) => expandReferencesSyncInner(item, context));

  if (isReference(value)) return expandReferenceSync(value, context);

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandReferencesSyncInner(item, context)]),
    );
  }

  return value;
}

function expandReferenceSync(ref, context) {
  const clean = cloneReferenceDescriptor(ref);
  if (context.depth <= 0 || typeof context.getObject !== "function") return clean;

  const target = referenceTarget(ref, context.database);
  if (!target?.database) {
    clean.object = null;
    return clean;
  }

  const key = referenceKey(target);
  if (context.seen.has(key)) {
    clean.object = null;
    return clean;
  }

  const nextSeen = new Set(context.seen);
  nextSeen.add(key);
  const object = context.getObject(target.database, target.collection, target.id);
  clean.object = object
    ? expandReferencesSyncInner(object, {
      ...context,
      database: target.database,
      depth: context.depth - 1,
      seen: nextSeen,
    })
    : null;
  return clean;
}

async function expandReferencesInner(value, context) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await expandReferencesInner(item, context));
    return out;
  }

  if (isReference(value)) return expandReference(value, context);

  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = await expandReferencesInner(item, context);
    return out;
  }

  return value;
}

async function expandReference(ref, context) {
  const clean = cloneReferenceDescriptor(ref);
  if (context.depth <= 0 || typeof context.getObject !== "function") return clean;

  const target = referenceTarget(ref, context.database);
  if (!target?.database) {
    clean.object = null;
    return clean;
  }

  const key = referenceKey(target);
  if (context.seen.has(key)) {
    clean.object = null;
    return clean;
  }

  const nextSeen = new Set(context.seen);
  nextSeen.add(key);
  const object = await context.getObject(target.database, target.collection, target.id);
  clean.object = object
    ? await expandReferencesInner(object, {
      ...context,
      database: target.database,
      depth: context.depth - 1,
      seen: nextSeen,
    })
    : null;
  return clean;
}

function cloneReferenceDescriptor(ref) {
  const out = {};
  for (const [key, value] of Object.entries(ref || {})) {
    if (key === "object") continue;
    out[key] = stripReferenceObjects(value);
  }
  return out;
}

function referenceDepthForCriteria(criteria) {
  if (!isPlainObject(criteria)) return 0;
  let depth = 0;

  for (const [path, expected] of Object.entries(criteria)) {
    if ((path === "$and" || path === "$or" || path === "$nor") && Array.isArray(expected)) {
      for (const child of expected) depth = Math.max(depth, referenceDepthForCriteria(child));
      continue;
    }
    if (path === "$not") {
      depth = Math.max(depth, referenceDepthForCriteria(expected));
      continue;
    }
    if (path === "$count" && isPlainObject(expected) && Array.isArray(expected.$constraints)) {
      for (const child of expected.$constraints) depth = Math.max(depth, referenceDepthForCriteria(child));
      continue;
    }
    if (!path.startsWith("$")) depth = Math.max(depth, referenceDepthForPath(path));
    depth = Math.max(depth, referenceDepthForOperatorValue(expected));
  }

  return depth;
}

function referenceDepthForOperatorValue(value) {
  if (Array.isArray(value)) return Math.max(0, ...value.map(referenceDepthForOperatorValue));
  if (!isPlainObject(value)) return 0;
  let depth = 0;
  for (const [key, item] of Object.entries(value)) {
    if (key === "$elemMatch") depth = Math.max(depth, referenceDepthForCriteria(item));
    else depth = Math.max(depth, referenceDepthForOperatorValue(item));
  }
  return depth;
}

function valueHasReferencePath(value) {
  return referenceDepthForOperatorValue(value) > 0;
}

function referenceDepthForPath(path) {
  if (typeof path !== "string" || path.length === 0) return 0;
  return path.split(".").filter((part) => part === "object").length;
}

function referenceKey({ database, collection, id }) {
  return `${database}\0${collection}\0${id}`;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
