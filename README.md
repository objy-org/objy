![OBJY DB](https://raw.githubusercontent.com/objy-org/objy/main/public/branding/objy-db-header-deep-field.png)

# OBJY DB

<p align="center">
  <strong>Fast, bulk-first object database, anywhere JavaScript runs.</strong><br>
  From in-browser memory and embedded applications to sharded, S3-backed clusters.
</p>

<p align="center">
  <a href="https://github.com/objy-org/objy/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/objy-org/objy/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@objy/db"><img alt="npm @objy/db" src="https://img.shields.io/npm/v/%40objy%2Fdb?label=%40objy%2Fdb"></a>
  <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2f81f7"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-f0a020">
</p>

OBJY DB stores and queries dynamic JavaScript objects directly. The same database core runs in modern browsers, inside Node.js applications, or behind a durable, sharded server cluster.

It is one object model and one query language across those environments. The server runtime adds networking, authentication, replication, and S3 durability without changing how collections, objects, queries, indexes, or aggregations behave.

[Get started](#get-started) · [Platforms](#choose-a-runtime) · [API](API.md) · [Operations](OPERATIONS.md) · [Benchmarks](BENCHMARKS.md)

## Get Started

Install the universal database:

```sh
npm install @objy/db
```

```js
import { createDatabase } from "@objy/db";

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
  $aggregate: { fields: { totalScore: { $sum: "score" } } }
});
```

This code works in Node.js and browser projects. Package-aware bundlers automatically select the appropriate platform runtime.

## Choose a Runtime

| Runtime | Package | Role |
| --- | --- | --- |
| Browser | `@objy/db` | The complete local in-memory database inside a web application |
| Embedded | `@objy/db` | The same direct database API inside a Node.js application or service |
| Server | `@objy/server` | HTTP, authentication, administration, durability, sharding, and replication |

The database core is not a reduced browser companion to the server. It owns storage, bulk CRUD, querying, aggregation, field indexes, RID columns, vector search, references, value dictionaries, and compressed-memory tiering in every supported runtime.

Browser and embedded deployments use that core directly. The server wraps it with shared access, security, files, persistence, routing, and optional cluster operation.

## Built Around Objects

```text
database
  collection
    metadata
    object _id=...
    object _id=...
```

- **Databases** are independent top-level namespaces.
- **Collections** contain dynamic objects and a small metadata document.
- **Objects** may have different shapes and value types and are identified by `_id`.
- **Metadata** declares derived behavior such as indexes, columns, and compression.

There is no required schema and no separate document type for each runtime. Objects are returned as ordinary JavaScript values.

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

## Bulk First

Bulk operations are the internal model, not an optional fast path. A single create, update, or delete is a bulk of one. Storage, derived structures, routing, replication, persistence, hooks, and NDJSON imports all preserve that model.

```js
await assets.insertMany(objects);
await assets.patchMany(patches);
await assets.replaceMany(replacements);
await assets.removeMany(ids);
```

The database also supports Mongo-style `$set` and `$unset` patches, sorting and paging, grouped aggregation, live references, client-provided vector embeddings, and full-object hydration at the API boundary.

## Memory and Speed

OBJY DB combines several structures rather than forcing every workload through one representation:

| Structure | Purpose |
| --- | --- |
| Object store | Fast access to complete dynamic objects |
| Value dictionaries | Share repeated values without a static schema |
| Field indexes | Narrow equality, containment, grouping, and sorting work |
| RID columns | Store declared scalar fields compactly and accelerate numeric aggregation |
| Vector index | Search client-provided `_vec` embeddings through HNSW |
| Compressed tiering | Keep selected fields hot while compressing the remaining object body in memory |

Derived structures remain implementation details. Reads still return normal complete objects, and query semantics remain the same when an index is absent or warming.

See [BENCHMARKS.md](BENCHMARKS.md) for reproducible Node.js, browser, HTTP, persistence, replication, and reshard measurements.

## Browser

Use `@objy/db` directly with a bundler:

```js
import { createDatabase } from "@objy/db";
```

GitHub releases also contain a standalone `objy-db-<version>.esm.js` module for applications without npm. Browser databases are currently memory-only: they have the complete local database engine but no server, authentication, S3, sharding, or replication.

## Server and Cluster

Install the server runtime when the database needs a network boundary:

```sh
npm install --global @objy/server
```

Create `objydb.config.json`:

```json
{
  "node": {
    "id": "node-8080",
    "url": "http://localhost:8080"
  },
  "server": {
    "port": 8080
  }
}
```

```sh
objy run
```

Open `http://localhost:8080/` for the admin console. The first boot generates a global administrator and prints its password once.

An HTTP runtime can also be embedded in another Node.js application:

```js
import { startServer } from "@objy/server";

const runtime = await startServer({ port: 8080 });
```

For durable nodes, replicas, object sharding, S3 configuration, failure behavior, monitoring, and restart-based resharding, continue with [OPERATIONS.md](OPERATIONS.md).

## Packages

Every release is built from this repository at one synchronized version:

| Package | Purpose |
| --- | --- |
| `@objy/db` | Universal database for Node.js and browsers |
| `@objy/server` | HTTP runtime, JavaScript client, CLI, clustering, and durability |

GitHub releases contain both npm tarballs, the standalone browser ESM module, and SHA-256 checksums.

## Alpha Status

OBJY DB is under active alpha development. Pin exact versions and expect configuration or APIs to evolve before `1.0`.

Current boundaries are explicit: there are no multi-object transactions, browser persistence is not implemented yet, distributed writes converge with whole-object last-write-wins semantics, and shard-count changes use a coordinated restart. Read the [operations guide](OPERATIONS.md) before evaluating durable deployments.

## Develop

```sh
npm ci
npm test
npm run test:browser
npm run test:universal
```

Keep changes bulk-first and preserve the boundaries between the universal database, platform adapters, and server services. See [CONTRIBUTING.md](CONTRIBUTING.md) for the test matrix and pull-request expectations.

## Documentation

- [Public REST API](API.md)
- [JavaScript client](client/README.md)
- [Operations and durability](OPERATIONS.md)
- [Benchmarks](BENCHMARKS.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Original source code is available under the [MIT License](LICENSE). OBJY and OBJY DB names, logos, brand artwork, and product copy remain reserved as described in [NOTICE.md](NOTICE.md). Third-party materials retain their respective licenses.
