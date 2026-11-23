# Data Explorer Development

The UI lives in this database repository, not a submodule.

See [Contributing](../CONTRIBUTING.md#development) for setup/builds/tests and the [database guide](../DB.md#data-explorer) for usage. Data/auth use the official client, without a browser engine or AI.

## Module Map

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

Details: [data architecture](src/data/README.md), [component API](src/ui/components/README.md), [verification](tests/README.md).
