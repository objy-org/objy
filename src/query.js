const rhsOperators = new Set([
  "$cb",
  "$deepEquals",
  "$eq",
  "$equal",
  "$ne",
  "$not",
  "$nor",
  "$and",
  "$or",
  "$any",
  "$all",
  "$null",
  "$in",
  "$likeI",
  "$like",
  "$startsWith",
  "$endsWith",
  "$elemMatch",
  "$contains",
  "$nin",
  "$regex",
  "$gte",
  "$gt",
  "$lt",
  "$lte",
  "$before",
  "$after",
  "$type",
  "$size",
  "$mod",
  "$between",
  "$exists",
]);

const queryControls = new Set([
  "$aggregate",
  "$cursor",
  "$limit",
  "$offset",
  "$page",
  "$pageSize",
  "$refDepth",
  "$skip",
  "$sort",
  "$vector",
]);

export function getPathValue(source, path) {
  if (source === null || source === undefined) return undefined;
  const key = String(path);
  if (key === "_id") return source._id;
  if (key === "id") return source.id;

  return key.split(".").reduce((cursor, part) => {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return undefined;
    return cursor[part];
  }, source);
}

export function stableKey(value) {
  return JSON.stringify(sortForKey(value));
}

export function matchesQuery(object, query = {}) {
  const criteria = stripQueryControls(query);
  if (!isPlainObject(criteria)) return false;

  for (const [path, expected] of Object.entries(criteria)) {
    if (path === "$and") {
      if (!logicalConstraints(expected).every((constraint) => matchesQuery(object, constraint))) return false;
      continue;
    }
    if (path === "$or") {
      if (!logicalConstraints(expected).some((constraint) => matchesQuery(object, constraint))) return false;
      continue;
    }
    if (path === "$nor") {
      if (logicalConstraints(expected).some((constraint) => matchesQuery(object, constraint))) return false;
      continue;
    }
    if (path === "$not") {
      if (matchesQuery(object, expected)) return false;
      continue;
    }
    if (path === "$count") {
      if (!matchesCount(object, expected)) return false;
      continue;
    }
    if (path === "$where") {
      if (!matchesWhere(object, expected)) return false;
      continue;
    }

    const actual = getPathValue(object, path);
    if (!matchesConstraint(actual, expected, path)) return false;
  }

  return true;
}

export function stripQueryControls(query = {}) {
  if (!isPlainObject(query)) return query;
  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (!queryControls.has(key)) out[key] = value;
  }
  return out;
}

export function splitQueryControls(query = {}) {
  if (!isPlainObject(query)) {
    return {
      criteria: {},
      controls: {},
    };
  }
  const criteria = {};
  const controls = {};
  for (const [key, value] of Object.entries(query)) {
    if (queryControls.has(key)) controls[key] = value;
    else criteria[key] = value;
  }
  return { criteria, controls };
}

export function parseQuerySort(value) {
  if (typeof value === "string" && value.length > 0) {
    return value.startsWith("-")
      ? { sortBy: value.slice(1), sort: "desc" }
      : { sortBy: value.replace(/^\+/, ""), sort: "asc" };
  }
  if (isPlainObject(value)) {
    const [field, direction] = Object.entries(value)[0] || [];
    if (!field) return {};
    return { sortBy: field, sort: direction === -1 || direction === "desc" ? "desc" : "asc" };
  }
  return {};
}

export function queryInteger(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

export function firstQueryInteger(...values) {
  for (const value of values) {
    const parsed = queryInteger(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function queryPageOffset(page, pageSize) {
  const parsedPage = queryInteger(page);
  return parsedPage === undefined || pageSize === undefined
    ? undefined
    : Math.max(0, parsedPage - 1) * pageSize;
}

export function compareSortValues(left, right) {
  if (Object.is(left, right)) return 0;
  if (left === undefined || left === null) return 1;
  if (right === undefined || right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export function matchesConstraint(actual, expected, parentKey) {
  if (expected === actual) return true;
  if (expected instanceof RegExp) return regexMatches(actual, expected);
  if (Array.isArray(expected)) return inOperator(actual, expected);

  if (expected && typeof expected === "object") {
    if (expected instanceof Date) return equal(actual, expected.getTime());
    if (expected.$regex !== undefined) return regexMatches(actual, regexFromLegacySpec(expected));

    for (const [operator, operand] of Object.entries(expected)) {
      if (!rhsOperators.has(operator)) return equal(actual, expected);
      if (!matchesOperator(operator, actual, operand, parentKey)) return false;
    }
    return true;
  }

  if (Array.isArray(actual)) return actual.some((entry) => equal(entry, expected));
  if (isNullishConstraint(expected)) return nullOperator(actual);
  return equal(actual, expected);
}

function matchesOperator(operator, actual, operand, parentKey) {
  switch (operator) {
    case "$cb":
      return typeof operand === "function" && Boolean(operand(actual, parentKey));
    case "$deepEquals":
      return stableKey(actual) === stableKey(operand);
    case "$eq":
    case "$equal":
      return equal(actual, operand);
    case "$ne":
      return !matchesConstraint(actual, operand, parentKey);
    case "$not":
      return !matchesConstraint(actual, operand, parentKey);
    case "$nor":
      return !orOperator(actual, operand, parentKey);
    case "$and":
    case "$all":
      return andOperator(actual, operand, parentKey);
    case "$or":
    case "$any":
      return orOperator(actual, operand, parentKey);
    case "$null":
      return Boolean(operand) ? nullOperator(actual) : !nullOperator(actual);
    case "$in":
      return inOperator(actual, operand);
    case "$likeI":
      return likeOperator(actual, operand, { ignoreCase: true });
    case "$like":
      return likeOperator(actual, operand);
    case "$startsWith":
      return stringList(actual).some((value) => value.startsWith(String(operand)));
    case "$endsWith":
      return stringList(actual).some((value) => value.endsWith(String(operand)));
    case "$elemMatch":
      return Array.isArray(actual) && actual.some((entry) => matchesQuery(entry, operand));
    case "$contains":
      return contains(actual, operand);
    case "$nin":
      return !inOperator(actual, operand);
    case "$regex":
      return regexMatches(actual, regexFromOperand(operand));
    case "$gte":
      return !nullOperator(actual) && actual >= resolveOperand(operand);
    case "$gt":
      return !nullOperator(actual) && actual > resolveOperand(operand);
    case "$lt":
      return !nullOperator(actual) && actual < resolveOperand(operand);
    case "$lte":
      return !nullOperator(actual) && actual <= resolveOperand(operand);
    case "$before":
      return beforeAfter(actual, operand, "$before");
    case "$after":
      return beforeAfter(actual, operand, "$after");
    case "$type":
      return typeOf(actual) === operand;
    case "$size":
      return sizeOf(actual) === Number(operand);
    case "$mod":
      return Array.isArray(operand) && operand.length >= 2 && actual % operand[0] == operand[1];
    case "$between":
      return Array.isArray(operand) &&
        operand.length >= 2 &&
        matchesConstraint(actual, { $gt: operand[0], $lt: operand[1] }, parentKey);
    case "$exists":
      return existsOperator(actual, operand);
    default:
      return false;
  }
}

function matchesCount(object, condition) {
  if (!isPlainObject(condition) || !Array.isArray(condition.$constraints)) return false;
  const count = condition.$constraints.filter((constraint) => matchesQuery(object, constraint)).length;
  return matchesConstraint(count, condition.$constraint);
}

function matchesWhere(object, condition) {
  if (typeof condition !== "function") return false;
  return Boolean(condition.call(object, object));
}

function logicalConstraints(value) {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return [];
  return Object.entries(value).map(([key, constraint]) => ({ [key]: constraint }));
}

function andOperator(actual, constraints, parentKey) {
  if (!Array.isArray(constraints)) return false;
  return constraints.every((constraint) => matchesConstraint(actual, constraint, parentKey));
}

function orOperator(actual, constraints, parentKey) {
  if (!Array.isArray(constraints)) return false;
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => constraints.some((constraint) => matchesConstraint(value, constraint, parentKey)));
}

function inOperator(actual, expected) {
  if (!Array.isArray(expected)) return false;
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => expected.some((constraint) => matchesConstraint(value, constraint)));
}

function contains(actual, expected) {
  if (typeof actual === "string") return actual.includes(String(expected));
  if (Array.isArray(actual)) return actual.some((entry) => equal(entry, expected));
  return false;
}

function regexMatches(actual, regex) {
  if (!(regex instanceof RegExp)) return false;
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => {
    regex.lastIndex = 0;
    return regex.test(value);
  });
}

function regexFromLegacySpec(spec) {
  if (spec.$regex && typeof spec.$regex === "object" && typeof spec.$regex.pattern === "string") {
    return new RegExp(spec.$regex.pattern, spec.$regex.flags || spec.$options || "");
  }
  return new RegExp(spec.$regex, spec.$options || "");
}

function regexFromOperand(operand) {
  if (operand instanceof RegExp) return operand;
  if (typeof operand === "string") return new RegExp(operand);
  if (operand && typeof operand === "object" && typeof operand.pattern === "string") {
    return new RegExp(operand.pattern, operand.flags || "");
  }
  return null;
}

function likeOperator(actual, expected, { ignoreCase = false } = {}) {
  const needle = ignoreCase ? String(expected).toLowerCase() : String(expected);
  return stringList(actual).some((value) => {
    const haystack = ignoreCase ? value.toLowerCase() : value;
    return haystack.includes(needle);
  });
}

function stringList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry) => typeof entry === "string");
}

function beforeAfter(actual, operand, operator) {
  const left = dateComparable(actual);
  const right = dateComparable(resolveOperand(operand));
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return operator === "$before" ? left <= right : left >= right;
}

function dateComparable(value) {
  if (typeof value === "string") return Date.parse(value);
  if (value instanceof Date) return value.getTime();
  return value;
}

function resolveOperand(value) {
  if (value && typeof value === "object" && value.$date !== undefined) return Date.parse(value.$date);
  return value;
}

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sizeOf(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (typeof value === "object") return Object.keys(value).length;
  return NaN;
}

function existsOperator(value, expected) {
  return (value !== undefined && value !== null) === Boolean(expected);
}

function nullOperator(value) {
  if (value === "" || value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.every((entry) => nullOperator(entry));
  return false;
}

function isNullishConstraint(value) {
  return value === "" || value === null || value === undefined;
}

function equal(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) return left.some((entry) => equal(entry, right));
  if (isNullishConstraint(right)) return nullOperator(left);
  if (isNullishConstraint(left)) return false;

  if (left instanceof Date) {
    if (right instanceof Date) return left.getTime() == right.getTime();
    if (typeof right === "number") return left.getTime() == right;
    if (typeof right === "string") return left.getTime() == Date.parse(right);
  }

  if ((left && typeof left === "object") || (right && typeof right === "object")) {
    return stableKey(left) === stableKey(right);
  }

  return left == right;
}

function sortForKey(value) {
  if (Array.isArray(value)) return value.map(sortForKey);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortForKey(entry)]),
    );
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
