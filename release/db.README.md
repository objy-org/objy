# OBJY DB

The complete OBJY DB server runtime: HTTP API, authentication, permissions, hooks, sharding, replication, S3 durability, local WAL, and admin UI.

This is the server runtime, not the retired embedded/browser API previously published under this package name.

```sh
npm install @objy/db
```

Start it from Node.js:

```js
import { startServer } from "@objy/db";

const runtime = await startServer({ port: 8080 });
console.log(runtime.port);
```

For a managed deployment, install the separate CLI:

```sh
npm install --global @objy/cli
objy deploy local --name dev --size tiny
```

The CLI automatically downloads and verifies the latest published OBJY DB release, then pins that exact release to the deployment. Restarts reuse the pinned version and never upgrade it implicitly.

Applications connect to a running server through the standalone client:

```sh
npm install @objy/client
```

The database package intentionally contains no executable. Object-hook registration remains available from `@objy/db/hooks`.

Read the [OBJY DB guide](https://github.com/objy-org/objy#readme), [API reference](https://github.com/objy-org/objy/blob/main/API.md), [JavaScript client](https://github.com/objy-org/objy-client), and [measured benchmarks](https://github.com/objy-org/objy/blob/main/BENCHMARKS.md).

Licensed under the MIT License.
