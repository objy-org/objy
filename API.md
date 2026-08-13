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
  "columnIndexes": ["score"]
}
```

**Object**

Objects are plain dynamic JSON-style records. They can have different shapes in the same collection, and values can be strings, numbers, booleans, arrays, nested objects, or `null`.

Every object has an `_id`. If `_id` is omitted on insert, the server generates a compact URL-safe id. `PUT` replaces the full object, `PATCH` merges fields, and `DELETE` creates a replicated delete. Special fields such as `_vec` are handled by storage features and are hidden from normal read responses.

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

**Column Indexes**

`columnIndexes` keep field values in index structures built for fast aggregate paths. They help `$sum`, `$avg`, `$count`, and grouped aggregates avoid reading full objects when the query can be planned from indexed ids and column values. Column index builds run in the background.

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
  "expiresIn": 900
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
  "expiresIn": 900
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
  "columnIndexes": ["score"]
}
```

Response:

```json
{
  "name": "{collection}",
  "created": true,
  "meta": {
    "indexes": ["status", "tenantId"],
    "columnIndexes": ["score"]
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
  "columnIndexes": ["score"]
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
  "columnIndexes": ["score"]
}
```

Response:

```json
{
  "indexes": ["status", "tenantId"],
  "columnIndexes": ["score"]
}
```

Changing `indexes` or `columnIndexes` rebuilds indexes in the background.

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

`PATCH` is a partial update.

Request:

```http
PATCH {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "score": 12
}
```

Response:

```json
{
  "_id": "object-1",
  "status": "archived",
  "score": 12
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
  { "_id": "object-1", "score": 51 },
  { "_id": "object-2", "score": 13 }
]
```

Response:

```json
{
  "updated": 2,
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

## Query

Query responses are plain arrays. Use GET for small URL-safe queries and POST `/search` for larger payloads.

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
  "$refDepth": 1
}
```

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

`/api/config` is the public status endpoint for the UI and operators. It requires a global user token.

Request:

```http
GET {URL}/api/config
Authorization: Bearer <accessToken>
```

Response:

```json
{
  "nodes": [
    {
      "node": { "id": "node-8080", "url": "{URL}" },
      "ownedShards": ["shard-0", "shard-3"],
      "memory": { "rss": 2190999552 },
      "indexes": {
        "status": "ready",
        "workers": {
          "columnIndex": { "type": "worker_thread", "active": 0 },
          "vectorIndex": { "type": "same_thread_task", "active": 0 }
        }
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

The full response includes peers, shards, per-node RSS memory, replication state, index readiness, and vector readiness.

## Response Notes

- Query, search, and aggregation responses are arrays.
- Single-object creates and reads return one object.
- Bulk writes return `{ inserted|updated|replaced, items }`.
- Bulk delete returns `{ deleted, ids, skipped }`.
- Error responses use `{ "error": "message" }`.
