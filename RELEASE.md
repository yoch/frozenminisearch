# Release process

This repository publishes two artifacts from the same release commit:

- npm package: `@yoch/frozenminisearch`
- GitHub Pages documentation: <https://yoch.github.io/frozenminisearch/>

GitHub Pages is built by CI from release tags. Do not commit generated `docs/`
HTML; the versioned site is produced from the tagged commit.

## Stable release

1. Update `package.json` version and `CHANGELOG.md`.
2. Run local verification:

   ```bash
   pnpm test
   pnpm build
   node scripts/verify-npm-pack.cjs
   pnpm docs:build
   ```

3. Commit the release changes.
4. Create and push the matching tag from the release commit:

   ```bash
   git tag vX.Y.Z
   git push origin HEAD
   git push origin vX.Y.Z
   ```

   Pushing the `vX.Y.Z` tag deploys GitHub Pages. The site header is built as
   `@yoch/frozenminisearch vX.Y.Z`.

5. Wait for the **Docs** workflow to pass for the tag.
6. Publish npm from the same tagged commit:

   ```bash
   pnpm release:stable
   ```

The publish script refuses to publish if the working tree is dirty, if `HEAD`
is not tagged with the exact `vX.Y.Z` tag from `package.json`, or if that tag
has not been pushed to `origin`.

## Beta release

Use the same flow with a prerelease version, for example `1.2.0-beta.1`, then:

```bash
git tag v1.2.0-beta.1
git push origin HEAD
git push origin v1.2.0-beta.1
pnpm run release:beta
```

Beta tags also deploy the docs because the workflow intentionally matches `v*`.

## Docs-only redeploy

Prefer release tags for published documentation. If a Pages redeploy is needed
without a new release, run the **Docs** workflow manually from GitHub Actions;
the version banner falls back to `package.json`.
