![OBJY DB](https://raw.githubusercontent.com/objy-org/objy/main/public/branding/objy-db-header-deep-field.png)

# OBJY DB

<p align="center">
  <strong>Fast in-memory object database for large-scale JavaScript workloads.</strong><br>
  Serve dynamic objects through one durable, distributed runtime.
</p>

<p align="center">
  <a href="https://github.com/objy-org/objy/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/objy-org/objy/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@objy/server"><img alt="npm @objy/server" src="https://img.shields.io/npm/v/%40objy%2Fserver?label=%40objy%2Fserver"></a>
  <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2f81f7"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-f0a020">
</p>

OBJY DB stores and queries dynamic objects in memory. The server combines CRUD, queries, aggregation, indexes, references, vectors, columns, and compressed-memory tiering with authentication, HTTP, S3 durability, sharding, and replication.

[Server guide](SERVER.md) · [REST API](API.md) · [JavaScript client](https://github.com/objy-org/objy-client) · [Benchmarks](BENCHMARKS.md)

## Start in Two Minutes

Install the deployment CLI and start a local server:

```sh
npm install --global @objy/cli
objy deploy local --name dev --size tiny
```

The CLI requires Node.js 22 or newer. The server supports Node.js 20 or newer.

The CLI prints the server URL and initial administrator password. Open the URL for the admin console, or connect from an application:

```sh
npm install @objy/client
```

```js
import { createClient } from "@objy/client";

const client = createClient({ url: "http://localhost:8080" });
await client.login({ username: "admin", password: "<printed-password>" });

await client.createDatabase("app");
const app = client.database("app");
await app.createCollection("assets", { indexes: ["status"] });

const assets = app.collection("assets");
await assets.insertMany([
  { name: "Laptop", status: "active", score: 9 },
  { name: "Phone", status: "archived", score: 4 }
]);

console.log(await assets.find({ status: "active" }));
```

The client also exposes replacements, patches, deletes, aggregation, files, vectors, and streaming imports. See the [client guide](https://github.com/objy-org/objy-client) or use the [HTTP API](API.md) directly.

Manage the deployment with the same CLI:

```sh
objy status dev
objy logs dev
objy restart dev
objy stop dev
```

## One Object Model

```text
database
  collection
    metadata
    object
    object
```

- A **database** is an independent namespace.
- A **collection** holds dynamic objects and a small metadata document.
- An **object** is a dynamic JSON document identified by `_id`.
- **Metadata** enables structures such as field indexes, RID columns, vectors, and compressed-memory tiering.

Objects in one collection may have different fields and value types. Reads return complete objects; indexes, columns, dictionaries, and compression remain internal.

## Why OBJY DB

- **In-memory:** data and derived structures stay close to execution for low-latency access.
- **Object native:** store dynamic objects without a required schema or ORM.
- **Large-scale operations:** single writes, bounded batches, and streamed NDJSON imports share one consistent model.
- **One database API:** use the same filters, aggregation, references, vectors, and metadata through HTTP or `@objy/client`.
- **Durable and distributed:** combine local WAL acknowledgements, S3 snapshots and journals, object sharding, and replication without changing the object model.

See [BENCHMARKS.md](BENCHMARKS.md) for reproducible server, persistence, replication, and resharding measurements.

## Alpha Status

OBJY DB is under active alpha development. Pin exact versions and expect APIs or configuration to evolve before `1.0`.

Current limits:

- No multi-object transactions.
- Distributed writes converge with whole-object last-write-wins semantics.
- Shard-count changes use a coordinated restart.

Read the [server guide](SERVER.md) before evaluating durable deployments.

## Develop

```sh
npm ci
npm test
npm run test:ui
npm run test:scale
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the test matrix and contribution workflow.

## Documentation

- [Server: durability and clustering](SERVER.md)
- [REST API](API.md)
- [JavaScript client](https://github.com/objy-org/objy-client)
- [Benchmarks](BENCHMARKS.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)

## License

Original source code is available under the [MIT License](LICENSE). OBJY and OBJY DB names, logos, brand artwork, and product copy remain reserved as described in [NOTICE.md](NOTICE.md). Third-party materials retain their respective licenses.
