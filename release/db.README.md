# OBJY DB

The universal, in-memory OBJY DB for Node.js and modern browsers. It provides dynamic objects, bulk-first writes, queries, aggregation, indexes, RID columns, references, vector search, value dictionaries, and compressed-memory tiering without a server or persistence layer.

```sh
npm install @objy/db
```

```js
import { createDatabase } from "@objy/db";

const objy = createDatabase();
await objy.createDatabase("app");
await objy.database("app").createCollection("assets", { indexes: ["status"] });

const assets = objy.database("app").collection("assets");
await assets.insertMany([
  { name: "Laptop", status: "active" },
  { name: "Phone", status: "archived" },
]);

console.log(await assets.find({ status: "active" }));
```

Use the same `@objy/db` import in Node.js and browsers. Package-aware tools select native Node compression or the portable browser runtime automatically; there is no separate browser npm package. Use `@objy/server` for HTTP, authentication, clustering, S3 durability, hooks, and the CLI. Applications connecting to a server can use the separate `@objy/client` package.

GitHub releases also include a standalone `objy-db-<version>.esm.js` file for browsers without npm or a bundler. Download it, serve it as a JavaScript module from your application, and import `createDatabase` from that URL.

See the [database guide](https://github.com/objy-org/objy/blob/main/DB.md) and [measured cross-runtime benchmarks](https://github.com/objy-org/objy/blob/main/BENCHMARKS.md) for more detail.

Licensed under the MIT License.
