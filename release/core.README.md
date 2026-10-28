# OBJY DB Core

The portable, in-memory OBJY DB engine. It provides dynamic objects, bulk-first writes, queries, aggregation, indexes, RID columns, references, vector search, value dictionaries, and compressed-memory tiering without a server or persistence layer.

```sh
npm install objydb
```

```js
import { createDatabase } from "objydb";

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

Use `@objydb/server` for HTTP, authentication, clustering, S3 durability, and the CLI. Use `@objydb/browser` for a browser-ready standalone module.

Licensed under the MIT License.
