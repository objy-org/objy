# Data Explorer

A framework-independent Web Component with isolated styles and no dependencies. It displays a database/collection tree, a separate object list, and an editable JSON pane.

The build bundles its local helpers into one classic script. It does not require the app shell, connection manager, or PDF renderer.

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

The plus in the Databases heading requests database creation. Each database has a plus to request collection creation. The plus above the object list requests object insertion into the selected collection; it is disabled until a collection is selected. Studio accepts one JSON object or an array of objects. These events bubble across the shadow boundary; the host owns the dialogs and database writes. In Studio they use the selected connection through the shared OBJY store and keep the explorer open.

Use unique database IDs, collection IDs within each database, and object IDs within each collection. Object identity prefers `_id`, then `id`, then the array index. Data must be JSON serializable. The component does not modify supplied data. Assign a fresh `databases` value to display updated records. Selection survives refreshes while its IDs remain present. Selecting another collection clears the previous object's JSON.

`explorer.selection` returns the current `{ databaseId, collectionId }` context (or `null`) for host integrations.

Save `explorer.viewState` before unmounting and restore it after assigning `databases` on the new instance. This preserves expansion, collection/object selection, pane scroll positions and unsaved object drafts. Keep view state per connection so servers with identical database/object names cannot share drafts. Drafts belong to the current page and are not persisted on reload. `selectDatabase(databaseId)` expands a database and clears the object panes. `selectCollection(databaseId, collectionId)` opens that collection and emits `collection-select`.

Object list titles use `_id` (with `id` as a standalone fallback). A compact JSON preview appears underneath in muted text, excluding the repeated `_id`. The collection heading includes a metadata button beside Add objects.

Arrow keys navigate and expand the tree; Enter or Space opens a collection. Right Arrow on a collection moves to its object list. Up/Down and Home/End in the list select objects; Left Arrow returns to the collection and Right Arrow focuses the JSON. Tab also moves between controls and panes. The JSON textarea supports normal editing, text selection and clipboard copying. Cmd/Ctrl+S saves the selected object. Save, Undo and Delete appear below the editor; Delete requires an inline confirmation. Invalid JSON and changed/removed `_id` values are rejected before dispatch.

The component inherits `--canvas`, `--surface`, `--ink`, `--secondary`, `--muted`, `--line`, `--accent`, `--wash`, and `--surface-hover`. Defaults provide a dark theme. At widths up to 620px the tree and object list stay side by side, with JSON below them. The host can supply complete arrays or load collections on demand as described below.

## Sizing

By default the explorer uses its own fixed desktop height and stacks the JSON pane below the lists on narrow screens. Add the `fill` attribute and give the host a bounded height (or `flex:1; min-height:0` inside a bounded flex column) to fill the available space. Studio uses this mode to fit the browser window. The explorer has no outer border; the inner pane dividers remain. Each pane scrolls independently.

## Optional asynchronous collections

Collections may include `loaded:false`, `count:null`, `loading`, `error` and `hasMore`. Existing fully populated arrays still work without these fields. Unknown counts display a dash. The host handles `collection-select` to load objects, then updates `.databases`. `load-objects` emits `{databaseId, collectionId, more}` for retry/load-more controls. The component never calls a database or a connection manager.

## Editing integration

The component owns editor text only; the host owns all server access. Listen for `manage-collection` with `{ databaseId, collectionId }` to open a metadata editor. Studio loads and saves the native metadata JSON through `ObjyStore.getMeta/setMeta`.

For `save-object` and `delete-object`, call `event.detail.respondWith(promise)` synchronously in the listener. Detail includes `databaseId`, `collectionId`, `objectId`, `original` (the loaded snapshot), and `object` (the parsed save value). Capture the current connection immediately. Resolve the promise only after the write is acknowledged and the host has assigned refreshed `explorer.databases`; reject with the actual failure to retain the draft and show an inline error. A missing handler produces an error, never a success message.

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

Set `explorer.busy = true` during other writes to disable editing and creation controls. Pending writes keep their captured target even if the user selects another object. Refreshes preserve dirty text; Undo discards that draft and displays the latest loaded object. A confirmed save resets the draft. If a write may have succeeded, repeat writes stay disabled until the user inspects the data and resets the draft.

Studio checks the loaded snapshot against a fresh server read before saving/deleting and rejects detected conflicts. This is a preflight check, not atomic compare-and-swap: the server API does not provide a conditional-write revision in this integration. The same check protects metadata edits. Confirmed write receipts survive a failed catalog refresh.

## Deletion and attachments

`delete-scope` emits `{ databaseId, collectionId? }` from each tree row; the host displays confirmation and performs deletion. The `_global` database has no delete button. Removing a scope from `.databases` clears its selection, drafts and query state.

`attach-file` and `open-file` emit `{ databaseId, collectionId, objectId, original }`. The host owns file selection, uploads, previews/downloads, confirmation and errors. Attachment replacement is disabled while the JSON draft is dirty or uncertain. File actions are hidden on derived query results. The component itself has no network or file-storage dependency.

## Collection queries

The query bar spans the object list and JSON pane, beside the database tree. Its textarea accepts a native JSON query object. Enter inserts a newline and the input grows with the text. Use Command+Enter (Ctrl+Enter on Windows/Linux) or the Run query button to execute it. Clear runs an empty query. No client-side filtering or JavaScript evaluation is performed.

Listen for `run-query` and synchronously call `detail.respondWith(promise)`, just like the write events. Detail contains `{ databaseId, collectionId, query, respondWith }`. The host captures the selected server, executes the query, and updates `explorer.databases` before resolving. A rejection keeps the prior results visible and displays an error. The component retains query text per collection in `viewState.queries`; this state remains in page memory.

The sliders button emits `build-query` with `{ databaseId, collectionId, text, apply }`. The host owns the graphical builder dialog. Call `apply(query)` with a JSON object to update the input without executing it; it returns the new input element for restoring focus and rejects a changed selection. Studio uses `showQueryBuilder` from `../query-builder.js` with the shared dialog component and field suggestions from loaded objects. It supports AND/OR filters, one sort and one aggregation with optional grouping. Unsupported JSON stays intact in the input.

Studio passes the JSON to the official client's `search` method. Ordinary filters use paginated server reads and Load more, preserving the query's sort order. The tree count remains the collection total; the object list count is the matching result count. Explicit `$limit`, `$skip`, `$offset`, `$page`, `$pageSize`, `$cursor`, `$aggregate` or `$vector` queries pass through as one native request, without overriding their result window. Their displayed count is the number of returned rows, and pagination is controlled by the supplied JSON.

Collections can expose `query`, `resultCount`, `directQuery`, and `readOnly` alongside their existing fields. Aggregate, vector and reference-expanded results are read only. Derived rows use separate result identities even if the payload includes an `_id`, so they cannot reuse an object's draft or trigger object writes. Ordinary matching objects retain the JSON editor. Active queries rerun after writes to their collection and manual refreshes. Load more appends the next page without re-fetching preceding rows.

Examples:

```json
{"active":true,"price":{"$gte":100},"$sort":{"price":-1}}
```

```json
{"active":true,"$aggregate":{"fields":{"total":{"$sum":"price"},"count":{"$count":true}}}}
```
