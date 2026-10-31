# OBJY DB in Your Application

**The complete in-memory object database, directly inside your code.**

`@objy/db` runs in Node.js and modern browsers. Both use the same storage, bulk CRUD, query engine, aggregation, indexes, columns, references, vectors, and compression. The package only changes its low-level platform adapters.

## Install in Node.js

```sh
npm install @objy/db
```

```js
import { createDatabase } from "@objy/db";
```

Node.js automatically uses its native compression and runtime adapters.

## Install in a Browser

With npm and a package-aware bundler, the installation and import are identical:

```sh
npm install @objy/db
```

```js
import { createDatabase } from "@objy/db";
```

The package export selects portable browser adapters automatically. No browser-specific application code is required.

Without npm, download `objy-db-<version>.esm.js` from a GitHub release, serve it with your application, and import it as a module:

```html
<script type="module">
  import { createDatabase } from "/vendor/objy-db-VERSION.esm.js";

  const objy = createDatabase();
</script>
```

## Use the Same Database API

Everything after installation is shared:

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

const active = await assets.find({ status: "active" });
const totals = await assets.search({
  $aggregate: {
    fields: {
      totalScore: { $sum: "score" }
    }
  }
});
```

Objects are ordinary JavaScript values. Collections accept different shapes and value types without a required schema.

## Bulk Is the Native Path

OBJY DB treats a single write as a bulk of one. Large and small operations therefore share the same validation, storage, and derived-state behavior.

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

Use `minimal: true` on bulk writes when only counts are needed and object readback would be wasted work.

## Shape the Workload with Metadata

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

These structures remain internal. Reads still hydrate and return complete objects, and queries retain correct scan paths when a structure is absent or still warming.

## Readiness and Lifecycle

Writes are visible immediately. Some derived work may continue cooperatively after large imports or metadata changes:

```js
await assets.ready();
```

Call `ready()` before a benchmark or before requiring vector search from a newly populated collection. Ordinary queries can fall back to scans while field indexes or columns catch up.

Inspect local state without starting a server:

```js
console.log(objy.stats());
```

Release the database when its owning application context is finished:

```js
objy.close();
```

## Memory Is the Database

The object store and its derived structures live in the JavaScript heap. This produces direct, low-latency access, but the application owns capacity:

- Import in bounded bulks rather than constructing one enormous array.
- Configure indexes and columns for fields that justify their memory cost.
- Use compressed tiering when large object bodies contain colder fields.
- Measure complete workload memory, including indexes, vectors, and temporary build state.
- Release unused databases instead of relying on eventual garbage collection.

Node.js deployments can choose an explicit V8 heap limit. Browser limits are controlled by the browser and device, so representative mobile and desktop testing matters.

## Platform Differences

| Detail | Embedded Node.js | Browser |
| --- | --- | --- |
| Database API | `@objy/db` | `@objy/db` |
| Storage and queries | Shared implementation | Shared implementation |
| Compression adapter | Native Node.js runtime | Portable browser runtime |
| Lifetime | Owning process | Page or worker context |
| Persistence | None | None |

That is the full distinction. Browser and embedded use the same database model and public methods.
