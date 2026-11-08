# OBJY DB in Your Application

**The complete in-memory object database, directly inside your code.**

Use `@objy/db` when an application should own the database itself. Node.js and modern browsers share the same storage, CRUD, query, aggregation, index, column, reference, vector, and compression behavior; only their low-level platform adapters differ.

[Overview](README.md) · [Server guide](SERVER.md) · [Benchmarks](BENCHMARKS.md)

## Install

The npm package and import are identical in Node.js and browser projects:

```sh
npm install @objy/db
```

```js
import { createDatabase } from "@objy/db";
```

Node.js selects native runtime adapters. Package-aware browser tools select portable browser adapters automatically.

For a browser without npm or a bundler, download `objy-db-<version>.esm.js` from a GitHub release, serve it with the application, and import it as a module:

```html
<script type="module">
  import { createDatabase } from "/vendor/objy-db-VERSION.esm.js";

  const objy = createDatabase();
</script>
```

## Create and Query Objects

```js
const objy = createDatabase();

await objy.createDatabase("app");
await objy.database("app").createCollection("assets", {
  indexes: ["status"],
  columns: ["score"]
});

const assets = objy.database("app").collection("assets");

await assets.insertMany([
  { name: "Laptop", status: "active", score: 9 },
  { name: "Phone", status: "archived", score: 4 }
]);

console.log(await assets.find({ status: "active" }));

console.log(await assets.search({
  $aggregate: {
    fields: {
      totalScore: { $sum: "score" }
    }
  }
}));
```

Objects are ordinary JavaScript values. Collections accept different shapes and value types without a required schema.

## Write One or Many

Single and multi-object methods share the same validation and storage behavior:

```js
await assets.insert(object);
await assets.insertMany(objects);

await assets.patch(id, {
  $set: { status: "archived" },
  $unset: ["temporaryNote"]
});

await assets.patchMany(patches);
await assets.replaceMany(replacements);
await assets.removeMany(ids);
```

Use `minimal: true` on a large write when the caller needs only counts and object readback would be wasted work.

## Configure Collections

Collection metadata enables structures that match the workload:

```json
{
  "indexes": ["status", "ownerId"],
  "columns": ["score"],
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "ownerId"],
    "minBytes": 4096
  }
}
```

| Structure | Best at |
| --- | --- |
| Field index | Equality, containment, grouping, and indexed sorting |
| RID column | Compact scalar storage and numeric aggregation |
| HNSW index | Search over client-provided `_vec` embeddings |
| Value dictionary | Sharing repeated values across dynamic objects |
| Compressed tiering | Keeping selected fields hot while compressing the rest |

These structures remain internal. Reads still return complete objects, and queries retain correct scan paths when a structure is absent or still warming.

## Readiness and Memory

Writes are visible immediately. Derived structures may continue building cooperatively after a large import or metadata change:

```js
await assets.ready();
```

Call `ready()` before benchmarking or requiring vector search from a newly populated collection. Ordinary queries can use correct scan fallbacks while field indexes or columns catch up.

Inspect local state and release the database without starting a server:

```js
console.log(objy.stats());
objy.close();
```

The live database and its derived structures occupy the JavaScript heap:

- Import in bounded batches instead of constructing one enormous array.
- Configure only indexes and columns that justify their memory cost.
- Use compressed tiering when large object bodies contain colder fields.
- Measure objects, indexes, vectors, and temporary build state together.
- Close unused databases instead of relying on eventual garbage collection.

Node.js can set an explicit V8 heap limit. Browser limits depend on the browser and device, so test representative environments.

## Runtime Notes

| Detail | Embedded Node.js | Browser |
| --- | --- | --- |
| Package and API | `@objy/db` | `@objy/db` |
| Storage and queries | Shared implementation | Shared implementation |
| Compression | Native Node.js adapter | Portable browser adapter |
| Lifetime | Owning process | Page or worker context |
| Persistence | None | None |

Use [`@objy/server`](SERVER.md) when the database needs HTTP access, authentication, S3 durability, sharding, or replication.
