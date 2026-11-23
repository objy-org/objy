# Contributing

Focused fixes, tests, docs, and performance work are welcome.

Start with the [engineering goals](AGENTS.md): correctness, predictable latency, sustained bulk throughput, and bounded memory guide design decisions.

## Before You Start

- Search existing issues before opening a new one.
- Open an issue before substantial architecture or public API work so the direction can be agreed first.
- Keep changes focused, bulk-first, and compatible with dynamic objects.
- Preserve the separation between storage, queries, routing, replication, persistence, and interfaces.
- Do not add compatibility branches or abstractions without a current use.

## Development

OBJY DB requires Node.js 20 or newer.

```sh
npm ci
npm test
```

`ui/` is a workspace in this repository. Root `npm ci` installs its dependencies; `npm test` builds it and runs server/UI integration tests.

| Command | Purpose |
| --- | --- |
| `npm run build:ui` | Generate `ui/dist/` and server assets in `public/ui/`, served at `/`, `/ui`, and `/ui/`. |
| `npm run dev:ui` | Rebuild on change at `http://127.0.0.1:4317/`; override with `PORT`. Refresh after rebuilds and allow this origin in server CORS. |
| `npm run test:ui:manual` | Open the printed localhost page and click **Run checks**; uses a disposable server, not an existing database. |
| `npm run test:ui` | Run the browser suite in Chromium, Firefox, and WebKit. First install browsers: `npx playwright install --with-deps`. |

Release and Docker builds compile the UI automatically. Source checkouts need `npm run build:ui` before server startup. Assets bundle the official client, with no CDN or browser AI. Never edit generated `ui/dist/` or `public/ui/`; source and release assets share the `public/` layout.

Start with `node bin/objy.js --config objydb.config.json` (same bootstrap as `node src/index.js`). See the [database guide](DB.md), [UI module map](ui/README.md), and build/test scripts in `ui/scripts/`. Development commands do not publish.

Add focused tests beside the behavior being changed. The broader suites are selected by impact:

| Change | Required command |
| --- | --- |
| Any runtime behavior | `npm test` |
| Admin console | `npm run test:ui` |
| Storage, queries, aggregation, indexes, columns, or compression | `npm run test:scale` |
| Exports, package files, release scripts, or metadata | `npm run check:package && npm run test:package` |
| Replication, restore, or resharding | Relevant `test:stress:*` command from `package.json` |

Include before/after commands and workloads for performance changes. One warm run is not a general benchmark; follow [BENCHMARKS.md](BENCHMARKS.md).

## Pull Requests

- Explain the user-visible behavior and the reason for the change.
- Keep unrelated formatting, generated files, and refactors out of the diff.
- Preserve single-operation-as-bulk-of-one behavior.
- Cover failure paths when changing distributed or durable state.
- Update the relevant public documentation when behavior or configuration changes.
- Confirm that no credentials, local WAL data, S3 data, customer data, or generated caches are included.

Report security issues privately as described in [SECURITY.md](SECURITY.md). By submitting a contribution, you agree that it is licensed under the repository's [MIT License](LICENSE).
