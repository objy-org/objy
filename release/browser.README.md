# OBJY DB Browser

OBJY DB packaged for browsers. It runs the portable in-memory engine directly in the page and requires no database server.

```sh
npm install @objydb/browser
```

```js
import { createDatabase } from "@objydb/browser";

const objy = createDatabase();
await objy.createDatabase("app");
await objy.database("app").createCollection("assets");

const assets = objy.database("app").collection("assets");
await assets.insert({ name: "Laptop", status: "active" });
console.log(await assets.find({ status: "active" }));
```

This distribution contains no Node.js, AWS, HTTP server, replication, or filesystem code. Browser persistence is not included yet; data lives for the lifetime of the page.

Licensed under the MIT License.
