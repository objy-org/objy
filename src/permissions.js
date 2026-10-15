import { matchesQuery } from "./query.js";

const OP_CODES = {
  create: "c",
  read: "r",
  update: "u",
  delete: "d",
};

const VALID_PERMS = new Set(["c", "r", "u", "d"]);
const QUERY_CONTROLS = new Set([
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

export function normalizePermissions(permissions) {
  if (permissions === undefined || permissions === null) return [];
  if (!Array.isArray(permissions)) throw permissionConfigError("permissions must be an array");

  return permissions.map((rule, index) => normalizeRule(rule, index)).filter(Boolean);
}

export function normalizeCollectionPermissions(permissions) {
  if (permissions === undefined) return { read: [], write: [] };
  if (!isPlainObject(permissions)) throw permissionConfigError("collectionPermissions must be an object");
  for (const key of Object.keys(permissions)) {
    if (key !== "read" && key !== "write") {
      throw permissionConfigError(`collectionPermissions.${key} is not supported`);
    }
  }
  const normalizeNames = (key) => {
    const names = permissions[key] === undefined ? [] : permissions[key];
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name.trim())) {
      throw permissionConfigError(`collectionPermissions.${key} must be a list of collection names`);
    }
    return [...new Set(names)];
  };
  return { read: normalizeNames("read"), write: normalizeNames("write") };
}

export function mergeReadPermissionQuery(criteria = {}, user = null, collection = null) {
  if (hasCollectionPermission(user, "read", collection)) return { denied: false, query: criteria || {} };
  const permissions = readRules(user);
  if (permissions.some(isAllowAllRule)) return { denied: false, query: criteria || {} };
  if (!permissions.length) return { denied: true, query: null };

  const authQuery = permissions.length === 1
    ? cloneValue(permissions[0].query || {})
    : { $or: permissions.map((rule) => cloneValue(rule.query || {})) };
  if (!criteria || Object.keys(criteria).length === 0) return { denied: false, query: authQuery };
  return {
    denied: false,
    query: { $and: [criteria, authQuery] },
  };
}

export function canCreate(user, object, collection = null) {
  return can(user, "create", object, collection);
}

export function canRead(user, object, collection = null) {
  return can(user, "read", object, collection);
}

export function canUpdate(user, before, after, collection = null) {
  return can(user, "update", before, collection) && can(user, "update", after, collection);
}

export function canDelete(user, object, collection = null) {
  return can(user, "delete", object, collection);
}

export function can(user, operation, object, collection = null) {
  const code = OP_CODES[operation] || operation;
  const collectionAction = code === "r" ? "read" : ["c", "u", "d"].includes(code) ? "write" : null;
  if (collectionAction && hasCollectionPermission(user, collectionAction, collection)) {
    return true;
  }
  return rulesFor(user).some((rule) => permits(rule, code) && matchesPermissionQuery(rule, object));
}

export function isPermissionBypass(userOrClaims) {
  return Boolean(
    userOrClaims?.admin === true ||
      (userOrClaims?.globalUser === true && userOrClaims?.role === "admin"),
  );
}

export function permissionError(operation, id = null) {
  const err = new Error(`Permission denied: ${operation}${id ? ` ${id}` : ""}`);
  err.status = 403;
  err.code = "E_PERMISSION_DENIED";
  return err;
}

function readRules(user) {
  return rulesFor(user).filter((rule) => permits(rule, OP_CODES.read));
}

function hasCollectionPermission(user, operation, collection) {
  if (!user || isPermissionBypass(user)) return true;
  if (typeof collection !== "string" || !collection) return false;
  const names = user.collectionPermissions?.[operation];
  return Array.isArray(names) && names.includes(collection);
}

function rulesFor(user) {
  if (!user || isPermissionBypass(user)) return [{ query: {}, perm: "*" }];
  try {
    return normalizePermissions(user.permissions);
  } catch {
    return [];
  }
}

function normalizeRule(rule, index) {
  if (!isPlainObject(rule)) throw permissionConfigError(`permissions[${index}] must be an object`);
  const perm = normalizePerm(rule.perm);
  if (!perm) return null;
  const query = rule.query === undefined ? {} : rule.query;
  if (!isPlainObject(query)) throw permissionConfigError(`permissions[${index}].query must be an object`);
  for (const key of Object.keys(query)) {
    if (QUERY_CONTROLS.has(key)) throw permissionConfigError(`permissions[${index}].query must not include ${key}`);
  }

  return {
    ...(typeof rule.name === "string" && rule.name.length > 0 ? { name: rule.name } : {}),
    query: cloneValue(query),
    perm,
  };
}

function normalizePerm(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "*") return "*";
  const chars = [];
  for (const ch of raw) {
    if (!VALID_PERMS.has(ch) || chars.includes(ch)) continue;
    chars.push(ch);
  }
  return chars.join("");
}

function permits(rule, code) {
  return rule.perm === "*" || (typeof rule.perm === "string" && rule.perm.includes(code));
}

function matchesPermissionQuery(rule, object) {
  if (isAllowAllRule(rule)) return true;
  return Boolean(object) && matchesQuery(object, rule.query || {});
}

function isAllowAllRule(rule) {
  return rule?.perm === "*" && Object.keys(rule.query || {}).length === 0;
}

function permissionConfigError(message) {
  const err = new TypeError(message);
  err.status = 400;
  return err;
}

function cloneValue(value) {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
