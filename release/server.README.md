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

Read the [server guide](https://github.com/objy-org/objy/blob/main/SERVER.md), [API reference](https://github.com/objy-org/objy/blob/main/API.md), and [measured benchmarks](https://github.com/objy-org/objy/blob/main/BENCHMARKS.md) in the main repository.

Licensed under the MIT License.
