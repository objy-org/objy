# OBJY DB HTTP API

<p align="center"><strong>Plain objects. Bulk-first operations. One public API.</strong></p>

This is the public HTTP contract for OBJY DB. The standalone [JavaScript client](https://github.com/objy-org/objy-client) exposes the same operations for browsers and Node.

[Start here](#start-here) | [JavaScript client](https://github.com/objy-org/objy-client) | [Database README](README.md)

## Start Here

Examples use `{URL}` as the server base URL. Public requests may reach any cluster node; OBJY DB routes them to the owning object shard.

```text
database
  collection
    object _id=...
```

| Placeholder | Meaning |
| --- | --- |
| `{URL}` | Public node or gateway URL, without a trailing slash. |
| `{db}` | Database namespace. |
| `{collection}` | Collection inside the database. |
| `{_id}` | Caller-provided or generated object id. |

Most routes require a bearer token:

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Objects are dynamic JSON-style records. Collections require no schema, and objects in one collection may have different shapes and value types. Every object has an `_id`; inserts generate a compact URL-safe id when it is omitted.

`PUT` replaces a complete object, `PATCH` applies Mongo-like `$set` and `$unset`, and `DELETE` creates a replicated delete. Query, search, and aggregation responses are plain arrays rather than envelopes.

`GET /client.js` serves the installed `@objy/client` module without authentication. It supports `HEAD`, ETag revalidation, and a `Link` header pointing to the current content-addressed module.

## Endpoint Map

| Area | Routes |
| --- | --- |
| [Authentication](#authentication-and-permissions) | Login and renew against any auth-enabled collection. |
| [Databases](#databases) | List, create, bootstrap an administrator, and delete. |
| [Collections](#collections) | List, create, delete, and manage collection metadata. |
| [Objects](#objects) | Single and bulk create, read, replace, patch, and delete. |
| [Imports](#streamed-bulk-writes) | Bounded NDJSON insert, replace, patch, and delete. |
| [Search](#query) | Filters, sorting, paging, aggregation, vectors, and references. |
| [Files](#file-handling) | Object-backed multipart upload, replacement, download, and deletion. |
| [Operations](#health-and-cluster-status) | Health and authenticated public cluster status. |

## Authentication and Permissions

Authentication is collection-based: any collection may contain user objects. On first boot, OBJY DB creates `admin` in `_global/users` and prints its generated password once. `OBJYDB_ADMIN_PASSWORD` may supply that initial password for unattended startup.

Passwords are hashed on write and redacted from responses. Tokens are scoped to the database and collection used for authentication.

### Login

`POST /api/{db}/{collection}/auth`

**Request**

```http
POST {URL}/api/_global/users/auth
Content-Type: application/json

{
  "username": "admin",
  "password": "<initial-password>"
}
```

**Response**

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

`POST /api/{db}/{collection}/renew`

**Request**

```http
POST {URL}/api/_global/users/renew
Content-Type: application/json

{
  "refreshToken": "..."
}
```

**Response**

```json
{
  "user": { "_id": "admin", "username": "admin", "role": "admin" },
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": 3600,
  "expires_in": 3600
}
```

Refresh tokens must be renewed against the same database and collection that issued them.

<details>
<summary><strong>Safe renewal and replay</strong></summary>

Access-token expiration rejected before an operation begins returns HTTP 401 with `code: "ACCESS_TOKEN_EXPIRED"` and `operationStarted: false`. A client may renew and replay that request once.

These markers do not authorize replay when `operationStarted` is true or `writeMayHaveSucceeded` is true. Other authentication failures and permission errors are not expiration signals.

</details>

### Permission Model

Database users can access only the database where they authenticated. A global user can address other databases, but database and collection administration requires `admin: true` or `role: "admin"`. Creating or deleting databases and reading `/api/config` specifically require a global admin token.

The built-in `_global` database is read-only through the public API after bootstrap. Object writes, metadata changes, collection changes, and database deletion are rejected even for a global administrator.

Collection grants provide broad read or write access by collection name:

```json
{
  "_id": "editor",
  "username": "editor",
  "password": "secret",
  "collectionPermissions": {
    "read": ["articles", "media"],
    "write": ["articles"]
  }
}
```

`read` allows object reads and queries. `write` allows create, update, and delete, but does not imply read access. Create users through `POST /api/{db}/users/object`; permission changes apply after login or renewal issues a new token.

Object-level rules combine a query with `c`, `r`, `u`, and `d` permissions:

```json
{
  "_id": "editor",
  "username": "editor",
  "password": "secret",
  "permissions": [
    {
      "name": "own articles",
      "query": { "ownerId": "editor" },
      "perm": "crud"
    }
  ]
}
```

Read rules are merged into the requested query. Updates must permit both the stored object and its resulting value. A non-admin user without a matching rule or collection grant is denied by default.

## Databases

### List Databases

`GET /api/databases`

**Request**

```http
GET {URL}/api/databases
Authorization: Bearer <accessToken>
```

**Response**

```json
{
  "databases": ["_global", "{db}"]
}
```

### Create Database

`POST /api/databases`

**Request**

```http
POST {URL}/api/databases
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "{db}",
  "meta": { "owner": "team-a" }
}
```

**Response**

```json
{
  "name": "{db}",
  "created": true,
  "meta": { "owner": "team-a" }
}
```

### Create Database With First Admin User

`POST /api/databases`

**Request**

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

**Response**

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

### Delete Database

`DELETE /api/databases/{db}`

This requires a global admin token. Deletion removes the database metadata and objects across the cluster and attempts to remove associated file blobs. `_global` cannot be deleted.

**Request**

```http
DELETE {URL}/api/databases/{db}
Authorization: Bearer <accessToken>
```

**Response**

```http
HTTP/1.1 204 No Content
```

## Collections

A collection is a dynamic group of objects plus a small metadata document. Metadata is kept in memory, persisted separately from objects, and may contain custom application keys.

These built-in keys change runtime behavior:

| Key | Purpose |
| --- | --- |
| `indexes` | Field indexes for equality filters, candidate narrowing, grouped values, and sorting. |
| `columns` | RID-addressed typed values for compact storage and numeric aggregation. |
| `tiering` | Compressed-memory offloading for selected cold object fields. |
| `hooks` | Names and activation settings for server-registered object middleware. |

```json
{
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  },
  "hooks": {
    "enabled": true,
    "use": ["timestamps", "audit"]
  }
}
```

Field indexes accelerate supported filter and sort paths. Columns use typed arrays for numbers and booleans, dictionary codes for strings, and an overflow map for unsupported values. They support `$sum`, `$avg`, `$min`, `$max`, `$count`, and grouped aggregation without changing hydrated API objects.

Tiering accepts either `keep` or `offload`, never both. For example, `"offload": ["history", "rawPayload"]` compresses only those paths. Indexed and column fields remain hot automatically. Queries over non-indexed compressed fields remain correct but require scan-time hydration.

Hooks store configuration only; executable code is registered on the server. `use` enables hooks for their registered operations, operation-specific arrays may target `create`, `read`, `update`, or `delete`, and `enabled: false` bypasses the chain.

Changing indexes, columns, or tiering rebuilds derived in-memory state through cooperative bounded tasks. Changing hooks only invalidates the cached hook plan.

### List Collections

`GET /api/{db}/collections`

**Request**

```http
GET {URL}/api/{db}/collections
Authorization: Bearer <accessToken>
```

**Response**

```json
{
  "database": "{db}",
  "collections": ["{collection}", "users"]
}
```

### Create Collection

`POST /api/{db}/collections`

**Request**

```http
POST {URL}/api/{db}/collections
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "{collection}",
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "hooks": {
    "enabled": true,
    "use": ["timestamps", "audit"]
  },
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

**Response**

```json
{
  "name": "{collection}",
  "created": true,
  "meta": {
    "indexes": ["status", "tenantId"],
    "columns": ["score"],
    "hooks": {
      "enabled": true,
      "use": ["timestamps", "audit"]
    },
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

`GET /api/{db}/{collection}/meta`

**Request**

```http
GET {URL}/api/{db}/{collection}/meta
Authorization: Bearer <accessToken>
```

**Response**

```json
{
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "hooks": {
    "enabled": true,
    "use": ["timestamps", "audit"]
  },
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

### Replace Collection Meta

`PUT /api/{db}/{collection}/meta`

**Request**

```http
PUT {URL}/api/{db}/{collection}/meta
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "hooks": {
    "enabled": true,
    "use": ["timestamps", "audit"]
  },
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

**Response**

```json
{
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "hooks": {
    "enabled": true,
    "use": ["timestamps", "audit"]
  },
  "tiering": {
    "mode": "compressedMemory",
    "keep": ["name", "status", "tenantId"],
    "minBytes": 4096
  }
}
```

### Delete Collection

`DELETE /api/{db}/collections/{collection}`

**Request**

```http
DELETE {URL}/api/{db}/collections/{collection}
Authorization: Bearer <accessToken>
```

**Response**

```http
HTTP/1.1 204 No Content
```

## Objects

Objects are plain dynamic JSON-style records. Strings, numbers, booleans, arrays, nested objects, and `null` may coexist across different shapes in one collection.

Every object has an `_id`. If `_id` is omitted on insert, the server generates a compact 16-character URL-safe id. Single and bulk operations use the same base route. Special fields such as `_vec` are handled by storage features and hidden from ordinary read responses.

### Insert One

`POST /api/{db}/{collection}/object`

**Request**

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

**Response**

```json
{
  "_id": "object-1",
  "status": "active",
  "score": 42,
  "tags": ["new", "paid"]
}
```

### Get One

`GET /api/{db}/{collection}/object/{_id}`

**Request**

```http
GET {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
```

**Response**

```json
{
  "_id": "object-1",
  "status": "active",
  "score": 42
}
```

### Replace One

`PUT /api/{db}/{collection}/object/{_id}`

`PUT` is a full object replacement. The URL object id is authoritative.

**Request**

```http
PUT {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "status": "archived",
  "score": 11
}
```

**Response**

```json
{
  "_id": "object-1",
  "status": "archived",
  "score": 11
}
```

### Patch One

`PATCH /api/{db}/{collection}/object/{_id}`

`PATCH` is a Mongo-like partial update. Use `$set` for dot-path writes and `$unset` for dot-path removals. `_id` cannot be changed.

**Request**

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

**Response**

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

`DELETE /api/{db}/{collection}/object/{_id}`

**Request**

```http
DELETE {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
```

**Response**

```http
HTTP/1.1 204 No Content
```

## File Handling

File handling is object-backed. One object can wrap one S3-backed blob, while the database object stores only a small `_file` descriptor. The S3 bucket should stay private; blob reads go through the API and use the same read permissions as the wrapping object.

```json
{
  "_file": {
    "storage": "s3",
    "key": "objydb/files/db/{db}/collection/{collection}/object/object-1/blob/{fileId}",
    "mimeType": "application/pdf"
  }
}
```

`_file.key` is derived by the server from `{db}`, `{collection}`, `_id`, and a generated file id. Clients should not invent or change it. Replacing a file writes a new blob key, commits the object pointer, then removes the old blob best-effort. Bulk file uploads are not supported; use one multipart request per file object.

### Create Object With File

`POST /api/{db}/{collection}/object`

**Request**

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

**Response**

```json
{
  "_id": "object-1",
  "name": "invoice.pdf",
  "status": "received",
  "_file": {
    "storage": "s3",
    "key": "objydb/files/db/{db}/collection/{collection}/object/object-1/blob/{fileId}",
    "mimeType": "application/pdf"
  }
}
```

### Read File Blob

`GET /api/{db}/{collection}/object/{_id}/blob`

**Request**

```http
GET {URL}/api/{db}/{collection}/object/object-1/blob
Authorization: Bearer <accessToken>
```

**Response**

```http
HTTP/1.1 200 OK
Content-Type: application/pdf

<binary file content>
```

### Replace Object With File

`PUT /api/{db}/{collection}/object/{_id}`

`PUT` replaces the full wrapping object and stores the new file under a new server-derived blob key. No old file version is exposed by OBJY DB; old blob cleanup is best-effort after the object pointer is durable.

**Request**

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

**Response**

```json
{
  "_id": "object-1",
  "name": "invoice-final.pdf",
  "status": "approved",
  "_file": {
    "storage": "s3",
    "key": "objydb/files/db/{db}/collection/{collection}/object/object-1/blob/{fileId}",
    "mimeType": "application/pdf"
  }
}
```

### Delete File Object

`DELETE /api/{db}/{collection}/object/{_id}`

Delete the wrapping object through normal object CRUD. The object delete is durable first; blob deletion is then attempted best-effort.

**Request**

```http
DELETE {URL}/api/{db}/{collection}/object/object-1
Authorization: Bearer <accessToken>
```

**Response**

```http
HTTP/1.1 204 No Content
```

## Bulk Objects

Batches are split by object shard internally. Duplicate ids inside one bulk request are rejected.

### Insert Many

`POST /api/{db}/{collection}/object`

**Request**

```http
POST {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

[
  { "_id": "object-1", "status": "active", "score": 42 },
  { "_id": "object-2", "status": "archived", "score": 10 }
]
```

**Response**

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

`POST /api/{db}/{collection}/object`

**Request**

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

**Response**

```json
{
  "inserted": 2
}
```

### Replace Many

`PUT /api/{db}/{collection}/object`

**Request**

```http
PUT {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

[
  { "_id": "object-1", "status": "active", "score": 50 },
  { "_id": "object-2", "status": "archived", "score": 12 }
]
```

**Response**

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

`PATCH /api/{db}/{collection}/object`

**Request**

```http
PATCH {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

[
  { "_id": "object-1", "$set": { "score": 51 }, "$unset": ["legacyFlag"] },
  { "_id": "object-2", "$set": { "score": 13 } }
]
```

**Response**

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

`DELETE /api/{db}/{collection}/object`

**Request**

```http
DELETE {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "ids": ["object-1", "object-2"]
}
```

**Response**

```json
{
  "deleted": 2,
  "ids": ["object-1", "object-2"],
  "skipped": []
}
```

The delete body may also be a plain array of ids.

### Streamed Bulk Writes

Large imports can use NDJSON so the server does not need to hold one giant JSON array in memory. Each line is one JSON value. Internally, OBJY DB buffers lines into bounded chunks and then uses the same bulk storage, routing, replication, durability, permission, and index paths as normal bulk writes.

Streamed writes require minimal responses:

```http
Content-Type: application/x-ndjson
Prefer: return=minimal
```

If a streamed request fails after earlier chunks were written, those earlier chunks stay committed. Use stable `_id` values when clients retry large streams. Omitted `_id` values are allowed on insert, but generated ids are not returned by minimal streamed responses.

#### Stream Insert

`POST /api/{db}/{collection}/object`

**Request**

```http
POST {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Prefer: return=minimal

{"_id":"object-1","status":"active","score":42}
{"_id":"object-2","status":"archived","score":10}
{"_id":"object-3","status":"generated","score":3}
```

**Response**

```json
{
  "inserted": 3
}
```

#### Stream Replace

`PUT /api/{db}/{collection}/object`

**Request**

```http
PUT {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Prefer: return=minimal

{"_id":"object-1","status":"active","score":50}
{"_id":"object-2","status":"archived","score":12}
```

**Response**

```json
{
  "replaced": 2
}
```

#### Stream Patch

`PATCH /api/{db}/{collection}/object`

**Request**

```http
PATCH {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Prefer: return=minimal

{"_id":"object-1","$set":{"score":51},"$unset":["legacyFlag"]}
{"_id":"object-2","$set":{"score":13}}
{"_id":"missing","$set":{"score":99}}
```

**Response**

```json
{
  "updated": 2,
  "skipped": 1
}
```

#### Stream Delete

`DELETE /api/{db}/{collection}/object`

**Request**

```http
DELETE {URL}/api/{db}/{collection}/object
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Prefer: return=minimal

{"_id":"object-1"}
{"_id":"object-2"}
{"_id":"missing"}
```

**Response**

```json
{
  "deleted": 2,
  "skipped": 1
}
```

## Query

Query responses are plain arrays. Use GET for small URL-safe queries and POST `/search` for larger payloads. Normal object queries default to `250` rows and cap each page at `250`; use `offset` / `$skip` or `$page` to read more.

### GET Query

`GET /api/{db}/{collection}/object`

`q` is URL-encoded JSON. The decoded query in this example is `{"status":"active","score":{"$gte":10}}`.

**Request**

```http
GET {URL}/api/{db}/{collection}/object?q=%7B%22status%22%3A%22active%22%2C%22score%22%3A%7B%22%24gte%22%3A10%7D%7D&sortBy=score&sort=desc&limit=50&offset=0
Authorization: Bearer <accessToken>
```

**Response**

```json
[
  { "_id": "object-1", "status": "active", "score": 42 },
  { "_id": "object-9", "status": "active", "score": 31 }
]
```

### POST Search

`POST /api/{db}/{collection}/search`

**Request**

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

**Response**

```json
[
  { "_id": "object-1", "status": "active", "score": 42 }
]
```

### Operator Query

`POST /api/{db}/{collection}/search`

**Request**

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

**Response**

```json
[
  { "_id": "object-1", "status": "active", "score": 42, "tags": ["paid"] }
]
```

Also supported: `$eq`, `$equal`, `$deepEquals`, `$ne`, `$in`, `$nin`, `$regex`, `$like`, `$likeI`, `$startsWith`, `$endsWith`, `$contains`, `$elemMatch`, `$exists`, `$null`, `$type`, `$size`, `$mod`, `$between`, `$before`, `$after`, `$and`, `$or`, `$nor`, `$not`, `$all`, and `$any`.

### Query Path

Query, vector-search, and aggregation responses include the planner decision in:

```http
x-objydb-query-path: index-full
```

<details>
<summary><strong>Planner path values</strong></summary>

Read paths include `scan`, `index-full`, `index-partial`, and `ordered-index`. Vector paths are `vector-index` and `vector-filter`. Aggregate paths include `aggregate-column-summary`, `aggregate-column-scan`, `aggregate-group-index`, `aggregate-group-forward-index`, `aggregate-group-column-scan`, and `aggregate-scan`.

Permission-denied reads report `permission-denied`; reference queries add `reference-` or `aggregate-reference-`. A sharded response may contain multiple comma-separated paths when shards use different plans.

</details>

## Aggregation

Aggregation is supplied as `$aggregate` inside the query object. Supported operators are `$sum`, `$avg`, `$min`, `$max`, and `$count`.

`POST /api/{db}/{collection}/search`

**Request**

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

**Response**

```json
[
  { "status": "active", "totalScore": 1234, "avgScore": 38.56, "count": 32 }
]
```

## Vector Search

Store embeddings on `_vec`. The vector is indexed separately and hidden from normal read responses.

### Insert Vector Object

`POST /api/{db}/{collection}/object`

**Request**

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

**Response**

```json
{
  "_id": "doc-1",
  "title": "Hello"
}
```

### Search Vectors

`POST /api/{db}/{collection}/search`

**Request**

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

**Response**

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

Reference descriptors point to another object without embedding a stored copy. `database` is optional; if omitted, the current database is used. Reads expand references by default with depth `1`; use `$refDepth: 0` to retain the descriptor only.

### Store Reference

`POST /api/{db}/{collection}/object`

**Request**

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

**Response**

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

`GET /api/{db}/{collection}/object/{_id}`

Reads expand references by default with depth `1`.

**Request**

```http
GET {URL}/api/{db}/{collection}/object/post-1
Authorization: Bearer <accessToken>
```

**Response**

```json
{
  "_id": "post-1",
  "title": "Hello",
  "author": {
    "type": "reference",
    "collection": "users",
    "value": "user-1",
    "object": { "_id": "user-1", "username": "alice" }
  }
}
```

### Read Unexpanded Reference

`GET /api/{db}/{collection}/object/{_id}`

**Request**

```http
GET {URL}/api/{db}/{collection}/object/post-1?$refDepth=0
Authorization: Bearer <accessToken>
```

**Response**

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

`POST /api/{db}/{collection}/search`

**Request**

```http
POST {URL}/api/{db}/{collection}/search
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "author.object.username": "alice"
}
```

**Response**

```json
[
  {
    "_id": "post-1",
    "title": "Hello",
    "author": {
      "type": "reference",
      "collection": "users",
      "value": "user-1",
      "object": { "_id": "user-1", "username": "alice" }
    }
  }
]
```

Vector search cannot currently be combined with reference object paths.

## Health and Cluster Status

### Health

The health route does not require authentication. During restore it remains available while data routes return `503` with `Retry-After: 5`.

`GET /health`

**Request**

```http
GET {URL}/health
```

**Response**

```json
{
  "ok": true,
  "node": "node-8080",
  "restore": null
}
```

While restoring, the response also has `"restoring": true` and `restore` contains current progress.

### Public Cluster Status

`/api/config` is the compact public status endpoint for the UI and operators. It requires a global admin token. Cluster collection is cached for one second so concurrent status requests reuse the same peer fan-out.

`GET /api/config`

**Request**

```http
GET {URL}/api/config
Authorization: Bearer <accessToken>
```

<details>
<summary><strong>Response example</strong></summary>

```json
{
  "ok": true,
  "generatedAt": "2026-09-18T08:41:22.000Z",
  "node": { "id": "node-8080", "url": "{URL}" },
  "rss": {
    "cluster": { "rss": 2190999552, "nodeCount": 1, "onlineNodeCount": 1 },
    "logical": { "rss": 2190999552, "nodeCount": 1, "onlineNodeCount": 1 },
    "physical": { "rss": 2190999552, "nodeCount": 1, "onlineNodeCount": 1 }
  },
  "heap": {
    "cluster": { "used": 1701040128, "total": 4294967296, "percent": 39.6 },
    "logical": { "used": 1701040128, "total": 4294967296, "percent": 39.6 },
    "physical": { "used": 1701040128, "total": 4294967296, "percent": 39.6 }
  },
  "indexes": {
    "ready": 18,
    "building": 2,
    "error": 0,
    "activeTasks": 1
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

</details>

The normal response contains one shard topology, lightweight node health, logical and physical heap/RSS totals, per-node memory-guard state, and aggregate index, vector, and logical compression information. Logical totals select one reachable replica per shard; physical totals count every process. The example abbreviates fields inside the memory summaries; the live response also includes byte/MiB totals, capacity percentages, and online/offline counts.

`indexes.activeTasks` counts active cooperative index, column, and vector maintenance tasks in the node process.

`replication.healthy` means the node has no known replication failure or queued/in-flight catch-up work. It is an operational health signal, not a full data-checksum comparison between replicas.

Detailed request:

```http
GET {URL}/api/config?details=1
Authorization: Bearer <accessToken>
```

The detailed response adds per-collection index, vector, and compression state plus full replication diagnostics. The admin UI requests it only when the cluster-status modal is opened. Restore progress is included only while a peer is restoring.

## Responses, Errors, and Limits

OBJY DB keeps public responses close to the requested operation:

| Operation | Response shape |
| --- | --- |
| Single create, read, replace, or patch | One object. |
| Query, search, vector search, or aggregation | An array. |
| Bulk write | Count fields plus returned items unless minimal response was requested. |
| Bulk delete | `{ deleted, ids, skipped }`. |
| Successful delete | `204 No Content`. |

Errors use a JSON body containing at least `error`. Additional fields may include `code`, `operationStarted`, `writeMayHaveSucceeded`, committed import counts, restore progress, or index readiness.

Normal object queries default to 250 rows and cap a page at 250. JSON bodies, individual objects, bulk counts, bulk bytes, file uploads, and pending persistence pressure are bounded by server configuration. Oversized requests return `413`; temporary restore or pressure responses may include `Retry-After`.

NDJSON streams commit bounded batches as they are processed. A later malformed line or failed batch does not roll back earlier committed batches.
