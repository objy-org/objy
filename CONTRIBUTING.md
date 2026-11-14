# Contributing

Thanks for helping improve OBJY DB. Focused fixes, tests, documentation, and carefully scoped performance work are welcome.

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

The database UI lives in `ui/` as an npm workspace in this same Git repository. Root `npm ci` installs its build dependencies; `npm test` builds it and runs both server and UI integration tests. There is no submodule or separate UI repository.

- `npm run build:ui` generates `ui/dist/` for standalone development and `public/ui/` for the server, which serves the UI at `/`, `/ui`, and `/ui/`.
- `npm run dev:ui` runs the UI alone at `http://127.0.0.1:4317/` with rebuild-on-change. Connect it to a local server allowed by that server's CORS configuration.
- `npm run test:ui:manual` prints a disposable localhost browser-test page; open it and click **Run checks**. It tests the actual server UI routes and API without modifying an existing database.
- `npm run test:ui` runs the same browser regression suite in Chromium, Firefox, and WebKit through Playwright. Install those browsers first with `npx playwright install --with-deps`.

Release packaging and Docker builds compile the UI automatically. A direct source checkout needs `npm run build:ui` before starting the server. Built assets bundle the official JavaScript client; no CDN or browser AI is required. Never edit generated `ui/dist/` or `public/ui/` files. Compiled release assets stay under `public/` for compatibility with the CLI’s server-package extraction.

Add focused tests beside the behavior being changed. The broader suites are selected by impact:

| Change | Required command |
| --- | --- |
| Any runtime behavior | `npm test` |
| Admin console | `npm run test:ui` |
| Storage, queries, aggregation, indexes, columns, or compression | `npm run test:scale` |
| Exports, package files, release scripts, or metadata | `npm run check:package && npm run test:package` |
| Replication, restore, or resharding | Relevant `test:stress:*` command from `package.json` |

Performance changes should include a before/after command and workload. Do not present a single warm run as a general benchmark; see [BENCHMARKS.md](BENCHMARKS.md) for the repository format.

## Pull Requests

- Explain the user-visible behavior and the reason for the change.
- Keep unrelated formatting, generated files, and refactors out of the diff.
- Preserve single-operation-as-bulk-of-one behavior.
- Cover failure paths when changing distributed or durable state.
- Update the relevant public documentation when behavior or configuration changes.
- Confirm that no credentials, local WAL data, S3 data, customer data, or generated caches are included.

Report security issues privately as described in [SECURITY.md](SECURITY.md). By submitting a contribution, you agree that it is licensed under the repository's [MIT License](LICENSE).
