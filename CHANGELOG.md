# Changelog

Notable changes to OBJY DB are recorded here. The project follows semantic versioning for published releases; alpha releases may still change APIs and configuration.

## Unreleased

### Added

- Dedicated database, server, and benchmark documentation for evaluation.
- Structured issue and pull-request templates.

## 0.2.0-alpha.0 - 2026-10-31

### Added

- Universal `@objy/db` package for Node.js and browsers.
- `@objy/server` package with the HTTP runtime, clustering, S3 durability, hooks, admin console, and `objy` CLI.
- Standalone, dependency-free `@objy/client` package for Node.js and browsers.
- Standalone browser ESM artifact in GitHub releases.
- Cross-runtime correctness and performance suite covering source, packed packages, HTTP, and Chromium.
- Restart-based reshard generations backed by shared S3 state.

### Changed

- Object storage is the default engine; shape storage remains selectable.
- Release packaging now produces synchronized database and server packages from one repository version.
- Browser and Node.js runtimes share the same database API and select platform implementations through package exports.

### Notes

- This is an alpha release. See [README.md](README.md#alpha-status), [DB.md](DB.md), and [SERVER.md](SERVER.md) before production evaluation.
- Earlier prerelease work is preserved in Git history; no older semantic-version release tags are reconstructed here.
