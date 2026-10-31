# Publishing checklist

Use this before publishing an OBJY DB release to GitHub, npm, or a container registry.

## Release identity

- [ ] Use the `package.json` version consistently in the Git tag, release notes, both npm packages, and container tag.
- [ ] Use an explicit npm distribution tag such as `alpha` for prereleases.
- [ ] Confirm that `@objy/db` and `@objy/server` are available at the intended version; no separate browser package is published.
- [ ] Confirm the working tree is clean and the release commit is on the intended branch.

## Legal and security

- [ ] Confirm that all ported source code is owned by the project and may be released under MIT.
- [ ] Scan tracked files and the complete Git history for credentials, private keys, production endpoints, and customer data.
- [ ] Review production dependencies for known vulnerabilities.
- [ ] Confirm that examples contain no reusable secrets or unsafe production defaults.

## Validation

- [ ] Run `npm ci` in a clean checkout.
- [ ] Run `npm test` and `npm run test:browser`.
- [ ] Run `npm run test:universal` and review the generated performance reports.
- [ ] Run `npm run check:package` and inspect all files under `.release/artifacts/`.
- [ ] Run `npm run test:packages` against clean tarball installations.
- [ ] Build and smoke-test the Docker image.
- [ ] Start a multi-node cluster and verify routing, replication, persistence, queries, aggregations, references, and vector search.
- [ ] Verify the README, database, server, API, benchmarks, changelog, links, and images.
- [ ] Verify that the compatible `@objy/client` version is published before `@objy/server`.

## Publish

- [ ] Open **Actions → Release → Run workflow** on the default branch.
- [ ] Enter the explicit version without a `v` prefix and choose the npm distribution tag.
- [ ] Let the workflow commit the version, create the tag, and publish the generated database and server tarballs.
- [ ] Publish the container image with immutable version and commit tags.
- [ ] Confirm the generated GitHub release contains both tarballs, the standalone browser ESM build of `@objy/db`, and `SHA256SUMS`.
- [ ] Smoke-test clean npm and container installations.
