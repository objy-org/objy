import { pathToFileURL } from "node:url";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { applyPatchToObject } from "../src/patch.js";

/** Optional OBJY object hook. The core database never imports OBJY. */
export async function register({ objectHooks, node, configPath, options = {} }) {
  if (!objectHooks || !node) throw new TypeError("OBJY plugin requires objectHooks and node");
  const runtime = options.runtime || "new-objy";
  const specifier = runtime.startsWith(".")
    ? pathToFileURL(resolvePath(configPath ? dirname(configPath) : process.cwd(), runtime)).href
    : isAbsolute(runtime) ? pathToFileURL(runtime).href : runtime;
  const module = await import(specifier);
  const OBJY = module.default || module;
  OBJY.globalMappers({ storage: null });
  const baseFamilies = new Map();
  const families = new Map();
  const affectableNames = new Map();
  const baseFamilyFor = (name) => {
    if (!baseFamilies.has(name)) {
      OBJY.define({ name, pluralName: `@objy/${name}/objects`, affectable: name === "Affectable", storage: null });
      baseFamilies.set(name, OBJY.getFamily(name));
    }
    return baseFamilies.get(name);
  };
  const sourceNamesFor = (database) => {
    if (!affectableNames.has(database)) {
      affectableNames.set(database, node.listCollections(database).filter((name) =>
        name === "Affectable" || node.getCollectionMeta(database, name)?.objy?.affectable === true));
    }
    return affectableNames.get(database);
  };
  const familyFor = (database, name) => {
    const key = `${database}\0${name}`;
    if (!families.has(key)) {
      const config = objyConfig(node.getCollectionMeta(database, name)?.objy);
      const base = baseFamilyFor(name);
      const family = new base.constructor({
        name,
        pluralName: base.pluralName,
        storage: null,
        observer: base.observer,
        featureRuntime: base.features,
        structure: config.structure,
        inheritFamily: config.inheritFamily,
        affectable: name === "Affectable" || config.affectable,
      });
      family._getFamily = (parentName) => familyFor(database, parentName);
      family._getAffectableFamilies = () => sourceNamesFor(database).map((source) => familyFor(database, source));
      families.set(key, family);
    }
    return families.get(key);
  };
  node.onChange?.((change) => {
    if (change.kind === "meta" || change.kind === "dropCollection") {
      families.delete(`${change.database}\0${change.collection}`);
      affectableNames.delete(change.database);
    } else if (change.kind === "dropDatabase") {
      for (const key of families.keys()) if (key.startsWith(`${change.database}\0`)) families.delete(key);
      affectableNames.delete(change.database);
    }
  });

  const handler = async (context, next) => {
    const { database, collection, operation, variant, lookup } = context;
    const familyDefinition = familyFor(database, collection);
    const scope = { database };

    const resolve = ({ family: name, id }) => lookup.get(name, id);
    const affectables = new Map();
    const resolveAffectables = ({ family: name }) => {
      if (!affectables.has(name)) affectables.set(name, (async () => {
        const rows = [];
        for (let offset = 0; ; offset += 250) {
          const page = await lookup.find(name, { affects: { $exists: true } }, { limit: 250, offset });
          rows.push(...page);
          if (page.length < 250) return rows;
        }
      })());
      return affectables.get(name);
    };
    const viewOptions = { resolve, resolveAffectables };
    const wrapperFor = async (row) => {
      if (!row) return null;
      return familyDefinition.object(row._id, scope).get({ perform: () => row, ...viewOptions });
    };
    const materialize = async (row) => (await wrapperFor(row))?._data || null;

    if (operation === "read") {
      await next();
      if (variant === "blob") return;
      if (variant === "single") {
        if (context.result.status === 200) context.result.body = await materialize(context.result.body);
      } else if (context.result.objectRows) {
        const rows = context.result.body || [];
        const views = await familyDefinition.objects(context.input.query || {}, scope)
          .get({ perform: () => rows, ...viewOptions });
        context.result.body = views.map((view) => view._data);
      }
      return;
    }

    if (operation === "create" || operation === "update") {
      const isPatch = Boolean(context.input.patches);
      const items = context.input.objects || context.input.patches || [];
      const before = operation === "update"
        ? await Promise.all(items.map((item) => lookup.get(collection, item._id)))
        : items.map(() => null);
      const beforeViews = await Promise.all(before.map(wrapperFor));
      const prepared = items.map((item, index) => {
        const current = before[index];
        try {
          const body = isPatch && current
            ? { ...applyPatchToObject(beforeViews[index]._data, withoutId(item)), _id: item._id }
            : item;
          if (operation === "create" || (!current && !isPatch)) {
            return familyDefinition.features.prepareCreateData(body, familyDefinition, scope).dataToPersist;
          }
          if (!current) return item; // OBJY DB decides whether a missing PATCH is skipped or 404.
          return familyDefinition.features.prepareUpdateData(body, familyDefinition, scope, {
            current,
            stored: current,
            inheritanceResolved: beforeViews[index]._inheritanceResolved,
            affectableDefaults: beforeViews[index]._affectableDefaults,
          }).dataToPersist;
        } catch (error) {
          if (error instanceof TypeError && !error.status) error.status = 400;
          throw error;
        }
      });

      // Check inheritance and affectable overlays before any part of the batch commits.
      for (let index = 0; index < prepared.length; index++) {
        if (!isPatch || before[index]) {
          try {
            await materialize(prepared[index]);
          } catch (error) {
            if (error instanceof TypeError && !error.status) error.status = 400;
            throw error;
          }
        }
      }
      if (isPatch) {
        context.input.patches = prepared.map((row, index) => before[index]
          ? patchBetween(before[index], row)
          : items[index]);
      } else {
        context.input.objects = prepared;
      }

      await next();
      if (!writeSucceeded(context.result)) return;
      if (familyDefinition.affectable) affectables.delete(collection);
      const returned = context.result.items || (context.result.body?._id ? [context.result.body] : []);
      const responses = [];
      let hasHandlerResult = false;
      for (let index = 0; index < prepared.length; index++) {
        const id = prepared[index]._id;
        let stored = returned.find((row) => row?._id === id);
        if (!stored) {
          try {
            stored = await lookup.get(collection, id);
          } catch (error) {
            if (operation !== "create" || error.status !== 403) throw error;
            stored = prepared[index];
          }
        }
        if (!stored) continue;
        const after = await materialize(stored);
        const previous = beforeViews[index]?._data || null;
        await notifyEvents(familyDefinition.observer, database, collection, id, before[index], stored);
        const handlerResult = await runHandlers(familyDefinition, previous ? after?.onChange : after?.onCreate,
          previous, after, scope);
        if (handlerResult != null) hasHandlerResult = true;
        responses[index] = handlerResult ?? after;
        replaceResponseRow(context.result, id, after);
      }
      if (hasHandlerResult && variant !== "stream") {
        context.result.responseOverride = variant.startsWith("bulk") ? responses : responses[0];
      }
      return;
    }

    if (operation === "delete") {
      const ids = context.input.ids || [];
      const before = await Promise.all(ids.map((id) => lookup.get(collection, id)));
      const views = await Promise.all(before.map(materialize));
      await next();
      if (!writeSucceeded(context.result)) return;
      const handled = new Set();
      const responses = [];
      let hasHandlerResult = false;
      for (let index = 0; index < ids.length; index++) {
        if (handled.has(ids[index])) continue;
        handled.add(ids[index]);
        if (!before[index] || await lookup.get(collection, ids[index])) continue;
        await notifyEvents(familyDefinition.observer, database, collection, ids[index], before[index], null);
        const handlerResult = await runHandlers(familyDefinition, views[index]?.onDelete, views[index], null, scope);
        if (handlerResult != null) hasHandlerResult = true;
        responses[index] = handlerResult;
      }
      if (hasHandlerResult && variant !== "stream") {
        context.result.responseOverride = variant === "single" ? responses[0] : responses.map((value) => value ?? null);
      }
    }
  };
  objectHooks.register(options.name || "objy", {
    handler,
    validateMeta: (meta) => objyConfig(meta.objy),
  });
}

function objyConfig(value) {
  if (value == null) return { structure: {}, inheritFamily: null, affectable: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidConfig("objy must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!["structure", "inheritFamily", "affectable"].includes(key)) {
      throw invalidConfig(`objy.${key} is not supported`);
    }
  }
  const { structure = {}, inheritFamily = null, affectable = false } = value;
  if (!structure || typeof structure !== "object" || Array.isArray(structure)) {
    throw invalidConfig("objy.structure must be an object");
  }
  if (inheritFamily !== null && (typeof inheritFamily !== "string" || !inheritFamily.trim())) {
    throw invalidConfig("objy.inheritFamily must be a non-empty string or null");
  }
  if (typeof affectable !== "boolean") throw invalidConfig("objy.affectable must be a boolean");
  return { structure, inheritFamily, affectable };
}

function invalidConfig(message) {
  const error = new TypeError(message);
  error.status = 400;
  return error;
}

function withoutId(value) {
  const { _id, ...rest } = value;
  return rest;
}

function patchBetween(before, after) {
  const $set = {};
  const $unset = [];
  for (const [key, value] of Object.entries(after)) {
    if (key !== "_id" && JSON.stringify(value) !== JSON.stringify(before[key])) $set[key] = value;
  }
  for (const key of Object.keys(before)) {
    if (key !== "_id" && !Object.hasOwn(after, key)) $unset.push(key);
  }
  return { _id: after._id, $set, $unset };
}

function writeSucceeded(result) {
  return result && (result.status === undefined || result.status < 400);
}

function replaceResponseRow(result, id, view) {
  if (!view) return;
  if (Array.isArray(result.items)) {
    const index = result.items.findIndex((item) => item?._id === id);
    if (index >= 0) result.items[index] = view;
  } else if (result.body?._id === id) {
    result.body = view;
  }
}

async function notifyEvents(observer, database, collection, id, before, after) {
  const oldEvents = before?._aggregatedEvents || [];
  const events = after?._aggregatedEvents || [];
  if (JSON.stringify(oldEvents) === JSON.stringify(events)) return;
  const change = { family: collection, context: { database }, id };
  try {
    if (events.length) {
      await observer.setEvents?.({ ...change, events: events.map(({ propName, date }) => ({ propName, date })) });
    } else {
      await observer.removeEvents?.(change);
    }
  } catch (error) {
    try {
      if (typeof observer.onError === "function") observer.onError(error);
      else console.error("[objy observer]", error);
    } catch { /* Diagnostics cannot change a committed CRUD result. */ }
  }
}

async function runHandlers(family, handlers, before, after, context) {
  if (!family.features.enabled("handlers")) return null;
  return new Promise((resolve) => family.features.runHandlers(handlers, family.observer, before, after,
    context, family.handlerTimeoutMs, resolve));
}
