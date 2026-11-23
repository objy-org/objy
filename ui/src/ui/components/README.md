# Data Explorer

A dependency-free Web Component: database/collection tree, object list, and JSON editor with isolated styles. Local helpers bundle into one classic script, without the app shell, connection manager, or PDF renderer.

```html
<script src="/components/data-explorer.js" defer></script>
<objy-data-explorer></objy-data-explorer>
<script>
  customElements.whenDefined('objy-data-explorer').then(() => {
    const explorer = document.querySelector('objy-data-explorer');
    explorer.databases = [{
      id: 'main',
      name: 'Main database',
      collections: [{
        id: 'customers',
        name: 'Customers',
        objects: [{ _id: 'c1', name: 'Alex Morgan', active: true }]
      }]
    }];
    explorer.addEventListener('create-database', () => {
      // Open your creation form, write through your database adapter,
      // reassign explorer.databases, then explorer.selectDatabase(databaseId).
    });
    explorer.addEventListener('create-collection', event => {
      const { databaseId } = event.detail;
      // Create a collection in this database through your adapter,
      // refresh databases, then explorer.selectCollection(databaseId, collectionId).
    });
    explorer.addEventListener('create-objects', event => {
      const { databaseId, collectionId } = event.detail;
      // Open an object form, insert through your adapter, and refresh databases.
    });
    explorer.addEventListener('collection-select', event => {
      console.log(event.detail); // { databaseId, collectionId }
    });
    explorer.addEventListener('object-select', event => {
      console.log(event.detail); // { databaseId, collectionId, object }
    });
  });
</script>
```

Creation buttons emit events for databases, collections, or objects; object creation requires a selected collection and accepts an object or array. Events cross the shadow boundary. The host owns dialogs/writes; Studio uses the selected connection's shared store without closing the explorer.

## Data and Selection

Data must be JSON serializable. Database IDs are unique; collection/object IDs are unique within their parent. Object identity uses `_id`, then `id`, then array index. The component never mutates input: assign fresh `databases` to refresh. Existing IDs preserve selection; changing collections clears the prior JSON.

| Member | Contract |
| --- | --- |
| `selection` | Current `{ databaseId, collectionId }`, or `null`. |
| `viewState` | Expansion, selection, scroll, and drafts. Save before unmount; restore after assigning `databases`. Keep per connection; drafts do not survive reload. |
| `selectDatabase(id)` | Expand the database and clear object panes. |
| `selectCollection(db, collection)` | Open and emit `collection-select`. |

Rows show IDs and compact previews excluding repeated `_id`; the collection heading provides meta and object creation controls.

## Keyboard and Layout

Arrows navigate/expand the tree; Enter/Space opens collections, Right moves to objects. In the object list, Up/Down/Home/End select; Left returns to the tree, Right focuses JSON. Tab traverses controls. The editor supports selection/copy and Cmd/Ctrl+S; Save/Undo/Delete sit below it. Delete confirms inline; invalid JSON or changed/missing `_id` is rejected before dispatch.

Theme variables: `--canvas`, `--surface`, `--ink`, `--secondary`, `--muted`, `--line`, `--accent`, `--wash`, `--surface-hover`; defaults are dark.

Desktop height is fixed by default. Use `fill` with a bounded host height, or `flex:1; min-height:0` in a bounded flex column, as Studio does. Panes scroll independently, with internal dividers and no outer border. At widths up to 620px, tree/list stay side by side above JSON.

## Optional asynchronous collections

Supply complete arrays or load on demand with `loaded:false`, `count:null`, `loading`, `error`, and `hasMore`. Unknown counts show a dash. Handle `collection-select` to load, then assign `.databases`; `load-objects` emits `{databaseId, collectionId, more}` for retry/load-more. The component never accesses the server.

## Editing integration

The host owns server access. `manage-collection` emits `{ databaseId, collectionId }`; Studio opens native meta through `ObjyStore.getMeta/setMeta`.

For `save-object` / `delete-object`, synchronously call `detail.respondWith(promise)`. Detail contains context IDs, `objectId`, `original` snapshot, and parsed save `object`. Capture the connection immediately; resolve only after acknowledgement and refreshed `.databases`. Rejection preserves the draft and displays the error; missing handlers fail.

```js
explorer.addEventListener('save-object', ({ detail }) => {
  const targetStore = store;
  detail.respondWith((async () => {
    await targetStore.replaceObject(detail.databaseId, detail.collectionId,
      detail.objectId, detail.object, { expected: detail.original });
    explorer.databases = targetStore.databases;
  })());
});
```

Set `busy = true` during other writes to disable editing/creation. Pending writes keep captured targets. Refresh preserves drafts; Undo shows latest loaded data, confirmed save resets the draft. Uncertain writes disable resubmission until inspection/reset.

Studio preflights object/meta edits and deletes against fresh reads, rejecting detected conflicts. This is not atomic compare-and-swap; no conditional-write revision is supplied. Confirmed receipts survive failed refreshes.

## Deletion and attachments

`delete-scope` emits `{ databaseId, collectionId? }`; the host confirms/deletes. `_global` has no delete control. Removing scopes from `.databases` clears their selection, drafts, and queries.

`attach-file` / `open-file` emit `{ databaseId, collectionId, objectId, original }`. The host handles files, previews, confirmations, and errors. Dirty/uncertain drafts block replacement; derived results hide file actions. The component has no file-storage dependency.

## Collection queries

The query bar above the object/editor panes accepts native JSON. Enter adds a newline; the input grows. Cmd/Ctrl+Enter or Run executes; Clear runs `{}`. No client-side filtering or JavaScript evaluation occurs.

`run-query` emits `{ databaseId, collectionId, query, respondWith }`. Use the synchronous `respondWith` protocol above: capture the server, query, then update `.databases` before resolving. Errors preserve results. Query text stays per collection in page-only `viewState.queries`.

`build-query` emits `{ databaseId, collectionId, text, apply }`. `apply(query)` fills without executing, returns the input for focus, and rejects changed selections. Studio uses `showQueryBuilder` from `../query-builder.js`, shared dialogs, and loaded-field suggestions: AND/OR, one sort, one optional-group aggregation. Unsupported JSON remains intact.

Studio calls client `search`. Ordinary filters retain sorted paging/Load more; tree counts remain collection totals, list counts describe matches. Explicit `$limit`, `$skip`, `$offset`, `$page`, `$pageSize`, `$cursor`, `$aggregate`, or `$vector` pass through once without window overrides; displayed counts use returned rows. Passing a key through does not add server support for it.

Collections may expose `query`, `resultCount`, `directQuery`, and `readOnly`. Aggregate/vector/reference-expanded rows are read-only with separate identities, even if payloads have `_id`; they cannot reuse object drafts or trigger writes. Ordinary results stay editable. Queries rerun after relevant writes/manual refresh; Load more appends without refetching earlier pages.

Examples:

```json
{"active":true,"price":{"$gte":100},"$sort":{"price":-1}}
```

```json
{"active":true,"$aggregate":{"fields":{"total":{"$sum":"price"},"count":{"$count":true}}}}
```
