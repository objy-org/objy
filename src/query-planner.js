import { normalizeAggregateSpec } from "./aggregate.js";

export const READ_PATH = {
  INDEX_EXACT: "index-exact",
  INDEX_PARTIAL: "index-partial",
  ORDERED_INDEX: "ordered-index",
  SCAN: "scan",
};

export const QUERY_PATH_HEADER = "x-objydb-query-path";

export const AGGREGATE_PATH = {
  COLUMN_SUMMARY: "aggregate-column-summary",
  COLUMN_SCAN: "aggregate-column-scan",
  GROUP_FORWARD_INDEX: "aggregate-group-forward-index",
  GROUP_INDEX: "aggregate-group-index",
  GROUP_COLUMN_SCAN: "aggregate-group-column-scan",
  SCAN: "aggregate-scan",
};

export function publicReadPath(path) {
  switch (path) {
    case READ_PATH.INDEX_EXACT:
      return "index-full";
    case READ_PATH.INDEX_PARTIAL:
      return "index-partial";
    case READ_PATH.ORDERED_INDEX:
      return "ordered-index";
    case READ_PATH.SCAN:
      return "scan";
    default:
      return path ? String(path) : null;
  }
}

export function publicAggregatePath(path) {
  return path ? String(path) : null;
}

export function combineQueryPaths(paths = []) {
  const out = [];
  const seen = new Set();
  for (const path of paths) {
    for (const part of String(path || "").split(",")) {
      const value = part.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out.join(",");
}

export function planRead(criteria = {}, options = {}, adapter) {
  const hasCriteria = hasObjectCriteria(criteria);
  const idPlan = hasCriteria ? planIndexedIds(criteria, adapter) : allIdsPlan();

  if (options.sortBy && adapter.hasOrderedIndex(options.sortBy)) {
    return {
      path: READ_PATH.ORDERED_INDEX,
      idPlan,
      sortBy: String(options.sortBy),
      reason: "sort field has an ordered field index",
    };
  }

  if (!hasCriteria) {
    return {
      path: READ_PATH.SCAN,
      idPlan,
      reason: "no criteria",
    };
  }

  if (idPlan?.exact) {
    return {
      path: READ_PATH.INDEX_EXACT,
      idPlan,
      reason: "all criteria are satisfied by field indexes",
    };
  }

  if (idPlan) {
    return {
      path: READ_PATH.INDEX_PARTIAL,
      idPlan,
      reason: "field indexes narrow part of the criteria",
    };
  }

  return {
    path: READ_PATH.SCAN,
    idPlan: allIdsPlan(),
    reason: "criteria are not indexable",
  };
}

export function planCount(criteria = {}, options = {}, adapter) {
  const read = planRead(criteria, options, adapter);
  if (read.path === READ_PATH.ORDERED_INDEX) {
    if (!hasObjectCriteria(criteria)) return { ...read, path: READ_PATH.SCAN, idPlan: allIdsPlan() };
    const idPlan = planIndexedIds(criteria, adapter);
    return idPlan
      ? { ...read, path: idPlan.exact ? READ_PATH.INDEX_EXACT : READ_PATH.INDEX_PARTIAL, idPlan }
      : { ...read, path: READ_PATH.SCAN, idPlan: allIdsPlan() };
  }
  return read;
}

export function planAggregate(criteria = {}, spec = {}, options = {}, adapter) {
  const normalized = normalizeAggregateSpec(spec);
  const hasCriteria = hasObjectCriteria(criteria);
  const includeId = typeof options.includeId === "function" ? options.includeId : null;
  const includeIds = options.includeIds instanceof Set ? options.includeIds : null;
  const idPlan = aggregateIdPlan(criteria, includeId, includeIds, adapter);
  const metricColumns = readyColumns(metricColumnPaths(normalized), adapter);

  if (!metricColumns.ready) {
    return aggregateScanPlan(normalized, `missing or building column index for ${metricColumns.missing}`);
  }

  if (normalized.groupBy.length === 0) {
    if (!hasCriteria && !includeId && !includeIds && canUseColumnSummary(normalized)) {
      return {
        path: AGGREGATE_PATH.COLUMN_SUMMARY,
        normalized,
        columns: metricColumns.columns,
        reason: "flat aggregate can be answered from column summaries",
      };
    }

    if (!idPlan) return aggregateScanPlan(normalized, "criteria cannot be narrowed by indexes");
    return {
      path: AGGREGATE_PATH.COLUMN_SCAN,
      normalized,
      columns: metricColumns.columns,
      idPlan,
      reason: "flat aggregate can scan column values over planned ids",
    };
  }

  if (!idPlan) return aggregateScanPlan(normalized, "criteria cannot be narrowed by indexes");

  const scopeShards = Array.isArray(options.scopeShards) ? options.scopeShards : null;
  if (normalized.groupBy.length === 1 && !isRowCountOnlyAggregate(normalized) && idPlan.exact && idPlan.ids instanceof Set &&
      adapter.hasGroupForwardIndex?.(normalized.groupBy[0])) {
    return {
      path: AGGREGATE_PATH.GROUP_FORWARD_INDEX,
      normalized,
      columns: metricColumns.columns,
      groupBy: normalized.groupBy[0],
      groupIndex: adapter.fieldIndex(normalized.groupBy[0]),
      idPlan,
      reason: "groupBy field can be read from the field index forward map and metrics have column indexes",
    };
  }

  if (normalized.groupBy.length === 1 && adapter.hasGroupIndex(normalized.groupBy[0])) {
    return {
      path: AGGREGATE_PATH.GROUP_INDEX,
      normalized,
      columns: metricColumns.columns,
      groupBy: normalized.groupBy[0],
      groupIndex: adapter.fieldIndex(normalized.groupBy[0]),
      idPlan,
      reason: "groupBy field has a field index and metrics have column indexes",
    };
  }

  const groupColumns = readyColumns(normalized.groupBy, adapter);
  if (!groupColumns.ready) {
    return aggregateScanPlan(normalized, `missing or building group column index for ${groupColumns.missing}`);
  }

  return {
    path: AGGREGATE_PATH.GROUP_COLUMN_SCAN,
    normalized,
    columns: mergeColumnMaps(metricColumns.columns, groupColumns.columns),
    idPlan,
    reason: "group fields and metric fields have ready column indexes",
  };
}

function planIndexedIds(criteria, adapter) {
  const exact = adapter.idsForCriteria(criteria);
  if (exact !== null) return { ids: exact, exact: true, verify: false };

  const partial = adapter.partialIdsForCriteria(criteria);
  if (partial !== null) return { ids: partial, exact: false, verify: true };

  return null;
}

function aggregateIdPlan(criteria, includeId, includeIds, adapter) {
  if (!hasObjectCriteria(criteria)) {
    if (includeIds && includeId) return { ids: adapter.filterIds(includeIds, includeId), exact: true, verify: false };
    if (includeIds) return { ids: includeIds, exact: true, verify: false };
    if (includeId) return { ids: adapter.idsForAll(includeId), exact: true, verify: false };
    return allIdsPlan();
  }

  const indexed = planIndexedIds(criteria, adapter);
  if (!indexed) return null;
  if (includeIds) return { ...indexed, scopeIds: includeIds };
  if (!includeId) return indexed;
  return {
    ...indexed,
    ids: adapter.filterIds(indexed.ids, includeId),
  };
}

function allIdsPlan() {
  return { ids: null, exact: true, verify: false };
}

function aggregateScanPlan(normalized, reason) {
  return {
    path: AGGREGATE_PATH.SCAN,
    normalized,
    reason,
  };
}

function readyColumns(paths, adapter) {
  const columns = new Map();
  for (const path of unique(paths)) {
    const column = adapter.column(path);
    if (!column || !column.ready) return { ready: false, missing: path, columns };
    columns.set(path, column);
  }
  return { ready: true, columns };
}

function metricColumnPaths(normalized) {
  const paths = [];
  for (const field of normalized.fields) {
    if (field.operator === "$count" && field.operand === true) continue;
    paths.push(field.operand);
  }
  return paths;
}

function canUseColumnSummary(normalized) {
  return normalized.fields.every((field) => {
    return field.operator === "$sum" || field.operator === "$avg" || field.operator === "$count";
  });
}

function isRowCountOnlyAggregate(normalized) {
  return normalized.fields.length > 0 &&
    normalized.fields.every((field) => field.operator === "$count" && field.operand === true);
}

function mergeColumnMaps(left, right) {
  const merged = new Map(left);
  for (const [path, column] of right) merged.set(path, column);
  return merged;
}

function hasObjectCriteria(criteria) {
  return Boolean(criteria && typeof criteria === "object" && !Array.isArray(criteria) && Object.keys(criteria).length > 0);
}

function unique(values) {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}
