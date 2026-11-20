# Data Explorer Development

The database UI is maintained here inside the server repository. There is no nested Git repository or submodule.

For setup, development commands, generated assets, and verification, use [Contributing](../CONTRIBUTING.md#development). For using the UI, see the [database guide](../DB.md#data-explorer). Authentication and data operations use the official JavaScript client; no browser database engine or AI is included.

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

See the [data architecture](src/data/README.md), [component API](src/ui/components/README.md), and [verification guide](tests/README.md) for their integration contracts and coverage.
