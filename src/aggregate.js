import { compareSortValues, getPathValue, stableKey } from "./query.js";

const aggregateOperators = new Set(["$sum", "$min", "$max", "$avg", "$count"]);

export function isObjectDbAggregateSpec(spec) {
  return Boolean(spec && typeof spec === "object" && !Array.isArray(spec) && spec.fields !== undefined);
}

export function aggregateObjects(rows, spec) {
  return mergeAggregatePartials(aggregatePartialObjects(rows, spec), spec);
}

export function aggregatePartialObjects(rows, spec) {
  const normalized = normalizeAggregateSpec(spec);
  const buckets = new Map();
  let rowsSeen = 0;

  for (const row of rows || []) {
    rowsSeen++;
    const groupValues = {};
    const groupKeyValues = [];
    for (const path of normalized.groupBy) {
      const value = getPathValue(row, path);
      const stored = value === undefined ? null : value;
      groupValues[path] = stored;
      groupKeyValues.push(stored);
    }

    const key = stableKey(groupKeyValues);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        groupValues,
        fields: makeFieldState(normalized.fields),
      };
      buckets.set(key, bucket);
    }

    for (const field of normalized.fields) stepField(bucket.fields[field.resultKey], field, row);
  }

  if (rowsSeen === 0) return [];

  return [...buckets.values()].map((bucket) => {
    const out = { ...bucket.groupValues };
    for (const field of normalized.fields) writePartialField(out, bucket.fields[field.resultKey], field);
    return out;
  });
}

export function mergeAggregatePartials(rows, spec) {
  const normalized = normalizeAggregateSpec(spec);
  const buckets = aggregatePartialBuckets(rows, normalized);
  if (buckets === null) return [];

  let result = [...buckets.values()].map((bucket) => {
    const out = { ...bucket.groupValues };
    for (const field of normalized.fields) out[field.resultKey] = finishField(bucket.fields[field.resultKey], field);
    return out;
  });

  if (normalized.sort.length) result = result.sort(makeComparator(normalized.sort));

  const start = (normalized.page - 1) * normalized.pageSize;
  return result.slice(start, start + normalized.pageSize);
}

export function combineAggregatePartials(rows, spec) {
  const normalized = normalizeAggregateSpec(spec);
  const buckets = aggregatePartialBuckets(rows, normalized);
  if (buckets === null) return [];

  return [...buckets.values()].map((bucket) => {
    const out = { ...bucket.groupValues };
    for (const field of normalized.fields) writePartialField(out, bucket.fields[field.resultKey], field);
    return out;
  });
}

function aggregatePartialBuckets(rows, normalized) {
  const buckets = new Map();
  let rowsSeen = 0;

  for (const row of rows || []) {
    rowsSeen++;
    const groupValues = {};
    const groupKeyValues = [];
    for (const path of normalized.groupBy) {
      const value = row?.[path];
      const stored = value === undefined ? null : value;
      groupValues[path] = stored;
      groupKeyValues.push(stored);
    }

    const key = stableKey(groupKeyValues);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        groupValues,
        fields: makeFieldState(normalized.fields),
      };
      buckets.set(key, bucket);
    }

    for (const field of normalized.fields) mergePartialField(bucket.fields[field.resultKey], field, row);
  }

  return rowsSeen === 0 ? null : buckets;
}

export function normalizeAggregateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError("$aggregate must be a plain object");
  }

  return {
    groupBy: normalizeGroupBy(spec.groupBy),
    fields: normalizeFields(spec.fields),
    sort: normalizeSort(spec.$sort),
    page: normalizePositiveInteger(spec.$page, "$aggregate.$page", 1),
    pageSize: normalizePositiveInteger(spec.$pageSize, "$aggregate.$pageSize", 20),
  };
}

function normalizeGroupBy(groupBy) {
  if (groupBy === undefined || groupBy === null) return [];
  if (typeof groupBy === "string" && groupBy.length > 0) return [groupBy];
  if (Array.isArray(groupBy)) {
    return groupBy.map((path) => {
      if (typeof path !== "string" || path.length === 0) {
        throw new TypeError("$aggregate.groupBy entries must be non-empty strings");
      }
      return path;
    });
  }
  throw new TypeError("$aggregate.groupBy must be a string or an array of strings");
}

function normalizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new TypeError("$aggregate.fields must be a plain object");
  }

  return Object.entries(fields).map(([resultKey, definition]) => {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new TypeError(`$aggregate.fields.${resultKey} must be an operator object`);
    }
    const entries = Object.entries(definition);
    if (entries.length !== 1) {
      throw new TypeError(`$aggregate.fields.${resultKey} must define exactly one operator`);
    }

    const [[operator, operand]] = entries;
    if (!aggregateOperators.has(operator)) {
      throw new TypeError(`$aggregate.fields.${resultKey} has unknown operator ${operator}`);
    }
    if (operator === "$count") {
      if (operand !== true && (typeof operand !== "string" || operand.length === 0)) {
        throw new TypeError(`$aggregate.fields.${resultKey}.$count must be true or a field path`);
      }
    } else if (typeof operand !== "string" || operand.length === 0) {
      throw new TypeError(`$aggregate.fields.${resultKey}.${operator} must be a field path`);
    }

    return { resultKey, operator, operand };
  });
}

function normalizeSort(sort) {
  if (sort === undefined || sort === null) return [];
  if (typeof sort !== "object" || Array.isArray(sort)) {
    throw new TypeError("$aggregate.$sort must be a plain object");
  }
  return Object.entries(sort).map(([path, direction]) => {
    if (direction !== 1 && direction !== -1) {
      throw new TypeError(`$aggregate.$sort.${path} must be 1 or -1`);
    }
    return { path, direction };
  });
}

function normalizePositiveInteger(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be an integer >= 1`);
  return parsed;
}

function makeFieldState(fields) {
  const state = {};
  for (const field of fields) {
    switch (field.operator) {
      case "$sum":
        state[field.resultKey] = { sum: 0 };
        break;
      case "$avg":
        state[field.resultKey] = { sum: 0, count: 0 };
        break;
      case "$min":
      case "$max":
        state[field.resultKey] = { value: undefined };
        break;
      case "$count":
        state[field.resultKey] = { count: 0 };
        break;
    }
  }
  return state;
}

function stepField(state, field, row) {
  switch (field.operator) {
    case "$sum": {
      const value = getPathValue(row, field.operand);
      if (typeof value === "number" && Number.isFinite(value)) state.sum += value;
      return;
    }
    case "$avg": {
      const value = getPathValue(row, field.operand);
      if (typeof value === "number" && Number.isFinite(value)) {
        state.sum += value;
        state.count++;
      }
      return;
    }
    case "$min": {
      const value = getPathValue(row, field.operand);
      if (!isComparable(value)) return;
      if (state.value === undefined || sameTypeLessThan(value, state.value)) state.value = value;
      return;
    }
    case "$max": {
      const value = getPathValue(row, field.operand);
      if (!isComparable(value)) return;
      if (state.value === undefined || sameTypeLessThan(state.value, value)) state.value = value;
      return;
    }
    case "$count": {
      if (field.operand === true) {
        state.count++;
        return;
      }
      const value = getPathValue(row, field.operand);
      if (value !== undefined && value !== null) state.count++;
      return;
    }
  }
}

function finishField(state, field) {
  switch (field.operator) {
    case "$sum":
      return state.sum;
    case "$avg":
      return state.count ? state.sum / state.count : null;
    case "$min":
    case "$max":
      return state.value === undefined ? null : state.value;
    case "$count":
      return state.count;
    default:
      return null;
  }
}

function writePartialField(out, state, field) {
  switch (field.operator) {
    case "$sum":
      out[field.resultKey] = state.sum;
      return;
    case "$avg":
      out[avgSumKey(field.resultKey)] = state.sum;
      out[avgCountKey(field.resultKey)] = state.count;
      return;
    case "$min":
    case "$max":
      out[field.resultKey] = state.value === undefined ? null : state.value;
      return;
    case "$count":
      out[field.resultKey] = state.count;
  }
}

function mergePartialField(state, field, row) {
  switch (field.operator) {
    case "$sum": {
      const value = row?.[field.resultKey];
      if (typeof value === "number" && Number.isFinite(value)) state.sum += value;
      return;
    }
    case "$avg": {
      const sum = row?.[avgSumKey(field.resultKey)];
      const count = row?.[avgCountKey(field.resultKey)];
      if (typeof sum === "number" && Number.isFinite(sum)) state.sum += sum;
      if (typeof count === "number" && Number.isFinite(count)) state.count += count;
      return;
    }
    case "$min": {
      const value = row?.[field.resultKey];
      if (!isComparable(value)) return;
      if (state.value === undefined || sameTypeLessThan(value, state.value)) state.value = value;
      return;
    }
    case "$max": {
      const value = row?.[field.resultKey];
      if (!isComparable(value)) return;
      if (state.value === undefined || sameTypeLessThan(state.value, value)) state.value = value;
      return;
    }
    case "$count": {
      const value = row?.[field.resultKey];
      if (typeof value === "number" && Number.isFinite(value)) state.count += value;
    }
  }
}

function avgSumKey(resultKey) {
  return `$partial.${resultKey}.sum`;
}

function avgCountKey(resultKey) {
  return `$partial.${resultKey}.count`;
}

function isComparable(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function sameTypeLessThan(left, right) {
  if (typeof left !== typeof right) return false;
  return compareSortValues(left, right) < 0;
}

function makeComparator(sort) {
  return (left, right) => {
    for (const { path, direction } of sort) {
      const leftValue = left[path];
      const rightValue = right[path];
      const leftMissing = leftValue === null || leftValue === undefined;
      const rightMissing = rightValue === null || rightValue === undefined;
      if (leftMissing && rightMissing) continue;
      if (leftMissing) return 1;
      if (rightMissing) return -1;
      const compared = compareSortValues(leftValue, rightValue);
      if (compared !== 0) return compared * direction;
    }
    return 0;
  };
}
