# OBJY DB Server

The complete OBJY DB server runtime: HTTP API, authentication, permissions, hooks, sharding, replication, S3 durability, local WAL, admin UI, JavaScript client, and process CLI.

```sh
npm install --global @objy/server
objy run --config ./objydb.config.json
```

Embed it in Node.js:

```js
import { startServer } from "@objy/server";

const runtime = await startServer({ port: 8080 });
console.log(runtime.port);
```

The HTTP client is available from `@objy/server/client`, and object-hook registration is available from `@objy/server/hooks`.

Licensed under the MIT License.
