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

The same import selects native Node compression in Node.js and portable compression in browsers. Use `@objy/server` for HTTP, authentication, clustering, S3 durability, and the CLI.

Licensed under the MIT License.
