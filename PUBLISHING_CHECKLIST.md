# Publishing checklist

Use this before publishing an OBJY DB release to GitHub, npm, or a container registry.

## Release identity

- [ ] Use the `package.json` version consistently in the Git tag, release notes, npm package, and container tag.
- [ ] Use an explicit npm distribution tag such as `alpha` for prereleases.
- [ ] Confirm the working tree is clean and the release commit is on the intended branch.

## Legal and security

- [ ] Confirm that all ported source code is owned by the project and may be released under MIT.
- [x] Scan tracked files and the complete Git history for credentials, private keys, production endpoints, and customer data.
- [x] Review production dependencies for known vulnerabilities.
- [x] Confirm that examples contain no reusable secrets or unsafe production defaults.

## Validation

- [x] Run `npm ci` in a clean checkout.
- [x] Run `npm test` and `npm run test:browser`.
- [x] Run `npm run check:package` and inspect `npm pack --dry-run`.
- [x] Build and smoke-test the Docker image.
- [ ] Start a multi-node cluster and verify routing, replication, persistence, queries, aggregations, references, and vector search.
- [x] Verify the README, API documentation, client documentation, links, and images.

## Publish

- [ ] Create and push an annotated `v<version>` tag from the verified commit.
- [ ] Publish npm manually with the intended distribution tag.
- [ ] Publish the container image with immutable version and commit tags.
- [ ] Create the GitHub release with notes and artifact checksums.
- [x] Smoke-test clean npm and container installations.
