# spread-db API

HTTP API for the default public spread-db interface.

Examples use `{URL}` as the base URL. In a cluster, public `/api` requests may hit any public node; the node routes object operations to the owning shard when needed.

## Context

spread-db stores data in three contexts: `database / collection / object`. Object endpoints always include the database and collection:

```text
{URL}/api/{db}/{collection}/object/{_id}
```

**Database**

A database is the top-level namespace. It separates application or customer data from other databases. Database names are part of every collection and object URL. The built-in `_global` database is used for the default global admin user.

**Collection**

A collection is a named group of objects inside one database. Collections are dynamic; they do not require a schema before objects are inserted.

Each collection also has a small `meta` JavaScript object. It is kept in memory and persisted separately from object data. Custom keys are allowed, and these built-in keys affect query planning:

```json
{
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

**Object**

Objects are plain dynamic JSON-style records. They can have different shapes in the same collection, and values can be strings, numbers, booleans, arrays, nested objects, or `null`.

Every object has an `_id`. If `_id` is omitted on insert, the server generates a compact URL-safe id. `PUT` replaces the full object, `PATCH` applies Mongo-like `$set` and `$unset` operators, and `DELETE` creates a replicated delete. Special fields such as `_vec` are handled by storage features and are hidden from normal read responses.

Public object routes use this shape:

```text
{URL}/api/{db}/{collection}/object/{_id}
```

**Authentication**

Auth is collection-based. Any collection can contain authable user objects. The default bootstrap user lives in `_global/users`:

```text
username: admin
password: 123
```

Most public endpoints require:

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Passwords are hashed on write and redacted from responses.

**Field Indexes**

`indexes` are in-memory field indexes. They are best for equality-style filtering, `$in`, narrowing candidate ids, and indexed sorting. They are also used by the query planner before falling back to scans.

**Columns**

`columns` move selected field values into RID-addressed column storage. Numeric, boolean, and repeated string values are kept compactly, while dynamic object reads still hydrate as ordinary full objects. They help `$sum`, `$avg`, `$min`, `$max`, `$count`, and grouped aggregates avoid reading full objects when the planner can combine indexed ids with column values. Column builds run in the background.

**Compressed Memory Tiering**

`tiering` can compress cold object fields in memory while keeping snapshots and journals as full logical objects. API reads still return ordinary full objects. Use either `keep` to name the fields that should remain hot, or `offload` to name fields that should be compressed; do not use both in the same meta object.

```json
{
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "applications"],
    "minBytes": 4096
  }
}
```

```json
{
  "tiering": {
    "mode": "compressedMemory",
    "offload": ["history", "rawPayload"],
    "minBytes": 4096
  }
}
```

Fields listed in `indexes` or `columns` are kept hot automatically, even if a broader parent object is offloaded. This lets indexes and column aggregates stay fast without inflating compressed data. Queries on non-indexed compressed fields still work, but they require scan-time hydration.

**Vector Index**

Objects may include `_vec`, an embedding vector. `_vec` is stored separately from the public object shape and is redacted from normal responses. Vector search uses the collection search endpoint with `$vector`. If the vector index is warming, search returns `503`.

**Live References**

A reference is a stored descriptor:

```json
{
  "type": "reference",
  "collection": "users",
  "value": "user-1"
}
```

Reads expand references by default with `$refDepth=1`, adding an `object` field. Use `$refDepth=0` to keep descriptors unexpanded.

## Auth

### Login

Request:

```http
POST {URL}/api/_global/users/auth
Content-Type: application/json

{
  "username": "admin",
  "password": "123"
}
```

Response:

```json
{
  "user": { "_id": "admin", "username": "admin", "role": "admin" },
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": 3600,
  "expires_in": 3600
}
```

### Renew Token

Request:

```http
POST {URL}/api/_global/users/renew
Content-Type: application/json

{
  "refreshToken": "..."
}
```

Response:

```json
{
  "user": { "_id": "admin", "username": "admin", "role": "admin" },
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": 3600,
  "expires_in": 3600
}
```

Refresh tokens must be renewed against the same database and collection they were issued from.

## Databases

### List Databases

Request:

```http
GET {URL}/api/databases
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "databases": ["_global", "{db}"]
}
```

### Create Database

Request:

```http
POST {URL}/api/databases
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "{db}",
  "meta": { "owner": "team-a" }
}
```

Response:

```json
{
  "name": "{db}",
  "created": true,
  "meta": { "owner": "team-a" }
}
```

### Create Database With First Admin User

Request:

```http
POST {URL}/api/databases
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "{db}",
  "adminUser": {
    "collection": "users",
    "username": "owner",
    "password": "secret"
  }
}
```

Response:

```json
{
  "name": "{db}",
  "created": true,
  "meta": {},
  "adminUser": {
    "collection": "users",
    "user": {
      "_id": "mHzQzLE6k9P9s6b2",
      "username": "owner",
      "admin": true
    }
  }
}
```

If `adminUser.collection` is omitted, `users` is used. The users collection receives a `username` index.

## Collections

### List Collections

Request:

```http
GET {URL}/api/{db}/collections
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "database": "{db}",
  "collections": ["{collection}", "users"]
}
```

### Create Collection

Request:

```http
POST {URL}/api/{db}/collections
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "{collection}",
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

Response:

```json
{
  "name": "{collection}",
  "created": true,
  "meta": {
    "indexes": ["status", "tenantId"],
    "columns": ["score"],
    "tiering": {
      "mode": "compressedMemory",
      "keep": ["name", "status", "tenantId"],
      "minBytes": 4096
    }
  }
}
```

You may also send `{ "name": "{collection}", "meta": { ... } }`.

### Read Collection Meta

Request:

```http
GET {URL}/api/{db}/{collection}/meta
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

### Replace Collection Meta

Request:

```http
PUT {URL}/api/{db}/{collection}/meta
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

Response:

```json
{
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

Changing `indexes`, `columns`, or `tiering` rebuilds derived in-memory structures.

### Delete Collection

Request:

```http
DELETE {URL}/api/{db}/collections/{collection}
Authorization: Bearer <accessToken>
```

Response:

```http
HTTP/1.1 204 No Content
```

## Objects

Every object has an `_id`. If `_id` is omitted on insert, the server generates a compact 16-character URL-safe id. Single operations and bulk operations use the same base route.

### Insert One

Request:

```http
POST {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "_id": "object-1",
  "status": "active",
  "score": 42,
  "tags": ["new", "paid"]
}
```

Response:

```json
{
  "_id": "object-1",
  "status": "active",
  "score": 42,
  "tags": ["new", "paid"]
}
```

### Get One

Request:

```http
GET {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "_id": "object-1",
  "status": "active",
  "score": 42
}
```

### Replace One

`PUT` is a full object replacement. The URL object id is authoritative.

Request:

```http
PUT {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "status": "archived",
  "score": 11
}
```

Response:

```json
{
  "_id": "object-1",
  "status": "archived",
  "score": 11
}
```

### Patch One

`PATCH` is a Mongo-like partial update. Use `$set` for dot-path writes and `$unset` for dot-path removals. `_id` cannot be changed.

Request:

```http
PATCH {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "$set": {
    "score": 12,
    "profile.city": "Hamburg"
  },
  "$unset": ["legacyFlag"]
}
```

Response:

```json
{
  "_id": "object-1",
  "status": "archived",
  "score": 12,
  "profile": {
    "city": "Hamburg"
  }
}
```

### Delete One

Request:

```http
DELETE {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
```

Response:

```http
HTTP/1.1 204 No Content
```

## File Handling

File handling is object-backed. One object can wrap one S3-backed blob, while the database object stores only a small `_file` descriptor. The S3 bucket should stay private; blob reads go through the API and use the same read permissions as the wrapping object.

```json
{
  "_file": {
    "storage": "s3",
    "key": "spread-db/files/db/{db}/collection/{collection}/object/object-1/blob/{fileId}",
    "mimeType": "application/pdf"
  }
}
```

`_file.key` is derived by the server from `{db}`, `{collection}`, `_id`, and a generated file id. Clients should not invent or change it. Replacing a file writes a new blob key, commits the object pointer, then removes the old blob best-effort. Bulk file uploads are not supported; use one multipart request per file object.

### Create Object With File

Request:

```http
POST {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data

part "object":
{
  "_id": "object-1",
  "name": "invoice.pdf",
  "status": "received"
}

part "file":
<binary file content>
```

Response:

```json
{
  "_id": "object-1",
  "name": "invoice.pdf",
  "status": "received",
  "_file": {
    "storage": "s3",
    "key": "spread-db/files/db/{db}/collection/{collection}/object/object-1/blob/{fileId}",
    "mimeType": "application/pdf"
  }
}
```

### Read File Blob

Request:

```http
GET {URL}/api/{db}/{collection}/object/object-1/blob
Authorization: Bearer <accessToken>
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/pdf

<binary file content>
```

### Replace Object With File

`PUT` replaces the full wrapping object and stores the new file under a new server-derived blob key. No old file version is exposed by spread-db; old blob cleanup is best-effort after the object pointer is durable.

Request:

```http
PUT {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data

part "object":
{
  "name": "invoice-final.pdf",
  "status": "approved"
}

part "file":
<binary file content>
```

Response:

```json
{
  "_id": "object-1",
  "name": "invoice-final.pdf",
  "status": "approved",
  "_file": {
    "storage": "s3",
    "key": "spread-db/files/db/{db}/collection/{collection}/object/object-1/blob/{fileId}",
    "mimeType": "application/pdf"
  }
}
```

### Delete File Object

Delete the wrapping object through normal object CRUD. The object delete is durable first; blob deletion is then attempted best-effort.

Request:

```http
DELETE {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
```

Response:

```http
HTTP/1.1 204 No Content
```

## Bulk Objects

Batches are split by object shard internally. Duplicate ids inside one bulk request are rejected.

### Insert Many

Request:

```http
POST {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

[
  { "_id": "object-1", "status": "active", "score": 42 },
  { "_id": "object-2", "status": "archived", "score": 10 }
]
```

Response:

```json
{
  "inserted": 2,
  "items": [
    { "_id": "object-1", "status": "active", "score": 42 },
    { "_id": "object-2", "status": "archived", "score": 10 }
  ]
}
```

### Insert Many With Minimal Response

Request:

```http
POST {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json
Prefer: return=minimal

[
  { "_id": "object-1", "status": "active" },
  { "_id": "object-2", "status": "archived" }
]
```

Response:

```json
{
  "inserted": 2
}
```

### Replace Many

Request:

```http
PUT {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

[
  { "_id": "object-1", "status": "active", "score": 50 },
  { "_id": "object-2", "status": "archived", "score": 12 }
]
```

Response:

```json
{
  "replaced": 2,
  "items": [
    { "_id": "object-1", "status": "active", "score": 50 },
    { "_id": "object-2", "status": "archived", "score": 12 }
  ]
}
```

### Patch Many

Request:

```http
PATCH {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

[
  { "_id": "object-1", "$set": { "score": 51 }, "$unset": ["legacyFlag"] },
  { "_id": "object-2", "$set": { "score": 13 } }
]
```

Response:

```json
{
  "updated": 2,
  "skipped": [],
  "items": [
    { "_id": "object-1", "status": "active", "score": 51 },
    { "_id": "object-2", "status": "archived", "score": 13 }
  ]
}
```

### Delete Many

Request:

```http
DELETE {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "ids": ["object-1", "object-2"]
}
```

Response:

```json
{
  "deleted": 2,
  "ids": ["object-1", "object-2"],
  "skipped": []
}
```

The delete body may also be a plain array of ids.

### Streamed Bulk Writes

Large imports can use NDJSON so the server does not need to hold one giant JSON array in memory. Each line is one JSON value. Internally, spread-db buffers lines into bounded chunks and then uses the same bulk storage, routing, replication, durability, permission, and index paths as normal bulk writes.

Streamed writes require minimal responses:

```http
Content-Type: application/x-ndjson
Prefer: return=minimal
```

If a streamed request fails after earlier chunks were written, those earlier chunks stay committed. Use stable `_id` values when clients retry large streams. Omitted `_id` values are allowed on insert, but generated ids are not returned by minimal streamed responses.

#### Stream Insert

Request:

```http
POST {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Prefer: return=minimal

{"_id":"object-1","status":"active","score":42}
{"_id":"object-2","status":"archived","score":10}
{"_id":"object-3","status":"generated","score":3}
```

Response:

```json
{
  "inserted": 3
}
```

#### Stream Replace

Request:

```http
PUT {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Prefer: return=minimal

{"_id":"object-1","status":"active","score":50}
{"_id":"object-2","status":"archived","score":12}
```

Response:

```json
{
  "replaced": 2
}
```

#### Stream Patch

Request:

```http
PATCH {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Prefer: return=minimal

{"_id":"object-1","$set":{"score":51},"$unset":["legacyFlag"]}
{"_id":"object-2","$set":{"score":13}}
{"_id":"missing","$set":{"score":99}}
```

Response:

```json
{
  "updated": 2,
  "skipped": 1
}
```

#### Stream Delete

Request:

```http
DELETE {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Prefer: return=minimal

{"_id":"object-1"}
{"_id":"object-2"}
{"_id":"missing"}
```

Response:

```json
{
  "deleted": 2,
  "skipped": 1
}
```

## Query

Query responses are plain arrays. Use GET for small URL-safe queries and POST `/search` for larger payloads. Normal object queries default to `250` rows and cap each page at `250`; use `offset` / `$skip` or `$page` to read more.

### GET Query

`q` is URL-encoded JSON. The decoded query in this example is `{"status":"active","score":{"$gte":10}}`.

Request:

```http
GET {URL}/api/{db}/{collection}/object?q=%7B%22status%22%3A%22active%22%2C%22score%22%3A%7B%22%24gte%22%3A10%7D%7D&sortBy=score&sort=desc&limit=50&offset=0
Authorization: Bearer <accessToken>
```

Response:

```json
[
  { "_id": "object-1", "status": "active", "score": 42 },
  { "_id": "object-9", "status": "active", "score": 31 }
]
```

### POST Search

Request:

```http
POST {URL}/api/{db}/{collection}/search
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "status": "active",
  "$sort": { "score": -1 },
  "$page": 1,
  "$pageSize": 50,
  "$refDepth": 1
}
```

You may also use `$limit` and `$skip` in the POST body. URL `limit` / `offset` parameters take precedence when both are present. Page size is capped at `250`.

Response:

```json
[
  { "_id": "object-1", "status": "active", "score": 42 }
]
```

### Operator Query

Request:

```http
POST {URL}/api/{db}/{collection}/search
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "status": { "$in": ["active", "queued"] },
  "score": { "$gte": 10, "$lt": 100 },
  "tags": { "$contains": "paid" },
  "$or": [
    { "status": "active" },
    { "score": { "$gt": 1000 } }
  ]
}
```

Response:

```json
[
  { "_id": "object-1", "status": "active", "score": 42, "tags": ["paid"] }
]
```

Also supported: `$eq`, `$ne`, `$nin`, `$regex`, `$startsWith`, `$endsWith`, `$exists`, `$null`, `$type`, `$size`, `$mod`, `$between`, `$before`, `$after`, `$and`, `$not`, `$nor`.

## Aggregation

Aggregation is supplied as `$aggregate` inside the query object. Supported operators are `$sum`, `$avg`, `$min`, `$max`, and `$count`.

Request:

```http
POST {URL}/api/{db}/{collection}/search
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "status": "active",
  "$aggregate": {
    "groupBy": "status",
    "fields": {
      "totalScore": { "$sum": "score" },
      "avgScore": { "$avg": "score" },
      "count": { "$count": true }
    },
    "$sort": { "totalScore": -1 },
    "$page": 1,
    "$pageSize": 20
  }
}
```

Response:

```json
[
  { "status": "active", "totalScore": 1234, "avgScore": 38.56, "count": 32 }
]
```

## Vector Search

Store embeddings on `_vec`. The vector is indexed separately and hidden from normal read responses.

### Insert Vector Object

Request:

```http
POST {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "_id": "doc-1",
  "title": "Hello",
  "_vec": [0.1, 0.2, 0.3]
}
```

Response:

```json
{
  "_id": "doc-1",
  "title": "Hello"
}
```

### Search Vectors

Request:

```http
POST {URL}/api/{db}/{collection}/search
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "$vector": {
    "vector": [0.1, 0.2, 0.3],
    "limit": 10,
    "ef": 64
  }
}
```

Response:

```json
[
  { "_id": "doc-1", "title": "Hello", "_score": 0.98 }
]
```

If the needed vector index is still warming:

```json
{
  "error": "vector index warming",
  "indexKey": "all",
  "indexStatus": "pending"
}
```

## Live References

Reference descriptors can point to another collection. `database` is optional; if omitted, the current database is used.

### Store Reference

Request:

```http
POST {URL}/api/{db}/{collection}/object?$refDepth=0
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "_id": "post-1",
  "title": "Hello",
  "author": {
    "type": "reference",
    "collection": "users",
    "value": "user-1"
  }
}
```

Response:

```json
{
  "_id": "post-1",
  "title": "Hello",
  "author": {
    "type": "reference",
    "collection": "users",
    "value": "user-1"
  }
}
```

### Read Expanded Reference

Reads expand references by default with depth `1`.

Request:

```http
GET {URL}/api/{db}/{collection}/object/post-1
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "_id": "post-1",
  "title": "Hello",
  "author": {
    "type": "reference",
    "collection": "users",
    "value": "user-1",
    "object": { "_id": "user-1", "username": "marco" }
  }
}
```

### Read Unexpanded Reference

Request:

```http
GET {URL}/api/{db}/{collection}/object/post-1?$refDepth=0
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "_id": "post-1",
  "title": "Hello",
  "author": {
    "type": "reference",
    "collection": "users",
    "value": "user-1"
  }
}
```

### Query Reference Path

Request:

```http
POST {URL}/api/{db}/{collection}/search
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "author.object.username": "marco"
}
```

Response:

```json
[
  {
    "_id": "post-1",
    "title": "Hello",
    "author": {
      "type": "reference",
      "collection": "users",
      "value": "user-1",
      "object": { "_id": "user-1", "username": "marco" }
    }
  }
]
```

Vector search cannot currently be combined with reference object paths.

## Public Cluster Status

`/api/config` is the compact public status endpoint for the UI and operators. It requires a global user token. Cluster collection is cached for one second so concurrent status requests reuse the same peer fan-out.

Request:

```http
GET {URL}/api/config
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "indexes": {
    "ready": 18,
    "building": 2,
    "error": 0,
    "activeWorkers": 1
  },
  "vectors": {
    "storedVectors": 4200,
    "activeIndexes": 2,
    "warmingIndexes": 0,
    "errors": 0
  },
  "compression": {
    "compressedObjects": 120000,
    "uncompressedBytes": 2899102924,
    "compressedBytes": 577136230,
    "savedPercent": 80.1
  },
  "nodes": [
    {
      "node": { "id": "node-8080", "url": "{URL}" },
      "ownedShards": ["shard-0", "shard-3"],
      "memory": { "rss": 2190999552, "heapUsed": 1701040128 },
      "replication": {
        "healthy": true,
        "lastSuccessfulSyncAt": "2026-09-18T08:41:22.000Z",
        "pendingHints": 0,
        "inflightPulls": 0,
        "error": null
      }
    }
  ],
  "shards": [
    {
      "name": "shard-0",
      "peers": [
        { "url": "{URL}", "online": true }
      ]
    }
  ]
}
```

The normal response contains one shard topology, lightweight node health, per-node heap/RSS and memory-guard state, and aggregate index, vector, and logical compression information. It omits duplicated peer topology and collection-level diagnostics.

`replication.healthy` means the node has no known replication failure or queued/in-flight catch-up work. It is an operational health signal, not a full data-checksum comparison between replicas.

Detailed request:

```http
GET {URL}/api/config?details=1
Authorization: Bearer <accessToken>
```

The detailed response adds per-collection index, vector, and compression state plus full replication diagnostics. The admin UI requests it only when the cluster-status modal is opened. Restore progress is included only while a peer is restoring.

## Response Notes

- Query, search, and aggregation responses are arrays.
- Single-object creates and reads return one object.
- Bulk writes return `{ inserted|updated|replaced, items }`.
- Bulk delete returns `{ deleted, ids, skipped }`.
- Error responses use `{ "error": "message" }`.
