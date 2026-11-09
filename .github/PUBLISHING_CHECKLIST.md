# Publishing Checklist

Use this before publishing an OBJY DB release to GitHub, npm, or a container registry.

## Release identity

- [ ] Use the `package.json` version consistently in the Git tag, release notes, npm package, and container tag.
- [ ] Use an explicit npm distribution tag such as `alpha` for prereleases.
- [ ] Confirm that `@objy/server` is available at the intended version.
- [ ] Confirm that `@objy/server` contains no executable; the `objy` binary is published only by `@objy/cli`.
- [ ] Confirm that the pinned `@objy/client` version imported by the admin console is already available from npm.
- [ ] Confirm the working tree is clean and the release commit is on the intended branch.

## Legal and security

- [ ] Confirm that all ported source code is owned by the project and may be released under MIT.
- [ ] Scan tracked files and the complete Git history for credentials, private keys, production endpoints, and customer data.
- [ ] Review production dependencies for known vulnerabilities.
- [ ] Confirm that examples contain no reusable secrets or unsafe production defaults.

## Validation

- [ ] Run `npm ci` in a clean checkout.
- [ ] Run `npm test` and `npm run test:ui`.
- [ ] Run `npm run test:scale` and review the generated performance reports.
- [ ] Run `npm run check:package` and inspect all files under `.release/artifacts/`.
- [ ] Run `npm run test:package` against a clean tarball installation.
- [ ] Build and smoke-test the Docker image.
- [ ] Start a multi-node cluster and verify routing, replication, persistence, queries, aggregations, references, and vector search.
- [ ] Verify the README, server, API, benchmarks, changelog, links, and images.

## Publish

- [ ] Open **Actions → Release → Run workflow** on the default branch.
- [ ] Enter the explicit version without a `v` prefix and choose the npm distribution tag.
- [ ] Let the workflow commit the version, create the tag, and publish the generated server tarball.
- [ ] Publish the container image with immutable version and commit tags.
- [ ] Confirm the generated GitHub release contains the server tarball and `SHA256SUMS`.
- [ ] Smoke-test clean npm and container installations.
