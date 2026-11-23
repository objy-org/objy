![OBJY DB](https://raw.githubusercontent.com/objy-org/objy/main/public/branding/objy-db-header-deep-field.png)

# OBJY DB

<p align="center"><strong>Fast in-memory object database for large-scale JavaScript workloads.</strong></p>

<p align="center">
  <a href="https://github.com/objy-org/objy/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/objy-org/objy/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@objy/db"><img alt="npm @objy/db" src="https://img.shields.io/npm/v/%40objy%2Fdb?label=%40objy%2Fdb"></a>
  <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <a href="https://github.com/objy-org/objy/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2f81f7"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-f0a020">
</p>

Query dynamic JSON objects in memory, aggregate, and follow live references. Use indexes for speed, compact columns and compression to fit more data. Scale across shards and replicas; add local WAL and S3 for durability.

```text
database -> collection -> objects
```

Objects need no shared schema. Each has an `_id`; collection meta configures indexes, storage, and read defaults. Connect through REST or the JavaScript client.

## Start the Database

Install the database with Node.js 20 or newer:

```sh
npm install --global @objy/db
```

Without a config file, start a memory-only node:

```sh
objy --node node-a --port 8080
```

If `objydb.config.json` exists in the working directory, it is loaded automatically. To keep settings in that file instead:

```json
{
  "node": { "id": "node-a", "url": "http://127.0.0.1:8080" },
  "server": { "port": 8080 }
}
```

```sh
objy
```

Open the printed URL and sign in with the administrator password from the logs. Ctrl+C shuts the foreground node down gracefully. This config is memory-only; see the guide for [durability](https://github.com/objy-org/objy/blob/main/DB.md#configuration) and [clusters](https://github.com/objy-org/objy/blob/main/DB.md#cluster-setup).

## Work with Objects

```sh
npm install @objy/client
```

```js
import { createClient } from "@objy/client";

const client = createClient({ url: "http://127.0.0.1:8080" });
await client.login({ username: "admin", password: "<printed-password>" });

await client.createDatabase("app");
const app = client.database("app");
await app.createCollection("assets", { indexes: ["status"] });
const assets = app.collection("assets");

await assets.insert({ _id: "a1", name: "Laptop", status: "new" });
await assets.get("a1");
await assets.find({ status: "new" });
await assets.replace("a1", { name: "Laptop Pro", status: "active" });
await assets.patch("a1", { $set: { score: 9 }, $unset: ["status"] });
await assets.remove("a1");
```

The same handle supports bulk/streamed writes, aggregation, vectors, references, and files. `@objy/db` runs the database; `@objy/client` connects.

## Go Deeper

- [Database guide](https://github.com/objy-org/objy/blob/main/DB.md): objects, queries, collection meta, configuration, persistence, and clusters.
- [JavaScript client](https://github.com/objy-org/objy-client): application API and client options.
- [REST API](https://github.com/objy-org/objy/blob/main/API.md): public endpoints with requests and responses.
- [Benchmarks](https://github.com/objy-org/objy/blob/main/BENCHMARKS.md): reproducible measurements and their limits.
- [Contributing](https://github.com/objy-org/objy/blob/main/CONTRIBUTING.md): source setup, development, and verification.

## License

Source: [MIT License](https://github.com/objy-org/objy/blob/main/LICENSE). Names, logos, brand artwork, and product copy remain reserved under [NOTICE.md](https://github.com/objy-org/objy/blob/main/NOTICE.md). Third-party licenses still apply.
