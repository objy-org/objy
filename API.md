# OBJY DB HTTP API

<p align="center"><strong>Dynamic objects. One public API.</strong></p>

Public HTTP reference. The [JavaScript client](https://github.com/objy-org/objy-client) exposes these operations in Node and browsers.

[Start here](#start-here) | [JavaScript client](https://github.com/objy-org/objy-client) | [OBJY DB](README.md)

## Start Here

Examples use `{URL}` for the server base URL. Send requests to any node; the database routes them to the owning shard.

Creation/meta changes use fixed administrative primaries; deletion/topology use the first shard's primary. If unavailable, administration returns `503` or forwarding timeout `504`, without failover. Ordinary CRUD can use surviving replicas. Stop the cluster for primary replacement or resharding.

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

Quick path:

```text
POST /api/_global/users/auth       -> access token
POST /api/{db}/{collection}/object -> stored object
POST /api/{db}/{collection}/search -> result array
```

Objects need no shared schema. `PUT` replaces, `PATCH` applies `$set`/`$unset`, and `DELETE` replicates deletion. Queries, search, and aggregation return plain arrays. Each endpoint below includes a request and response.

## Endpoint Map

| Area | Routes |
| --- | --- |
| [Authentication](#authentication) | Login and renew against any auth-enabled collection. |
| [Databases](#databases) | List, create, bootstrap an administrator, and delete. |
| [Collections](#collections) | List, create, delete, and manage collection metadata. |
| [Objects](#objects) | Single and bulk create, read, replace, patch, and delete. |
| [Imports](#streamed-bulk-writes) | Bounded NDJSON insert, replace, patch, and delete. |
| [Permissions](#permissions) | Collection grants and object-level authorization rules. |
| [Files](#file-handling) | Object-backed multipart upload, replacement, download, and deletion. |
| [Search](#query) | Filters, sorting, paging, aggregation, vectors, and references. |
| [Operations](#health-and-cluster-status) | Health and authenticated public cluster status. |

## Authentication

Any collection can contain users. First boot creates `admin` in `_global/users` and prints its password once; `OBJYDB_ADMIN_PASSWORD` can supply it instead.

Passwords are hashed on write and redacted from responses. Tokens are scoped to the database and collection used for authentication.

Password inputs are plaintext, even if hash-like, limited to 1024 UTF-8 bytes. Hashing uses salted PBKDF2-HMAC-SHA256 (600,000 iterations); login durably upgrades weaker hashes. Work is asynchronous and bounded; overload returns `503` / `Retry-After`.

Access tokens remain valid until expiry, even after account deletion or permission changes. Renewal reloads the current user and permissions; it fails if the account is missing or its `tokenVersion` changed.

### Login

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

Only `401` with `code: "ACCESS_TOKEN_EXPIRED"` and `operationStarted: false` permits renewal and one replay. Never replay if `operationStarted` or `writeMayHaveSucceeded` is true; other auth/permission errors are not expiry signals.

</details>

## Databases

### List Databases

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

Requires a global admin token. Removes metadata, objects, persisted snapshots/journals, and associated file blobs. `_global` cannot be deleted.

Database/collection deletion blocks writes, meta changes, and recreation with `409`. `204` means all configured peers drained the context and shared cleanup finished. On unavailable peers or cleanup failure, `503` leaves deletion pending: retry DELETE on any node. Timeouts never reopen it. Other contexts remain writable, except children of a deleting database. Recreation is allowed after completion. Clusters require shared S3; standalone deletion can be memory-only.

Shared state needs strongly consistent S3 GET/PUT/LIST/DELETE, not ETags. Preserve each node's WAL directory, `publication-clock.json`, and secrets; run one process per identity. Stop the cluster and upgrade together: older servers/tools may not understand publication records. See [recovery and operations](DB.md#persistence-and-recovery).

A DELETE sent after explicit recreation is a new operation against the recreated context, not a retry of its previous deletion.

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

A collection holds dynamic objects and in-memory meta, persisted separately when enabled. Meta also accepts application keys.

These built-in keys change runtime behavior:

| Key | Purpose |
| --- | --- |
| `indexes` | Field indexes for equality filters, candidate narrowing, grouped values, and sorting. |
| `columns` | RID-addressed typed values for compact storage and numeric aggregation. |
| `tiering` | Compressed-memory offloading for selected cold object fields. |
| `structure` | Conditional virtual values applied only to returned objects. |
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
  "structure": [
    {
      "condition": { "type": "asset" },
      "apply": { "status": "managed" }
    }
  ],
  "hooks": {
    "enabled": true,
    "use": ["timestamps", "audit"]
  }
}
```

Indexes accelerate supported filters/sorts. Columns store numbers/booleans in typed arrays, strings as dictionary codes, and unsupported values in overflow. They support ordinary/grouped `$sum`, `$avg`, `$min`, `$max`, and `$count`; returned objects stay unchanged.

Tiering accepts `keep` or `offload`, never both. `"offload": ["history", "rawPayload"]` compresses those paths; indexed/column fields stay hot. Unindexed compressed-field queries require hydration.

Structure conditions inspect physical fields; `{}` matches all. Later matching defaults override earlier ones; physical values win. Identity, file, vector, and auth fields cannot be virtual.

Virtual defaults appear only in reads, never filters, sorts, paging membership, aggregates, indexes, columns, or durable/replicated data. Unsetting an override reveals its fallback. Structure changes apply on the next read without rewriting data or rebuilding state.

Hooks reference server-registered code. `use` selects registered operations; optional per-operation arrays target `create`, `read`, `update`, or `delete`. `enabled: false` bypasses hooks.

Index, column, and tiering changes schedule bounded background work; responses accept settings, not completed conversion. Reads/writes remain available. Hook changes only invalidate the cached plan.

Removing columns moves values back into objects before release. Migration preserves reads but costs time and temporary memory. Compression preserves arrays, including nested array paths. See [meta concepts](DB.md#collection-meta).

### List Collections

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

**Request**

```http
POST {URL}/api/{db}/collections
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "name": "{collection}",
  "indexes": ["status", "tenantId"],
  "columns": ["score"],
  "structure": [
    {
      "condition": { "type": "asset" },
      "apply": { "status": "managed" }
    }
  ],
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

Uses the same [coordinated deletion lifecycle](#delete-database) as databases. Until completion, object writes, metadata edits, and recreating this collection return `409`. A failed DELETE is safe to retry.

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

Objects accept strings, numbers, booleans, arrays, nested objects, and `null` in any shape. Omitted `_id` values become 16-character URL-safe IDs. Single/bulk operations share the base route; `_vec` is hidden from ordinary reads.

### Insert One

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

Full replacement; the URL ID is authoritative.

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

Use `$set` / `$unset` for dot-path changes/removals. `_id` is immutable.

Numeric segments address array elements (`items.0.score`); unsetting an element leaves `null`, without shifting. Updates/meta field paths reject `__proto__`, `prototype`, and `constructor`.

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

NDJSON sends one JSON value per line instead of a giant array. Bounded batches use the ordinary bulk storage, routing, replication, durability, permissions, and indexes.

Streamed writes require minimal responses:

```http
Content-Type: application/x-ndjson
Prefer: return=minimal
```

Earlier batches stay committed after failure. Use stable IDs for retries; inserts may omit `_id`, but minimal responses do not return generated IDs.

Persistence pressure pauses unapplied batches using flush notifications, also for ordinary writes and replication. `imports.persistenceWaitMs` defaults to 60000 ms; timeout, storage failure, or full waiting capacity returns `503` / `Retry-After`. Disconnect cancels unapplied waits. Allow for client/proxy timeouts; acknowledgement policy is unchanged.

#### Stream Insert

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


## Permissions

Database users stay within their login database; global users can address others. Context/meta administration requires `admin: true` or `role: "admin"`; database creation/deletion and `/api/config` require a global admin.

`_global` is publicly read-only after bootstrap, including objects, meta, and context changes, even for global admins.

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

`read` allows reads/queries; `write` allows create/update/delete, not read. Create users at `POST /api/{db}/users/object`; permission changes require login or renewal.

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

Read rules merge into queries; updates must permit stored and resulting values. Non-admins without matching rules or grants are denied.

Account security is separate from ordinary collection-write access, in every collection:

- Only a database admin (for that database) or global admin may assign or change an account's `admin`, `role`, `permissions`, `collectionPermissions`, or `tokenVersion`.
- With the usual write permission, users may change their own credentials or delete their own account. Other accounts' credentials and deletion require an admin. Ownership matches database, collection, and `_id`, not username alone.
- Creating an unprivileged account is allowed with create permission; activating an object with existing privilege fields requires an admin. Ordinary non-account objects may still use those field names as business data.

Checks cover single, bulk, NDJSON, multipart, and hook-modified writes. Violations return `403`, not silently stripped fields. Issued access tokens retain authority until expiry.

## File Handling

One object wraps one private S3 blob through `_file`. Blob reads use the API and the object's read permissions; keep the bucket private.

```json
{
  "_file": {
    "storage": "s3",
    "key": "objydb/files/db/{db}/collection/{collection}/object/object-1/blob/{fileId}",
    "mimeType": "application/pdf"
  }
}
```

The server derives `_file.key` from context, `_id`, and a generated file ID; do not set it yourself. Replacement writes a blob, commits its pointer, then removes the old blob best-effort. Upload one multipart file object per request; bulk uploads are unsupported.

### Create Object With File

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

## Query

Use GET for small queries or POST `/search` for larger bodies. Object pages default/cap at 250 rows; advance with `offset` / `$skip` or `$page`.

Default sort: `_id` ascending, also the tie-breaker for explicit sorts. Ascending types: numbers, strings, booleans, arrays, objects, `null`, missing. Strings use case-sensitive UTF-16 order, not locale. Arrays compare elements; objects compare sorted keys/values. Descending reverses field order, not the ID tie-breaker.

Indexes/scans share this ordering across shards. Pages read live data, not snapshots; writes or replica lag can shift boundaries.

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

Compact status includes topology, node health, logical/physical memory, memory guards, and index/vector/compression totals. Logical totals select one reachable replica per shard; physical totals count every process. Memory summaries above are abbreviated; live responses also include byte/MiB totals, percentages, and reachability counts.

`indexes.activeTasks` counts active cooperative index, column, and vector maintenance tasks in the node process.

`replication.healthy` means no known failure or pending/in-flight catch-up, not a replica checksum match.

Detailed request:

```http
GET {URL}/api/config?details=1
Authorization: Bearer <accessToken>
```

Details add per-collection index/vector/compression state and replication diagnostics. The UI requests them on opening cluster status. Restore progress appears only during restore.

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

Configuration bounds JSON bodies, objects, bulk counts/bytes, file uploads, and persistence pressure. Oversized requests return `413`; restore/pressure responses may include `Retry-After`. Object page limits are listed under [Query](#query).

For partial-commit behavior and retries, see [streamed writes](#streamed-bulk-writes).
