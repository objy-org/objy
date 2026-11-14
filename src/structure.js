import { matchesQuery } from "./query.js";

const RESERVED_ROOTS = new Set([
  "_id",
  "_file",
  "_vec",
  "admin",
  "collectionPermissions",
  "globalUser",
  "password",
  "permissions",
  "sessionId",
  "tokenVersion",
]);
const SENSITIVE_CONDITION_KEYS = new Set(["_vec", "password"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UNSUPPORTED_CONDITION_KEYS = new Set([
  "$aggregate",
  "$cb",
  "$cursor",
  "$limit",
  "$offset",
  "$page",
  "$pageSize",
  "$refDepth",
  "$skip",
  "$sort",
  "$vector",
  "$where",
]);

export function normalizeStructure(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError("collection meta structure must be an array");

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw structureError(index, "must be a plain object");
    for (const key of Object.keys(entry)) {
      if (key !== "condition" && key !== "apply") {
        throw structureError(index, `.${key} is not supported`);
      }
    }
    const condition = entry.condition === undefined ? {} : entry.condition;
    if (!isPlainObject(condition)) throw structureError(index, ".condition must be a plain object");
    if (!isPlainObject(entry.apply)) throw structureError(index, ".apply must be a plain object");
    assertConditionValue(condition, `structure[${index}].condition`);
    assertApplyValue(entry.apply, index, []);
    return {
      condition: cloneJsonValue(condition),
      apply: cloneJsonValue(entry.apply),
    };
  });
}

export function compileStructure(structure = []) {
  if (!structure.length) return null;
  return structure.map(({ condition, apply }) => ({
    matches: (object) => matchesQuery(object, condition),
    values: flattenApplyValue(apply),
  }));
}

export function materializeStructure(object, plan) {
  if (!plan || !isPlainObject(object)) return object;
  const matching = [];
  for (const rule of plan) if (rule.matches(object)) matching.push(rule);
  const physicalValues = new Set();
  for (const rule of matching) {
    for (const entry of rule.values) {
      if (hasPhysicalValue(object, entry.path)) physicalValues.add(entry);
    }
  }
  for (const rule of matching) {
    for (const entry of rule.values) {
      if (!physicalValues.has(entry)) setVirtualValue(object, entry.path, cloneJsonValue(entry.value));
    }
  }
  return object;
}

function flattenApplyValue(value, path = [], out = []) {
  const entries = Object.entries(value);
  if (path.length && entries.length === 0) out.push({ path, value });
  for (const [key, entry] of entries) {
    const nextPath = [...path, key];
    if (isPlainObject(entry) && Object.keys(entry).length) flattenApplyValue(entry, nextPath, out);
    else out.push({ path: nextPath, value: entry });
  }
  return out;
}

function hasPhysicalValue(object, path) {
  let current = object;
  for (let index = 0; index < path.length; index++) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, path[index])) return false;
    current = current[path[index]];
    if (index < path.length - 1 && !isPlainObject(current)) return true;
  }
  return true;
}

function setVirtualValue(object, path, value) {
  let current = object;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key];
  }
  current[path[path.length - 1]] = value;
}

function assertConditionValue(value, label) {
  assertJsonValue(value, label, (key, path) => {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`${path} contains an unsafe key`);
    if (SENSITIVE_CONDITION_KEYS.has(key)) throw new TypeError(`${path}.${key} is not supported`);
    if (UNSUPPORTED_CONDITION_KEYS.has(key)) throw new TypeError(`${path}.${key} is not supported`);
  });
}

function assertApplyValue(value, index, path) {
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (UNSAFE_KEYS.has(key)) throw structureError(index, `.apply.${nextPath.join(".")} is unsafe`);
    if (path.length === 0 && RESERVED_ROOTS.has(key)) {
      throw structureError(index, `.apply.${key} is reserved`);
    }
    if (isPlainObject(entry)) assertApplyValue(entry, index, nextPath);
    else assertJsonValue(entry, `structure[${index}].apply.${nextPath.join(".")}`);
  }
}

function assertJsonValue(value, label, inspectKey = null) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`, inspectKey));
    return;
  }
  if (!isPlainObject(value)) throw new TypeError(`${label} must contain JSON values`);
  for (const [key, entry] of Object.entries(value)) {
    inspectKey?.(key, label);
    assertJsonValue(entry, `${label}.${key}`, inspectKey);
  }
}

function cloneJsonValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]));
}

function structureError(index, message) {
  return new TypeError(`collection meta structure[${index}]${message}`);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
