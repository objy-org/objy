# Changelog

Notable changes to OBJY DB are recorded here. The project follows semantic versioning for published releases; alpha releases may still change APIs and configuration.

## Unreleased

### Removed

- Embedded Node.js and browser database distributions. OBJY DB now ships as the `@objy/server` runtime; applications connect through HTTP or `@objy/client`.

## 0.1.0 - 2026-11-04

### Added

- Universal `@objy/db` package for Node.js and browsers.
- `@objy/server` package with the HTTP runtime, clustering, S3 durability, hooks, and admin console. Deployment tooling lives in the separate `@objy/cli` package.
- Standalone, dependency-free `@objy/client` package for Node.js and browsers.
- Standalone browser ESM artifact in GitHub releases.
- Cross-runtime correctness and performance suite covering source, packed packages, HTTP, and Chromium.
- Restart-based reshard generations backed by shared S3 state.
- Dedicated database, server, and benchmark documentation for evaluation.
- Structured issue and pull-request templates.

### Changed

- Object storage is the default engine; shape storage remains selectable.
- Release packaging now produces synchronized database and server packages from one repository version.
- Browser and Node.js runtimes share the same database API and select platform implementations through package exports.
- The server no longer packages or serves the standalone JavaScript client; applications and the admin console consume `@objy/client` independently.

### Notes

- This is an alpha release. See [README.md](README.md) and [API.md](API.md) before production evaluation.
- Earlier prerelease work is preserved in Git history; no older semantic-version release tags are reconstructed here.
