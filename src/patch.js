const PROTECTED_ROOTS = new Set(["_id"]);

export function applyPatchToObject(current, patch) {
  if (!isPlainObject(patch)) throw new TypeError("patch body must be a plain object");
  assertSupportedPatchKeys(patch);

  const next = clonePatchValue(current || {});
  delete next._id;

  const set = patch.$set ?? {};
  if (!isPlainObject(set)) throw new TypeError("$set must be a plain object when provided");
  for (const [path, value] of Object.entries(set)) {
    setPath(next, path, clonePatchValue(value), `$set.${path}`);
  }

  for (const path of unsetPaths(patch.$unset)) {
    unsetPath(next, path, "$unset");
  }

  return next;
}

export function patchUnsetsPath(patch, path) {
  if (!path || !isPlainObject(patch)) return false;
  return unsetPaths(patch.$unset).includes(path);
}

function assertSupportedPatchKeys(patch) {
  for (const key of Object.keys(patch)) {
    if (key !== "$set" && key !== "$unset") {
      throw new TypeError(`unsupported patch key "${key}"`);
    }
  }
}

function unsetPaths(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return Object.keys(value);
  throw new TypeError("$unset must be an array of dot-notation paths or an object when provided");
}

function setPath(target, path, value, field) {
  const parts = assertPatchPath(path, field);
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = cursor[part];
    if (!isPlainObject(next)) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function unsetPath(target, path, field) {
  const parts = assertPatchPath(path, field);
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    cursor = cursor[parts[i]];
    if (!isPlainObject(cursor)) return;
  }
  delete cursor[parts[parts.length - 1]];
}

function assertPatchPath(path, field) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError(`${field} must be a non-empty dot-notation path`);
  }
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0)) {
    throw new TypeError(`${field} must be a valid dot-notation path`);
  }
  if (PROTECTED_ROOTS.has(parts[0])) {
    throw new TypeError(`${parts[0]} cannot be changed`);
  }
  return parts;
}

function clonePatchValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clonePatchValue);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clonePatchValue(child)]));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
