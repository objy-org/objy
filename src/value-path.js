const UNSAFE_PARTS = new Set(["__proto__", "prototype", "constructor"]);
const own = (value, key) => value !== null && typeof value === "object" && Object.hasOwn(value, key);
const container = (value) => value !== null && typeof value === "object";
const arrayIndex = (key) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < 0xffff_ffff;

export function valuePathParts(path) {
  if (typeof path !== "string" || !path) {
    throw new TypeError("field must be a valid dot-notation path");
  }
  const parts = path.split(".");
  for (const part of parts) {
    if (!part) throw new TypeError("field must be a valid dot-notation path");
    if (UNSAFE_PARTS.has(part)) throw new TypeError("unsafe field path");
  }
  return parts;
}

export function setValuePath(object, path, value) {
  const parts = valuePathParts(path);
  const visit = (source, index) => {
    const key = parts[index];
    const next = Array.isArray(source) ? source.slice() : container(source) ? { ...source } : arrayIndex(key) ? [] : {};
    if (Array.isArray(next) && !arrayIndex(key)) throw new TypeError("array paths must use numeric indices");
    next[key] = index === parts.length - 1 ? value : visit(own(source, key) ? source[key] : undefined, index + 1);
    return next;
  };
  return visit(object, 0);
}

export function unsetValuePath(object, path, { prune = true, arrayElement = "hole" } = {}) {
  const parts = valuePathParts(path);
  const visit = (source, index) => {
    const key = parts[index];
    if (!own(source, key)) return source;
    if (Array.isArray(source) && !arrayIndex(key)) throw new TypeError("array paths must use numeric indices");
    const child = index === parts.length - 1 ? undefined : visit(source[key], index + 1);
    if (index !== parts.length - 1 && child === source[key]) return source;
    const next = Array.isArray(source) ? source.slice() : { ...source };
    const remove = index === parts.length - 1 || (prune && container(child) && !Array.isArray(child) && !Object.keys(child).length);
    if (!remove) next[key] = child;
    else if (Array.isArray(next) && arrayElement === "null") next[key] = null;
    else delete next[key];
    return next;
  };
  return visit(object, 0);
}

// Compression moves an entire array, never a JSON fragment with ambiguous holes.
export function containerStoragePath(object, path) {
  if (!path.includes(".")) return path;
  const parts = valuePathParts(path);
  let current = object;
  for (let index = 0; index < parts.length; index++) {
    if (Array.isArray(current)) return parts.slice(0, index).join(".");
    if (!own(current, parts[index])) return path;
    current = current[parts[index]];
  }
  return path;
}
