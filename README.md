![OBJY DB](https://raw.githubusercontent.com/objy-org/objy/main/public/branding/objy-db-header-deep-field.png)

# OBJY DB

<p align="center">
  <strong>Fast, bulk-first object database, anywhere JavaScript runs.</strong><br>
  Start a server, embed it in Node.js, or run it directly in the browser.
</p>

<p align="center">
  <a href="https://github.com/objy-org/objy/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/objy-org/objy/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@objy/server"><img alt="npm @objy/server" src="https://img.shields.io/npm/v/%40objy%2Fserver?label=%40objy%2Fserver"></a>
  <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2f81f7"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-f0a020">
</p>

OBJY DB stores and queries dynamic JavaScript objects directly. Its in-memory core handles bulk CRUD, queries, aggregations, indexes, references, vectors, and compressed data. The server adds authentication, HTTP, S3 durability, sharding, and replication.

[Start the server](#start-the-server) · [Database guide](DB.md) · [Server guide](SERVER.md) · [REST API](API.md) · [Benchmarks](BENCHMARKS.md)

## Choose How to Run

- **Server:** install `@objy/server` for HTTP, authentication, persistence, sharding, and replication. The included `objy` CLI runs and manages database nodes. Start with the [server guide](SERVER.md).
- **Embedded or browser:** install `@objy/db` to use the same database core directly inside a Node.js or web application, without a server. Start with the [database guide](DB.md).

## Start the Server

Install the server package:

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

Start the server:

```sh
objy start
```

Open [http://localhost:8080](http://localhost:8080) for the admin console. On first boot, OBJY DB creates a global administrator and prints its generated password once.

That is a complete local database server. Add S3 and a shard map when it needs durability or multiple nodes; the [server guide](SERVER.md) covers that path.

The CLI manages the server lifecycle:

```sh
objy status
objy logs
objy restart
objy stop
```

## Work with Objects

The server ships a small JavaScript client for Node.js and browsers:

```js
import { createClient } from "@objy/server/client";

const client = createClient({ url: "http://localhost:8080" });
await client.login({ username: "admin", password: "<printed-password>" });

await client.createDatabase("app");
const app = client.database("app");
await app.createCollection("assets", {
  indexes: ["status"],
  columns: ["score"]
});

const assets = app.collection("assets");

await assets.insertMany([
  { _id: "laptop-1", name: "Laptop", status: "active", score: 9 },
  { _id: "phone-1", name: "Phone", status: "archived", score: 4 }
]);

const active = await assets.find(
  { status: "active", score: { $gte: 5 } },
  { sortBy: "score", sort: "desc", limit: 50 }
);

await assets.patch("laptop-1", {
  $set: { status: "archived" },
  $unset: ["temporaryNote"]
});

const totals = await assets.search({
  $aggregate: {
    groupBy: "status",
    fields: {
      count: { $count: true },
      totalScore: { $sum: "score" }
    }
  }
});
```

Single writes and their bulk equivalents share the same behavior: `insert` / `insertMany`, `patch` / `patchMany`, `replace` / `replaceMany`, and `remove` / `removeMany`. IDs are generated when omitted.

Use the [JavaScript client guide](client/README.md) for the complete client API or [API.md](API.md) for direct HTTP requests.

## The Object Model

```text
database
  collection
    metadata
    object
    object
```

- A **database** is an independent namespace.
- A **collection** holds dynamic objects and a small metadata document.
- An **object** is an ordinary JavaScript value identified by `_id`.
- **Metadata** declares behavior such as indexes, columns, vectors, and compressed-memory tiering.

Objects in one collection may have different fields and value types. Reads return complete objects; indexes and storage structures remain implementation details.

The query language supports nested fields, logical and comparison operators, sorting, paging, aggregation, live references, and client-provided vector embeddings. Bulk operations are the native write path, including streamed NDJSON imports.

## Why OBJY DB

- **Object native:** store dynamic objects without a required schema or ORM.
- **Bulk first:** single and bulk operations use one internal model.
- **In-memory speed:** indexes, RID columns, value dictionaries, vectors, and compression work together behind normal object reads.
- **One query language:** use the same filters and aggregations in the browser, embedded, or over HTTP.
- **Scale when needed:** the server adds durable WAL acknowledgements, S3 snapshots and journals, object sharding, and replication.

See [BENCHMARKS.md](BENCHMARKS.md) for reproducible measurements across the direct database, browser, HTTP, persistence, replication, and resharding paths.

## Alpha Status

OBJY DB is under active alpha development. Pin exact versions and expect APIs or configuration to evolve before `1.0`.

There are currently no multi-object transactions, browser persistence is not implemented, distributed writes converge with whole-object last-write-wins semantics, and shard-count changes use a coordinated restart. Read [SERVER.md](SERVER.md) before evaluating durable deployments.

## Develop

```sh
npm ci
npm test
npm run test:browser
npm run test:universal
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the test matrix and contribution workflow.

## Documentation

- [Database: embedded and browser](DB.md)
- [Server: durability and clustering](SERVER.md)
- [REST API](API.md)
- [JavaScript client](client/README.md)
- [Benchmarks](BENCHMARKS.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)

## License

Original source code is available under the [MIT License](LICENSE). OBJY and OBJY DB names, logos, brand artwork, and product copy remain reserved as described in [NOTICE.md](NOTICE.md). Third-party materials retain their respective licenses.
