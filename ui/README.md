# OBJY Server UI

The database UI is maintained here inside the server repository. There is no nested Git repository or submodule.

From the repository root:

```sh
npm ci
npm run build:ui
npm run dev:ui
```

The development view runs at http://127.0.0.1:4317/. The server serves the compiled `public/ui/` from the repository root at `/`, `/ui`, and `/ui/`. New connections prefill the page's origin (protocol, hostname or IP, and port); change it if the database runs at a different address. Saved logins retain their server URL. Authentication uses the official JavaScript client. No browser database engine or AI is included.

- `src/ui/components/data-explorer.js`: reusable three-pane Web Component.
- `src/ui/app.js`: connection controls and database actions; one shared loading path for browsing and queries.
- `src/ui/dialog.js`: dialog submission, keyboard focus, and cleanup.
- `src/ui/node-view.js`: node pills and statistics markup.
- `src/ui/query-builder.js`: graphical filters, sorting, and aggregation, converted to native JSON queries.
- `src/ui/markup.js`: shared HTML escaping, icons, and JSON input validation.
- `src/ui/attachments.js` and `pdf-preview.js`: attachment previews and lazy PDF rendering.
- `src/data/`: official-client adapter, queries, paging, and saved sessions.
- `tests/`: integration tests and the browser regression harness.
- `scripts/`: build, local development, browser tests, and the opt-in local load-data utility.

Database and collection rows reveal a delete button on hover or keyboard focus. Deletion requires the exact name and removes the scope's objects and attachments; `_global` cannot be deleted. The object editor provides Attach file / Replace file and Open controls. Open previews images and PDFs in a modal, with a Download option. Unsupported file types download directly. Add objects accepts an optional attachment with a single JSON object. Files use the server's configured blob storage and the official client's multipart and download methods; no direct storage access is used.

The sliders button beside the JSON query opens a small query builder. Combine filters with AND/OR, choose one sort, or summarize with Count, Sum, Average, Minimum or Maximum and an optional group field. Field suggestions come from loaded objects; other field names and dotted paths can be typed directly. Values accept text or JSON; quote numeric strings and use arrays for “one of”. Apply query fills the JSON input; Run or Cmd/Ctrl+Enter executes it through the existing official-client path. Advanced queries that the controls cannot represent remain editable in JSON and are never partially overwritten.

See [server development instructions](../CONTRIBUTING.md), [data architecture](src/data/README.md), and [component API](src/ui/components/README.md). `dist/` and root `public/ui/` are generated; release and Docker builds include it automatically.
