# OBJY DB Server

The complete OBJY DB server runtime: HTTP API, authentication, permissions, hooks, sharding, replication, S3 durability, local WAL, admin UI, and process CLI.

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

Install the standalone HTTP client from `@objy/client`. Object-hook registration remains available from `@objy/server/hooks`.

Read the [server guide](https://github.com/objy-org/objy/blob/main/SERVER.md), [API reference](https://github.com/objy-org/objy/blob/main/API.md), [JavaScript client](https://github.com/objy-org/objy-client), and [measured benchmarks](https://github.com/objy-org/objy/blob/main/BENCHMARKS.md).

Licensed under the MIT License.
