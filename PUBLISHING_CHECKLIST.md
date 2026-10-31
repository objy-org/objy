# Publishing checklist

Use this before publishing an OBJY DB release to GitHub, npm, or a container registry.

## Release identity

- [ ] Use the `package.json` version consistently in the Git tag, release notes, both npm packages, and container tag.
- [ ] Use an explicit npm distribution tag such as `alpha` for prereleases.
- [ ] Confirm that `@objy/db` and `@objy/server` are available at the intended version.
- [ ] Confirm the working tree is clean and the release commit is on the intended branch.

## Legal and security

- [ ] Confirm that all ported source code is owned by the project and may be released under MIT.
- [x] Scan tracked files and the complete Git history for credentials, private keys, production endpoints, and customer data.
- [x] Review production dependencies for known vulnerabilities.
- [x] Confirm that examples contain no reusable secrets or unsafe production defaults.

## Validation

- [x] Run `npm ci` in a clean checkout.
- [x] Run `npm test` and `npm run test:browser`.
- [x] Run `npm run test:universal` and review the generated performance reports.
- [x] Run `npm run check:package` and inspect all files under `.release/artifacts/`.
- [x] Run `npm run test:packages` against clean tarball installations.
- [x] Build and smoke-test the Docker image.
- [ ] Start a multi-node cluster and verify routing, replication, persistence, queries, aggregations, references, and vector search.
- [x] Verify the README, API documentation, client documentation, links, and images.

## Publish

- [ ] Open **Actions → Release → Run workflow** on the default branch.
- [ ] Enter the explicit version without a `v` prefix and choose the npm distribution tag.
- [ ] Let the workflow commit the version, create the tag, and publish the generated database and server tarballs.
- [ ] Publish the container image with immutable version and commit tags.
- [ ] Confirm the generated GitHub release contains both tarballs, the standalone browser ESM build, and `SHA256SUMS`.
- [x] Smoke-test clean npm and container installations.
