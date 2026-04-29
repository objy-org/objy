# OBJY — notes for Claude

This file orients an AI assistant working in this repo. Read it before answering questions about OBJY or editing the code.

## What OBJY is

OBJY is a JavaScript framework by Marco Boelling for building applications out of **behavior-driven objects** — plain JS objects that carry their own events, actions, lifecycle handlers, permissions, inheritance, and constraints. The runtime ties those objects to pluggable backends for storage, action execution, and scheduled observation.

The mental model: a "use case" is often just one well-shaped object. Instead of spreading logic across controllers, schedulers, and services, the object itself declares what it is and what happens to it.

Package: `objy` on npm (ESM, also bundled to CJS and browser). Current version lives in `package.json` (`0.7.238` at time of writing). Runtime deps: `moment`, `shortid`. Build tool: Rollup. Tests: Jest.

## Two-step programming model

```js
import _OBJY from 'objy';
const OBJY = new _OBJY();

// 1. Define an object family (bucket + optional custom mappers)
OBJY.define({
  name: 'object',           // singular constructor → OBJY.object(...)
  pluralName: 'objects',    // plural constructor   → OBJY.objects(...)
  templateFamily: 'template', // optional: which family supplies inherit/affect templates
  storage:   OBJY.customStorage({...}),
  processor: OBJY.customProcessor({...}),
  observer:  OBJY.customObserver({...}),
});

// 2. Use objects
OBJY.object({ name: 'hi', onChange: { log: { action: 'console.log("changed")' } } })
    .add(data => { /* created */ });

OBJY.objects({ name: 'hi' }).get(list => {});
```

`OBJY.define` can be called multiple times to declare several families (e.g. `template`, `object`, `user`). Each family gets its own singular/plural constructor on the instance.

## What lives on an object

- **Regular properties** — any JSON value, or `{ type, value, ... }` for typed props.
- **Event properties** — `{ type: 'event', date | interval, action }`. `date` fires once; `interval` (ISO-8601 durations like `"P1Y"`) fires recurrently. The observer triggers them.
- **Lifecycle handlers** — `onCreate`, `onChange`, `onDelete`, each a map of named action entries that run on the respective mutation.
- **Inheritance** — `inherits: [id, ...]` merges in properties/handlers from one or more template objects.
- **Permissions** — per-role allow/deny on read/write/execute.
- **Authorisations** — query-based access (user may see/edit objects matching a query).
- **Privileges** — named capabilities attached to the object.
- **Constraints** — `_constraints: [{ key, validate(value) }]` for validation; supports dotted paths.
- **Applications / clients** — tagging for multi-app, multi-tenant use.

Predefined top-level keys (from `instance/attributes.js`): `_aggregatedEvents`, `authorisations`, `_id`, `role`, `applications`, `inherits`, `onCreate`, `onChange`, `onDelete`, `permissions`, `privileges`, `created`, `lastModified`.

## Context (multitenancy + identity)

Global context is set on the OBJY instance:

- `OBJY.client(id)` / `OBJY.tenant(id)` — active tenant (workspace).
- `OBJY.useUser(userObj)` — active user (drives permission checks).
- `OBJY.app(id)` — active app (tags writes, filters reads).
- `OBJY.clone()` — returns a scoped copy of the instance with its own context object so concurrent requests don't bleed state.

Permission checks can be bypassed with `OBJY.ignorePermissions = true` / `OBJY.ignoreAuthorisations = true` (see `attributes.js`).

## Three pluggable mappers

Every family can wire in its own backend. Templates live under `mappers/templates/`.

1. **Storage** (`OBJY.customStorage({...})`) — CRUD. Interface: `connect`, `closeConnection`, `setObjectFamily`, `setMultiTenancy`, `createClient`, `listClients`, `getById`, `getByCriteria`, `count`, `add`, `update`, `remove`. Shipped reference: `mappers/storage.inmemory.js`.

2. **Processor** (`OBJY.customProcessor({...})`) — executes the `action` DSL on events/handlers. Interface: `execute(dsl, beforeObj, afterObj, prop, callback, client, app, user, options)`. Shipped reference: `mappers/processor.eval.js` (JS `eval`). Swap in to sandbox, run DSLs, call remote workers, etc.

3. **Observer** (`OBJY.customObserver({...})`) — polls/streams date + interval events and asks the processor to fire actions. Interface: `initialize(millis)`, `run(date)`. Shipped references: `mappers/observer.interval.js` and `mappers/observer.stream.js`.

Mappers support two multitenancy modes: `isolated` and `shared` (see `CONSTANTS.MULTITENANCY`), and two observer types: `scheduled` and `queried`.

## Affectables (templates that auto-apply)

`OBJY.affectables` and `OBJY.staticRules` hold rule objects of the form `{ affects: <query>, apply: <partialObject>, _id }`. `instance/apply.js` walks them on every mutation: any object matching `affects` gets `apply` merged into it — props, handlers, permissions, privileges, authorisations, applications. Lets you layer cross-cutting behavior (audit, tagging, rate-limits) without modifying the object definitions.

## Repo layout

```
objy.js                      # entry — composes the OBJY() factory from instance/*
instance/
  attributes.js              # default state (mappers, caches, sequences, context)
  general.js                 # clone, ID/RANDOM, constraint check, DSL dispatch
  apply.js                   # affectables engine (template merging)
  permission.js              # permission + authorisation checks
  object.js                  # core object behavior
  property.js                # property operations (add/set/remove, typed props)
  mapper.js                  # mapper registration + custom* factories
  wrapper.js                 # OBJY.object(...) wrapping layer
  singular-constructor.js    # OBJY.object(...) — create/get/update/remove single
  plural-constructor.js      # OBJY.objects({query}) — query/aggregate many
mappers/
  storage.inmemory.js
  processor.eval.js
  observer.interval.js
  observer.stream.js
  templates/{storage,processor,observer}.js   # interface contracts
lib/dependencies/
  query.js                   # MongoDB-ish query engine used by affectables + plural constructor
  logger.js, exceptions.js, constants.js
dist/
  index.js, index.cjs, browser.js            # Rollup output
test/                        # Jest specs (structure, inheritance, permissions, affectable)
example.js, example.html, apptest.js, handlertest.js, mapperchainexample.js
```

## Common object API (from tests + property.js)

Chainable on an `OBJY.object(...)` wrapper:

- Structure: `setName`, `setType`, `addProperty(path, value)`, `setProperty`, `setPropertyValue`, `removeProperty`.
- Access control: `setPermission`, `removePermission`, `addApplication`, `removeApplication`.
- Handlers: `setOnCreate(name, action)`, `setOnChange`, `setOnDelete`, `removeOnCreate`, etc.
- Lifecycle: `.add(cb)`, `.get(cb)`, `.update(cb)`, `.remove(cb)`.

Plural:

- `OBJY.objects(queryJson).get(cb)` — array of matches.
- `OBJY.objects(queryJson).count(cb)`.

## Build / dev

- `npm install`
- `npm run build` — Rollup emits `dist/index.js` (ESM) and `dist/index.cjs` (CJS) from `objy.js`.
- Tests use Jest (`jest.config.js`). Note: test files in `test/` use `require('../objy.js')` against an ESM entry — expect interop friction when running under current Node without additional config; tests may need to be run against the built CJS bundle.

## Working in this repo — house rules

- Preserve the ESM shape: `package.json` has `"type": "module"` and `exports` pointing to `dist/index.js` / `dist/index.cjs`. New files under `instance/` should use `import`/`export default`.
- Don't drop `predefinedProperties` entries without checking `instance/apply.js` and the permission/handler logic — they're filtered on the template merge path.
- The processor executes arbitrary DSL strings. The shipped `processor.eval.js` uses `eval`. When building custom processors, keep the signature `execute(dsl, beforeObj, afterObj, prop, callback, client, app, user, options)` and surface errors through the callback, not thrown exceptions (the observer loops swallow throws silently).
- Query language: `lib/dependencies/query.js` — a small MongoDB-ish matcher with `undot` support. It's shared by affectables and plural constructors, so edits ripple.
- Rollup is the only build step; don't introduce bundlers or TS without discussing.

## Related projects

- `objy-org/spoo` — a full platform built on OBJY (HTTP API, auth, multi-tenant hosting). Good reference for "what does OBJY look like in production."
- `objy-catalog` on npm — catalog of prebuilt mappers.

## Docs / links

- Homepage: https://objy.xyz
- Full docs: https://objy.xyz/#/DOCUMENTATION.md
- GitHub: https://github.com/objy-org/objy
- npm: https://www.npmjs.com/package/objy
- Medium intro: https://medium.com/objy-framework/objy-javascript-objects-with-behavior-dbc1ba2aff71
