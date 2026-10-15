const OPERATIONS = Object.freeze(["create", "read", "update", "delete"]);
const OPERATION_SET = new Set(OPERATIONS);
const META_KEYS = new Set(["enabled", "use", ...OPERATIONS]);
const EMPTY_CHAIN = Object.freeze([]);

export function createObjectHookRegistry() {
  return new ObjectHookRegistry();
}

export function createObjectHookRunner(node, registry = createObjectHookRegistry()) {
  if (!(registry instanceof ObjectHookRegistry)) {
    throw new TypeError("objectHooks must be an ObjectHookRegistry");
  }
  return new ObjectHookRunner(node, registry);
}

export function normalizeObjectHooksMeta(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new TypeError("collection meta hooks must be a plain object");

  for (const key of Object.keys(value)) {
    if (!META_KEYS.has(key)) throw new TypeError(`collection meta hooks.${key} is not supported`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new TypeError("collection meta hooks.enabled must be a boolean");
  }

  const out = { enabled: value.enabled !== false };
  for (const key of ["use", ...OPERATIONS]) {
    const names = normalizeNames(value[key], `hooks.${key}`);
    if (names.length) out[key] = names;
  }
  return out;
}

export class ObjectHookRegistry {
  constructor() {
    this.definitions = new Map();
    this.revision = 0;
  }

  register(name, definition) {
    const key = normalizeName(name, "hook name");
    if (this.definitions.has(key)) throw new TypeError(`object hook is already registered: ${key}`);

    const handler = typeof definition === "function" ? definition : definition?.handler;
    if (typeof handler !== "function") throw new TypeError(`object hook ${key} requires a handler`);
    const validateMeta = typeof definition === "function" ? null : definition.validateMeta;
    if (validateMeta != null && typeof validateMeta !== "function") {
      throw new TypeError(`object hook ${key} validateMeta must be a function`);
    }
    const operations = normalizeOperations(typeof definition === "function" ? undefined : definition.operations);
    this.definitions.set(key, { name: key, handler, operations, validateMeta });
    this.revision++;
    return this;
  }

  get(name) {
    return this.definitions.get(String(name));
  }

  get size() {
    return this.definitions.size;
  }
}

export class ObjectHookRunner {
  constructor(node, registry) {
    if (!node) throw new TypeError("node is required");
    this.node = node;
    this.registry = registry;
    this.configs = new Map();
    this.plans = new Map();
    this.registryRevision = registry.revision;
    this._loadExistingCollections();
    this.unsubscribe = node.onChange?.((change) => this._onChange(change)) || null;
  }

  validateMeta(meta = {}) {
    const config = normalizeObjectHooksMeta(meta?.hooks);
    if (!config?.enabled) return config;
    for (const name of configuredNames(config)) {
      const hook = this.registry.get(name);
      if (!hook) throw new TypeError(`object hook is not registered: ${name}`);
      hook.validateMeta?.(meta);
    }
    for (const operation of OPERATIONS) {
      for (const name of config[operation] || []) {
        if (!this.registry.get(name)?.operations.has(operation)) {
          throw new TypeError(`object hook ${name} does not support ${operation}`);
        }
      }
    }
    return config;
  }

  run({ operation, variant, database, collection, input, principal = null, batch = null, lookup = null }, execute) {
    if (!OPERATION_SET.has(operation)) throw new TypeError(`unsupported object hook operation: ${operation}`);
    if (typeof execute !== "function") throw new TypeError("object hook operation requires an executor");

    const chain = this._plan(database, collection, operation);
    if (!chain.length) return execute(input, null);

    const context = {
      operation,
      variant,
      database,
      collection,
      input,
      principal: principal ? deepFreeze(structuredClone(principal)) : null,
      lookup,
      batch: batch ? Object.freeze({ ...batch }) : null,
      state: Object.create(null),
      count: inputCount(input),
      result: undefined,
      hooked: true,
    };
    let cursor = -1;

    const dispatch = async (index) => {
      if (index <= cursor) throw hookExecutionError("object hook next() called more than once");
      cursor = index;
      if (index === chain.length) {
        context.result = await execute(context.input, context);
        return context.result;
      }

      let called = false;
      let nextPromise;
      const next = () => {
        if (called) throw hookExecutionError(`object hook ${chain[index].name} called next() more than once`);
        called = true;
        nextPromise = dispatch(index + 1);
        return nextPromise;
      };
      try {
        await chain[index].handler(context, next);
      } catch (err) {
        if (!err.status) err.status = 500;
        throw err;
      }
      if (!called) throw hookExecutionError(`object hook ${chain[index].name} must call next()`);
      return nextPromise;
    };

    return dispatch(0);
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.configs.clear();
    this.plans.clear();
  }

  _plan(database, collection, operation) {
    if (!this.registry.size) return EMPTY_CHAIN;
    if (this.registryRevision !== this.registry.revision) {
      this.registryRevision = this.registry.revision;
      this.plans.clear();
      for (const config of this.configs.values()) this.validateMeta({ hooks: config });
    }

    const scope = scopeKey(database, collection);
    const key = `${scope}\0${operation}`;
    if (this.plans.has(key)) return this.plans.get(key);
    const config = this.configs.get(scope);
    if (!config?.enabled) {
      this.plans.set(key, EMPTY_CHAIN);
      return EMPTY_CHAIN;
    }

    const chain = [];
    for (const name of config.use || []) {
      const hook = this.registry.get(name);
      if (!hook) throw hookExecutionError(`object hook is not registered: ${name}`);
      if (hook.operations.has(operation)) chain.push(hook);
    }
    for (const name of config[operation] || []) {
      const hook = this.registry.get(name);
      if (!hook) throw hookExecutionError(`object hook is not registered: ${name}`);
      if (!hook.operations.has(operation)) throw hookExecutionError(`object hook ${name} does not support ${operation}`);
      if (!chain.includes(hook)) chain.push(hook);
    }
    Object.freeze(chain);
    this.plans.set(key, chain);
    return chain;
  }

  _loadExistingCollections() {
    for (const database of this.node.listDatabases?.() || []) {
      for (const collection of this.node.listCollections?.(database) || []) {
        const meta = this.node.getCollectionMeta(database, collection) || {};
        const config = this.validateMeta(meta);
        if (config) this.configs.set(scopeKey(database, collection), config);
      }
    }
  }

  _onChange(change = {}) {
    if (change.kind === "meta") {
      const key = scopeKey(change.database, change.collection);
      const config = normalizeObjectHooksMeta(change.meta?.hooks);
      if (config) this.configs.set(key, config);
      else this.configs.delete(key);
      this._invalidateScope(key);
      return;
    }
    if (change.kind === "dropCollection") {
      const key = scopeKey(change.database, change.collection);
      this.configs.delete(key);
      this._invalidateScope(key);
      return;
    }
    if (change.kind === "dropDatabase") {
      const prefix = `${change.database}\0`;
      for (const key of this.configs.keys()) if (key.startsWith(prefix)) this.configs.delete(key);
      for (const key of this.plans.keys()) if (key.startsWith(prefix)) this.plans.delete(key);
    }
  }

  _invalidateScope(scope) {
    for (const operation of OPERATIONS) this.plans.delete(`${scope}\0${operation}`);
  }
}

function normalizeOperations(value) {
  const operations = value === undefined || value === "all" ? OPERATIONS : value;
  if (!Array.isArray(operations)) throw new TypeError("object hook operations must be an array or 'all'");
  const normalized = unique(operations.map((operation) => String(operation)));
  for (const operation of normalized) {
    if (!OPERATION_SET.has(operation)) throw new TypeError(`unsupported object hook operation: ${operation}`);
  }
  return new Set(normalized);
}

function normalizeNames(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`collection meta ${label} must be an array`);
  return unique(value.map((name) => normalizeName(name, label)));
}

function normalizeName(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must contain non-empty strings`);
  return value.trim();
}

function configuredNames(config) {
  return unique([...(config.use || []), ...OPERATIONS.flatMap((operation) => config[operation] || [])]);
}

function inputCount(input = {}) {
  for (const key of ["objects", "patches", "ids"]) {
    if (Array.isArray(input[key])) return input[key].length;
  }
  return 0;
}

function scopeKey(database, collection) {
  return `${database}\0${collection}`;
}

function unique(values) {
  return [...new Set(values)];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function hookExecutionError(message) {
  const err = new TypeError(message);
  err.status = 500;
  return err;
}
